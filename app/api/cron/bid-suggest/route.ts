/**
 * Vercel Cron 핸들러 — 입찰 권고 (Phase B.2)
 *
 * 목적:
 *   - 광고주별 비용 TOP N 키워드에 대해 한계효용 권고 → BidSuggestion(Inbox) 적재
 *   - 자동 SA 변경 X — 운영자 승인 후 ChangeBatch 흐름으로 적용 (Phase B.3 UI)
 *
 * 매시간 실행. cron 등록 (vercel.json):
 *   { "path": "/api/cron/bid-suggest", "schedule": "20 * * * *" }
 *   - 분 20 — alerts(0) / batch(매분) / stat-hourly(5) / auto-bidding(10) / sync-all(15) 와 분리
 *   - Authorization: Bearer ${CRON_SECRET} 자동 부착
 *
 * 동작:
 *   1. CRON_SECRET 검증 (불일치 시 401)
 *   2. 활성 광고주 조회 (status='active' AND BidAutomationConfig.mode != 'off' [없으면 inbox 폴백])
 *   3. 광고주 직렬:
 *      a. BidAutomationConfig 로드 (없거나 off면 skip)
 *      b. 캠페인 예산 페이싱/성과 권고 → BidSuggestion(engineSource='budget') 적재
 *      c. KeywordPerformanceProfile 로드 (없으면 bid 엔진만 skip)
 *      d. BiddingPolicy.enabled=true 키워드 nccKeywordId 셋 (자동 실행 키워드 제외 — auto-bidding cron 책임)
 *      e. StatDaily 7d groupBy(refId) sum(cost) desc TOP N
 *      f. Keyword 매핑 (nccKeywordId → id / bidAmt / userLock / status)
 *      g. 각 키워드:
 *         - userLock=true / status='deleted' → skip
 *         - useGroupBidAmt=true → skip (명시 입찰만)
 *         - decideMarginalSuggestion
 *         - suggest → upsertSuggestion (pending 1개 보장)
 *         - hold + 'low_confidence_data' 아님 → 기존 pending dismiss
 *   4. JSON 응답 (광고주별 통계)
 *
 * 정책:
 *   - BidSuggestion 키워드별 active pending engineSource='bid' 1개만 (코드 강제)
 *   - expiresAt = +7d 기본
 *   - SA 호출 0 — Estimate 활용은 후속 PR (Phase B 정련)
 *   - BiddingPolicy 등록 키워드 제외 — auto-bidding cron 이 자동 실행 대상
 *
 * Vercel maxDuration:
 *   - Pro 900s 한도 → 800. 광고주 N <= ~13 + TOP 100 키워드 직렬 가정.
 *   - 광고주 수 증가 시 슬라이스(`BID_SUGGEST_ADVERTISER_SLICE`) 도입 후속 PR.
 *
 * SPEC: SPEC v0.2.1 F-11.2 + plan(graceful-sparking-graham) Phase B.2
 */

import { NextRequest, NextResponse } from "next/server"

import { prisma } from "@/lib/db/prisma"
import { scrubString } from "@/lib/crypto/scrub-string"
import {
  bundleSuggestions,
  decideMarginalSuggestion,
  type AdvertiserBaselineInput,
  type AutomationTargets,
  type BundleInputDecision,
  type KeywordPerfInput,
  type MarginalDecision,
} from "@/lib/auto-bidding/marginal-score"
import type * as Prisma from "@/lib/generated/prisma/internal/prismaNamespace"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 800

// =============================================================================
// 응답 타입 / 상수
// =============================================================================

const TOP_N = Number(process.env.BID_SUGGEST_TOP_N ?? "100")
const STATS_WINDOW_DAYS = 7
const SUGGESTION_TTL_DAYS = 7
/**
 * stat-daily stale 차단 임계 (Phase 7).
 *
 * StatDaily 적재가 본 임계 이상 정체된 광고주는 권고 생성 skip — 잘못된 데이터로 권고
 * 누적되는 사고 방지. 기준은 StatDaily.updatedAt 광고주별 max (recordSyncAt 미적재).
 *
 * 임계 30h 근거: stat-daily cron 은 KST 03:00 1회/일 + 광고주별 SA 보고서 빌드 폴링 ~5분.
 *   - 정상 운영 시 ageHours 가 24h 사이클로 변동 (KST 03:30 직전 ~24h, 직후 ~0).
 *   - 24h+α (폴링 지연/장애 여유 6h) = 30h 초과 = 전일자 적재 실패 1건만 검출.
 *   - 임계를 6h 등 짧게 두면 KST 02:00~03:30 슬롯에서 정상 광고주가 매일 stale 처리되는 운영 사고 발생.
 */
