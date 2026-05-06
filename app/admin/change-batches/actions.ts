"use server"

/**
 * 변경 프리뷰·롤백 admin — Server Actions (F-6.x)
 *
 * 본 모듈 스코프 (SPEC v0.2.1 / F-6.x):
 *   - F-6.1 미리보기: 단건 액션 흐름은 BulkActionModal 에서 이미 구현 완료. 본 모듈 추가 작업 없음.
 *   - F-6.2 진행률: 단일 PUT 동기 실행이라 의미 적음. Job Table 도입 시 본격. 본 모듈은 결과 카운트만.
 *   - F-6.3 부분 실패 재시도: retryFailedItems — 실패 ChangeItem만 targetType별로 SA 재호출.
 *   - F-6.4 롤백: rollbackChangeBatch — toggle/update 계열 한정 + DB 현재값 vs after JSON drift 감지.
 *
 * 정책:
 *   - admin 권한 필수 (모든 액션 진입부 assertRole("admin"))
 *   - 외부 SA 호출은 모두 lib/naver-sa/* 모듈 통과 (fetch 직접 호출 금지 — CLAUDE.md "외부 API 통과")
 *   - 자격증명 resolver 자동 등록 (`@/lib/naver-sa/credentials` side-effect import)
 *   - 광고주 한정: ChangeBatch.summary.advertiserId → Advertiser.id 조회 + hasKeys 검증
 *   - 모든 변경은 ChangeBatch + ChangeItem 적재 (롤백 자체도 새 ChangeBatch — CLAUDE.md "모든 변경은 ChangeBatch")
 *   - 시크릿은 logAudit 적재 단계에서 마스킹됨 (lib/audit/log.ts sanitize). 본 모듈은 raw 응답·payload 첨부 금지.
 *
 * 롤백 drift 감지 (RollbackOptions.saRecheck):
 *   - 기본 (saRecheck=false): DB 현재값 vs ChangeItem.after 비교만. SA 호출 0회. 외부 변경 감지 X.
 *   - 정밀 (saRecheck=true, F-6.4): SA 재조회로 외부 변경(타 사용자/자동화/네이버측)까지 감지.
 *     비용: 광고그룹별 list API + 광고주 단위 list 1~2회. 토큰 버킷 자동 throttle.
 *   - ignoreDrift=true 일 때만 drift 행도 강제 롤백. 기본값(false)은 skip.
 *
 * UI 는 `import { ... } from "@/app/admin/change-batches/actions"` 로 호출.
 */

import { z } from "zod"
import { revalidatePath } from "next/cache"

import { prisma } from "@/lib/db/prisma"
import { assertRole } from "@/lib/auth/access"
import { logAudit } from "@/lib/audit/log"

// 자격증명 resolver 자동 등록 (retry / rollback 시 SA API 호출 위해 필요)
import "@/lib/naver-sa/credentials"

import {
  updateKeywordsBulk,
  listKeywords,
  type KeywordBulkUpdateItem,
  type Keyword,
} from "@/lib/naver-sa/keywords"
import {
  updateAdgroupsBulk,
  listAdgroups,
  type AdgroupBulkUpdateItem,
  type AdGroup,
} from "@/lib/naver-sa/adgroups"
import {
  updateCampaignsBulk,
  listCampaigns,
  type CampaignBulkUpdateItem,
  type Campaign,
} from "@/lib/naver-sa/campaigns"
import {
  updateAdsBulk,
  listAds,
  type AdBulkUpdateItem,
  type Ad,
} from "@/lib/naver-sa/ads"
import {
  updateAdExtensionsBulk,
  listAdExtensions,
  type AdExtensionBulkUpdateItem,
  type AdExtension,
} from "@/lib/naver-sa/ad-extensions"

import type {
  ChangeBatchStatus,
  ChangeItemStatus,
  Prisma,
} from "@/lib/generated/prisma/client"

// =============================================================================
// 타입
// =============================================================================

export type ChangeBatchFilter = {
  userId?: string
  /** 정확 일치 (예: "keyword.toggle"). 부분 일치는 본 PR 비대상. */
  action?: string
  status?: "pending" | "running" | "done" | "failed"
  /** ISO 문자열 (>= createdAt) */
  fromTs?: string
  /** ISO 문자열 (<= createdAt) */
  toTs?: string
  /** keyset pagination — 마지막 row.id (id < cursor, id desc 정렬) */
  cursor?: string
  /** default 50, max 200 */
  limit?: number
}

export type ChangeBatchRow = {
  id: string
  userId: string | null
  userDisplayName: string | null
  action: string
  status: ChangeBatchStatus
  total: number
  processed: number
  attempt: number
  summary: unknown
  createdAt: string // ISO
  finishedAt: string | null
  /** items where status='failed' 카운트 (재시도 가능 항목 수). */
  failedCount: number
}

export type ChangeBatchPage = {
  items: ChangeBatchRow[]
  nextCursor: string | null
  hasMore: boolean
}

export type ChangeItemRow = {
  id: string
  targetType: string
  targetId: string | null
  before: unknown
  after: unknown
  status: ChangeItemStatus
  error: string | null
  idempotencyKey: string
  attempt: number
}

export type ChangeBatchDetail = ChangeBatchRow & {
  items: ChangeItemRow[]
}

export type RetryResult = {
  ok: boolean
  retried: number
  successAfterRetry: number
  stillFailed: number
  error?: string
}

export type RollbackOptions = {
  /** true 면 drift 항목도 강제 롤백. 기본 false (drift 행은 skip). */
  ignoreDrift?: boolean
  /**
   * true=SA 재조회로 정밀 검사. false(기본)=DB current vs after 단순 비교(레거시).
   *
   * SA 재조회 모드 (F-6.4 정밀화):
   *   - DB 가 아닌 네이버 SA 측 현재값을 진실로 비교 → 외부 변경(타 사용자/자동화/네이버측) 감지.
   *   - targetType 별 list API 1회로 전체 nccId 인덱싱 → 단건 N회 호출 회피.
   *     (Keyword/Ad/AdExtension 은 광고그룹 단위 list 라 광고그룹 K개면 K회.)
   *   - SA 호출 실패 시 보수적으로 drift=true 처리 (롤백 차단).
   *
   * 레거시 모드 (기본):
   *   - SA 호출 0회. DB 현재 컬럼 vs ChangeItem.after 만 비교.
   *   - 동기화(*.sync) 후 외부 변경은 감지 못 함.
   */
  saRecheck?: boolean
}

export type RollbackItemResult = {
  itemId: string
  targetType: string
  targetId: string | null
  ok: boolean
  reason?: "drift" | "unsupported_action" | "no_before" | "sa_failed"
  error?: string
}

export type RollbackResult = {
  newBatchId: string // 롤백을 표현하는 새 ChangeBatch
  total: number
  success: number
  failed: number
  drift: number // ignoreDrift=false 시 skip 된 drift 항목 수
  items: RollbackItemResult[]
}

// =============================================================================
// 상수: 액션 화이트리스트
// =============================================================================

/**
 * 롤백 지원 액션 (toggle/update 계열).
 *
 * 비지원:
 *   - 생성: keyword.create / keyword.csv / ad.create / adext.create
 *   - 삭제: keyword.delete / ad.delete / adext.delete
 *   - 동기화: *.sync (변경 자체가 아님)
 *   - 채널: adgroup.channel (SA 필드 미확정 — 원 액션도 의도된 실패 처리)
 *
 * 화이트리스트 외 액션 호출 시 throw.
 */
const ROLLBACK_SUPPORTED_ACTIONS = new Set<string>([
  "bid_inbox.apply",
  "keyword.toggle",
  "keyword.bid",
  "keyword.inline_update",
  "adgroup.toggle",
  "adgroup.bid",
  "adgroup.budget",
  "campaign.toggle",
  "campaign.budget",
  "ad.toggle",
  "adext.toggle",
])

/** 재시도 지원 액션 (실패 ChangeItem 재호출 가능). 롤백 화이트리스트와 동일. */
const RETRY_SUPPORTED_ACTIONS = ROLLBACK_SUPPORTED_ACTIONS

// =============================================================================
// Zod 스키마
// =============================================================================

const shortId = z.string().trim().min(1).max(128)
const isoString = z.string().trim().min(1).max(64)

const filterSchema = z.object({
  userId: shortId.optional(),
  action: z.string().trim().min(1).max(128).optional(),
  status: z.enum(["pending", "running", "done", "failed"]).optional(),
  fromTs: isoString.optional(),
  toTs: isoString.optional(),
  cursor: shortId.optional(),
  limit: z.number().int().optional(),
})

const rollbackOptionsSchema = z.object({
  ignoreDrift: z.boolean().optional(),
  saRecheck: z.boolean().optional(),
})

