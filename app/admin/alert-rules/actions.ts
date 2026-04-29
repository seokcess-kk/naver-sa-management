"use server"

/**
 * 알림 룰 admin — Server Actions (F-8.x)
 *
 * 정책:
 *   - admin 권한 필수 (모든 액션 진입부 assertRole("admin"))
 *   - AuditLog 기록 — admin 액션 감사 (before/after)
 *   - 본 모듈은 외부 SA API 변경 X → ChangeBatch 미사용
 *   - rule.params 는 type 별로 다름 (lib/alerts/evaluators.ts 의 *Params 타입)
 *     본 모듈은 type 화이트리스트만 검증. params shape 검증은 type 별 Zod 스키마로 분기.
 *   - delete 는 hard delete + cascade (AlertEvent 까지 같이 삭제됨 — schema 의 onDelete: Cascade)
 *
 * UI 는 `import { ... } from "@/app/admin/alert-rules/actions"` 로 호출.
 */

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { prisma } from "@/lib/db/prisma"
import { assertRole } from "@/lib/auth/access"
import { logAudit } from "@/lib/audit/log"
import type { Prisma } from "@/lib/generated/prisma/client"

// =============================================================================
// 타입
// =============================================================================

export type AlertRuleType =
  | "budget_burn"
  | "bizmoney_low"
  | "api_auth_error"
  | "inspect_rejected"

export type AlertRuleRow = {
  id: string
  type: string
  params: unknown
  channelHint: string | null
  enabled: boolean
  createdAt: string // ISO
  updatedAt: string // ISO
  /** 최근 24h 적재된 AlertEvent 카운트 (디버깅용). */
  recentEventsCount: number
}

export type ActionResult<T = unknown> =
  | { ok: true; data?: T }
  | { ok: false; error: string }

// =============================================================================
// Zod 스키마
// =============================================================================

const shortId = z.string().trim().min(1).max(128)
const advertiserIdSchema = z.string().trim().min(1).max(128)

/** type 화이트리스트. 신규 추가 시 lib/alerts/evaluators.ts 와 동기화. */
const alertRuleTypeSchema = z.enum([
  "budget_burn",
  "bizmoney_low",
  "api_auth_error",
  "inspect_rejected",
])

/**
 * type 별 params 스키마.
 *
 * 공통: advertiserId 필수 (모델에 advertiserId 컬럼이 없어 params 에 저장하는 정책 — 본 PR 합의).
 * type 별 추가 필드는 evaluators 의 *Params 타입과 일치.
 */
const budgetBurnParamsSchema = z
  .object({
    advertiserId: advertiserIdSchema,
    thresholds: z
      .array(z.number().int().min(1).max(1000))
      .min(1)
      .max(10)
      .optional(),
  })
  .strict()

const bizmoneyLowParamsSchema = z
  .object({
    advertiserId: advertiserIdSchema,
    days: z.number().int().min(1).max(30).optional(),
  })
  .strict()

const apiAuthErrorParamsSchema = z
  .object({
    advertiserId: advertiserIdSchema,
  })
  .strict()

const inspectRejectedParamsSchema = z
  .object({
    advertiserId: advertiserIdSchema,
    withinMinutes: z.number().int().min(5).max(1440).optional(),
    maxCandidates: z.number().int().min(1).max(200).optional(),
  })
  .strict()

/** params 검증을 type 에 따라 분기. */
function validateParams(
  type: AlertRuleType,
  params: unknown,
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  let parsed
  switch (type) {
    case "budget_burn":
      parsed = budgetBurnParamsSchema.safeParse(params)
      break
    case "bizmoney_low":
      parsed = bizmoneyLowParamsSchema.safeParse(params)
      break
    case "api_auth_error":
      parsed = apiAuthErrorParamsSchema.safeParse(params)
      break
    case "inspect_rejected":
      parsed = inspectRejectedParamsSchema.safeParse(params)
      break
    default:
      return { ok: false, error: `미지원 type: ${type}` }
  }
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "유효하지 않은 params",
    }
  }
  return { ok: true, data: parsed.data as Record<string, unknown> }
}

const createSchema = z.object({
  type: alertRuleTypeSchema,
  params: z.unknown(), // type 별로 분기 검증
  channelHint: z.string().trim().max(64).optional().nullable(),
  enabled: z.boolean().optional(),
})

const updateSchema = z.object({
  id: shortId,
  params: z.unknown().optional(),
  channelHint: z.string().trim().max(64).optional().nullable(),
  enabled: z.boolean().optional(),
})

// =============================================================================
// 1. listAlertRules
// =============================================================================

/**
 * admin: AlertRule 목록 + 최근 24h 이벤트 카운트.
 *
 * 정렬: createdAt desc (최신 룰 우선).
 * 24h 카운트는 별도 groupBy 1쿼리 + 매핑.
 */
export async function listAlertRules(): Promise<AlertRuleRow[]> {
  await assertRole("admin")

  const rules = await prisma.alertRule.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      type: true,
      params: true,
      channelHint: true,
      enabled: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  if (rules.length === 0) return []

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const eventCounts = await prisma.alertEvent.groupBy({
    by: ["ruleId"],
    where: {
      ruleId: { in: rules.map((r) => r.id) },
      createdAt: { gte: since },
    },
    _count: { _all: true },
  })
  const countMap = new Map<string, number>(
    eventCounts.map((g) => [g.ruleId, g._count._all]),
  )

  return rules.map((r) => ({
    id: r.id,
    type: r.type,
    params: r.params ?? null,
    channelHint: r.channelHint,
    enabled: r.enabled,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    recentEventsCount: countMap.get(r.id) ?? 0,
  }))
}