const STAT_STALENESS_HOURS = 30

type CronError = {
  advertiserId: string
  keywordId?: string
  message: string
}

type CronResponse = {
  ok: boolean
  advertisersTotal: number
  advertisersOk: number
  advertisersSkipped: number
  /** stat-daily 적재가 STAT_STALENESS_HOURS 초과로 stale → 권고 생성 skip 카운트 (Phase 7). */
  advertisersStale: number
  keywordsScanned: number
  budgetCampaignsScanned: number
  suggestionsCreated: number
  suggestionsUpdated: number
  suggestionsDismissed: number
  /** 묶음 권고 (scope='adgroup') 신규 생성 카운트. */
  bundlesCreated: number
  /** 묶음 권고 supersede (status='dismissed' with reasonCode='superseded_by_new_bundle'). */
  bundlesDismissed: number
  /** 단건 (scope='keyword') 권고 신규/갱신/무시 — 기존 흐름 통계. */
  singlesCreated: number
  singlesUpdated: number
  singlesDismissed: number
  ts: string
  errors: CronError[]
  error?: string
}

function safeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return scrubString(raw).slice(0, 500)
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base)
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

// =============================================================================
// 광고주 1명 처리
// =============================================================================

type AdvertiserStats = {
  scanned: number
  budgetScanned: number
  created: number
  updated: number
  dismissed: number
  bundlesCreated: number
  bundlesDismissed: number
  singlesCreated: number
  singlesUpdated: number
  singlesDismissed: number
  /** stat-daily stale → 본 광고주 진입부 skip (Phase 7). */
  stale: boolean
}

type BudgetSuggestionStats = {
  scanned: number
  created: number
  updated: number
  dismissed: number
}

type BudgetConfig = {
  budgetPacingMode: "focus" | "explore" | "protect"
  targetCpa: number | null
  targetRoas: Prisma.Decimal | number | null
}

type BudgetDecision =
  | {
      decision: "suggest"
      reasonCode: string
      suggestedDailyBudget: number
      severity: "info" | "warn" | "critical"
      reason: string
      meta: Record<string, number | string | null>
    }
  | {
      decision: "hold"
      reasonCode: string
    }

function roundBudget(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.round(v / 1000) * 1000)
}

function clampBudgetChange(
  currentBudget: number,
  suggestedBudget: number,
  mode: BudgetConfig["budgetPacingMode"],
): number {
  const maxIncreasePct = mode === "explore" ? 0.3 : mode === "protect" ? 0.1 : 0.2
  const maxDecreasePct = mode === "protect" ? 0.25 : 0.15
  const min = currentBudget * (1 - maxDecreasePct)
  const max = currentBudget * (1 + maxIncreasePct)
  return roundBudget(Math.min(max, Math.max(min, suggestedBudget)))
}