// =============================================================================
// 헬퍼
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
 * ChangeBatch.summary 에서 advertiserId 추출.
 *
 * 모든 변경 액션 (F-2.x / F-3.x / F-4.x / F-5.x)이 summary 에 advertiserId 를 적재하므로
 * 본 헬퍼는 그 키를 신뢰한다. 누락 시 throw — 본 PR 처리 불가.
 */
function extractAdvertiserId(summary: unknown): string {
  if (
    summary !== null &&
    typeof summary === "object" &&
    "advertiserId" in (summary as Record<string, unknown>)
  ) {
    const v = (summary as Record<string, unknown>).advertiserId
    if (typeof v === "string" && v.length > 0) return v
  }
  throw new Error("ChangeBatch.summary.advertiserId 누락 — 본 PR 처리 불가")
}

/**
 * 광고주 조회 + hasKeys 검증.
 *
 * SA 재호출 가능 상태인지 확인하고 customerId 반환.
 * 키 미입력(F-1.2 CSV 메타만 등록 후 시크릿 미입력) 광고주는 명시적 차단.
 */
async function loadAdvertiserOrThrow(advertiserId: string): Promise<{
  advertiserId: string
  customerId: string
}> {
  const adv = await prisma.advertiser.findUnique({
    where: { id: advertiserId },
    select: {
      id: true,
      customerId: true,
      status: true,
      apiKeyEnc: true,
      secretKeyEnc: true,
    },
  })
  if (!adv) {
    throw new Error("존재하지 않는 광고주입니다")
  }
  if (adv.status === "archived") {
    throw new Error("아카이브된 광고주입니다")
  }
  const hasKeys = adv.apiKeyEnc !== null && adv.secretKeyEnc !== null
  if (!hasKeys) {
    throw new Error("API 키/시크릿 미입력 — 재시도/롤백 불가")
  }
  return { advertiserId: adv.id, customerId: adv.customerId }
}

/**
 * 광고주 한정 revalidate path. UI 의 키워드/광고그룹/캠페인/소재/확장소재 페이지를 광범위 갱신.
 * 후속 PR 에서 targetType 별 정밀 갱신으로 좁힐 수 있음.
 */
function revalidateAdvertiserPaths(advertiserId: string): void {
  revalidatePath(`/${advertiserId}/keywords`)
  revalidatePath(`/${advertiserId}/adgroups`)
  revalidatePath(`/${advertiserId}/campaigns`)
  revalidatePath(`/${advertiserId}/ads`)
  revalidatePath(`/${advertiserId}/extensions`)
  revalidatePath("/admin/change-batches")
}

// =============================================================================
// 1. listChangeBatches
// =============================================================================

/**
 * admin: ChangeBatch 목록 (필터 + cursor pagination).
 *
 * 정렬: id desc (cuid 시간 단조 — createdAt 역순과 사실상 동일).
 * 페이징:
 *   take(limit+1) 로 초과분 1개 → hasMore=true 판정 후 잘라냄.
 *   nextCursor = items[last].id (다음 호출에서 cursor 로 전달).
 *
 * 실패 카운트:
 *   _count.items where status='failed' 가 Prisma 1쿼리로 안 나오므로,
 *   별도 groupBy 1쿼리 + 매핑. (전체 1+1 = 2 쿼리, 페이지 단위라 비용 작음.)
 */
export async function listChangeBatches(
  filter: ChangeBatchFilter,
): Promise<ChangeBatchPage> {
  await assertRole("admin")

  const parsed = filterSchema.safeParse(filter)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "유효하지 않은 입력")
  }
  const f = parsed.data
  const limit = clampLimit(f.limit)

  const where: Prisma.ChangeBatchWhereInput = {}

  if (f.userId) where.userId = f.userId
  if (f.action) where.action = f.action
  if (f.status) where.status = f.status

  const from = parseDate(f.fromTs)
  const to = parseDate(f.toTs)
  if (from || to) {
    where.createdAt = {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    }
  }

  if (f.cursor) {
    where.AND = [
      ...((where.AND as Prisma.ChangeBatchWhereInput[]) ?? []),
      { id: { lt: f.cursor } },
    ]
  }

  const rows = await prisma.changeBatch.findMany({
    where,
    orderBy: { id: "desc" },
    take: limit + 1,
    select: {
      id: true,
      userId: true,
      action: true,
      status: true,
      total: true,
      processed: true,
      attempt: true,
      summary: true,
      createdAt: true,
      finishedAt: true,
      user: { select: { displayName: true } },
    },
  })

  const hasMore = rows.length > limit
  const sliced = hasMore ? rows.slice(0, limit) : rows
  const nextCursor = hasMore ? sliced[sliced.length - 1]?.id ?? null : null

  // 실패 카운트 — 페이지 batch 들에 한해 별도 groupBy
  const batchIds = sliced.map((r) => r.id)
  const failedCounts = batchIds.length
    ? await prisma.changeItem.groupBy({
        by: ["batchId"],
        where: { batchId: { in: batchIds }, status: "failed" },
        _count: { _all: true },
      })
    : []
  const failedMap = new Map<string, number>(
    failedCounts.map((g) => [g.batchId, g._count._all]),
  )

  const items: ChangeBatchRow[] = sliced.map((r) => ({
    id: r.id,
    userId: r.userId,
    userDisplayName: r.user?.displayName ?? null,
    action: r.action,
    status: r.status,
    total: r.total,
    processed: r.processed,
    attempt: r.attempt,
    summary: r.summary ?? null,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    failedCount: failedMap.get(r.id) ?? 0,
  }))

  return { items, nextCursor, hasMore }
}

// =============================================================================
// 2. getChangeBatchDetail
// =============================================================================

/**
 * admin: ChangeBatch 단건 상세 + 전체 ChangeItem 목록.
 *
 * items 정렬: createdAt asc (적재 순서 = 사용자 의도 순서).
 * 미존재 → null.
 *
 * 직렬화 주의: before/after 는 Prisma JSON. 호출부(서버 컴포넌트)에서 그대로 client component 로
 * 전달 시 Date 등 비-JSON 값이 없으므로 안전. 시크릿은 적재 단계에서 처리됨 가정.
 */
export async function getChangeBatchDetail(
  batchId: string,
): Promise<ChangeBatchDetail | null> {
  await assertRole("admin")
  const id = shortId.parse(batchId)

  const row = await prisma.changeBatch.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      action: true,
      status: true,
      total: true,
      processed: true,
      attempt: true,
      summary: true,
      createdAt: true,
      finishedAt: true,
      user: { select: { displayName: true } },
      items: {
        select: {
          id: true,
          targetType: true,
          targetId: true,
          before: true,
          after: true,
          status: true,
          error: true,
          idempotencyKey: true,
          attempt: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
  })

  if (!row) return null

  const failedCount = row.items.filter((it) => it.status === "failed").length

  return {
    id: row.id,
    userId: row.userId,
    userDisplayName: row.user?.displayName ?? null,
    action: row.action,
    status: row.status,
    total: row.total,
    processed: row.processed,
    attempt: row.attempt,
    summary: row.summary ?? null,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    failedCount,
    items: row.items.map((it) => ({
      id: it.id,
      targetType: it.targetType,
      targetId: it.targetId,
      before: it.before ?? null,
      after: it.after ?? null,
      status: it.status,
      error: it.error,
      idempotencyKey: it.idempotencyKey,
      attempt: it.attempt,
    })),
  }
}

// =============================================================================
// 3. retryFailedItems
// =============================================================================

/**
 * 실패 ChangeItem 만 재시도 (F-6.3 부분 실패 재시도).
 *
 * 동작:
 *   1. assertRole("admin")
 *   2. ChangeBatch + items where status='failed' 조회
 *   3. ChangeBatch.action 이 RETRY_SUPPORTED_ACTIONS 화이트리스트에 있는지 확인
 *      - 비지원: error 메시지로 안내, 변경 없음
 *   4. summary.advertiserId → advertiser + hasKeys 검증
 *   5. targetType 별로 그룹화 후 SA 일괄 호출
 *      - Keyword:     updateKeywordsBulk(items, fields)
 *      - AdGroup:     updateAdgroupsBulk(items, fields)
 *      - Campaign:    updateCampaignsBulk(items, fields)
 *      - Ad:          updateAdsBulk(items, fields)
 *      - AdExtension: updateAdExtensionsBulk(items, fields)
 *   6. 응답 매핑 — 성공 row → ChangeItem.status='done' + attempt++
 *                  누락/실패 row → ChangeItem.status='failed' + error 갱신 + attempt++
 *   7. ChangeBatch.attempt++ 및 finalize 검토 (실패가 0 으로 떨어지면 전체 done)
 *   8. AuditLog action="batch.retry"
 *
 * 멱등성:
 *   - ChangeItem.idempotencyKey 는 적재 시 batchId+nccId 로 unique. 재시도가 새 row 만들지 않음.
 *   - SA 호출은 동일 patch 가 다시 가도 결과 동일 (네이버 SA PUT 은 idempotent).
 *
 * patch 추출 (after JSON 에서 SA 패치 필드 복원):
 *   - 각 액션별 after JSON 의 키 = SA fields 와 동일 (after 는 적재 시 SA 호출 payload 와 일치).
 */
