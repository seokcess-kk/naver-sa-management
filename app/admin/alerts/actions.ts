"use server"

/**
 * 알림 이벤트 admin — Server Actions (F-8.x)
 *
 * 정책:
 *   - admin 권한 필수 (모든 액션 진입부 assertRole("admin"))
 *   - AlertEvent 자체는 변경 X — 조회 전용
 *   - payload 는 raw 그대로 노출. 시크릿은 평가기·dispatch 단계에서 평문 미주입 가정
 *     (lib/audit/log.ts 와 별도 sanitize 없음 — 본 모듈 책임 X)
 *   - cursor pagination (id desc) — limit 기본 50, max 200
 *   - 광고주별 필터: payload 안의 meta.advertiserId 매칭
 *
 * UI 는 `import { ... } from "@/app/admin/alerts/actions"` 로 호출.
 */

import { z } from "zod"

import { prisma } from "@/lib/db/prisma"
import { assertRole } from "@/lib/auth/access"
import type { AlertEventStatus, Prisma } from "@/lib/generated/prisma/client"

// =============================================================================
// 타입
// =============================================================================

export type AlertEventFilter = {
  ruleId?: string
  status?: AlertEventStatus
  /** payload.meta.advertiserId 매칭 */
  advertiserId?: string
  /** keyset pagination — 마지막 row.id (id < cursor) */
  cursor?: string
  /** default 50, max 200 */
  limit?: number
}

export type AlertEventRow = {
  id: string
  ruleId: string
  ruleType: string
  payload: unknown
  status: AlertEventStatus
  sentAt: string | null
  createdAt: string
}

export type AlertEventPage = {
  items: AlertEventRow[]
  nextCursor: string | null
  hasMore: boolean
}

// =============================================================================
// Zod 스키마
// =============================================================================

const shortId = z.string().trim().min(1).max(128)

const filterSchema = z.object({
  ruleId: shortId.optional(),
  status: z.enum(["pending", "sent", "failed", "muted"]).optional(),
  advertiserId: shortId.optional(),
  cursor: shortId.optional(),
  limit: z.number().int().optional(),
})

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

function clampLimit(input?: number): number {
  if (input == null || !Number.isFinite(input)) return DEFAULT_LIMIT
  const n = Math.floor(input)
  if (n < 1) return 1
  if (n > MAX_LIMIT) return MAX_LIMIT
  return n
}

// =============================================================================
// listAlertEvents
// =============================================================================

/**
 * admin: AlertEvent 조회 (필터 + cursor pagination).
 *
 * 정렬: id desc (cuid 시간 단조 — createdAt 역순과 사실상 동일).
 * 페이징: take(limit+1) 로 초과분 1개 → hasMore 판정 후 잘라냄.
 *
 * advertiserId 필터:
 *   - payload 안의 meta.advertiserId 매칭 (평가기 candidate.meta 가 항상 채움)
 *   - JSON path filter 사용
 */
export async function listAlertEvents(
  filter: AlertEventFilter,
): Promise<AlertEventPage> {
  await assertRole("admin")

  const parsed = filterSchema.safeParse(filter)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "유효하지 않은 입력")
  }
  const f = parsed.data
  const limit = clampLimit(f.limit)

  const where: Prisma.AlertEventWhereInput = {}
  if (f.ruleId) where.ruleId = f.ruleId
  if (f.status) where.status = f.status

  if (f.advertiserId) {
    // payload.meta.advertiserId 매칭 (대부분의 candidate)
    // payload.advertiserId 도 폴백 (혹시 모를 누락 케이스)
    where.AND = [
      ...((where.AND as Prisma.AlertEventWhereInput[]) ?? []),
      {
        OR: [
          { payload: { path: ["meta", "advertiserId"], equals: f.advertiserId } },
          { payload: { path: ["advertiserId"], equals: f.advertiserId } },
        ],
      },
    ]
  }

  if (f.cursor) {
    where.AND = [
      ...((where.AND as Prisma.AlertEventWhereInput[]) ?? []),
      { id: { lt: f.cursor } },
    ]
  }

  const rows = await prisma.alertEvent.findMany({
    where,
    orderBy: { id: "desc" },
    take: limit + 1,
    select: {
      id: true,
      ruleId: true,
      payload: true,
      status: true,
      sentAt: true,
      createdAt: true,
      rule: { select: { type: true } },
    },
  })

  const hasMore = rows.length > limit
  const sliced = hasMore ? rows.slice(0, limit) : rows
  const nextCursor = hasMore ? sliced[sliced.length - 1]?.id ?? null : null

  const items: AlertEventRow[] = sliced.map((r) => ({
    id: r.id,
    ruleId: r.ruleId,
    ruleType: r.rule.type,
    payload: r.payload ?? null,
    status: r.status,
    sentAt: r.sentAt ? r.sentAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }))

  return { items, nextCursor, hasMore }
}
