"use server"

/**
 * F-11/F-12 Phase B.3 — Suggestion Inbox Server Actions
 *
 * 책임:
 *   1. listBidSuggestions       — Inbox 페이지 데이터 (RSC 도 사용 가능)
 *   2. approveBidSuggestions    — 다중 선택 일괄 적용 (ChangeBatch + ChangeItem 적재)
 *   3. dismissBidSuggestions    — 다중 선택 일괄 거부 (status='dismissed')
 *
 * 운영 정책 (CLAUDE.md / 안전장치):
 *   - 진입부 getCurrentAdvertiser(advertiserId) — 광고주 화이트리스트 검증
 *   - mutation 액션은 viewer 차단 (operator+ 만) — bidding-policies/actions.ts 와 동일 패턴
 *   - "staging → 미리보기 → 확정" 모델: 본 액션은 "확정" 시점만
 *     · 키워드 입찰/OFF: ChangeBatch + ChangeItem 적재 → /api/batch/run cron 실행
 *     · 타게팅/예산: 외부 배치 호환성이 없어 즉시 반영 후 done ChangeItem 기록
 *   - 광고주 횡단 차단:
 *      * BidSuggestion.advertiserId == advertiserId
 *      * Keyword 는 adgroup.campaign.advertiserId join 으로 한정
 *   - AuditLog 의무 — bid_inbox.approve / bid_inbox.dismiss
 *   - revalidatePath(`/${advertiserId}/bid-inbox`)
 *
 * 데이터 정합성 (사전 실패 처리):
 *   - status='deleted' OR userLock=true OR useGroupBidAmt=true 키워드 → ChangeItem.status='failed'
 *     error="invalid_keyword_state"
 *   - drift 1차 기록: ChangeItem.before 에 현재 keyword.bidAmt + useGroupBidAmt 한 번 더 캡처
 *     (apply.ts 가 SA write 시 응답으로 비교하지만, 본 PR 단순화: drift 차단 없이 적용 진행)
 *
 * cron 픽업 정합성:
 *   - 본 액션이 만드는 ChangeBatch.action = "bid_inbox.apply"
 *   - app/api/batch/run/route.ts 의 lease 쿼리 화이트리스트에 'bid_inbox.apply' 도 등록 필요
 *     (본 PR 에서 동시 수정)
 *   - ChangeItem.targetType="Keyword" + after.operation="UPDATE" + after.fields/patch shape →
 *     기존 lib/batch/apply.ts 의 applyUpdate 를 그대로 재사용 (코드 변경 X)
 *
 * SPEC: SPEC v0.2.1 F-11.4 + plan(graceful-sparking-graham) Phase B.3
 */

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { prisma } from "@/lib/db/prisma"
import { getCurrentAdvertiser } from "@/lib/auth/access"
import { logAudit } from "@/lib/audit/log"
import { enrichBidReason } from "@/lib/llm/bid-reason"
import {
  updateCampaignsBulk,
  type CampaignBulkUpdateItem,
} from "@/lib/naver-sa/campaigns"
import type {
  DecisionMetrics,
  SuggestAction,
} from "@/lib/auto-bidding/marginal-score"
import type { Prisma as PrismaTypes } from "@/lib/generated/prisma/client"
import type {
  BidSuggestionSeverity,
  BidSuggestionSource,
} from "@/lib/generated/prisma/client"

// =============================================================================
// 공통 타입
// =============================================================================

export type ActionResult<T = void> =
  | ({ ok: true } & (T extends void ? Record<never, never> : { data: T }))
  | { ok: false; error: string }

/** Inbox 1행 — 클라이언트 테이블 props. */
export type BidSuggestionRow = {
  id: string
  engineSource: BidSuggestionSource
  severity: BidSuggestionSeverity
  reason: string
  /** 본문 그대로(JSON) — engineSource 별 shape 이 다르므로 클라이언트에서 guard 후 표시. */
  action: BidSuggestionAction
  createdAt: string // ISO
  expiresAt: string // ISO
  /** 키워드 메타 (engineSource='bid' 의 경우 항상 채워짐). null = 타게팅/예산 등 키워드 무관. */
  keyword: {
    id: string
    nccKeywordId: string
    text: string
    /** SA 응답 미포함 시 null. */
    matchType: string | null
    bidAmt: number | null
    useGroupBidAmt: boolean
    userLock: boolean
    status: string
    adgroupName: string
    campaignName: string
  } | null
}

/** BidSuggestion.action JSON. bid 엔진은 marginal-score.SuggestAction shape. */
export type BidSuggestionAction = {
  currentBid?: number | null
  suggestedBid?: number | null
  deltaPct?: number | null
  direction?: "up" | "down"
  /** F.4 enrich 결과 — 1회만 저장. 존재 시 클라이언트는 LLM 호출 X. */
  llmEnrichedReason?: string
  [key: string]: unknown
}

export type ListOptions = {
  /** 엔진 필터 — 미지정 = 전체. */
  engineSource?: BidSuggestionSource | "all"
  /** 한도 — 운영 데이터 < 1000 가정, 기본 500. */
  take?: number
}

