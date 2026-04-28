"use server"

/**
 * 사용자 / 권한 admin — Server Actions (F-1.6)
 *
 * 정책:
 *   - admin 권한 필수 (모든 액션 진입부 assertRole("admin"))
 *   - 인증·회원가입은 Supabase Auth 가 담당. UserProfile 은 첫 로그인 시 자동 생성됨
 *     (lib/auth/access.ts getCurrentUser 참고). 본 모듈은 사용자 직접 생성·삭제를 지원하지 않음.
 *   - 자기 자신 admin → 강등 차단 (마지막 admin 시스템 잠금 위험)
 *   - 자기 자신 disabled 차단 (관리자 화면에서 본인 잠금 방지)
 *   - AuditLog 기록 — admin 액션은 감사 중요 (before/after)
 *   - 본 모듈은 외부 SA API 변경 X → ChangeBatch 미사용
 *   - UserProfile 자체에 시크릿 컬럼 없음 (별도 마스킹 불요)
 *
 * UI 는 `import { ... } from "@/app/admin/users/actions"` 로 호출.
 */

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { prisma } from "@/lib/db/prisma"
import { assertRole } from "@/lib/auth/access"
import { logAudit } from "@/lib/audit/log"
import type { UserRole, UserStatus } from "@/lib/generated/prisma/client"

// =============================================================================
// 타입
// =============================================================================

export type UserRow = {
  id: string
  displayName: string
  role: UserRole
  status: UserStatus
  advertiserCount: number
  createdAt: string // ISO
}

export type UserAdvertiserAccessRow = {
  advertiserId: string
  advertiserName: string
  customerId: string
  grantedAt: string // ISO
  grantorDisplayName: string | null
}

export type UserDetail = {
  id: string
  displayName: string
  role: UserRole
  status: UserStatus
  advertiserAccess: UserAdvertiserAccessRow[]
  createdAt: string // ISO
}

export type ActionResult = { ok: true } | { ok: false; error: string }

// =============================================================================
// Zod 스키마
// =============================================================================

const userIdSchema = z.string().trim().min(1).max(128)
const advertiserIdSchema = z.string().trim().min(1).max(128)
const roleSchema = z.enum(["admin", "operator", "viewer"])
const statusSchema = z.enum(["active", "disabled"])

const updateRoleSchema = z.object({
  userId: userIdSchema,
  role: roleSchema,
})

const updateStatusSchema = z.object({
  userId: userIdSchema,
  status: statusSchema,
})

const grantAccessSchema = z.object({
  userId: userIdSchema,
  advertiserId: advertiserIdSchema,
})

const revokeAccessSchema = z.object({
  userId: userIdSchema,
  advertiserId: advertiserIdSchema,
})

// =============================================================================
// 1. listUsers
// =============================================================================

/**
 * admin: 사용자 목록 + 광고주 접근 카운트.
 * 정렬: createdAt 내림차순 (최신 사용자 우선).
 */
export async function listUsers(): Promise<UserRow[]> {
  await assertRole("admin")

  const rows = await prisma.userProfile.findMany({
    select: {
      id: true,
      displayName: true,
      role: true,
      status: true,
      createdAt: true,
      _count: { select: { advertiserAccess: true } },
    },
    orderBy: { createdAt: "desc" },
  })

  return rows.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    role: r.role,
    status: r.status,
    advertiserCount: r._count.advertiserAccess,
    createdAt: r.createdAt.toISOString(),
  }))
}

// =============================================================================
// 2. getUserDetail
// =============================================================================

/**
 * admin: 사용자 상세 + 부여된 광고주 접근 목록 (advertiser 메타 + grantor displayName 포함).
 * 미존재 → null.
 */
export async function getUserDetail(userId: string): Promise<UserDetail | null> {
  await assertRole("admin")
  const id = userIdSchema.parse(userId)

  const user = await prisma.userProfile.findUnique({
    where: { id },
    select: {
      id: true,
      displayName: true,
      role: true,
      status: true,
      createdAt: true,
      advertiserAccess: {
        select: {
          advertiserId: true,
          grantedAt: true,
          advertiser: {
            select: { name: true, customerId: true },
          },
          grantor: {
            select: { displayName: true },
          },
        },
        orderBy: { grantedAt: "desc" },
      },
    },
  })

  if (!user) return null

  return {
    id: user.id,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
    advertiserAccess: user.advertiserAccess.map((a) => ({
      advertiserId: a.advertiserId,
      advertiserName: a.advertiser.name,
      customerId: a.advertiser.customerId,
      grantedAt: a.grantedAt.toISOString(),
      grantorDisplayName: a.grantor?.displayName ?? null,
    })),
  }
}

