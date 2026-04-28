/**
 * 권한 헬퍼 (앱 DB 기반 권한 모델)
 *
 * 모델 (SPEC 6.1 F-1.6):
 *   - 인증: Supabase Auth (user.id = UUID)
 *   - 권한·광고주 화이트리스트: 앱 DB UserProfile / UserAdvertiserAccess
 *   - Auth metadata 단독 운영 X
 *
 * 모든 Server Action 진입부에서 다음 중 하나를 호출:
 *   - getCurrentUser() : 인증된 UserProfile 반환
 *   - assertRole(role) : 부족 시 throw
 *   - assertAdvertiserAccess(userId, advertiserId) : 화이트리스트 검사
 */

import { prisma } from "@/lib/db/prisma"
import { getServerSupabase } from "@/lib/supabase/server"
import type {
  UserProfile,
  UserRole,
  AdvertiserStatus,
} from "@/lib/generated/prisma/client"

/** 권한 부족 / 미인증 시 throw 되는 에러. UI에서 catch 하여 안내 메시지 매핑. */
export class AuthorizationError extends Error {
  constructor(message = "권한 부족") {
    super(message)
    this.name = "AuthorizationError"
  }
}

export class UnauthenticatedError extends Error {
  constructor(message = "로그인이 필요합니다") {
    super(message)
    this.name = "UnauthenticatedError"
  }
}

const ROLE_RANK: Record<UserRole, number> = {
  viewer: 1,
  operator: 2,
  admin: 3,
}

/**
 * 현재 Supabase Auth 사용자 + UserProfile 조인.
 *
 * 동작:
 *   1. supabase.auth.getUser() 로 인증 사용자 확인 (없으면 UnauthenticatedError)
 *   2. prisma.userProfile.findUnique({ id }) 조회
 *   3. UserProfile 미존재 시 자동 생성 (의사결정: 첫 로그인 시 viewer 기본 생성)
 *   4. status=disabled 면 UnauthenticatedError
 */
export async function getCurrentUser(): Promise<UserProfile> {
  const supabase = await getServerSupabase()
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()

  if (error || !user) {
    throw new UnauthenticatedError()
  }

  let profile = await prisma.userProfile.findUnique({ where: { id: user.id } })

  if (!profile) {
    const displayName =
      (user.user_metadata?.name as string | undefined) ??
      (user.user_metadata?.full_name as string | undefined) ??
      user.email ??
      user.id
    profile = await prisma.userProfile.create({
      data: {
        id: user.id,
        displayName,
        // 기본 viewer. admin 승급은 별도 운영 채널.
        role: "viewer",
        status: "active",
      },
    })
  }

  if (profile.status === "disabled") {
    throw new UnauthenticatedError("비활성화된 계정입니다")
  }

  return profile
}

/**
 * 현재 사용자가 최소 role 이상인지 확인. 부족 시 AuthorizationError.
 *
 * 권한 위계:
 *   viewer < operator < admin
 *
 * @returns 검증된 UserProfile (이후 로직에서 재조회 불필요)
 */
export async function assertRole(role: UserRole): Promise<UserProfile> {
  const me = await getCurrentUser()
  if (ROLE_RANK[me.role] < ROLE_RANK[role]) {
    throw new AuthorizationError("권한 부족")
  }
  return me
}

/**
 * 사용자가 특정 광고주에 접근 권한이 있는지 확인.
 * admin 은 전체 접근 (화이트리스트 무시).
 */
export async function assertAdvertiserAccess(
  userId: string,
  advertiserId: string,
): Promise<void> {
  const me = await prisma.userProfile.findUnique({ where: { id: userId } })
  if (!me || me.status !== "active") {
    throw new UnauthenticatedError()
  }
  if (me.role === "admin") return

  const access = await prisma.userAdvertiserAccess.findUnique({
    where: { userId_advertiserId: { userId, advertiserId } },
  })
  if (!access) {
    throw new AuthorizationError("해당 광고주에 대한 접근 권한이 없습니다")
  }
}