// =============================================================================
// Zod 스키마
// =============================================================================

const advertiserIdSchema = z.string().trim().min(1).max(128)
const idsSchema = z.array(z.string().trim().min(1).max(128)).min(1).max(500)

// =============================================================================
// 1. listBidSuggestions
// =============================================================================

/**
 * 활성 pending Suggestion 목록.
 *
 *   - status='pending' AND expiresAt > now()
 *   - advertiserId 한정
 *   - engineSource 필터 (선택)
 *   - 키워드 join (engineSource='bid' / 'quality' 케이스)
 */
export async function listBidSuggestions(
  advertiserId: string,
  opts: ListOptions = {},
): Promise<ActionResult<BidSuggestionRow[]>> {
  try {
    advertiserIdSchema.parse(advertiserId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `잘못된 광고주 ID: ${msg}` }
  }

  // 권한 검증 (viewer 도 read 가능)
  await getCurrentAdvertiser(advertiserId)

  const take = Math.max(1, Math.min(2000, opts.take ?? 500))
  const engineFilter =
    opts.engineSource && opts.engineSource !== "all"
      ? { engineSource: opts.engineSource }
      : {}

  const rows = await prisma.bidSuggestion.findMany({
    where: {
      advertiserId,
      status: "pending",
      expiresAt: { gt: new Date() },
      ...engineFilter,
    },
    select: {
      id: true,
      engineSource: true,
      severity: true,
      reason: true,
      action: true,
      createdAt: true,
      expiresAt: true,
      keyword: {
        select: {
          id: true,
          nccKeywordId: true,
          keyword: true,
          matchType: true,
          bidAmt: true,
          useGroupBidAmt: true,
          userLock: true,
          status: true,
          adgroup: {
            select: {
              name: true,
              campaign: { select: { name: true } },
            },
          },
        },
      },
    },
    orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
    take,
  })

  const data: BidSuggestionRow[] = rows.map((r) => ({
    id: r.id,
    engineSource: r.engineSource,
    severity: r.severity,
    reason: r.reason,
    action: r.action as unknown as BidSuggestionAction,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    keyword: r.keyword
      ? {
          id: r.keyword.id,
          nccKeywordId: r.keyword.nccKeywordId,
          text: r.keyword.keyword,
          matchType: r.keyword.matchType,
          bidAmt: r.keyword.bidAmt,
          useGroupBidAmt: r.keyword.useGroupBidAmt,
          userLock: r.keyword.userLock,
          status: r.keyword.status,
          adgroupName: r.keyword.adgroup.name,
          campaignName: r.keyword.adgroup.campaign.name,
        }
      : null,
  }))

  return { ok: true, data }
}

// =============================================================================
// 2. approveBidSuggestions
// =============================================================================

export type ApproveResult = {
  batchId: string
  /** 입력 suggestion 개수. */
  count: number
  /** 사전 실패 (invalid_keyword_state 등) — UI 결과 표시용. */
  preFailed: number
  /** 적재 후 처리 대기 중인 ChangeItem 수 (= count - preFailed). */
  enqueued: number
}

type TargetingApplyResult =
  | {
      ok: true
      targetId: string
      before: PrismaTypes.InputJsonValue
      after: PrismaTypes.InputJsonValue
    }
  | {
      ok: false
      error: string
      before: PrismaTypes.InputJsonValue
    }

type BudgetApplyResult =
  | {
      ok: true
      targetId: string
      before: PrismaTypes.InputJsonValue
      after: PrismaTypes.InputJsonValue
    }
  | {
      ok: false
      error: string
      targetId: string
      before: PrismaTypes.InputJsonValue
      after: PrismaTypes.InputJsonValue
    }

type BudgetActionItem = {
  campaignId?: string
  nccCampaignId?: string
  suggestedDailyBudget: number
  currentDailyBudget?: number | null
  reasonCode?: string
}

const TARGETING_BUCKET_HOURS: Record<string, string[]> = {
  weekday_morning: expandHours(["mon", "tue", "wed", "thu", "fri"], 9, 12),
  weekday_afternoon: expandHours(["mon", "tue", "wed", "thu", "fri"], 13, 17),
  evening: expandHours(["mon", "tue", "wed", "thu", "fri", "sat", "sun"], 18, 23),
  off_peak: buildOffPeakHours(),
}

function expandHours(days: string[], from: number, to: number): string[] {
  const out: string[] = []
  for (const day of days) {
    for (let hour = from; hour <= to; hour++) out.push(`${day}-${hour}`)
  }
  return out
}

function buildOffPeakHours(): string[] {
  const allDays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
  const excluded = new Set([
    ...expandHours(["mon", "tue", "wed", "thu", "fri"], 9, 12),
    ...expandHours(["mon", "tue", "wed", "thu", "fri"], 13, 17),
    ...expandHours(allDays, 18, 23),
  ])
  const out: string[] = []
  for (const day of allDays) {
    for (let hour = 0; hour <= 23; hour++) {
      const key = `${day}-${hour}`
      if (!excluded.has(key)) out.push(key)
    }
  }
  return out
}

function jsonToNumberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const n = typeof raw === "number" ? raw : Number(raw)
    if (Number.isFinite(n)) out[key] = n
  }
  return out
}

function readRecommendedTargetingWeights(
  action: BidSuggestionAction,
): Record<string, number> | null {
  if (action.kind !== "hour_weights_recommendation") return null
  const buckets = action.buckets
  if (!buckets || typeof buckets !== "object" || Array.isArray(buckets)) {
    return null
  }
  const out: Record<string, number> = {}
  for (const [bucket, raw] of Object.entries(buckets as Record<string, unknown>)) {
    if (!TARGETING_BUCKET_HOURS[bucket]) continue
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const rec = raw as Record<string, unknown>
    if (rec.hasSignal !== true) continue
    const weight = Number(rec.recommendedWeight)
    if (!Number.isFinite(weight) || weight < 0 || weight > 3) continue
    out[bucket] = Number(weight.toFixed(2))
  }
  return Object.keys(out).length > 0 ? out : null
}

async function applyTargetingSuggestion(
  advertiserId: string,
  action: BidSuggestionAction,
): Promise<TargetingApplyResult> {
  const before = await prisma.targetingRule.findUnique({
    where: { advertiserId },
  })
  const beforeJson: PrismaTypes.InputJsonValue = before
    ? ({
        enabled: before.enabled,
        defaultWeight: Number(before.defaultWeight),
        hourWeights: before.hourWeights,
      } as PrismaTypes.InputJsonValue)
    : { existed: false }

  const bucketWeights = readRecommendedTargetingWeights(action)
  if (!bucketWeights) {
    return {
      ok: false,
      error: "unsupported_targeting_action",
      before: beforeJson,
    }
  }

  const hourWeights = jsonToNumberRecord(before?.hourWeights)
  for (const [bucket, weight] of Object.entries(bucketWeights)) {
    for (const key of TARGETING_BUCKET_HOURS[bucket] ?? []) {
      hourWeights[key] = weight
    }
  }

  const after = await prisma.targetingRule.upsert({
    where: { advertiserId },
    update: {
      enabled: true,
      hourWeights,
    },
    create: {
      advertiserId,
      enabled: true,
      defaultWeight: 1.0,
      hourWeights,
    },
  })

  return {
    ok: true,
    targetId: after.id,
    before: beforeJson,
    after: {
      enabled: after.enabled,
      defaultWeight: Number(after.defaultWeight),
      appliedBuckets: bucketWeights,
      hourWeights: after.hourWeights,
    } as PrismaTypes.InputJsonValue,
  }
}

function readBudgetActionItems(action: BidSuggestionAction): BudgetActionItem[] | null {
  if (action.kind !== "campaign_budget_update") return null

  const rawItems = Array.isArray(action.items) ? action.items : [action]
  const out: BudgetActionItem[] = []
  for (const raw of rawItems.slice(0, 200)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const item = raw as Record<string, unknown>
    const campaignId =
      typeof item.campaignId === "string" && item.campaignId.trim().length > 0
        ? item.campaignId.trim()
        : undefined
    const nccCampaignId =
      typeof item.nccCampaignId === "string" &&
      item.nccCampaignId.trim().length > 0
        ? item.nccCampaignId.trim()
        : undefined
    const suggestedRaw =
      item.suggestedDailyBudget ?? item.dailyBudget ?? item.suggestedBudget
    const suggestedDailyBudget = Number(suggestedRaw)
    if (
      (!campaignId && !nccCampaignId) ||
      !Number.isInteger(suggestedDailyBudget) ||
      suggestedDailyBudget < 0
    ) {
      continue
    }
    const currentRaw = item.currentDailyBudget ?? item.currentBudget
    const currentDailyBudget =
      currentRaw == null || currentRaw === ""
        ? null
        : Number.isFinite(Number(currentRaw))
          ? Number(currentRaw)
          : undefined

    out.push({
      campaignId,
      nccCampaignId,
      suggestedDailyBudget,
      currentDailyBudget,
      reasonCode:
        typeof item.reasonCode === "string" ? item.reasonCode : undefined,
    })
  }

  return out.length > 0 ? out : null
}