function decideBudgetSuggestion(input: {
  campaignName: string
  currentDailyBudget: number
  costYesterday: number
  cost7d: number
  conversions7d: number | null
  revenue7d: number | null
  cfg: BudgetConfig
}): BudgetDecision {
  const {
    campaignName,
    currentDailyBudget,
    costYesterday,
    cost7d,
    conversions7d,
    revenue7d,
    cfg,
  } = input
  if (currentDailyBudget <= 0 || cost7d <= 0) {
    return { decision: "hold", reasonCode: "no_budget_signal" }
  }

  const yesterdayPacePct = (costYesterday / currentDailyBudget) * 100
  const sevenDayPacePct = (cost7d / (currentDailyBudget * 7)) * 100
  const cpa7d =
    conversions7d != null && conversions7d > 0 ? cost7d / conversions7d : null
  const roas7d =
    revenue7d != null && cost7d > 0 ? revenue7d / cost7d : null
  const targetRoas =
    cfg.targetRoas == null ? null : Number(cfg.targetRoas)

  const meetsCpa = cfg.targetCpa == null || (cpa7d != null && cpa7d <= cfg.targetCpa)
  const meetsRoas = targetRoas == null || (roas7d != null && roas7d >= targetRoas)
  const hasTarget = cfg.targetCpa != null || targetRoas != null
  const performanceOk = hasTarget ? meetsCpa || meetsRoas : true
  const performanceBad =
    (cfg.targetCpa != null && cpa7d != null && cpa7d > cfg.targetCpa * 1.25) ||
    (targetRoas != null && roas7d != null && roas7d < targetRoas * 0.8)

  const meta = {
    currentDailyBudget,
    costYesterday,
    cost7d,
    yesterdayPacePct: Number(yesterdayPacePct.toFixed(2)),
    sevenDayPacePct: Number(sevenDayPacePct.toFixed(2)),
    cpa7d: cpa7d == null ? null : Math.round(cpa7d),
    roas7d: roas7d == null ? null : Number(roas7d.toFixed(2)),
    budgetPacingMode: cfg.budgetPacingMode,
  }

  if (yesterdayPacePct >= 98 && sevenDayPacePct >= 75 && performanceOk) {
    const factor =
      cfg.budgetPacingMode === "explore"
        ? 1.3
        : cfg.budgetPacingMode === "protect"
          ? 1.1
          : 1.2
    const suggestedDailyBudget = clampBudgetChange(
      currentDailyBudget,
      currentDailyBudget * factor,
      cfg.budgetPacingMode,
    )
    return {
      decision: "suggest",
      reasonCode: "budget_exhausted_with_signal",
      suggestedDailyBudget,
      severity: yesterdayPacePct >= 110 ? "critical" : "warn",
      reason: `${campaignName} 캠페인이 어제 일예산의 ${yesterdayPacePct.toFixed(0)}%를 사용했고 7일 페이스도 ${sevenDayPacePct.toFixed(0)}%입니다. 성과 목표를 크게 벗어나지 않아 일예산을 ${suggestedDailyBudget.toLocaleString()}원으로 증액 권고합니다.`,
      meta,
    }
  }

  if (sevenDayPacePct <= 35 && cost7d >= currentDailyBudget && cfg.budgetPacingMode !== "explore") {
    const suggestedDailyBudget = clampBudgetChange(
      currentDailyBudget,
      Math.max(cost7d / 7 / 0.65, currentDailyBudget * 0.75),
      cfg.budgetPacingMode,
    )
    if (suggestedDailyBudget < currentDailyBudget) {
      return {
        decision: "suggest",
        reasonCode: "budget_underused",
        suggestedDailyBudget,
        severity: "info",
        reason: `${campaignName} 캠페인의 7일 예산 사용률이 ${sevenDayPacePct.toFixed(0)}%로 낮습니다. 예산을 ${suggestedDailyBudget.toLocaleString()}원으로 낮춰 다른 캠페인에 재배분하는 것을 권고합니다.`,
        meta,
      }
    }
  }

  if (performanceBad && sevenDayPacePct >= 50) {
    const suggestedDailyBudget = clampBudgetChange(
      currentDailyBudget,
      currentDailyBudget * 0.85,
      cfg.budgetPacingMode,
    )
    if (suggestedDailyBudget < currentDailyBudget) {
      return {
        decision: "suggest",
        reasonCode: "budget_reduce_for_efficiency",
        suggestedDailyBudget,
        severity: "warn",
        reason: `${campaignName} 캠페인의 최근 7일 효율이 목표 대비 낮습니다. 예산 소진은 이어지고 있어 일예산을 ${suggestedDailyBudget.toLocaleString()}원으로 감액 권고합니다.`,
        meta,
      }
    }
  }

  return { decision: "hold", reasonCode: "budget_within_band" }
}