// =============================================================================
// 3. updateUserRole
// =============================================================================

/**
 * admin: 사용자 역할 변경.
 *
 * 안전장치:
 *   - 본인이 admin → operator/viewer 로 강등 시,
 *     다른 admin 이 0명이면 시스템 잠금 위험 → 차단 (Error 반환).
 *   - 변경 없음(같은 role) → ok 반환만, AuditLog 미기록.
 *
 * AuditLog: action="user.role_change", before/after = { role }
 */
export async function updateUserRole(
  input: z.infer<typeof updateRoleSchema>,
): Promise<ActionResult> {
  const me = await assertRole("admin")
  const parsed = updateRoleSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "유효하지 않은 입력" }
  }
  const { userId, role: newRole } = parsed.data

  const target = await prisma.userProfile.findUnique({
    where: { id: userId },
    select: { id: true, role: true, status: true },
  })
  if (!target) {
    return { ok: false, error: "존재하지 않는 사용자입니다" }
  }

  // 변경 없음 — 즉시 OK
  if (target.role === newRole) {
    return { ok: true }
  }

  // 자기 자신을 admin → 비-admin 으로 강등할 때, 다른 admin 0명이면 차단
  if (target.id === me.id && target.role === "admin" && newRole !== "admin") {
    const adminCount = await prisma.userProfile.count({
      where: { role: "admin", status: "active" },
    })
    if (adminCount <= 1) {
      return {
        ok: false,
        error: "마지막 admin 입니다. 다른 admin 을 먼저 임명한 뒤 강등하세요.",
      }
    }
  }

  await prisma.userProfile.update({
    where: { id: userId },
    data: { role: newRole },
  })

  await logAudit({
    userId: me.id,
    action: "user.role_change",
    targetType: "UserProfile",
    targetId: userId,
    before: { role: target.role },
    after: { role: newRole },
  })

  revalidatePath("/admin/users")
  revalidatePath(`/admin/users/${userId}`)

  return { ok: true }
}

// =============================================================================
// 4. updateUserStatus
// =============================================================================

/**
 * admin: 사용자 상태 변경 (active / disabled).
 *
 * 안전장치:
 *   - 자기 자신 disabled 차단 (본인 잠금 방지).
 *   - active → active 같은 무변경은 ok 반환만, AuditLog 미기록.
 *   - 비활성화 시 다른 admin 카운트도 보호: 본인이 마지막 active admin 이면 disable 차단.
 *
 * AuditLog: action="user.status_change", before/after = { status }
 */
export async function updateUserStatus(
  input: z.infer<typeof updateStatusSchema>,
): Promise<ActionResult> {
  const me = await assertRole("admin")
  const parsed = updateStatusSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "유효하지 않은 입력" }
  }
  const { userId, status: newStatus } = parsed.data

  // 본인 disabled 차단 (자기 자신을 잠그는 행위 방지)
  if (userId === me.id && newStatus === "disabled") {
    return { ok: false, error: "본인 계정은 비활성화할 수 없습니다" }
  }

  const target = await prisma.userProfile.findUnique({
    where: { id: userId },
    select: { id: true, role: true, status: true },
  })
  if (!target) {
    return { ok: false, error: "존재하지 않는 사용자입니다" }
  }

  // 변경 없음
  if (target.status === newStatus) {
    return { ok: true }
  }

  // 마지막 active admin 비활성화 차단 (본인이 아닌 다른 admin 비활성화 케이스 포함)
  if (target.role === "admin" && newStatus === "disabled") {
    const adminCount = await prisma.userProfile.count({
      where: { role: "admin", status: "active" },
    })
    if (adminCount <= 1) {
      return {
        ok: false,
        error: "마지막 활성 admin 입니다. 다른 admin 을 먼저 임명한 뒤 비활성화하세요.",
      }
    }
  }

  await prisma.userProfile.update({
    where: { id: userId },
    data: { status: newStatus },
  })

  await logAudit({
    userId: me.id,
    action: "user.status_change",
    targetType: "UserProfile",
    targetId: userId,
    before: { status: target.status },
    after: { status: newStatus },
  })

  revalidatePath("/admin/users")
  revalidatePath(`/admin/users/${userId}`)

  return { ok: true }
}

