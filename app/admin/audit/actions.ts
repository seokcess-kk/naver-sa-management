"use server"

/**
 * 감사 로그 뷰어 admin — Server Actions (F-1.7)
 *
 * 정책:
 *   - admin 권한 필수 (모든 액션 진입부 assertRole("admin"))
 *   - AuditLog 자체는 변경 X — 조회 전용
 *   - before/after 는 raw 그대로 노출. 시크릿은 logAudit 적재 단계에서 이미 마스킹됨
 *     (lib/audit/log.ts sanitize). 본 모듈은 추가 마스킹 책임 없음.
 *   - DoS 방지: limit 상한 200, default 50
 *   - cursor 기반 keyset pagination — id desc 정렬 + take(limit+1) 패턴
 *   - 광고주별 필터: AuditLog.before/after JSON 안의 `advertiserId` 키 path filter.
 *     단, 일부 액션(advertiser.* 계열)은 targetType=Advertiser & targetId=<id> 로
 *     기록되어 JSON 안에 advertiserId 키가 없을 수 있음 → targetType+targetId 매칭도 OR.
 *
 * UI 는 `import { ... } from "@/app/admin/audit/actions"` 로 호출.
 */

import { z } from "zod"

import { prisma } from "@/lib/db/prisma"
import { assertRole } from "@/lib/auth/access"
import type { Prisma } from "@/lib/generated/prisma/client"

// =============================================================================
// 타입
// =============================================================================

export type AuditFilter = {
  userId?: string
  action?: string
  targetType?: string
  targetId?: string
  /** 광고주별 필터. before/after JSON 의 advertiserId 또는 (Advertiser, advertiserId) 타겟 매칭. */
  advertiserId?: string
  /** ISO 문자열 (>=) */
  fromTs?: string
  /** ISO 문자열 (<=) */
  toTs?: string
  /** keyset pagination — 마지막 row.id (id < cursor) */
  cursor?: string
  /** default 50, max 200 */
  limit?: number
}

export type AuditLogRow = {
  id: string
  userDisplayName: string | null
  userId: string | null
  action: string
  targetType: string
  targetId: string | null
  before: unknown // Json (마스킹 적재됨)
  after: unknown
  ts: string // ISO
}

export type AuditLogPage = {
  items: AuditLogRow[]
  nextCursor: string | null
  hasMore: boolean
}

export type AuditFilterOptions = {
  actions: string[]
  targetTypes: string[]
}

// =============================================================================
// Zod 스키마
// =============================================================================

// id / cuid 길이 여유 + UUID 호환을 위해 1..128 로 느슨히 받음
const shortId = z.string().trim().min(1).max(128)
// 광고주 customerId 등이 들어올 수도 있으나 본 액션은 내부 advertiserId(=Advertiser.id) 가정.
// 외부에서 고객 ID 를 검색하고 싶으면 후속 별개 액션으로 분리.
const isoString = z.string().trim().min(1).max(64)

const filterSchema = z.object({
  userId: shortId.optional(),
  action: z.string().trim().min(1).max(128).optional(),
  targetType: z.string().trim().min(1).max(64).optional(),
  targetId: shortId.optional(),
  advertiserId: shortId.optional(),
  fromTs: isoString.optional(),
  toTs: isoString.optional(),
  cursor: shortId.optional(),
  limit: z.number().int().optional(),
})

// =============================================================================
// 1. listAuditLogs
// =============================================================================

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

function clampLimit(input?: number): number {
  if (input == null || !Number.isFinite(input)) return DEFAULT_LIMIT
  const n = Math.floor(input)
  if (n < 1) return 1
  if (n > MAX_LIMIT) return MAX_LIMIT
  return n
}

function parseDate(iso: string | undefined): Date | undefined {
  if (!iso) return undefined
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return undefined
  return d
}