async function processBudgetSuggestions(
  advertiserId: string,
  cfg: BudgetConfig,
): Promise<BudgetSuggestionStats> {
  const stats: BudgetSuggestionStats = {
    scanned: 0,
    created: 0,
    updated: 0,
    dismissed: 0,
  }

  const campaigns = await prisma.campaign.findMany({
    where: {
      advertiserId,
      status: { not: "deleted" },
      dailyBudget: { not: null },
    },
    select: {
      id: true,
      nccCampaignId: true,
      name: true,
      dailyBudget: true,
    },
  })
  if (campaigns.length === 0) return stats

  const since = addDays(new Date(), -STATS_WINDOW_DAYS)
  const yesterday = addDays(new Date(), -1)
  const yesterdayDate = new Date(Date.UTC(
    yesterday.getUTCFullYear(),
    yesterday.getUTCMonth(),
    yesterday.getUTCDate(),
  ))
  const cost7d = await prisma.statDaily.groupBy({
    by: ["refId"],
    where: {
      advertiserId,
      level: "campaign",
      refId: { in: campaigns.map((c) => c.nccCampaignId) },
      date: { gte: since },
    },
    _sum: {
      cost: true,
      conversions: true,
      revenue: true,
    },
  })
  const costYesterday = await prisma.statDaily.groupBy({
    by: ["refId"],
    where: {
      advertiserId,
      level: "campaign",
      refId: { in: campaigns.map((c) => c.nccCampaignId) },
      date: yesterdayDate,
    },
    _sum: { cost: true },
  })

  const sevenDayById = new Map(cost7d.map((r) => [r.refId, r]))
  const yesterdayById = new Map(costYesterday.map((r) => [r.refId, r]))
  const expiresAt = addDays(new Date(), SUGGESTION_TTL_DAYS)

  for (const c of campaigns) {
    stats.scanned++
    const budget = Number(c.dailyBudget ?? 0)
    if (budget <= 0) continue
    const sevenDay = sevenDayById.get(c.nccCampaignId)
    const yesterdayRow = yesterdayById.get(c.nccCampaignId)
    const decision = decideBudgetSuggestion({
      campaignName: c.name,
      currentDailyBudget: budget,
      costYesterday: yesterdayRow?._sum.cost ? Number(yesterdayRow._sum.cost) : 0,
      cost7d: sevenDay?._sum.cost ? Number(sevenDay._sum.cost) : 0,
      conversions7d: sevenDay?._sum.conversions ?? null,
      revenue7d: sevenDay?._sum.revenue ? Number(sevenDay._sum.revenue) : null,
      cfg,
    })

    const existing = await prisma.bidSuggestion.findFirst({
      where: {
        advertiserId,
        engineSource: "budget",
        status: "pending",
        action: {
          path: ["campaignId"],
          equals: c.id,
        },
      },
      select: { id: true },
    })

    if (decision.decision === "suggest") {
      const action = {
        kind: "campaign_budget_update",
        campaignId: c.id,
        nccCampaignId: c.nccCampaignId,
        currentDailyBudget: budget,
        suggestedDailyBudget: decision.suggestedDailyBudget,
        reasonCode: decision.reasonCode,
        metrics: decision.meta,
        items: [
          {
            campaignId: c.id,
            nccCampaignId: c.nccCampaignId,
            currentDailyBudget: budget,
            suggestedDailyBudget: decision.suggestedDailyBudget,
            reasonCode: decision.reasonCode,
          },
        ],
      } satisfies Prisma.InputJsonValue

      const data = {
        advertiserId,
        keywordId: null,
        adgroupId: null,
        engineSource: "budget" as const,
        action,
        reason: decision.reason,
        severity: decision.severity,
        status: "pending" as const,
        expiresAt,
      }
      if (existing) {
        await prisma.bidSuggestion.update({
          where: { id: existing.id },
          data: {
            action: data.action,
            reason: data.reason,
            severity: data.severity,
            expiresAt,
          },
        })
        stats.updated++
      } else {
        await prisma.bidSuggestion.create({ data })
        stats.created++
      }
    } else if (existing) {
      const r = await prisma.bidSuggestion.updateMany({
        where: { id: existing.id, status: "pending" },
        data: { status: "dismissed" },
      })
      stats.dismissed += r.count
    }
  }

  return stats
}