// =============================================================================
// 5. grantAdvertiserAccess
// =============================================================================

/**
 * admin: 사용자에게 광고주 화이트리스트 부여.
 *
 * 동작:
 *   - 사용자 / 광고주 존재 검사 (광고주는 status != 'archived' 만 허용)
 *   - upsert: 이미 부여된 경우 grantedAt 갱신 + grantedBy 갱신 (재부여)
 *   - admin role 사용자에게 부여해도 거부하지 않음 (admin 은 화이트리스트 무관하게
 *     전체 접근 가능 — assertAdvertiserAccess 가 admin 우회. 단순히 기록 목적으로 허용).
 *
 * AuditLog: action="user.access_grant", after = { advertiserId, advertiserName, customerId }
 */
export async function grantAdvertiserAccess(input: {
  userId: string
  advertiserId: string
}): Promise<ActionResult> {
  const me = await assertRole("admin")
  const parsed = grantAccessSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "유효하지 않은 입력" }
  }
  const { userId, advertiserId } = parsed.data

  const user = await prisma.userProfile.findUnique({
    where: { id: userId },
    select: { id: true },
  })
  if (!user) {
    return { ok: false, error: "존재하지 않는 사용자입니다" }
  }

  const advertiser = await prisma.advertiser.findUnique({
    where: { id: advertiserId },
    select: { id: true, name: true, customerId: true, status: true },
  })
  if (!advertiser) {
    return { ok: false, error: "존재하지 않는 광고주입니다" }
  }
  if (advertiser.status === "archived") {
    return { ok: false, error: "아카이브된 광고주에는 권한을 부여할 수 없습니다" }
  }

  await prisma.userAdvertiserAccess.upsert({
    where: { userId_advertiserId: { userId, advertiserId } },
    create: {
      userId,
      advertiserId,
      grantedBy: me.id,
    },
    update: {
      grantedBy: me.id,
      grantedAt: new Date(),
    },
  })

  await logAudit({
    userId: me.id,
    action: "user.access_grant",
    targetType: "UserProfile",
    targetId: userId,
    before: null,
    after: {
      advertiserId,
      advertiserName: advertiser.name,
      customerId: advertiser.customerId,
    },
  })

  revalidatePath("/admin/users")
  revalidatePath(`/admin/users/${userId}`)

  return { ok: true }
}

// =============================================================================
// 6. revokeAdvertiserAccess
// =============================================================================

/**
 * admin: 사용자 광고주 화이트리스트 회수.
 *
 * 동작:
 *   - 미부여(레코드 없음) 인 경우도 ok 반환 (멱등성)
 *   - 회수 후 AuditLog 기록 (before 에 부여 정보 보존)
 *
 * AuditLog: action="user.access_revoke", before = { advertiserId, advertiserName, customerId, grantedAt }
 */
export async function revokeAdvertiserAccess(input: {
  userId: string
  advertiserId: string
}): Promise<ActionResult> {
  const me = await assertRole("admin")
  const parsed = revokeAccessSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "유효하지 않은 입력" }
  }
  const { userId, advertiserId } = parsed.data

  // 광고주 메타는 AuditLog before 기록을 위해 함께 조회
  const access = await prisma.userAdvertiserAccess.findUnique({
    where: { userId_advertiserId: { userId, advertiserId } },
    select: {
      grantedAt: true,
      advertiser: { select: { name: true, customerId: true } },
    },
  })

  // 멱등 — 이미 회수됨
  if (!access) {
    return { ok: true }
  }

  await prisma.userAdvertiserAccess.delete({
    where: { userId_advertiserId: { userId, advertiserId } },
  })

  await logAudit({
    userId: me.id,
    action: "user.access_revoke",
    targetType: "UserProfile",
    targetId: userId,
    before: {
      advertiserId,
      advertiserName: access.advertiser.name,
      customerId: access.advertiser.customerId,
      grantedAt: access.grantedAt.toISOString(),
    },
    after: null,
  })

  revalidatePath("/admin/users")
  revalidatePath(`/admin/users/${userId}`)

  return { ok: true }
}