export async function retryFailedItems(batchId: string): Promise<RetryResult> {
  const me = await assertRole("admin")
  const id = shortId.parse(batchId)

  const batch = await prisma.changeBatch.findUnique({
    where: { id },
    select: {
      id: true,
      action: true,
      status: true,
      total: true,
      summary: true,
      attempt: true,
    },
  })
  if (!batch) {
    return {
      ok: false,
      retried: 0,
      successAfterRetry: 0,
      stillFailed: 0,
      error: "존재하지 않는 ChangeBatch 입니다",
    }
  }

  if (!RETRY_SUPPORTED_ACTIONS.has(batch.action)) {
    return {
      ok: false,
      retried: 0,
      successAfterRetry: 0,
      stillFailed: 0,
      error: `재시도 비지원 액션: ${batch.action} (생성/삭제/동기화는 본 PR 비대상)`,
    }
  }

  let advertiserId: string
  try {
    advertiserId = extractAdvertiserId(batch.summary)
  } catch (e) {
    return {
      ok: false,
      retried: 0,
      successAfterRetry: 0,
      stillFailed: 0,
      error: e instanceof Error ? e.message : String(e),
    }
  }

  let advertiserMeta: { advertiserId: string; customerId: string }
  try {
    advertiserMeta = await loadAdvertiserOrThrow(advertiserId)
  } catch (e) {
    return {
      ok: false,
      retried: 0,
      successAfterRetry: 0,
      stillFailed: 0,
      error: e instanceof Error ? e.message : String(e),
    }
  }

  const failedItems = await prisma.changeItem.findMany({
    where: { batchId: id, status: "failed" },
    select: {
      id: true,
      targetType: true,
      targetId: true,
      before: true,
      after: true,
      attempt: true,
    },
  })

  if (failedItems.length === 0) {
    return {
      ok: true,
      retried: 0,
      successAfterRetry: 0,
      stillFailed: 0,
    }
  }

  // -- targetId 가 없는 행은 재시도 불가 (CREATE 사전 단계의 'pending:externalId' 등) ----
  const retriable = failedItems.filter((it) => typeof it.targetId === "string" && it.targetId.length > 0)
  const skippedNoTarget = failedItems.length - retriable.length

  // -- targetType 별 그룹화 ---------------------------------------------------
  const byType = new Map<string, typeof retriable>()
  for (const it of retriable) {
    const list = byType.get(it.targetType) ?? []
    list.push(it)
    byType.set(it.targetType, list)
  }

  let successAfterRetry = 0
  let stillFailed = skippedNoTarget

  // 사전 markup: skippedNoTarget 행은 attempt++ + 사유 기록 (계속 failed)
  if (skippedNoTarget > 0) {
    const skippedIds = failedItems
      .filter((it) => typeof it.targetId !== "string" || it.targetId.length === 0)
      .map((it) => it.id)
    await prisma.changeItem.updateMany({
      where: { id: { in: skippedIds } },
      data: {
        error: "재시도 불가 — targetId 없음 (CREATE 사전 단계)",
        attempt: { increment: 1 },
      },
    })
  }

  // -- 그룹별 SA 호출 ---------------------------------------------------------
  for (const [targetType, items] of byType.entries()) {
    try {
      const { successCount, failedCount } = await retryGroup(
        targetType,
        batch.action,
        items,
        advertiserMeta.customerId,
      )
      successAfterRetry += successCount
      stillFailed += failedCount
    } catch (e) {
      // 그룹 단위 실패 (네트워크/HMAC/검증 에러) — 그룹 전체 still failed
      const msg = e instanceof Error ? e.message : String(e)
      await prisma.changeItem.updateMany({
        where: { id: { in: items.map((it) => it.id) } },
        data: {
          error: `재시도 그룹 실패: ${msg}`.slice(0, 500),
          attempt: { increment: 1 },
        },
      })
      stillFailed += items.length
    }
  }

  // -- ChangeBatch finalize ---------------------------------------------------
  // 모든 실패가 done 으로 전환됐으면 batch.status='done' 으로 격상.
  const remainingFailed = await prisma.changeItem.count({
    where: { batchId: id, status: "failed" },
  })
  await prisma.changeBatch.update({
    where: { id },
    data: {
      attempt: { increment: 1 },
      status: remainingFailed === 0 ? "done" : "failed",
      processed: batch.total, // 재시도 후도 처리된 총 건수는 변하지 않음 (모두 시도됨).
      finishedAt: new Date(),
    },
  })

  await logAudit({
    userId: me.id,
    action: "batch.retry",
    targetType: "ChangeBatch",
    targetId: id,
    before: null,
    after: {
      batchId: id,
      advertiserId,
      retried: failedItems.length,
      successAfterRetry,
      stillFailed,
    },
  })

  revalidateAdvertiserPaths(advertiserId)
  revalidatePath(`/admin/change-batches/${id}`)

  return {
    ok: true,
    retried: failedItems.length,
    successAfterRetry,
    stillFailed,
  }
}

/**
 * targetType 별 SA 호출 (재시도 전용).
 *
 * after JSON 에서 패치 필드를 복원해 SA bulk PUT 으로 일괄 호출.
 * 응답 매핑:
 *   - 응답 set 에 포함된 nccId → ChangeItem.status='done', error=null, attempt++
 *   - 누락 → 'failed' + error="응답 누락" + attempt++
 *
 * 본 함수는 그룹 단위 SA 호출 한 번 (청크 분할은 호출부 책임 — 본 PR 은 재시도라 보통 작은 규모).
 */