// =============================================================================
// 2. createAlertRule
// =============================================================================

/**
 * admin: AlertRule 생성.
 *
 * - type 화이트리스트 (4종) + type 별 params 검증 (advertiserId 필수)
 * - advertiserId 존재성 + status != 'archived' 검증 (params 안에 들어있는 값)
 * - AuditLog: action="alert_rule.create"
 */
export async function createAlertRule(input: {
  type: AlertRuleType
  params: unknown
  channelHint?: string | null
  enabled?: boolean
}): Promise<ActionResult<{ id: string }>> {
  const me = await assertRole("admin")
  const parsed = createSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "유효하지 않은 입력" }
  }
  const { type, params, channelHint, enabled } = parsed.data

  const paramsCheck = validateParams(type, params)
  if (!paramsCheck.ok) {
    return { ok: false, error: paramsCheck.error }
  }

  // advertiserId 존재성 검증
  const advertiserId = paramsCheck.data.advertiserId as string
  const advertiser = await prisma.advertiser.findUnique({
    where: { id: advertiserId },
    select: { id: true, status: true },
  })
  if (!advertiser) {
    return { ok: false, error: "존재하지 않는 광고주입니다" }
  }
  if (advertiser.status === "archived") {
    return { ok: false, error: "아카이브된 광고주에는 알림 룰을 만들 수 없습니다" }
  }

  const created = await prisma.alertRule.create({
    data: {
      type,
      params: paramsCheck.data as Prisma.InputJsonValue,
      channelHint: channelHint ?? null,
      enabled: enabled ?? true,
    },
    select: { id: true },
  })

  await logAudit({
    userId: me.id,
    action: "alert_rule.create",
    targetType: "AlertRule",
    targetId: created.id,
    before: null,
    after: {
      type,
      advertiserId,
      params: paramsCheck.data,
      channelHint: channelHint ?? null,
      enabled: enabled ?? true,
    },
  })

  revalidatePath("/admin/alert-rules")

  return { ok: true, data: { id: created.id } }
}

// =============================================================================
// 3. updateAlertRule
// =============================================================================

/**
 * admin: AlertRule 부분 수정.
 *
 * - type 변경은 비허용 (룰 의미 자체가 바뀜 — 새로 만들고 기존 삭제 권장)
 * - params 변경 시 type 별 재검증
 * - AuditLog: action="alert_rule.update", before/after 부분 필드만
 */
export async function updateAlertRule(input: {
  id: string
  params?: unknown
  channelHint?: string | null
  enabled?: boolean
}): Promise<ActionResult> {
  const me = await assertRole("admin")
  const parsed = updateSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "유효하지 않은 입력" }
  }
  const { id, params, channelHint, enabled } = parsed.data

  const existing = await prisma.alertRule.findUnique({
    where: { id },
    select: {
      id: true,
      type: true,
      params: true,
      channelHint: true,
      enabled: true,
    },
  })
  if (!existing) {
    return { ok: false, error: "존재하지 않는 알림 룰입니다" }
  }

  const data: Prisma.AlertRuleUpdateInput = {}
  let nextParams: Record<string, unknown> | undefined

  if (params !== undefined) {
    const check = validateParams(existing.type as AlertRuleType, params)
    if (!check.ok) {
      return { ok: false, error: check.error }
    }
    nextParams = check.data
    data.params = check.data as Prisma.InputJsonValue
  }
  if (channelHint !== undefined) {
    data.channelHint = channelHint
  }
  if (enabled !== undefined) {
    data.enabled = enabled
  }

  if (Object.keys(data).length === 0) {
    return { ok: true }
  }

  await prisma.alertRule.update({ where: { id }, data })

  await logAudit({
    userId: me.id,
    action: "alert_rule.update",
    targetType: "AlertRule",
    targetId: id,
    before: {
      params: existing.params ?? null,
      channelHint: existing.channelHint,
      enabled: existing.enabled,
    },
    after: {
      params: nextParams ?? existing.params ?? null,
      channelHint: channelHint !== undefined ? channelHint : existing.channelHint,
      enabled: enabled !== undefined ? enabled : existing.enabled,
    },
  })

  revalidatePath("/admin/alert-rules")
  revalidatePath(`/admin/alert-rules/${id}`)

  return { ok: true }
}

// =============================================================================
// 4. deleteAlertRule
// =============================================================================

/**
 * admin: AlertRule 삭제.
 *
 * - schema 의 onDelete: Cascade 로 AlertEvent 도 함께 삭제됨
 * - 삭제 전 before snapshot 기록 (감사용)
 * - AuditLog: action="alert_rule.delete"
 */
export async function deleteAlertRule(id: string): Promise<ActionResult> {
  const me = await assertRole("admin")
  const parsedId = shortId.safeParse(id)
  if (!parsedId.success) {
    return { ok: false, error: "유효하지 않은 id" }
  }

  const existing = await prisma.alertRule.findUnique({
    where: { id: parsedId.data },
    select: {
      id: true,
      type: true,
      params: true,
      channelHint: true,
      enabled: true,
    },
  })
  // 멱등 — 이미 삭제됨
  if (!existing) {
    return { ok: true }
  }

  await prisma.alertRule.delete({ where: { id: parsedId.data } })

  await logAudit({
    userId: me.id,
    action: "alert_rule.delete",
    targetType: "AlertRule",
    targetId: parsedId.data,
    before: {
      type: existing.type,
      params: existing.params ?? null,
      channelHint: existing.channelHint,
      enabled: existing.enabled,
    },
    after: null,
  })

  revalidatePath("/admin/alert-rules")

  return { ok: true }
}