async function applyBudgetSuggestion(
  advertiserId: string,
  customerId: string,
  action: BidSuggestionAction,
): Promise<BudgetApplyResult> {
  const items = readBudgetActionItems(action)
  if (!items) {
    return {
      ok: false,
      error: "unsupported_budget_action",
      targetId: advertiserId,
      before: { suggestion: "budget" },
      after: { suggestion: "budget" },
    }
  }

  const campaignIds = items
    .map((item) => item.campaignId)
    .filter((v): v is string => v != null)
  const nccCampaignIds = items
    .map((item) => item.nccCampaignId)
    .filter((v): v is string => v != null)

  const campaigns = await prisma.campaign.findMany({
    where: {
      advertiserId,
      status: { not: "deleted" },
      OR: [
        ...(campaignIds.length > 0 ? [{ id: { in: campaignIds } }] : []),
        ...(nccCampaignIds.length > 0
          ? [{ nccCampaignId: { in: nccCampaignIds } }]
          : []),
      ],
    },
    select: {
      id: true,
      nccCampaignId: true,
      name: true,
      dailyBudget: true,
      status: true,
    },
  })

  const byId = new Map(campaigns.map((c) => [c.id, c]))
  const byNccId = new Map(campaigns.map((c) => [c.nccCampaignId, c]))
  const updateByNccId = new Map<string, BudgetActionItem>()
  for (const item of items) {
    const campaign =
      (item.campaignId ? byId.get(item.campaignId) : undefined) ??
      (item.nccCampaignId ? byNccId.get(item.nccCampaignId) : undefined)
    if (!campaign) continue
    updateByNccId.set(campaign.nccCampaignId, item)
  }

  const before = campaigns
    .filter((c) => updateByNccId.has(c.nccCampaignId))
    .map((c) => ({
      id: c.id,
      nccCampaignId: c.nccCampaignId,
      name: c.name,
      dailyBudget: c.dailyBudget == null ? null : Number(c.dailyBudget),
      status: c.status,
    }))

  if (updateByNccId.size !== items.length || before.length === 0) {
    return {
      ok: false,
      error: "campaign_not_found",
      targetId: advertiserId,
      before: { campaigns: before },
      after: { requested: items },
    }
  }

  const apiItems: CampaignBulkUpdateItem[] = before.map((c) => {
    const next = updateByNccId.get(c.nccCampaignId)!
    return {
      nccCampaignId: c.nccCampaignId,
      dailyBudget: next.suggestedDailyBudget,
    }
  })

  try {
    const updated = await updateCampaignsBulk(customerId, apiItems, "dailyBudget")
    const updatedMap = new Map(updated.map((c) => [c.nccCampaignId, c]))
    for (const c of campaigns) {
      const u = updatedMap.get(c.nccCampaignId)
      if (!u) continue
      await prisma.campaign.update({
        where: { id: c.id },
        data: {
          dailyBudget:
            typeof u.dailyBudget === "number" ? u.dailyBudget : null,
          raw: u as unknown as PrismaTypes.InputJsonValue,
        },
      })
    }

    const appliedCampaigns = apiItems.map((item) => ({
      nccCampaignId: item.nccCampaignId,
      dailyBudget: item.dailyBudget ?? null,
    }))
    const singleBefore = before.length === 1 ? before[0] : null
    const singleAfter = appliedCampaigns.length === 1 ? appliedCampaigns[0] : null

    return {
      ok: true,
      targetId: before.length === 1 ? before[0].nccCampaignId : advertiserId,
      before: singleBefore
        ? ({
            campaignId: singleBefore.id,
            nccCampaignId: singleBefore.nccCampaignId,
            name: singleBefore.name,
            dailyBudget: singleBefore.dailyBudget,
            status: singleBefore.status,
          } as PrismaTypes.InputJsonValue)
        : ({ campaigns: before } as PrismaTypes.InputJsonValue),
      after: singleAfter
        ? ({
            operation: "UPDATE",
            fields: "dailyBudget",
            nccCampaignId: singleAfter.nccCampaignId,
            dailyBudget: singleAfter.dailyBudget,
          } as PrismaTypes.InputJsonValue)
        : ({
            operation: "UPDATE",
            fields: "dailyBudget",
            campaigns: appliedCampaigns,
          } as PrismaTypes.InputJsonValue),
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      error: msg,
      targetId: before.length === 1 ? before[0].nccCampaignId : advertiserId,
      before: { campaigns: before },
      after: {
        operation: "UPDATE",
        fields: "dailyBudget",
        campaigns: apiItems.map((item) => ({
          nccCampaignId: item.nccCampaignId,
          dailyBudget: item.dailyBudget ?? null,
        })),
      },
    }
  }
}

/**
 * 다중 선택 Suggestion 일괄 적용.
 *
 * 흐름:
 *   1. 권한 검증 + viewer 차단
 *   2. suggestion 로드 (status='pending', advertiserId 일치, engineSource in bid/quality/targeting/budget)
 *      - bid     : 입찰가 UPDATE ChangeItem
 *      - quality : kind='off' 인 OFF 후보만 Keyword OFF ChangeItem
 *      - targeting: hour weight 추천을 TargetingRule 에 즉시 반영하고 done ChangeItem 기록
 *      - budget  : campaign_budget_update 를 SA 캠페인 일예산 변경으로 즉시 반영하고 done ChangeItem 기록
 *   3. 키워드 메타 join (advertiserId 한정)
 *   4. ChangeBatch 1건 생성 (action='bid_inbox.apply', status='pending')
 *   5. 각 suggestion → ChangeItem 1건:
 *      - 키워드 invalid 상태 → status='failed' / error="invalid_keyword_state"
 *      - 정상 → status='pending', after.operation='UPDATE', fields/patch shape (apply.ts 호환)
 *   6. BidSuggestion.updateMany → status='applied', appliedBatchId=batch.id
 *   7. AuditLog 1건
 *   8. revalidatePath
 *
 * 후속 처리:
 *   - /api/batch/run cron 이 1분 간격으로 lease 획득 → ChangeItem 처리.
 *   - 본 PR 에서 cron 화이트리스트에 'bid_inbox.apply' 추가.
 */