/**
 * admin: AuditLog 조회 (필터 + cursor pagination).
 *
 * 정렬: id desc (= ts 역순과 사실상 동일 — cuid 는 시간순 단조 증가).
 * 페이징:
 *   take(limit+1) 로 초과분 1개 → hasMore=true 판정 후 잘라냄.
 *   nextCursor = items[last].id (다음 호출에서 cursor 로 전달).
 *
 * 광고주 필터:
 *   OR(
 *     before.advertiserId == X,
 *     after.advertiserId == X,
 *     (targetType == "Advertiser" AND targetId == X)
 *   )
 */
export async function listAuditLogs(filter: AuditFilter): Promise<AuditLogPage> {
  await assertRole("admin")

  const parsed = filterSchema.safeParse(filter)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "유효하지 않은 입력")
  }
  const f = parsed.data
  const limit = clampLimit(f.limit)

  const where: Prisma.AuditLogWhereInput = {}

  if (f.userId) where.userId = f.userId
  if (f.action) where.action = f.action
  if (f.targetType) where.targetType = f.targetType
  if (f.targetId) where.targetId = f.targetId

  // ts range
  const from = parseDate(f.fromTs)
  const to = parseDate(f.toTs)
  if (from || to) {
    where.ts = {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    }
  }

  // 광고주 필터 — JSON path + targetType/Id 백업 매칭
  if (f.advertiserId) {
    const advId = f.advertiserId
    const advOr: Prisma.AuditLogWhereInput[] = [
      { after: { path: ["advertiserId"], equals: advId } },
      { before: { path: ["advertiserId"], equals: advId } },
      { AND: [{ targetType: "Advertiser" }, { targetId: advId }] },
    ]
    // 다른 OR 조건과 AND 결합되도록 별도 키로
    where.AND = [...((where.AND as Prisma.AuditLogWhereInput[]) ?? []), { OR: advOr }]
  }

  // cursor — id < cursor (id desc 정렬이므로 다음 페이지는 더 작은 id)
  if (f.cursor) {
    where.AND = [
      ...((where.AND as Prisma.AuditLogWhereInput[]) ?? []),
      { id: { lt: f.cursor } },
    ]
  }

  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: { id: "desc" },
    take: limit + 1,
    select: {
      id: true,
      userId: true,
      action: true,
      targetType: true,
      targetId: true,
      before: true,
      after: true,
      ts: true,
      user: { select: { displayName: true } },
    },
  })

  const hasMore = rows.length > limit
  const sliced = hasMore ? rows.slice(0, limit) : rows
  const nextCursor = hasMore ? sliced[sliced.length - 1]?.id ?? null : null

  const items: AuditLogRow[] = sliced.map((r) => ({
    id: r.id,
    userId: r.userId,
    userDisplayName: r.user?.displayName ?? null,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    before: r.before ?? null,
    after: r.after ?? null,
    ts: r.ts.toISOString(),
  }))

  return { items, nextCursor, hasMore }
}

// =============================================================================
// 2. listAuditFilterOptions
// =============================================================================

/**
 * admin: 필터 셀렉트 옵션 채우기 — distinct action / targetType.
 *
 * groupBy 로 distinct 추출 (DISTINCT 는 Prisma 직접 지원 X, groupBy 가 동등 비용).
 * AuditLog 가 매우 커지면 비용 상승 — UI 캐싱(예: 5분) 권장. 본 액션은 단순 조회만.
 */
export async function listAuditFilterOptions(): Promise<AuditFilterOptions> {
  await assertRole("admin")

  const [actionGroups, typeGroups] = await Promise.all([
    prisma.auditLog.groupBy({
      by: ["action"],
      orderBy: { action: "asc" },
    }),
    prisma.auditLog.groupBy({
      by: ["targetType"],
      orderBy: { targetType: "asc" },
    }),
  ])

  return {
    actions: actionGroups.map((g) => g.action),
    targetTypes: typeGroups.map((g) => g.targetType),
  }
}