async function retryGroup(
  targetType: string,
  action: string,
  items: Array<{
    id: string
    targetType: string
    targetId: string | null
    before: Prisma.JsonValue
    after: Prisma.JsonValue
    attempt: number
  }>,
  customerId: string,
): Promise<{ successCount: number; failedCount: number }> {
  if (items.length === 0) return { successCount: 0, failedCount: 0 }

  // -- after JSON → SA payload + fields 산출 ---------------------------------
  // after JSON 의 키 = 적재 시 SA 호출 payload 와 일치 (action 별 적재 코드 합의).
  const fieldUnion = new Set<string>()
  type Triple<T> = { item: (typeof items)[number]; sa: T }

  switch (targetType) {
    case "Keyword": {
      const list: Triple<KeywordBulkUpdateItem>[] = []
      for (const it of items) {
        const after = (it.after ?? {}) as Record<string, unknown>
        const sa: KeywordBulkUpdateItem = { nccKeywordId: it.targetId! }
        if ("bidAmt" in after) {
          sa.bidAmt = after.bidAmt as number | null | undefined
          fieldUnion.add("bidAmt")
        }
        if ("useGroupBidAmt" in after) {
          sa.useGroupBidAmt = after.useGroupBidAmt as boolean | undefined
          fieldUnion.add("useGroupBidAmt")
        }
        if ("userLock" in after) {
          sa.userLock = after.userLock as boolean | undefined
          fieldUnion.add("userLock")
        }
        list.push({ item: it, sa })
      }
      const fields = Array.from(fieldUnion).join(",")
      if (fields.length === 0) return failAllWith(items, "재시도 패치 필드 없음")

      const updated = await updateKeywordsBulk(
        customerId,
        list.map((t) => t.sa),
        fields,
      )
      const updatedIds = new Set(updated.map((u) => u.nccKeywordId))
      return await applyRetryResults(list, updatedIds, (sa) => sa.nccKeywordId)
    }
    case "AdGroup": {
      const list: Triple<AdgroupBulkUpdateItem>[] = []
      for (const it of items) {
        const after = (it.after ?? {}) as Record<string, unknown>
        const sa: AdgroupBulkUpdateItem = { nccAdgroupId: it.targetId! }
        if ("bidAmt" in after) {
          sa.bidAmt = after.bidAmt as number | null | undefined
          fieldUnion.add("bidAmt")
        }
        if ("dailyBudget" in after) {
          sa.dailyBudget = after.dailyBudget as number | null | undefined
          fieldUnion.add("dailyBudget")
          // budget 액션은 useDailyBudget 함께 전달 (campaigns/adgroups 적재 패턴).
          const useDaily =
            typeof after.dailyBudget === "number" && (after.dailyBudget as number) > 0
          sa.useDailyBudget = useDaily
          fieldUnion.add("useDailyBudget")
        }
        if ("userLock" in after) {
          sa.userLock = after.userLock as boolean | undefined
          fieldUnion.add("userLock")
        }
        list.push({ item: it, sa })
      }
      const fields = Array.from(fieldUnion).join(",")
      if (fields.length === 0) return failAllWith(items, "재시도 패치 필드 없음")

      const updated = await updateAdgroupsBulk(
        customerId,
        list.map((t) => t.sa),
        fields,
      )
      const updatedIds = new Set(updated.map((u) => u.nccAdgroupId))
      return await applyRetryResults(list, updatedIds, (sa) => sa.nccAdgroupId)
    }
    case "Campaign": {
      const list: Triple<CampaignBulkUpdateItem>[] = []
      for (const it of items) {
        const after = (it.after ?? {}) as Record<string, unknown>
        const sa: CampaignBulkUpdateItem = { nccCampaignId: it.targetId! }
        if ("dailyBudget" in after) {
          sa.dailyBudget = after.dailyBudget as number | null | undefined
          fieldUnion.add("dailyBudget")
        }
        if ("userLock" in after) {
          sa.userLock = after.userLock as boolean | undefined
          fieldUnion.add("userLock")
        }
        list.push({ item: it, sa })
      }
      const fields = Array.from(fieldUnion).join(",")
      if (fields.length === 0) return failAllWith(items, "재시도 패치 필드 없음")

      const updated = await updateCampaignsBulk(
        customerId,
        list.map((t) => t.sa),
        fields,
      )
      const updatedIds = new Set(updated.map((u) => u.nccCampaignId))
      return await applyRetryResults(list, updatedIds, (sa) => sa.nccCampaignId)
    }
    case "Ad": {
      const list: Triple<AdBulkUpdateItem>[] = []
      for (const it of items) {
        const after = (it.after ?? {}) as Record<string, unknown>
        const sa: AdBulkUpdateItem = { nccAdId: it.targetId! }
        if ("userLock" in after) {
          sa.userLock = after.userLock as boolean | undefined
          fieldUnion.add("userLock")
        }
        list.push({ item: it, sa })
      }
      const fields = Array.from(fieldUnion).join(",")
      if (fields.length === 0) return failAllWith(items, "재시도 패치 필드 없음")

      const updated = await updateAdsBulk(
        customerId,
        list.map((t) => t.sa),
        fields,
      )
      const updatedIds = new Set(updated.map((u) => u.nccAdId))
      return await applyRetryResults(list, updatedIds, (sa) => sa.nccAdId)
    }
    case "AdExtension": {
      const list: Triple<AdExtensionBulkUpdateItem>[] = []
      for (const it of items) {
        const after = (it.after ?? {}) as Record<string, unknown>
        const sa: AdExtensionBulkUpdateItem = { nccExtId: it.targetId! }
        if ("userLock" in after) {
          sa.userLock = after.userLock as boolean | undefined
          fieldUnion.add("userLock")
        }
        list.push({ item: it, sa })
      }
      const fields = Array.from(fieldUnion).join(",")
      if (fields.length === 0) return failAllWith(items, "재시도 패치 필드 없음")

      const updated = await updateAdExtensionsBulk(
        customerId,
        list.map((t) => t.sa),
        fields,
      )
      const updatedIds = new Set(updated.map((u) => u.nccExtId))
      return await applyRetryResults(list, updatedIds, (sa) => sa.nccExtId)
    }
    default:
      // 알 수 없는 targetType — action 화이트리스트 통과했으나 적재 측 매핑 누락 가능
      void action
      return failAllWith(items, `재시도 비지원 targetType: ${targetType}`)
  }
}

async function applyRetryResults<T>(
  list: Array<{
    item: {
      id: string
      targetType: string
      targetId: string | null
      attempt: number
    }
    sa: T
  }>,
  updatedIds: Set<string>,
  saIdFn: (sa: T) => string,
): Promise<{ successCount: number; failedCount: number }> {
  let successCount = 0
  let failedCount = 0
  // 개별 update — 일괄 update 는 Prisma 가 set 별 분기를 못함.
  for (const t of list) {
    const ok = updatedIds.has(saIdFn(t.sa))
    if (ok) {
      await prisma.changeItem.update({
        where: { id: t.item.id },
        data: {
          status: "done",
          error: null,
          attempt: { increment: 1 },
        },
      })
      successCount++
    } else {
      await prisma.changeItem.update({
        where: { id: t.item.id },
        data: {
          error: "재시도 응답 누락",
          attempt: { increment: 1 },
        },
      })
      failedCount++
    }
  }
  return { successCount, failedCount }
}

async function failAllWith(
  items: Array<{ id: string }>,
  msg: string,
): Promise<{ successCount: number; failedCount: number }> {
  await prisma.changeItem.updateMany({
    where: { id: { in: items.map((it) => it.id) } },
    data: { error: msg.slice(0, 500), attempt: { increment: 1 } },
  })
  return { successCount: 0, failedCount: items.length }
}

// =============================================================================
// 4. rollbackChangeBatch
// =============================================================================

/**
 * 변경 일괄 롤백 (F-6.4).
 *
 * 동작:
 *   1. assertRole("admin")
 *   2. 원 ChangeBatch 조회 + items where status='done' (failed 항목은 변경 적용 안 됐으므로 롤백 불요)
 *   3. ROLLBACK_SUPPORTED_ACTIONS 화이트리스트 검증 — 비지원이면 throw
 *   4. summary.advertiserId → advertiser + hasKeys 검증
 *   5. drift 감지 (옵션):
 *      - saRecheck=false (기본): DB 현재값 vs ChangeItem.after 비교 (레거시 — SA 호출 0회)
 *      - saRecheck=true: SA 재조회로 외부 변경 감지 (광고그룹별 list API K회 + 광고주별 1회)
 *      - 일치하면 drift 없음 → 롤백 적용
 *      - 불일치 시 drift — ignoreDrift=false 면 skip + reason="drift"
 *   6. 새 ChangeBatch 생성 (action="rollback:${원action}", attempt=1, summary={advertiserId, originalBatchId})
 *      ChangeItem 적재 — before/after 뒤바꿔서 (롤백 적용값 = 원 before)
 *   7. targetType 별 SA 호출 (before 값으로 PUT)
 *   8. 응답 매핑 + DB 업데이트
 *   9. ChangeBatch finalize
 *  10. AuditLog action="batch.rollback"
 *
 * drift 감지 모드:
 *   - 레거시 (saRecheck=false, 기본): DB 비교만. 동기화 직후 상태 가정. SA 외부 변경 감지 X.
 *   - 정밀 (saRecheck=true, F-6.4): SA 재조회로 비교. 외부 변경(타 사용자/자동화/네이버측) 감지.
 *     비용: 광고그룹 K개면 K회 + 광고주 단위 1~2회 (list API).
 */