export async function approveBidSuggestions(
  advertiserId: string,
  suggestionIds: string[],
): Promise<ActionResult<ApproveResult>> {
  // -- 입력 검증 --
  let parsedIds: string[]
  try {
    advertiserIdSchema.parse(advertiserId)
    parsedIds = idsSchema.parse(suggestionIds)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `잘못된 입력: ${msg}` }
  }
  parsedIds = Array.from(new Set(parsedIds))

  // -- 권한 + 광고주 컨텍스트 --
  const { advertiser, user } = await getCurrentAdvertiser(advertiserId)
  if (user.role === "viewer") {
    return { ok: false, error: "권한 부족 (viewer)" }
  }
  if (!advertiser.hasKeys) {
    return {
      ok: false,
      error: "API 키/시크릿 미입력 — 적용 시 SA 호출 불가",
    }
  }

  // -- suggestion 로드 (현재 적용 지원: bid / quality OFF / targeting / budget) -
  const suggestions = await prisma.bidSuggestion.findMany({
    where: {
      id: { in: parsedIds },
      advertiserId,
      status: "pending",
      engineSource: { in: ["bid", "quality", "targeting", "budget"] },
    },
    select: {
      id: true,
      keywordId: true,
      engineSource: true,
      action: true,
      reason: true,
      severity: true,
    },
  })

  if (suggestions.length === 0) {
    return {
      ok: false,
      error: "유효한 pending suggestion 이 없습니다 (이미 처리되었거나 만료)",
    }
  }

  // -- 키워드 메타 join (광고주 한정) ----------------------------------------
  const keywordIds = suggestions
    .map((s) => s.keywordId)
    .filter((v): v is string => v != null)
  const keywords = await prisma.keyword.findMany({
    where: {
      id: { in: keywordIds },
      adgroup: { campaign: { advertiserId } },
    },
    select: {
      id: true,
      nccKeywordId: true,
      bidAmt: true,
      useGroupBidAmt: true,
      userLock: true,
      status: true,
    },
  })
  const keywordById = new Map(keywords.map((k) => [k.id, k]))

  // -- ChangeBatch 생성 -------------------------------------------------------
  const batch = await prisma.changeBatch.create({
    data: {
      userId: user.id,
      action: "bid_inbox.apply",
      status: "pending",
      total: suggestions.length,
      processed: 0,
      attempt: 0,
      summary: {
        advertiserId,
        suggestionCount: suggestions.length,
        engineSources: Array.from(
          new Set(suggestions.map((s) => s.engineSource)),
        ),
      },
    },
  })

  // -- ChangeItem seed 산출 ---------------------------------------------------
  type ChangeItemSeed = {
    batchId: string
    targetType: string
    targetId: string
    before: PrismaTypes.InputJsonValue
    after: PrismaTypes.InputJsonValue
    idempotencyKey: string
    status: "pending" | "failed" | "done"
    error?: string
  }

  const seeds: ChangeItemSeed[] = []
  let preFailed = 0
  let directDone = 0

  for (const s of suggestions) {
    const action = s.action as unknown as BidSuggestionAction
    if (s.engineSource === "budget") {
      const applied = await applyBudgetSuggestion(
        advertiserId,
        advertiser.customerId,
        action,
      )
      if (!applied.ok) {
        preFailed++
        seeds.push({
          batchId: batch.id,
          targetType: "Campaign",
          targetId: applied.targetId,
          before: applied.before,
          after: {
            attempted: applied.after,
            suggestionId: s.id,
            engineSource: s.engineSource,
            reason: applied.error,
          },
          idempotencyKey: `${batch.id}:${s.id}`,
          status: "failed",
          error: applied.error,
        })
      } else {
        directDone++
        seeds.push({
          batchId: batch.id,
          targetType: "Campaign",
          targetId: applied.targetId,
          before: applied.before,
          after: {
            ...(applied.after as Record<string, unknown>),
            suggestionId: s.id,
            suggestionReason: s.reason,
          } as PrismaTypes.InputJsonValue,
          idempotencyKey: `${batch.id}:${s.id}`,
          status: "done",
        })
      }
      continue
    }

    if (s.engineSource === "targeting") {
      const applied = await applyTargetingSuggestion(advertiserId, action)
      if (!applied.ok) {
        preFailed++
        seeds.push({
          batchId: batch.id,
          targetType: "TargetingRule",
          targetId: advertiserId,
          before: applied.before,
          after: {
            suggestionId: s.id,
            engineSource: s.engineSource,
            reason: applied.error,
          },
          idempotencyKey: `${batch.id}:${s.id}`,
          status: "failed",
          error: applied.error,
        })
      } else {
        directDone++
        seeds.push({
          batchId: batch.id,
          targetType: "TargetingRule",
          targetId: applied.targetId,
          before: applied.before,
          after: {
            applied: applied.after,
            suggestionId: s.id,
            suggestionReason: s.reason,
          },
          idempotencyKey: `${batch.id}:${s.id}`,
          status: "done",
        })
      }
      continue
    }

    const k = s.keywordId ? keywordById.get(s.keywordId) : null

    // 키워드 미존재 / 광고주 외 → 사전 실패
    if (!k) {
      preFailed++
      seeds.push({
        batchId: batch.id,
        targetType: "Keyword",
        targetId: s.keywordId ?? `unknown:${s.id}`,
        before: { suggestionId: s.id },
        after: { suggestionId: s.id },
        idempotencyKey: `${batch.id}:${s.id}`,
        status: "failed",
        error: "keyword_not_found",
      })
      continue
    }

    const isQualityOff =
      s.engineSource === "quality" && action.kind === "off"
    const isBidUpdate =
      s.engineSource === "bid" &&
      typeof action.suggestedBid === "number"

    if (!isBidUpdate && !isQualityOff) {
      preFailed++
      seeds.push({
        batchId: batch.id,
        targetType: "Keyword",
        targetId: k.nccKeywordId,
        before: {
          bidAmt: k.bidAmt,
          useGroupBidAmt: k.useGroupBidAmt,
          userLock: k.userLock,
          status: k.status,
        },
        after: {
          suggestionId: s.id,
          engineSource: s.engineSource,
          reason: "unsupported_suggestion_action",
        },
        idempotencyKey: `${batch.id}:${k.nccKeywordId}`,
        status: "failed",
        error: "unsupported_suggestion_action",
      })
      continue
    }

    // 잠금 / 삭제 / 그룹 입찰가 사용 → 사전 실패.
    // quality OFF 는 그룹입찰가 여부와 무관하게 userLock=true 적용이 가능하므로 useGroupBidAmt 는 bid 에만 차단.
    if (
      k.userLock ||
      k.status === "deleted" ||
      (isBidUpdate && k.useGroupBidAmt)
    ) {
      preFailed++
      seeds.push({
        batchId: batch.id,
        targetType: "Keyword",
        targetId: k.nccKeywordId,
        before: {
          bidAmt: k.bidAmt,
          useGroupBidAmt: k.useGroupBidAmt,
          userLock: k.userLock,
          status: k.status,
        },
        after: {
          suggestedBid: isBidUpdate ? action.suggestedBid : undefined,
          suggestedAction: isQualityOff ? "off" : undefined,
        },
        idempotencyKey: `${batch.id}:${k.nccKeywordId}`,
        status: "failed",
        error: "invalid_keyword_state",
      })
      continue
    }

    if (isQualityOff) {
      seeds.push({
        batchId: batch.id,
        targetType: "Keyword",
        targetId: k.nccKeywordId,
        before: {
          userLock: k.userLock,
          status: k.status,
          reasonCode:
            typeof action.reasonCode === "string" ? action.reasonCode : null,
        },
        after: {
          operation: "OFF" as const,
          customerId: advertiser.customerId,
          nccKeywordId: k.nccKeywordId,
          suggestionId: s.id,
          suggestionReason: s.reason,
        },
        idempotencyKey: `${batch.id}:${k.nccKeywordId}`,
        status: "pending",
      })
      continue
    }

    // 정상 — apply.ts 호환 shape (operation=UPDATE / fields / patch / customerId)
    const before = {
      bidAmt: k.bidAmt,
      useGroupBidAmt: k.useGroupBidAmt,
    }
    const after = {
      operation: "UPDATE" as const,
      customerId: advertiser.customerId,
      nccKeywordId: k.nccKeywordId,
      fields: "bidAmt,useGroupBidAmt",
      patch: {
        bidAmt: action.suggestedBid,
        useGroupBidAmt: false,
      },
      // 디버그 / 감사용
      suggestionId: s.id,
      suggestionReason: s.reason,
    }

    seeds.push({
      batchId: batch.id,
      targetType: "Keyword",
      targetId: k.nccKeywordId,
      before,
      after,
      idempotencyKey: `${batch.id}:${k.nccKeywordId}`,
      status: "pending",
    })
  }

  // -- ChangeItem 적재 --------------------------------------------------------
  await prisma.changeItem.createMany({
    data: seeds.map((s) => ({
      batchId: s.batchId,
      targetType: s.targetType,
      targetId: s.targetId,
      before: s.before,
      after: s.after,
      idempotencyKey: s.idempotencyKey,
      status: s.status,
      error: s.error,
    })),
  })

  // -- BidSuggestion.applied 마킹 --------------------------------------------
  // 사전 실패 행도 applied 로 마킹 (재시도 방지) — 단, summary 에 preFailed 노출.
  // 운영자가 "왜 실패했는지" 는 ChangeItem 결과 페이지에서 확인.
  await prisma.bidSuggestion.updateMany({
    where: {
      id: { in: suggestions.map((s) => s.id) },
      advertiserId,
      status: "pending",
    },
    data: {
      status: "applied",
      appliedBatchId: batch.id,
    },
  })

  // 사전 실패가 0이고 대기 1개 이상 → 정상 enqueue. 대기 0이면 batch 즉시 failed 마킹.
  const enqueued = suggestions.length - preFailed - directDone
  if (enqueued === 0) {
    await prisma.changeBatch.update({
      where: { id: batch.id },
      data: {
        status: preFailed > 0 ? "failed" : "done",
        processed: suggestions.length,
        finishedAt: new Date(),
      },
    })
  } else if (directDone > 0) {
    await prisma.changeBatch.update({
      where: { id: batch.id },
      data: { processed: directDone },
    })
  }

  // -- AuditLog --------------------------------------------------------------
  await logAudit({
    userId: user.id,
    action: "bid_inbox.approve",
    targetType: "ChangeBatch",
    targetId: batch.id,
    before: null,
    after: {
      advertiserId,
      batchId: batch.id,
      suggestionIds: suggestions.map((s) => s.id),
      total: suggestions.length,
      preFailed,
      enqueued,
      directDone,
    },
  })

  revalidatePath(`/${advertiserId}/bid-inbox`)

  return {
    ok: true,
    data: {
      batchId: batch.id,
      count: suggestions.length,
      preFailed,
      enqueued,
    },
  }
}