async function processAdvertiser(advertiserId: string): Promise<AdvertiserStats> {
  const stats: AdvertiserStats = {
    scanned: 0,
    budgetScanned: 0,
    created: 0,
    updated: 0,
    dismissed: 0,
    bundlesCreated: 0,
    bundlesDismissed: 0,
    singlesCreated: 0,
    singlesUpdated: 0,
    singlesDismissed: 0,
    stale: false,
  }

  // -- a. automation config 로드 (없거나 off 면 skip — 운영자 명시 활성화 필요) ---
  const cfg = await prisma.bidAutomationConfig.findUnique({
    where: { advertiserId },
  })
  if (!cfg || cfg.mode === "off") {
    return stats
  }

  // -- a-2. stat-daily stale 차단 (Phase 7) --------------------------------
  // 본 cron 은 StatDaily 7d groupBy 결과에 권고를 의존 — 적재가 정체된 광고주는
  // 잘못된 권고 생성 위험. lastSyncAt 은 stat 키 미보유 (5종 sync 만 추적) →
  // StatDaily.updatedAt 광고주별 max 로 stale 판정.
  // 신규 광고주 (StatDaily 0행) 는 skip 안 함 — baseline 가드(KeywordPerformanceProfile
  // dataDays=0) 가 따로 처리.
  const lastStat = await prisma.statDaily.findFirst({
    where: { advertiserId },
    select: { updatedAt: true },
    orderBy: { updatedAt: "desc" },
  })
  if (lastStat?.updatedAt) {
    const ageHours =
      (Date.now() - lastStat.updatedAt.getTime()) / (1000 * 60 * 60)
    if (ageHours > STAT_STALENESS_HOURS) {
      stats.stale = true
      return stats
    }
  }
  const targets: AutomationTargets = {
    targetCpc: cfg?.targetCpc ?? null,
    maxCpc: cfg?.maxCpc ?? null,
    minCtr: cfg?.minCtr ?? null,
    targetAvgRank: cfg?.targetAvgRank ?? null,
    targetCpa: cfg?.targetCpa ?? null,
    targetRoas: cfg?.targetRoas ?? null,
  }

  const budgetStats = await processBudgetSuggestions(advertiserId, {
    budgetPacingMode: cfg.budgetPacingMode,
    targetCpa: cfg.targetCpa ?? null,
    targetRoas: cfg.targetRoas ?? null,
  })
  stats.budgetScanned += budgetStats.scanned
  stats.created += budgetStats.created
  stats.updated += budgetStats.updated
  stats.dismissed += budgetStats.dismissed

  // -- c. baseline 로드 -----------------------------------------------------
  const kpp = await prisma.keywordPerformanceProfile.findUnique({
    where: { advertiserId },
  })
  if (!kpp || kpp.dataDays === 0) {
    return stats // baseline 없음 — bid 엔진만 다음 cron 까지 대기
  }
  const baseline: AdvertiserBaselineInput = {
    avgCtr: kpp.avgCtr,
    avgCvr: kpp.avgCvr,
    avgCpc: kpp.avgCpc,
  }

  // -- d. BiddingPolicy 등록 키워드 (자동 실행 대상 — 본 cron 제외) -----------
  const policyKeywords = await prisma.biddingPolicy.findMany({
    where: { advertiserId, enabled: true },
    select: { keywordId: true },
  })
  const policyKeywordIds = new Set(policyKeywords.map((p) => p.keywordId))

  // -- e. TOP N — StatDaily level='keyword' 7일 cost 큰 순 -------------------
  const since = addDays(new Date(), -STATS_WINDOW_DAYS)
  const top = await prisma.statDaily.groupBy({
    by: ["refId"],
    where: {
      advertiserId,
      level: "keyword",
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
    orderBy: { _sum: { cost: "desc" } },
    take: TOP_N,
  })

  if (top.length === 0) {
    return stats // 데이터 없음
  }

  // -- f. Keyword 매핑 — adgroup name 까지 조인 (묶음 표시명 캐시) ----------
  const nccIds = top.map((t) => t.refId)
  const keywords = await prisma.keyword.findMany({
    where: {
      nccKeywordId: { in: nccIds },
      status: { not: "deleted" },
    },
    select: {
      id: true,
      nccKeywordId: true,
      bidAmt: true,
      useGroupBidAmt: true,
      userLock: true,
      adgroup: { select: { id: true, name: true } },
    },
  })
  const keywordMap = new Map(keywords.map((k) => [k.nccKeywordId, k]))

  // -- g. Pass 1 — 키워드별 결정 수집 ---------------------------------------
  const decisions: BundleInputDecision[] = []
  const heldKeywordIds: string[] = [] // hold + dismiss-eligible 키워드 (단건 정리용)

  for (const row of top) {
    stats.scanned++
    const k = keywordMap.get(row.refId)
    if (!k) continue
    if (k.userLock) continue
    if (policyKeywordIds.has(k.id)) continue
    if (k.useGroupBidAmt || k.bidAmt == null || k.bidAmt <= 0) continue

    const sum = row._sum
    const keywordPerf: KeywordPerfInput = {
      keywordId: k.id,
      nccKeywordId: k.nccKeywordId,
      currentBid: k.bidAmt,
      clicks7d: sum.clicks ?? 0,
      impressions7d: sum.impressions ?? 0,
      cost7d: sum.cost ? Number(sum.cost) : 0,
      conversions7d: sum.conversions ?? null,
      revenue7d: sum.revenue ? Number(sum.revenue) : null,
      avgRank7d: row._avg.avgRnk != null ? Number(row._avg.avgRnk) : null,
    }

    const decision: MarginalDecision = decideMarginalSuggestion({
      keyword: keywordPerf,
      baseline,
      targets,
    })

    if (decision.decision === "hold") {
      // hold 는 묶음 비대상 — 기존 단건 dismiss 흐름만 유지.
      if (decision.reason !== "low_confidence_data") {
        heldKeywordIds.push(k.id)
      }
      continue
    }

    decisions.push({
      decision,
      keywordId: k.id,
      adgroupId: k.adgroup.id,
      adgroupName: k.adgroup.name,
    })
  }

  // -- h. Pass 2 — 묶음 / 단건 분리 ------------------------------------------
  const { bundles, fallbackSingles } = bundleSuggestions(decisions)
  const expiresAt = addDays(new Date(), SUGGESTION_TTL_DAYS)

  // -- i. 기존 묶음 권고 supersede — 옵션 B (단순 / 변동 키워드 셋에 강건) ---
  // 같은 광고주의 status='pending' AND scope='adgroup' AND engineSource='bid' 묶음을
  // dismiss 처리. 이번 cron 결과가 새로운 진실. 묶음 키워드 셋이 변동돼도 안전.
  // dismiss 사유는 reason 본문 prefix 로 표식 (운영자 inbox 에서 supersede 표시 후속).
  const supersededBundles = await prisma.bidSuggestion.updateMany({
    where: {
      advertiserId,
      engineSource: "bid",
      scope: "adgroup",
      status: "pending",
    },
    data: {
      status: "dismissed",
      reason: "superseded_by_new_bundle",
    },
  })
  stats.bundlesDismissed += supersededBundles.count
  stats.dismissed += supersededBundles.count

  // -- j. 묶음 신규 생성 -----------------------------------------------------
  for (const b of bundles) {
    const action = {
      kind: "keyword_bid_bundle",
      adgroupId: b.adgroupId,
      direction: b.direction,
      reasonCode: b.reasonCode,
      avgDeltaPct: b.avgDeltaPct,
      itemCount: b.items.length,
    } satisfies Prisma.InputJsonValue

    const reason =
      `${b.adgroupName} 광고그룹의 ${b.items.length}개 키워드 입찰가 ` +
      `${b.direction === "up" ? "인상" : "인하"} 권고 (평균 ±${b.avgDeltaPct.toFixed(1)}% / ${b.reasonCode})`

    await prisma.bidSuggestion.create({
      data: {
        advertiserId,
        keywordId: null,
        adgroupId: b.adgroupId,
        engineSource: "bid",
        action,
        reason,
        severity: b.maxSeverity,
        status: "pending",
        scope: "adgroup",
        affectedCount: b.items.length,
        targetName: b.adgroupName,
        itemsJson: b.items as unknown as Prisma.InputJsonValue,
        expiresAt,
      },
    })
    stats.bundlesCreated++
    stats.created++
  }

  // -- k. fallbackSingles 단건 BidSuggestion 적재 (기존 흐름 보존) ----------
  for (const fs of fallbackSingles) {
    if (fs.decision.decision !== "suggest") continue
    const existing = await prisma.bidSuggestion.findFirst({
      where: {
        keywordId: fs.keywordId,
        engineSource: "bid",
        scope: "keyword",
        status: "pending",
      },
      select: { id: true },
    })
    const data = {
      advertiserId,
      keywordId: fs.keywordId,
      adgroupId: fs.adgroupId,
      engineSource: "bid" as const,
      action: fs.decision.action as unknown as Prisma.InputJsonValue,
      reason: fs.decision.reason,
      severity: fs.decision.severity,
      status: "pending" as const,
      scope: "keyword" as const,
      affectedCount: 1,
      expiresAt,
    }
    if (existing) {
      await prisma.bidSuggestion.update({
        where: { id: existing.id },
        data: {
          action: data.action,
          reason: data.reason,
          severity: data.severity,
          expiresAt,
        },
      })
      stats.singlesUpdated++
      stats.updated++
    } else {
      await prisma.bidSuggestion.create({ data })
      stats.singlesCreated++
      stats.created++
    }
  }

  // -- l. hold 된 키워드의 기존 단건 pending dismiss --------------------------
  if (heldKeywordIds.length > 0) {
    const r = await prisma.bidSuggestion.updateMany({
      where: {
        keywordId: { in: heldKeywordIds },
        engineSource: "bid",
        scope: "keyword",
        status: "pending",
      },
      data: { status: "dismissed" },
    })
    stats.singlesDismissed += r.count
    stats.dismissed += r.count
  }

  return stats
}

// =============================================================================
// 핵심 진입점
// =============================================================================

export async function GET(req: NextRequest): Promise<NextResponse<CronResponse>> {
  const ts = new Date().toISOString()

  // -- 1. CRON_SECRET 검증 ---------------------------------------------------
  const cronSecret = process.env.CRON_SECRET
  const auth = req.headers.get("authorization") ?? ""
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      {
        ok: false,
        advertisersTotal: 0,
        advertisersOk: 0,
        advertisersSkipped: 0,
        advertisersStale: 0,
        keywordsScanned: 0,
        budgetCampaignsScanned: 0,
        suggestionsCreated: 0,
        suggestionsUpdated: 0,
        suggestionsDismissed: 0,
        bundlesCreated: 0,
        bundlesDismissed: 0,
        singlesCreated: 0,
        singlesUpdated: 0,
        singlesDismissed: 0,
        ts,
        errors: [],
        error: "unauthorized",
      },
      { status: 401 },
    )
  }

  // -- 2. 활성 광고주 (mode='off' 제외 — config 없으면 default inbox 처리) ---
  const advertisers = await prisma.advertiser.findMany({
    where: { status: "active" },
    select: {
      id: true,
      bidAutomationConfig: { select: { mode: true } },
    },
    orderBy: { id: "asc" },
  })
  // config 없거나 mode='off' 광고주 사전 제외 — processAdvertiser 가 한 번 더 가드.
  const eligible = advertisers.filter(
    (a) =>
      a.bidAutomationConfig != null &&
      a.bidAutomationConfig.mode !== "off",
  )

  // -- 3. 광고주 직렬 처리 ---------------------------------------------------
  let advertisersOk = 0
  let advertisersSkipped = 0
  let advertisersStale = 0
  let keywordsScanned = 0
  let budgetCampaignsScanned = 0
  let suggestionsCreated = 0
  let suggestionsUpdated = 0
  let suggestionsDismissed = 0
  let bundlesCreated = 0
  let bundlesDismissed = 0
  let singlesCreated = 0
  let singlesUpdated = 0
  let singlesDismissed = 0
  const errors: CronError[] = []

  for (const adv of eligible) {
    try {
      const r = await processAdvertiser(adv.id)
      keywordsScanned += r.scanned
      budgetCampaignsScanned += r.budgetScanned
      suggestionsCreated += r.created
      suggestionsUpdated += r.updated
      suggestionsDismissed += r.dismissed
      bundlesCreated += r.bundlesCreated
      bundlesDismissed += r.bundlesDismissed
      singlesCreated += r.singlesCreated
      singlesUpdated += r.singlesUpdated
      singlesDismissed += r.singlesDismissed
      if (r.stale) advertisersStale++
      else if (r.scanned > 0 || r.budgetScanned > 0) advertisersOk++
      else advertisersSkipped++
    } catch (e) {
      const message = safeError(e)
      errors.push({ advertiserId: adv.id, message })
      console.error(
        `[cron/bid-suggest] advertiser=${adv.id} failed: ${message}`,
      )
    }
  }

  return NextResponse.json({
    ok: true,
    advertisersTotal: eligible.length,
    advertisersOk,
    advertisersSkipped,
    advertisersStale,
    keywordsScanned,
    budgetCampaignsScanned,
    suggestionsCreated,
    suggestionsUpdated,
    suggestionsDismissed,
    bundlesCreated,
    bundlesDismissed,
    singlesCreated,
    singlesUpdated,
    singlesDismissed,
    ts,
    errors,
  })
}