export async function rollbackChangeBatch(
  batchId: string,
  options?: RollbackOptions,
): Promise<RollbackResult> {
  const me = await assertRole("admin")
  const id = shortId.parse(batchId)
  const opts = rollbackOptionsSchema.parse(options ?? {})
  const ignoreDrift = opts.ignoreDrift === true
  const saRecheck = opts.saRecheck === true

  // -- 1. 원 batch 조회 -------------------------------------------------------
  const batch = await prisma.changeBatch.findUnique({
    where: { id },
    select: {
      id: true,
      action: true,
      summary: true,
      items: {
        where: { status: "done" },
        select: {
          id: true,
          targetType: true,
          targetId: true,
          before: true,
          after: true,
        },
      },
    },
  })
  if (!batch) {
    throw new Error("존재하지 않는 ChangeBatch 입니다")
  }

  // -- 2. 화이트리스트 검증 ---------------------------------------------------
  if (!ROLLBACK_SUPPORTED_ACTIONS.has(batch.action)) {
    throw new Error(
      `롤백 비지원 액션: ${batch.action} (생성/삭제/동기화는 본 PR 비대상)`,
    )
  }

  const advertiserId = extractAdvertiserId(batch.summary)
  const advertiserMeta = await loadAdvertiserOrThrow(advertiserId)

  // -- 3. drift 감지 ---------------------------------------------------------
  // saRecheck=true → SA 재조회 (외부 변경 감지). false(기본) → DB 비교 (레거시).
  // 둘 다 targetType 별 list API 1회로 인덱싱 (단건 N회 호출 회피).
  const driftMap = saRecheck
    ? await detectDriftSA(batch.items, advertiserMeta.customerId)
    : await detectDrift(batch.items)

  // -- 4. before 가 비어있는 항목은 롤백 대상 외 (적재 시 실수) ---------------
  type Prepared = {
    itemId: string
    targetType: string
    targetId: string
    before: Record<string, unknown>
    after: Record<string, unknown>
    drift: boolean
  }
  const prepared: Prepared[] = []
  const earlyResults: RollbackItemResult[] = []

  for (const it of batch.items) {
    if (typeof it.targetId !== "string" || it.targetId.length === 0) {
      // 정상 done 항목인데 targetId 가 없으면 적재 단계 버그 — 안전망으로 skip.
      earlyResults.push({
        itemId: it.id,
        targetType: it.targetType,
        targetId: it.targetId,
        ok: false,
        reason: "no_before",
        error: "targetId 없음",
      })
      continue
    }
    const before = (it.before ?? {}) as Record<string, unknown>
    const after = (it.after ?? {}) as Record<string, unknown>
    if (Object.keys(before).length === 0) {
      earlyResults.push({
        itemId: it.id,
        targetType: it.targetType,
        targetId: it.targetId,
        ok: false,
        reason: "no_before",
        error: "before 비어있음 — 롤백 불가",
      })
      continue
    }
    const drift = driftMap.get(it.id) === true
    prepared.push({
      itemId: it.id,
      targetType: it.targetType,
      targetId: it.targetId,
      before,
      after,
      drift,
    })
  }

  // ignoreDrift=false 면 drift 항목 skip
  const driftSkipped: RollbackItemResult[] = []
  const willApply: Prepared[] = []
  for (const p of prepared) {
    if (p.drift && !ignoreDrift) {
      driftSkipped.push({
        itemId: p.itemId,
        targetType: p.targetType,
        targetId: p.targetId,
        ok: false,
        reason: "drift",
        error: "DB 현재값이 적재된 after 와 다름 — drift 감지 (ignoreDrift=true 로 강제 가능)",
      })
    } else {
      willApply.push(p)
    }
  }

  // -- 5. 새 ChangeBatch 생성 (롤백 표현) -------------------------------------
  const rollbackAction = `rollback:${batch.action}`
  const total = willApply.length

  const newBatch = await prisma.changeBatch.create({
    data: {
      userId: me.id,
      action: rollbackAction,
      status: total === 0 ? "done" : "running",
      total,
      processed: 0,
      attempt: 1,
      summary: {
        advertiserId,
        originalBatchId: id,
        originalAction: batch.action,
        ignoreDrift,
        saRecheck,
        // 디버깅 메타: 사전 skip 건수
        preSkipped: earlyResults.length,
        driftSkipped: driftSkipped.length,
      },
    },
  })

  // willApply 가 0 이면 즉시 종료 (총합 계산 후 audit)
  if (total === 0) {
    await prisma.changeBatch.update({
      where: { id: newBatch.id },
      data: { finishedAt: new Date() },
    })
    await logAudit({
      userId: me.id,
      action: "batch.rollback",
      targetType: "ChangeBatch",
      targetId: id,
      before: null,
      after: {
        newBatchId: newBatch.id,
        advertiserId,
        originalBatchId: id,
        originalAction: batch.action,
        total: 0,
        success: 0,
        failed: 0,
        drift: driftSkipped.length,
      },
    })
    revalidateAdvertiserPaths(advertiserId)
    revalidatePath(`/admin/change-batches/${id}`)
    return {
      newBatchId: newBatch.id,
      total: 0,
      success: 0,
      failed: earlyResults.length,
      drift: driftSkipped.length,
      items: [...earlyResults, ...driftSkipped],
    }
  }

  // -- 6. ChangeItem 적재 — before/after 뒤바꿔서 -----------------------------
  // 롤백의 "이전(현재)" = 원 after, "이후(목표)" = 원 before.
  const seedData: Prisma.ChangeItemCreateManyInput[] = willApply.map((p) => ({
    batchId: newBatch.id,
    targetType: p.targetType,
    targetId: p.targetId,
    before: p.after as Prisma.InputJsonValue,
    after: p.before as Prisma.InputJsonValue,
    idempotencyKey: `${newBatch.id}:${p.targetId}`,
    status: "pending",
  }))
  await prisma.changeItem.createMany({ data: seedData })

  // 새 batch 의 items 와 itemId 매핑 (DB 가 새 ChangeItem.id 발급)
  const newItems = await prisma.changeItem.findMany({
    where: { batchId: newBatch.id },
    select: { id: true, targetType: true, targetId: true },
  })
  const newItemIdByTarget = new Map<string, string>(
    newItems.map((n) => [`${n.targetType}:${n.targetId}`, n.id]),
  )

  // -- 7. targetType 별 SA 호출 (before 값으로 PUT) ---------------------------
  const items: RollbackItemResult[] = [...earlyResults, ...driftSkipped]

  // targetType 별 그룹화
  const byType = new Map<string, Prepared[]>()
  for (const p of willApply) {
    const list = byType.get(p.targetType) ?? []
    list.push(p)
    byType.set(p.targetType, list)
  }

  let success = 0
  let failed = earlyResults.length // pre-skip 도 failed 로 카운트 (drift 는 별도)

  for (const [targetType, group] of byType.entries()) {
    try {
      const groupResult = await rollbackGroup(
        targetType,
        group,
        advertiserMeta.customerId,
        newBatch.id,
        newItemIdByTarget,
      )
      success += groupResult.success
      failed += groupResult.failed
      items.push(...groupResult.items)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 그룹 단위 SA 실패 — 전체 failed 처리
      const ids: string[] = []
      for (const p of group) {
        const newId = newItemIdByTarget.get(`${p.targetType}:${p.targetId}`)
        if (newId) ids.push(newId)
        items.push({
          itemId: newId ?? p.itemId,
          targetType: p.targetType,
          targetId: p.targetId,
          ok: false,
          reason: "sa_failed",
          error: msg,
        })
        failed++
      }
      if (ids.length > 0) {
        await prisma.changeItem.updateMany({
          where: { id: { in: ids } },
          data: { status: "failed", error: msg.slice(0, 500) },
        })
      }
    }
  }

  // -- 8. ChangeBatch finalize -----------------------------------------------
  const finalStatus: ChangeBatchStatus = failed === 0 && success > 0 ? "done" : success === 0 ? "failed" : "done"
  await prisma.changeBatch.update({
    where: { id: newBatch.id },
    data: {
      status: finalStatus,
      processed: total,
      finishedAt: new Date(),
    },
  })

  // -- 9. AuditLog -----------------------------------------------------------
  await logAudit({
    userId: me.id,
    action: "batch.rollback",
    targetType: "ChangeBatch",
    targetId: id,
    before: null,
    after: {
      newBatchId: newBatch.id,
      advertiserId,
      originalBatchId: id,
      originalAction: batch.action,
      total,
      success,
      failed,
      drift: driftSkipped.length,
      ignoreDrift,
      saRecheck,
    },
  })

  revalidateAdvertiserPaths(advertiserId)
  revalidatePath(`/admin/change-batches/${id}`)
  revalidatePath(`/admin/change-batches/${newBatch.id}`)

  return {
    newBatchId: newBatch.id,
    total,
    success,
    failed,
    drift: driftSkipped.length,
    items,
  }
}

/**
 * drift 감지 — DB 현재값 vs ChangeItem.after.
 *
 * 본 PR 단순화: SA 재조회 X, DB row 의 컬럼만 검사.
 * targetType 별로 DB 일괄 조회 후 ChangeItem.after JSON 의 키별로 비교.
 *
 * 비교 규칙:
 *   - userLock: DB.status === "off" 이면 userLock=true, "on" 이면 false 로 환산 후 비교
 *   - bidAmt:   DB.bidAmt (Decimal/Int) → number | null 환산 후 비교
 *   - dailyBudget: DB.dailyBudget (Decimal) → number | null 환산 후 비교
 *   - useGroupBidAmt: DB.useGroupBidAmt (boolean) 직접 비교
 *
 * 미지원 키나 미존재 행은 drift=false 처리 (안전한 기본값 — 롤백 시도 허용).
 *
 * 반환: itemId → drift 여부 boolean
 */