// =============================================================================
// 3. enrichSuggestionReason — LLM 보강 (Phase F.4 lazy on-demand)
// =============================================================================

export type EnrichResult = {
  text: string
  usedLlm: boolean
  /** 이미 enrich 된 결과 재반환 — LLM 재호출 X. */
  cached: boolean
}

const STATS_WINDOW_DAYS_FOR_ENRICH = 7

/**
 * 단건 BidSuggestion reason 을 LLM 으로 보강.
 *
 * 흐름:
 *   1. 권한 검증 (operator+ — read-only 에 가까우나 비용 발생 호출이라 viewer 차단)
 *   2. BidSuggestion 로드 (status='pending', advertiserId 일치, engineSource='bid')
 *   3. 이미 action.llmEnrichedReason 존재 → 그대로 반환 (LLM 재호출 방지)
 *   4. Keyword + StatDaily 7일 누적 재계산 → DecisionMetrics 재구성
 *      · cron 이 metrics 를 적재하지 않아 본 시점 재계산 필수
 *   5. enrichBidReason 호출
 *   6. 성공 → action JSON 에 llmEnrichedReason 저장 (재호출 방지) + AuditLog
 *
 * 비용 안전:
 *   - 1건 1회만 호출 (재호출 방지) — 텍스트가 만족스럽지 않아도 재시도 X
 *   - 광고주 1명 100건 enrich = 100 × $0.005 = $0.5 → 월 $2 / 광고주
 *   - LLM_MONTHLY_BUDGET_USD env 한도 도달 시 callLlmWithFallback 이 폴백
 *
 * 비대상:
 *   - engineSource ≠ 'bid' (quality / targeting / budget) — 후속 PR 별도 prompt
 *   - 일괄 enrich (다중 선택) — 비용 폭증 방지 차원에서 의도적 단건만
 */