// =============================================================================
// 광고주 셀렉터 / 컨텍스트 헬퍼 (F-1.4)
// =============================================================================
// (dashboard) 라우트에서 GNB 셀렉터 + 광고주 컨텍스트 페이지 진입 시 사용.
//
// 권한 분기 (SPEC 8.1 / F-1.6):
//   - admin: status='archived' 제외 모든 광고주
//   - operator/viewer: UserAdvertiserAccess 화이트리스트 ∩ status != 'archived'
//
// 시크릿 안전장치:
//   - apiKeyEnc / secretKeyEnc 컬럼은 SELECT 하긴 하나 그 자체를 반환 객체에 노출 X.
//     "키 입력 여부"는 hasKeys boolean 으로만 파생 (SA 호출 가능 여부 UI 표시용).

/** 광고주 셀렉터 / 컨텍스트 표시에 필요한 최소 필드 + hasKeys 파생 컬럼. */
export type AccessibleAdvertiser = {
  id: string
  customerId: string
  name: string
  status: AdvertiserStatus
  /** apiKeyEnc / secretKeyEnc 둘 다 채워졌는지 (SA API 호출 가능 여부) */
  hasKeys: boolean
}

/** 광고주 미존재 시 throw. UI 에서 catch 하여 404 매핑. */
export class AdvertiserNotFoundError extends Error {
  constructor(message = "존재하지 않는 광고주입니다") {
    super(message)
    this.name = "AdvertiserNotFoundError"
  }
}

/**
 * 현재 사용자가 접근 가능한 광고주 목록.
 *
 *   - admin: status != 'archived' 전체
 *   - operator/viewer: UserAdvertiserAccess 화이트리스트 ∩ status != 'archived'
 *   - 정렬: name 가나다 순 (Postgres 기본 collation)
 *   - 반환 shape: AccessibleAdvertiser[] (hasKeys boolean 포함, 시크릿 컬럼 노출 X)
 *
 * GNB 셀렉터가 매 페이지 진입에서 호출하므로 가벼운 SELECT 만 수행.
 */
export async function listAccessibleAdvertisers(): Promise<
  AccessibleAdvertiser[]
> {
  const me = await getCurrentUser()

  const baseSelect = {
    id: true,
    customerId: true,
    name: true,
    status: true,
    apiKeyEnc: true,
    secretKeyEnc: true,
  } as const

  const rows =
    me.role === "admin"
      ? await prisma.advertiser.findMany({
          where: { status: { not: "archived" } },
          select: baseSelect,
          orderBy: { name: "asc" },
        })
      : await prisma.advertiser.findMany({
          where: {
            status: { not: "archived" },
            access: { some: { userId: me.id } },
          },
          select: baseSelect,
          orderBy: { name: "asc" },
        })

  // Bytes → boolean 즉시 변환. 원본 시크릿은 절대 클라이언트로 흐르지 않게.
  return rows.map((r) => ({
    id: r.id,
    customerId: r.customerId,
    name: r.name,
    status: r.status,
    hasKeys: r.apiKeyEnc !== null && r.secretKeyEnc !== null,
  }))
}

/**
 * `/[advertiserId]/...` 페이지 진입 시 권한 검증 + 광고주 객체 반환.
 *
 *   1. getCurrentUser() — 미인증 시 UnauthenticatedError
 *   2. role !== 'admin' → assertAdvertiserAccess(userId, advertiserId)
 *   3. 광고주 조회 (시크릿 컬럼 SELECT 하지만 반환 객체엔 hasKeys 만)
 *   4. 미존재 → AdvertiserNotFoundError
 *   5. status === 'archived' → AuthorizationError ("아카이브된 광고주")
 *
 * 반환값에 시크릿(enc) 절대 포함 X.
 */
export async function getCurrentAdvertiser(
  advertiserId: string,
): Promise<{
  advertiser: AccessibleAdvertiser
  user: UserProfile
}> {
  const me = await getCurrentUser()

  if (me.role !== "admin") {
    await assertAdvertiserAccess(me.id, advertiserId)
  }

  const row = await prisma.advertiser.findUnique({
    where: { id: advertiserId },
    select: {
      id: true,
      customerId: true,
      name: true,
      status: true,
      apiKeyEnc: true,
      secretKeyEnc: true,
    },
  })

  if (!row) {
    throw new AdvertiserNotFoundError()
  }
  if (row.status === "archived") {
    throw new AuthorizationError("아카이브된 광고주입니다")
  }

  return {
    advertiser: {
      id: row.id,
      customerId: row.customerId,
      name: row.name,
      status: row.status,
      hasKeys: row.apiKeyEnc !== null && row.secretKeyEnc !== null,
    },
    user: me,
  }
}