async function detectDrift(
  items: Array<{
    id: string
    targetType: string
    targetId: string | null
    after: Prisma.JsonValue
  }>,
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>()

  // targetType 별로 grouping
  const keywordIds: string[] = []
  const adgroupIds: string[] = []
  const campaignIds: string[] = []
  const adIds: string[] = []
  const extIds: string[] = []
  for (const it of items) {
    if (typeof it.targetId !== "string" || it.targetId.length === 0) continue
    switch (it.targetType) {
      case "Keyword":
        keywordIds.push(it.targetId)
        break
      case "AdGroup":
        adgroupIds.push(it.targetId)
        break
      case "Campaign":
        campaignIds.push(it.targetId)
        break
      case "Ad":
        adIds.push(it.targetId)
        break
      case "AdExtension":
        extIds.push(it.targetId)
        break
    }
  }

  const [kRows, gRows, cRows, aRows, eRows] = await Promise.all([
    keywordIds.length
      ? prisma.keyword.findMany({
          where: { nccKeywordId: { in: keywordIds } },
          select: {
            nccKeywordId: true,
            bidAmt: true,
            useGroupBidAmt: true,
            status: true,
          },
        })
      : Promise.resolve([]),
    adgroupIds.length
      ? prisma.adGroup.findMany({
          where: { nccAdgroupId: { in: adgroupIds } },
          select: {
            nccAdgroupId: true,
            bidAmt: true,
            dailyBudget: true,
            status: true,
          },
        })
      : Promise.resolve([]),
    campaignIds.length
      ? prisma.campaign.findMany({
          where: { nccCampaignId: { in: campaignIds } },
          select: {
            nccCampaignId: true,
            dailyBudget: true,
            status: true,
          },
        })
      : Promise.resolve([]),
    adIds.length
      ? prisma.ad.findMany({
          where: { nccAdId: { in: adIds } },
          select: { nccAdId: true, status: true },
        })
      : Promise.resolve([]),
    extIds.length
      ? prisma.adExtension.findMany({
          where: { nccExtId: { in: extIds } },
          select: { nccExtId: true, status: true },
        })
      : Promise.resolve([]),
  ])

  const kMap = new Map(kRows.map((r) => [r.nccKeywordId, r]))
  const gMap = new Map(gRows.map((r) => [r.nccAdgroupId, r]))
  const cMap = new Map(cRows.map((r) => [r.nccCampaignId, r]))
  const aMap = new Map(aRows.map((r) => [r.nccAdId, r]))
  const eMap = new Map(eRows.map((r) => [r.nccExtId, r]))

  for (const it of items) {
    if (typeof it.targetId !== "string" || it.targetId.length === 0) {
      result.set(it.id, false)
      continue
    }
    const after = (it.after ?? {}) as Record<string, unknown>

    let drift = false
    switch (it.targetType) {
      case "Keyword": {
        const db = kMap.get(it.targetId)
        if (!db) {
          result.set(it.id, false) // 미존재 — 롤백 시도 허용 (적재 단계에서 잡힘)
          continue
        }
        if ("userLock" in after) {
          const dbUserLock = db.status === "off"
          if (dbUserLock !== Boolean(after.userLock)) drift = true
        }
        if (!drift && "bidAmt" in after) {
          const dbBid = db.bidAmt === null ? null : Number(db.bidAmt)
          if (dbBid !== (after.bidAmt as number | null)) drift = true
        }
        if (!drift && "useGroupBidAmt" in after) {
          if (db.useGroupBidAmt !== Boolean(after.useGroupBidAmt)) drift = true
        }
        break
      }
      case "AdGroup": {
        const db = gMap.get(it.targetId)
        if (!db) {
          result.set(it.id, false)
          continue
        }
        if ("userLock" in after) {
          const dbUserLock = db.status === "off"
          if (dbUserLock !== Boolean(after.userLock)) drift = true
        }
        if (!drift && "bidAmt" in after) {
          const dbBid = db.bidAmt === null ? null : Number(db.bidAmt)
          if (dbBid !== (after.bidAmt as number | null)) drift = true
        }
        if (!drift && "dailyBudget" in after) {
          const dbBudget = db.dailyBudget === null ? null : Number(db.dailyBudget)
          if (dbBudget !== (after.dailyBudget as number | null)) drift = true
        }
        break
      }
      case "Campaign": {
        const db = cMap.get(it.targetId)
        if (!db) {
          result.set(it.id, false)
          continue
        }
        if ("userLock" in after) {
          const dbUserLock = db.status === "off"
          if (dbUserLock !== Boolean(after.userLock)) drift = true
        }
        if (!drift && "dailyBudget" in after) {
          const dbBudget = db.dailyBudget === null ? null : Number(db.dailyBudget)
          if (dbBudget !== (after.dailyBudget as number | null)) drift = true
        }
        break
      }
      case "Ad": {
        const db = aMap.get(it.targetId)
        if (!db) {
          result.set(it.id, false)
          continue
        }
        if ("userLock" in after) {
          const dbUserLock = db.status === "off"
          if (dbUserLock !== Boolean(after.userLock)) drift = true
        }
        break
      }
      case "AdExtension": {
        const db = eMap.get(it.targetId)
        if (!db) {
          result.set(it.id, false)
          continue
        }
        if ("userLock" in after) {
          const dbUserLock = db.status === "off"
          if (dbUserLock !== Boolean(after.userLock)) drift = true
        }
        break
      }
    }
    result.set(it.id, drift)
  }

  return result
}

/**
 * drift 감지 (정밀 — F-6.4 SA 재조회).
 *
 * DB 가 아닌 **네이버 SA 측 현재값**을 진실로 비교 → 외부 변경(타 사용자/자동화/네이버측) 감지.
 *
 * 호출 비용:
 *   - Keyword/Ad/AdExtension: DB 에서 부모 nccAdgroupId 룩업 → 광고그룹별 list API 호출.
 *     광고그룹 K개면 K회 호출 (단건 N회 호출 회피).
 *   - AdGroup: listAdgroups(customerId) 1회.
 *   - Campaign: listCampaigns(customerId) 1회.
 *   - 토큰 버킷이 자동 throttle. 큰 batch 라도 광고그룹 수만 늘어남.
 *
 * SA 호출 실패 처리 (보수):
 *   - 그룹 list 실패 → 해당 그룹 모든 item drift=true (롤백 차단)
 *   - 응답에 nccId 누락 → 해당 item drift=true (네이버 측 삭제 가능성)
 *
 * 비교 규칙 (after JSON 키 vs SA 응답값):
 *   - userLock: SA.userLock (boolean) 직접 비교. SA 미정의 시 false 가정.
 *   - bidAmt: SA.bidAmt (number|null) 직접 비교.
 *   - useGroupBidAmt: SA.useGroupBidAmt (boolean) 직접 비교.
 *   - dailyBudget: SA.dailyBudget (number|null) 직접 비교.
 *   - 미지원 키는 비교 skip (drift 에 영향 없음).
 *
 * 반환: itemId → drift 여부 boolean
 */