export async function enrichSuggestionReason(
  advertiserId: string,
  suggestionId: string,
): Promise<ActionResult<EnrichResult>> {
  // -- 입력 검증 --
  try {
    advertiserIdSchema.parse(advertiserId)
    z.string().trim().min(1).max(128).parse(suggestionId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `잘못된 입력: ${msg}` }
  }

  // -- 권한 검증 (viewer 차단 — 비용 발생 호출) --
  const { user } = await getCurrentAdvertiser(advertiserId)
  if (user.role === "viewer") {
    return { ok: false, error: "권한 부족 (viewer 는 AI 설명 불가)" }
  }

  // -- BidSuggestion 로드 (pending + advertiser + bid 엔진 한정) --
  const suggestion = await prisma.bidSuggestion.findFirst({
    where: {
      id: suggestionId,
      advertiserId,
      status: "pending",
      engineSource: "bid",
    },
    select: {
      id: true,
      keywordId: true,
      action: true,
      reason: true,
    },
  })
  if (!suggestion) {
    return {
      ok: false,
      error:
        "권고를 찾을 수 없습니다 (이미 처리되었거나 'bid' 엔진이 아님 — quality/targeting/budget 은 후속 PR)",
    }
  }

  // -- 이미 enrich 된 결과 → 재사용 (LLM 재호출 방지) --
  const actionRaw = suggestion.action as Record<string, unknown> | null
  if (
    actionRaw &&
    typeof actionRaw === "object" &&
    typeof actionRaw.llmEnrichedReason === "string" &&
    actionRaw.llmEnrichedReason.length > 0
  ) {
    return {
      ok: true,
      data: {
        text: actionRaw.llmEnrichedReason,
        usedLlm: true,
        cached: true,
      },
    }
  }

  // -- 키워드 + 7일 stats 재계산 (cron 미적재 metrics 재구성) --
  if (!suggestion.keywordId) {
    return {
      ok: false,
      error: "키워드 미연결 권고 — bid 엔진은 키워드가 필수",
    }
  }

  const keyword = await prisma.keyword.findFirst({
    where: {
      id: suggestion.keywordId,
      adgroup: { campaign: { advertiserId } },
    },
    select: {
      keyword: true,
      nccKeywordId: true,
    },
  })
  if (!keyword) {
    return { ok: false, error: "키워드 미존재 (광고주 일치 X)" }
  }

  const since = new Date()
  since.setUTCDate(since.getUTCDate() - STATS_WINDOW_DAYS_FOR_ENRICH)

  const agg = await prisma.statDaily.aggregate({
    where: {
      advertiserId,
      level: "keyword",
      refId: keyword.nccKeywordId,
      date: { gte: since },
    },
    _sum: {
      impressions: true,
      clicks: true,
      cost: true,
      conversions: true,
      revenue: true,
    },
    _avg: { avgRnk: true },
  })

  const impressions7d = agg._sum.impressions ?? 0
  const clicks7d = agg._sum.clicks ?? 0
  const cost7d = agg._sum.cost ? Number(agg._sum.cost) : 0
  const conversions7d = agg._sum.conversions ?? null
  const revenue7d = agg._sum.revenue ? Number(agg._sum.revenue) : null

  const currentRoas =
    cost7d > 0 && revenue7d != null && revenue7d > 0
      ? revenue7d / cost7d
      : null
  const currentCpa =
    conversions7d != null && conversions7d > 0 && cost7d > 0
      ? cost7d / conversions7d
      : null
  const keywordCpc = clicks7d > 0 ? cost7d / clicks7d : null
  const keywordCtr =
    impressions7d > 0 ? (clicks7d / impressions7d) * 100 : null
  const avgRank7d = agg._avg.avgRnk != null ? Number(agg._avg.avgRnk) : null

  const metrics: DecisionMetrics = {
    clicks7d,
    cost7d,
    revenue7d,
    currentRoas,
    currentCpa,
    keywordCpc,
    keywordCtr,
    avgRank7d,
  }

  const action = actionRaw as unknown as SuggestAction
  if (
    !action ||
    typeof action.currentBid !== "number" ||
    typeof action.suggestedBid !== "number"
  ) {
    return {
      ok: false,
      error: "권고 액션 shape 불일치 — 'bid' 엔진 SuggestAction 필요",
    }
  }

  // -- LLM 호출 (폴백 포함) --
  const enriched = await enrichBidReason({
    searchTerm: keyword.keyword,
    suggestion: {
      currentBid: action.currentBid,
      suggestedBid: action.suggestedBid,
      deltaPct: action.deltaPct,
      direction: action.direction,
    },
    metrics,
    defaultReason: suggestion.reason,
  })

  // -- 폴백 (usedLlm=false) — 저장 X (LLM 미호출 = 보존할 새 텍스트 없음) --
  if (!enriched.usedLlm) {
    return {
      ok: true,
      data: {
        text: enriched.text,
        usedLlm: false,
        cached: false,
      },
    }
  }

  // -- 성공 → action JSON 에 보존 + AuditLog --
  const newAction: PrismaTypes.InputJsonValue = {
    ...(actionRaw ?? {}),
    llmEnrichedReason: enriched.text,
  } as PrismaTypes.InputJsonValue

  await prisma.bidSuggestion.update({
    where: { id: suggestion.id },
    data: { action: newAction },
  })

  await logAudit({
    userId: user.id,
    action: "bid_suggestion.enrich",
    targetType: "BidSuggestion",
    targetId: suggestion.id,
    before: null,
    after: {
      advertiserId,
      suggestionId: suggestion.id,
      usedLlm: true,
      // LLM 응답 본문은 prompt 파생물 — AuditLog 에는 길이만 (privacy)
      enrichedTextLength: enriched.text.length,
    },
  })

  revalidatePath(`/${advertiserId}/bid-inbox`)

  return {
    ok: true,
    data: {
      text: enriched.text,
      usedLlm: true,
      cached: false,
    },
  }
}

