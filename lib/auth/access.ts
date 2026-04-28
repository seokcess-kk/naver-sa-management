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
import type { UserProfile, UserRole } from "@/lib/generated/prisma/client"

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