async function detectDriftSA(
  items: Array<{
    id: string
    targetType: string
    targetId: string | null
    after: Prisma.JsonValue
  }>,
  customerId: string,
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>()

  // -- 1. targetType 별로 grouping ---------------------------------------------
  const keywordItems: Array<{ id: string; targetId: string; after: Record<string, unknown> }> = []
  const adgroupItems: Array<{ id: string; targetId: string; after: Record<string, unknown> }> = []
  const campaignItems: Array<{ id: string; targetId: string; after: Record<string, unknown> }> = []
  const adItems: Array<{ id: string; targetId: string; after: Record<string, unknown> }> = []
  const extItems: Array<{ id: string; targetId: string; after: Record<string, unknown> }> = []

  for (const it of items) {
    if (typeof it.targetId !== "string" || it.targetId.length === 0) {
      result.set(it.id, false) // targetId 없음 — 비교 불가, 롤백 시도 허용
      continue
    }
    const after = (it.after ?? {}) as Record<string, unknown>
    switch (it.targetType) {
      case "Keyword":
        keywordItems.push({ id: it.id, targetId: it.targetId, after })
        break
      case "AdGroup":
        adgroupItems.push({ id: it.id, targetId: it.targetId, after })
        break
      case "Campaign":
        campaignItems.push({ id: it.id, targetId: it.targetId, after })
        break
      case "Ad":
        adItems.push({ id: it.id, targetId: it.targetId, after })
        break
      case "AdExtension":
        extItems.push({ id: it.id, targetId: it.targetId, after })
        break
      default:
        result.set(it.id, false) // 알 수 없는 targetType — 롤백 시도 허용
    }
  }

  // -- 2. Keyword/Ad/AdExtension: DB 에서 nccAdgroupId 매핑 ---------------------
  // Keyword/Ad: nccKeywordId/nccAdId 로 조회 → adgroup.nccAdgroupId
  // AdExtension: nccExtId 로 조회 → adgroup.nccAdgroupId (ownerType="adgroup" 가정)
  const kAdgroupMap = await mapToAdgroupId(
    "Keyword",
    keywordItems.map((it) => it.targetId),
  )
  const aAdgroupMap = await mapToAdgroupId(
    "Ad",
    adItems.map((it) => it.targetId),
  )
  const eAdgroupMap = await mapToAdgroupId(
    "AdExtension",
    extItems.map((it) => it.targetId),
  )

  // -- 3. SA list API 호출 (광고그룹별 / 광고주 단위) ---------------------------
  // 호출 실패 시 conservativeDriftIds 에 해당 item id 추가 (drift=true 처리).
  const conservativeDriftIds = new Set<string>()

  // 3-1. Keyword: 광고그룹별 listKeywords
  const kSaMap = new Map<string, Keyword>()
  if (keywordItems.length > 0) {
    const adgroupGroups = groupBy(keywordItems, (it) => kAdgroupMap.get(it.targetId) ?? "")
    for (const [nccAdgroupId, group] of adgroupGroups) {
      if (!nccAdgroupId) {
        // DB 매핑 실패 — 해당 키워드는 보수적으로 drift 처리
        for (const it of group) conservativeDriftIds.add(it.id)
        continue
      }
      try {
        const remote = await listKeywords(customerId, { nccAdgroupId })
        for (const k of remote) kSaMap.set(k.nccKeywordId, k)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.warn(
          `[detectDriftSA] listKeywords failed nccAdgroupId=${nccAdgroupId}: ${msg}`,
        )
        for (const it of group) conservativeDriftIds.add(it.id)
      }
    }
  }

  // 3-2. Ad: 광고그룹별 listAds
  const aSaMap = new Map<string, Ad>()
  if (adItems.length > 0) {
    const adgroupGroups = groupBy(adItems, (it) => aAdgroupMap.get(it.targetId) ?? "")
    for (const [nccAdgroupId, group] of adgroupGroups) {
      if (!nccAdgroupId) {
        for (const it of group) conservativeDriftIds.add(it.id)
        continue
      }
      try {
        const remote = await listAds(customerId, { nccAdgroupId })
        for (const a of remote) aSaMap.set(a.nccAdId, a)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.warn(
          `[detectDriftSA] listAds failed nccAdgroupId=${nccAdgroupId}: ${msg}`,
        )
        for (const it of group) conservativeDriftIds.add(it.id)
      }
    }
  }

  // 3-3. AdExtension: 광고그룹별 listAdExtensions (type 필터 없음 — 전체 가져와 nccExtId 매칭)
  const eSaMap = new Map<string, AdExtension>()
  if (extItems.length > 0) {
    const adgroupGroups = groupBy(extItems, (it) => eAdgroupMap.get(it.targetId) ?? "")
    for (const [nccAdgroupId, group] of adgroupGroups) {
      if (!nccAdgroupId) {
        for (const it of group) conservativeDriftIds.add(it.id)
        continue
      }
      try {
        const remote = await listAdExtensions(customerId, { nccAdgroupId })
        for (const ext of remote) eSaMap.set(ext.nccExtId, ext)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.warn(
          `[detectDriftSA] listAdExtensions failed nccAdgroupId=${nccAdgroupId}: ${msg}`,
        )
        for (const it of group) conservativeDriftIds.add(it.id)
      }
    }
  }

  // 3-4. AdGroup: listAdgroups 1회
  const gSaMap = new Map<string, AdGroup>()
  if (adgroupItems.length > 0) {
    try {
      const remote = await listAdgroups(customerId)
      for (const g of remote) gSaMap.set(g.nccAdgroupId, g)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[detectDriftSA] listAdgroups failed: ${msg}`)
      for (const it of adgroupItems) conservativeDriftIds.add(it.id)
    }
  }

  // 3-5. Campaign: listCampaigns 1회
  const cSaMap = new Map<string, Campaign>()
  if (campaignItems.length > 0) {
    try {
      const remote = await listCampaigns(customerId)
      for (const c of remote) cSaMap.set(c.nccCampaignId, c)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[detectDriftSA] listCampaigns failed: ${msg}`)
      for (const it of campaignItems) conservativeDriftIds.add(it.id)
    }
  }

  // -- 4. 비교 — after JSON 키별로 SA 응답값과 비교 ----------------------------
  // saMissing → drift=true (네이버 측 삭제 가능성). conservativeDriftIds 도 동일 처리.

  // Keyword
  for (const it of keywordItems) {
    if (conservativeDriftIds.has(it.id)) {
      result.set(it.id, true)
      continue
    }
    const sa = kSaMap.get(it.targetId)
    if (!sa) {
      result.set(it.id, true) // SA 응답 누락 — 외부 삭제 가능성, 보수적 drift
      continue
    }
    let drift = false
    const after = it.after
    if ("userLock" in after) {
      const saLock = sa.userLock ?? false
      if (saLock !== Boolean(after.userLock)) drift = true
    }
    if (!drift && "bidAmt" in after) {
      const saBid = sa.bidAmt === undefined || sa.bidAmt === null ? null : Number(sa.bidAmt)
      const afterBid = after.bidAmt === null || after.bidAmt === undefined ? null : Number(after.bidAmt)
      if (saBid !== afterBid) drift = true
    }
    if (!drift && "useGroupBidAmt" in after) {
      const saUseGroup = sa.useGroupBidAmt ?? false
      if (saUseGroup !== Boolean(after.useGroupBidAmt)) drift = true
    }
    result.set(it.id, drift)
  }

  // AdGroup
  for (const it of adgroupItems) {
    if (conservativeDriftIds.has(it.id)) {
      result.set(it.id, true)
      continue
    }
    const sa = gSaMap.get(it.targetId)
    if (!sa) {
      result.set(it.id, true)
      continue
    }
    let drift = false
    const after = it.after
    if ("userLock" in after) {
      const saLock = sa.userLock ?? false
      if (saLock !== Boolean(after.userLock)) drift = true
    }
    if (!drift && "bidAmt" in after) {
      const saBid = sa.bidAmt === undefined || sa.bidAmt === null ? null : Number(sa.bidAmt)
      const afterBid = after.bidAmt === null || after.bidAmt === undefined ? null : Number(after.bidAmt)
      if (saBid !== afterBid) drift = true
    }
    if (!drift && "dailyBudget" in after) {
      const saBudget = sa.dailyBudget === undefined || sa.dailyBudget === null ? null : Number(sa.dailyBudget)
      const afterBudget = after.dailyBudget === null || after.dailyBudget === undefined ? null : Number(after.dailyBudget)
      if (saBudget !== afterBudget) drift = true
    }
    result.set(it.id, drift)
  }

  // Campaign
  for (const it of campaignItems) {
    if (conservativeDriftIds.has(it.id)) {
      result.set(it.id, true)
      continue
    }
    const sa = cSaMap.get(it.targetId)
    if (!sa) {
      result.set(it.id, true)
      continue
    }
    let drift = false
    const after = it.after
    if ("userLock" in after) {
      const saLock = sa.userLock ?? false
      if (saLock !== Boolean(after.userLock)) drift = true
    }
    if (!drift && "dailyBudget" in after) {
      const saBudget = sa.dailyBudget === undefined || sa.dailyBudget === null ? null : Number(sa.dailyBudget)
      const afterBudget = after.dailyBudget === null || after.dailyBudget === undefined ? null : Number(after.dailyBudget)
      if (saBudget !== afterBudget) drift = true
    }
    result.set(it.id, drift)
  }

  // Ad
  for (const it of adItems) {
    if (conservativeDriftIds.has(it.id)) {
      result.set(it.id, true)
      continue
    }
    const sa = aSaMap.get(it.targetId)
    if (!sa) {
      result.set(it.id, true)
      continue
    }
    let drift = false
    const after = it.after
    if ("userLock" in after) {
      const saLock = sa.userLock ?? false
      if (saLock !== Boolean(after.userLock)) drift = true
    }
    result.set(it.id, drift)
  }

  // AdExtension
  for (const it of extItems) {
    if (conservativeDriftIds.has(it.id)) {
      result.set(it.id, true)
      continue
    }
    const sa = eSaMap.get(it.targetId)
    if (!sa) {
      result.set(it.id, true)
      continue
    }
    let drift = false
    const after = it.after
    if ("userLock" in after) {
      const saLock = sa.userLock ?? false
      if (saLock !== Boolean(after.userLock)) drift = true
    }
    result.set(it.id, drift)
  }

  return result
}

/**
 * targetType 별로 ncc{Type}Id → 부모 nccAdgroupId 매핑.
 *
 * SA list API 가 광고그룹 단위라 광고그룹 ID 가 필요. ChangeItem.after JSON 에는 보통
 * 부모 nccAdgroupId 가 없으므로 DB 에서 join 으로 가져온다.
 *
 * AdExtension: ownerType="adgroup" 가정 (P1 SPEC). campaign 단위 확장소재는 매핑 실패 → 보수 drift.
 */
async function mapToAdgroupId(
  targetType: "Keyword" | "Ad" | "AdExtension",
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const out = new Map<string, string>()
  if (targetType === "Keyword") {
    const rows = await prisma.keyword.findMany({
      where: { nccKeywordId: { in: ids } },
      select: { nccKeywordId: true, adgroup: { select: { nccAdgroupId: true } } },
    })
    for (const r of rows) {
      if (r.adgroup?.nccAdgroupId) out.set(r.nccKeywordId, r.adgroup.nccAdgroupId)
    }
  } else if (targetType === "Ad") {
    const rows = await prisma.ad.findMany({
      where: { nccAdId: { in: ids } },
      select: { nccAdId: true, adgroup: { select: { nccAdgroupId: true } } },
    })
    for (const r of rows) {
      if (r.adgroup?.nccAdgroupId) out.set(r.nccAdId, r.adgroup.nccAdgroupId)
    }
  } else {
    // AdExtension — ownerType="adgroup" 만 매핑 (campaign 은 P1 비대상)
    const rows = await prisma.adExtension.findMany({
      where: { nccExtId: { in: ids }, ownerType: "adgroup" },
      select: { nccExtId: true, adgroup: { select: { nccAdgroupId: true } } },
    })
    for (const r of rows) {
      if (r.adgroup?.nccAdgroupId) out.set(r.nccExtId, r.adgroup.nccAdgroupId)
    }
  }
  return out
}