// =============================================================================
// 4. dismissBidSuggestions
// =============================================================================

export type DismissResult = {
  count: number
}

/**
 * 다중 선택 Suggestion 일괄 거부.
 *
 *   - status: pending → dismissed (광고주 + 입력 ID 한정)
 *   - SA 호출 X / ChangeBatch 생성 X
 *   - AuditLog 1건
 */
export async function dismissBidSuggestions(
  advertiserId: string,
  suggestionIds: string[],
): Promise<ActionResult<DismissResult>> {
  let parsedIds: string[]
  try {
    advertiserIdSchema.parse(advertiserId)
    parsedIds = idsSchema.parse(suggestionIds)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `잘못된 입력: ${msg}` }
  }
  parsedIds = Array.from(new Set(parsedIds))

  const { user } = await getCurrentAdvertiser(advertiserId)
  if (user.role === "viewer") {
    return { ok: false, error: "권한 부족 (viewer)" }
  }

  const r = await prisma.bidSuggestion.updateMany({
    where: {
      id: { in: parsedIds },
      advertiserId,
      status: "pending",
    },
    data: { status: "dismissed" },
  })

  await logAudit({
    userId: user.id,
    action: "bid_inbox.dismiss",
    targetType: "Advertiser",
    targetId: advertiserId,
    before: null,
    after: {
      advertiserId,
      suggestionIds: parsedIds,
      dismissedCount: r.count,
    },
  })

  revalidatePath(`/${advertiserId}/bid-inbox`)

  return { ok: true, data: { count: r.count } }
}