/** 작은 그룹화 헬퍼 — Map<key, items[]>. */
function groupBy<T>(items: T[], keyFn: (it: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const it of items) {
    const k = keyFn(it)
    const list = out.get(k) ?? []
    list.push(it)
    out.set(k, list)
  }
  return out
}

/**
 * 롤백: targetType 그룹 단위 SA 호출.
 *
 * before(원 ChangeItem.before) 값으로 SA bulk PUT.
 * 새 ChangeItem (롤백 batch 의 item) 의 status 를 결과대로 갱신.
 */
async function rollbackGroup(
  targetType: string,
  group: Array<{
    itemId: string
    targetType: string
    targetId: string
    before: Record<string, unknown>
    after: Record<string, unknown>
    drift: boolean
  }>,
  customerId: string,
  newBatchId: string,
  newItemIdByTarget: Map<string, string>,
): Promise<{ success: number; failed: number; items: RollbackItemResult[] }> {
  if (group.length === 0) {
    return { success: 0, failed: 0, items: [] }
  }

  const results: RollbackItemResult[] = []
  const fieldUnion = new Set<string>()

  switch (targetType) {
    case "Keyword": {
      const saItems: KeywordBulkUpdateItem[] = []
      for (const p of group) {
        const sa: KeywordBulkUpdateItem = { nccKeywordId: p.targetId }
        // before 의 키만 패치 (롤백 적용 필드).
        if ("bidAmt" in p.before) {
          sa.bidAmt = p.before.bidAmt as number | null | undefined
          fieldUnion.add("bidAmt")
        }
        if ("useGroupBidAmt" in p.before) {
          sa.useGroupBidAmt = p.before.useGroupBidAmt as boolean | undefined
          fieldUnion.add("useGroupBidAmt")
        }
        if ("userLock" in p.before) {
          sa.userLock = p.before.userLock as boolean | undefined
          fieldUnion.add("userLock")
        }
        saItems.push(sa)
      }
      const fields = Array.from(fieldUnion).join(",")
      if (fields.length === 0) {
        return await failGroup(group, newItemIdByTarget, "롤백 패치 필드 없음")
      }
      const updated = await updateKeywordsBulk(customerId, saItems, fields)
      const updatedIds = new Set(updated.map((u) => u.nccKeywordId))
      return await applyRollback(group, updatedIds, newItemIdByTarget, results, "Keyword")
    }
    case "AdGroup": {
      const saItems: AdgroupBulkUpdateItem[] = []
      for (const p of group) {
        const sa: AdgroupBulkUpdateItem = { nccAdgroupId: p.targetId }
        if ("bidAmt" in p.before) {
          sa.bidAmt = p.before.bidAmt as number | null | undefined
          fieldUnion.add("bidAmt")
        }
        if ("dailyBudget" in p.before) {
          sa.dailyBudget = p.before.dailyBudget as number | null | undefined
          fieldUnion.add("dailyBudget")
          sa.useDailyBudget =
            typeof p.before.dailyBudget === "number" &&
            (p.before.dailyBudget as number) > 0
          fieldUnion.add("useDailyBudget")
        }
        if ("userLock" in p.before) {
          sa.userLock = p.before.userLock as boolean | undefined
          fieldUnion.add("userLock")
        }
        saItems.push(sa)
      }
      const fields = Array.from(fieldUnion).join(",")
      if (fields.length === 0) {
        return await failGroup(group, newItemIdByTarget, "롤백 패치 필드 없음")
      }
      const updated = await updateAdgroupsBulk(customerId, saItems, fields)
      const updatedIds = new Set(updated.map((u) => u.nccAdgroupId))
      return await applyRollback(group, updatedIds, newItemIdByTarget, results, "AdGroup")
    }
    case "Campaign": {
      const saItems: CampaignBulkUpdateItem[] = []
      for (const p of group) {
        const sa: CampaignBulkUpdateItem = { nccCampaignId: p.targetId }
        if ("dailyBudget" in p.before) {
          sa.dailyBudget = p.before.dailyBudget as number | null | undefined
          fieldUnion.add("dailyBudget")
        }
        if ("userLock" in p.before) {
          sa.userLock = p.before.userLock as boolean | undefined
          fieldUnion.add("userLock")
        }
        saItems.push(sa)
      }
      const fields = Array.from(fieldUnion).join(",")
      if (fields.length === 0) {
        return await failGroup(group, newItemIdByTarget, "롤백 패치 필드 없음")
      }
      const updated = await updateCampaignsBulk(customerId, saItems, fields)
      const updatedIds = new Set(updated.map((u) => u.nccCampaignId))
      return await applyRollback(group, updatedIds, newItemIdByTarget, results, "Campaign")
    }
    case "Ad": {
      const saItems: AdBulkUpdateItem[] = []
      for (const p of group) {
        const sa: AdBulkUpdateItem = { nccAdId: p.targetId }
        if ("userLock" in p.before) {
          sa.userLock = p.before.userLock as boolean | undefined
          fieldUnion.add("userLock")
        }
        saItems.push(sa)
      }
      const fields = Array.from(fieldUnion).join(",")
      if (fields.length === 0) {
        return await failGroup(group, newItemIdByTarget, "롤백 패치 필드 없음")
      }
      const updated = await updateAdsBulk(customerId, saItems, fields)
      const updatedIds = new Set(updated.map((u) => u.nccAdId))
      return await applyRollback(group, updatedIds, newItemIdByTarget, results, "Ad")
    }
    case "AdExtension": {
      const saItems: AdExtensionBulkUpdateItem[] = []
      for (const p of group) {
        const sa: AdExtensionBulkUpdateItem = { nccExtId: p.targetId }
        if ("userLock" in p.before) {
          sa.userLock = p.before.userLock as boolean | undefined
          fieldUnion.add("userLock")
        }
        saItems.push(sa)
      }
      const fields = Array.from(fieldUnion).join(",")
      if (fields.length === 0) {
        return await failGroup(group, newItemIdByTarget, "롤백 패치 필드 없음")
      }
      const updated = await updateAdExtensionsBulk(customerId, saItems, fields)
      const updatedIds = new Set(updated.map((u) => u.nccExtId))
      return await applyRollback(group, updatedIds, newItemIdByTarget, results, "AdExtension")
    }
    default:
      return await failGroup(
        group,
        newItemIdByTarget,
        `롤백 비지원 targetType: ${targetType}`,
      )
  }
}

async function applyRollback(
  group: Array<{
    itemId: string
    targetType: string
    targetId: string
  }>,
  updatedIds: Set<string>,
  newItemIdByTarget: Map<string, string>,
  results: RollbackItemResult[],
  targetType: string,
): Promise<{ success: number; failed: number; items: RollbackItemResult[] }> {
  let success = 0
  let failed = 0
  for (const p of group) {
    const newId = newItemIdByTarget.get(`${targetType}:${p.targetId}`)
    if (!newId) continue
    if (updatedIds.has(p.targetId)) {
      await prisma.changeItem.update({
        where: { id: newId },
        data: { status: "done", error: null },
      })
      results.push({
        itemId: newId,
        targetType,
        targetId: p.targetId,
        ok: true,
      })
      success++
    } else {
      await prisma.changeItem.update({
        where: { id: newId },
        data: { status: "failed", error: "롤백 응답 누락" },
      })
      results.push({
        itemId: newId,
        targetType,
        targetId: p.targetId,
        ok: false,
        reason: "sa_failed",
        error: "롤백 응답 누락",
      })
      failed++
    }
  }
  return { success, failed, items: results }
}

async function failGroup(
  group: Array<{ itemId: string; targetType: string; targetId: string }>,
  newItemIdByTarget: Map<string, string>,
  msg: string,
): Promise<{ success: number; failed: number; items: RollbackItemResult[] }> {
  const ids: string[] = []
  const items: RollbackItemResult[] = []
  for (const p of group) {
    const newId = newItemIdByTarget.get(`${p.targetType}:${p.targetId}`)
    if (newId) {
      ids.push(newId)
      items.push({
        itemId: newId,
        targetType: p.targetType,
        targetId: p.targetId,
        ok: false,
        reason: "sa_failed",
        error: msg,
      })
    }
  }
  if (ids.length > 0) {
    await prisma.changeItem.updateMany({
      where: { id: { in: ids } },
      data: { status: "failed", error: msg.slice(0, 500) },
    })
  }
  return { success: 0, failed: group.length, items }
}
