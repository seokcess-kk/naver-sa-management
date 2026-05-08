/**
 * Vercel Cron 핸들러 — 입찰 권고 (Phase B.2)
 *
 * 목적:
 *   - 광고주별 비용 TOP N 키워드에 대해 한계효용 권고 → BidSuggestion(Inbox) 적재
 *   - 운영 중인 캠페인의 5순위 미달 키워드 인상 권고 (Estimate 기반) → BidSuggestion(Inbox) 적재
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
 *      g. 각 키워드 마진얼/묶음 결정 (decideMarginalSuggestion)
 *      h. 운영 중 캠페인 > 키워드 중 recentAvgRnk > targetAvgRank 후보에 대해
 *         Estimate API (PC) 호출 → decideRankSuggestion → BidSuggestion(scope='keyword') 적재.
 *         같은 키워드의 marginal pending 권고가 있으면 rank 결과로 update (사용자 의도: rank 우선).
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
import { dispatch } from "@/lib/notifier"
import { shouldThrottle } from "@/lib/notifier/throttle"
import { STAT_DAILY_DEVICE_FILTER } from "@/lib/stat-daily/device-filter"
import {
  bundleSuggestions,
  DEFAULT_MARGINAL_CONFIG,
  decideMarginalSuggestion,
  type AdvertiserBaselineInput,
  type AutomationTargets,
  type BundleInputDecision,
  type KeywordPerfInput,
  type MarginalDecision,
} from "@/lib/auto-bidding/marginal-score"
import {
  decideAdgroupRankSuggestion,
  decideRankSuggestion,
} from "@/lib/auto-bidding/decide-rank"
import { getCachedAveragePositionBid } from "@/lib/auto-bidding/estimate-cached"
import type { AveragePositionBidRow } from "@/lib/naver-sa/estimate"
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
 * rank 권고 단계 — 광고주당 후보 키워드 상한.
 *
 * 매시간 cron 1회 × Estimate 호출 1회/키워드 = 광고주당 시간당 최대 ~500건 (env override 가능).
 * 캐시 hit 률이 높아지면 (30분 TTL) 실효 SA 호출은 절반 이하.
 * 광고주 ~10명 가정 시 시간당 ~5,000건 / 30분 캐시 hit 후 ~2,500건 — 안전 범위.
 */
const BID_RANK_PER_ADV_CAP = Number(process.env.BID_RANK_PER_ADV_CAP ?? "500")
/**
 * 광고그룹 단위 rank 권고 단계 — 광고주당 후보 광고그룹 상한 (Phase 2A).
 *
 * 키워드 단위와 별도 cap — 광고그룹은 키워드보다 카디널리티가 작으나 (수십 ~ 수백)
 * 메모리 가중평균 보정 / Estimate 호출 부담은 비슷. 기본 200 — 광고주당 시간당
 * 최대 200건 Estimate 호출. 캐시 hit 시 절반 이하.
 *
 * env 가드 — NaN / 음수 / 0 / 너무 큰 값 방어. 1~5000 범위 클램프 (W3 패턴).
 */
const BID_RANK_ADGROUP_PER_ADV_CAP = (() => {
  const raw = Number(process.env.BID_RANK_ADGROUP_PER_ADV_CAP ?? "200")
  if (!Number.isFinite(raw) || raw <= 0) return 200
  return Math.min(5000, Math.max(1, Math.floor(raw)))
})()
/**
 * rank 권고 단계 — 측정 평균 순위 가중평균 윈도 (시간).
 *
 * `Keyword.recentAvgRnk` 는 stat-hourly cron 의 last non-null 단일 시간값 — 노이즈 큼.
 * 본 윈도 내 `StatHourly` 행을 노출수로 가중평균 → 보다 안정된 effectiveRank 산출.
 * 기본 6 — 매시간 cron 의 1시간 신선도 + 6시간 평활화 균형.
 * 가중평균 행이 없으면 (노출 0 / NULL only) `Keyword.recentAvgRnk` fallback.
 */
/**
 * env 가드 — NaN / 음수 / 0 / 24h 초과 입력 방어 (W3).
 *   - 비정수 / 비유한수 → 기본 6
 *   - <= 0 → 기본 6 (가중평균 윈도가 0/음수면 의미 없음)
 *   - > 24 → 24로 클램프 (StatHourly 의미상 하루 이상은 무의미)
 *   - 소수 → floor (정수 시간만 의미 있음)
 */
const BID_RANK_RECENT_HOURS = (() => {
  const raw = Number(process.env.BID_RANK_RECENT_HOURS ?? "6")
  if (!Number.isFinite(raw) || raw <= 0) return 6
  return Math.min(24, Math.floor(raw))
})()
/**
 * rank 권고 단계 — Estimate 디바이스 범위.
 *
 * - "PC" — PC Estimate 만 호출 (기존 동작 호환).
 * - "BOTH" — PC + MOBILE 둘 다 호출. `decideRankSuggestion` 이 `max(pcBid, mobileBid)` 로
 *   보수적 정책 (PC·MOBILE 둘 다 5위 도달 보장). MOBILE 호출만 throw 하면 PC 결과로 진행
 *   (가용성 우선 fallback).
 *
 * 측정값 (StatHourly) 은 device='ALL' 만 적재 가능 (네이버 SA hh24 × pcMblTp 동시 breakdown
 * 미지원) — 본 토글은 Estimate 만 분리.
 */
const BID_RANK_DEVICE_SCOPE: "PC" | "BOTH" = (() => {
  const raw = process.env.BID_RANK_DEVICE_SCOPE ?? "BOTH"
  if (raw !== "PC" && raw !== "BOTH") return "BOTH"
  return raw as "PC" | "BOTH"
})()
/** KST = UTC+9. (ingest.ts 의 KST_OFFSET_MS 와 동일 — 본 모듈도 inline 사용). */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000
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
  /** rank 권고 단계 — recentAvgRnk > targetAvgRank 후보 스캔 수. */
  rankCandidatesScanned: number
  /** rank 권고 단계 — BidSuggestion 신규 생성 (scope='keyword', engineSource='bid'). */
  rankCreated: number
  /** rank 권고 단계 — 기존 pending 권고 update 으로 덮어쓴 카운트. */
  rankUpdated: number
  /** rank 권고 단계 — Estimate < currentBid 등 hold ('estimate_below_current' / 'estimate_position_not_found' 등). */
  rankHoldNotReached: number
  /** rank 권고 단계 — maxCpc 클램프 후 currentBid 이하 ('capped_at_max_cpc') 카운트. */
  rankCappedAtMaxCpc: number
  /** rank 권고 단계 — Estimate 호출 throw 카운트 (cron 진행은 계속). */
  rankEstimateFailed: number
  /**
   * rank 권고 단계 — `effectiveRank` 산출에 StatHourly 6h 가중평균을 사용한 권고 수.
   * (suggest 결과만 카운트 — hold 는 비대상)
   */
  rankWeightedSourceCount: number
  /**
   * rank 권고 단계 — `effectiveRank` 산출에 `Keyword.recentAvgRnk` (last non-null) 만
   * 사용한 권고 수. StatHourly 6h 윈도에 노출 0 / NULL only 인 키워드 fallback.
   */
  rankFallbackSourceCount: number
  /**
   * rank 권고 단계 — stale 정리 (W4): 5위 도달 / 비활성화 / 그룹입찰 전환 / 정책 등록 등으로
   * 후보에서 빠진 키워드의 기존 `below_target_rank` pending 권고 dismiss 수.
   * marginal 권고 (다른 reasonCode) 는 영향 없음.
   */
  rankStaleDismissed: number
  // -- 광고그룹 단위 rank 권고 (Phase 2A) ------------------------------------
  /** 광고그룹 단위 후보 스캔 수 (effectiveRank > target 인 광고그룹). */
  adgroupRankCandidatesScanned: number
  /** 신규 BidSuggestion (scope='adgroup', reasonCode='adgroup_below_target_rank'). */
  adgroupRankCreated: number
  /** 기존 pending 광고그룹 권고 update 으로 덮어쓴 카운트. */
  adgroupRankUpdated: number
  /** 광고그룹 권고 hold (estimate_below_current / estimate_position_not_found 등). */
  adgroupRankHoldNotReached: number
  /** 광고그룹 권고 maxCpc 클램프 후 currentBid 이하 (capped_at_max_cpc) 카운트. */
  adgroupRankCappedAtMaxCpc: number
  /** 광고그룹 권고 Estimate 호출 throw (대표 키워드 단위 흡수). */
  adgroupRankEstimateFailed: number
  /** 광고그룹 권고 — StatHourly 가중평균 사용 권고 수 (suggest 만). */
  adgroupRankWeightedSourceCount: number
  /** 광고그룹 권고 — Keyword.recentAvgRnk 단순 평균 fallback 사용 권고 수 (suggest 만). */
  adgroupRankFallbackSourceCount: number
  /** 광고그룹 권고 stale 정리 (W4) — 후보에서 빠진 광고그룹의 기존 pending dismiss 수. */
  adgroupRankStaleDismissed: number
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
  /** rank 권고 단계 — 후보 키워드 스캔 수. */
  rankCandidatesScanned: number
  /** rank 권고 단계 — 신규 BidSuggestion create. */
  rankCreated: number
  /** rank 권고 단계 — 기존 pending update 덮어쓰기. */
  rankUpdated: number
  /** rank 권고 단계 — Estimate hold (목표 도달 불가 / position 누락 / Estimate <= currentBid). */
  rankHoldNotReached: number
  /** rank 권고 단계 — maxCpc 클램프 후 currentBid 이하 hold. */
  rankCappedAtMaxCpc: number
  /** rank 권고 단계 — Estimate 호출 throw 카운트 (키워드 단위 흡수). */
  rankEstimateFailed: number
  /** rank 권고 단계 — StatHourly 6h 가중평균 사용 권고 수 (suggest 만). */
  rankWeightedSourceCount: number
  /** rank 권고 단계 — Keyword.recentAvgRnk fallback 사용 권고 수 (suggest 만). */
  rankFallbackSourceCount: number
  /** rank 권고 단계 — stale 정리 (W4): 후보에서 빠진 키워드의 기존 below_target_rank pending dismiss 수. */
  rankStaleDismissed: number
  // -- 광고그룹 단위 rank 권고 (Phase 2A) ------------------------------------
  adgroupRankCandidatesScanned: number
  adgroupRankCreated: number
  adgroupRankUpdated: number
  adgroupRankHoldNotReached: number
  adgroupRankCappedAtMaxCpc: number
  adgroupRankEstimateFailed: number
  adgroupRankWeightedSourceCount: number
  adgroupRankFallbackSourceCount: number
  adgroupRankStaleDismissed: number
}

type BudgetSuggestionStats = {
  scanned: number
  created: number
  updated: number
  dismissed: number
}

export type BudgetConfig = {
  budgetPacingMode: "focus" | "explore" | "protect"
  targetCpa: number | null
  targetRoas: Prisma.Decimal | number | null
}

export type BudgetDecision =
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

export function roundBudget(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.round(v / 1000) * 1000)
}

export function clampBudgetChange(
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

export function decideBudgetSuggestion(input: {
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
      // device 이중집계 방지 — 옵션 B (PC + MOBILE). 자세한 근거는
      // lib/stat-daily/device-filter.ts 참조.
      ...STAT_DAILY_DEVICE_FILTER,
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
      ...STAT_DAILY_DEVICE_FILTER,
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

// =============================================================================
// processRankSuggestions — 5순위 미달 키워드 인상 권고 (Phase B.2 rank step)
// =============================================================================
//
// 진입 가정 (호출부):
//   - BidAutomationConfig.mode != 'off' (이미 가드)
//   - stat-daily stale 가드 통과
//   - cfg.targetAvgRank 정규화는 decideRankSuggestion 내부 처리 (NULL → 5)
//
// 후보 추출:
//   - 운영 중 (Campaign.status='on' AND AdGroup.status='on' AND Keyword.status='on')
//   - useGroupBidAmt=false / userLock=false / bidAmt > 0 (명시 입찰만)
//   - recentAvgRnk > targetAvgRank (목표 미달)
//   - BiddingPolicy.enabled=true 키워드 제외 (auto-bidding cron 책임)
//   - 광고주당 BID_RANK_PER_ADV_CAP 상한 — recentAvgRnk desc (가장 미달인 키워드 우선)
//
// 처리:
//   - Estimate API (PC) 호출 — 30분 캐시 우선 (estimate-cached.ts)
//   - decideRankSuggestion → suggest 면 BidSuggestion upsert (scope='keyword', engineSource='bid')
//   - 같은 키워드의 marginal 흐름 권고가 있어도 update 으로 덮어쓰기 (rank 우선 정책)
//   - Estimate throw 는 키워드 단위 흡수 → rankEstimateFailed++
//
// 디바이스:
//   - PC 만 (1차 PR). MOBILE 확장은 운영 후 후속.

type RankSuggestionStats = {
  candidatesScanned: number
  created: number
  updated: number
  holdNotReached: number
  cappedAtMaxCpc: number
  estimateFailed: number
  /** StatHourly 6h 가중평균 사용 (suggest 만 카운트). */
  weightedSourceCount: number
  /** Keyword.recentAvgRnk fallback 사용 (suggest 만 카운트). */
  fallbackSourceCount: number
  /**
   * stale 정리 — 이번 cron run 에서 effectiveRank > target 후보로 진입하지 않은
   * 키워드의 기존 `reasonCode='below_target_rank'` pending 권고를 dismiss 처리한 수.
   * 사유: 5위 도달 / 비활성화 / 그룹입찰 전환 / 정책 등록 / userLock / 캠페인 OFF 등.
   * marginal 권고 (다른 reasonCode) 는 action.reasonCode JSON path 매칭으로 보존.
   */
  staleDismissed: number
}

/**
 * KST 기준 최근 N시간 윈도의 (date, hour) 페어 N 개 생성.
 *
 * cron 시작 시각의 KST 시각을 hour 정밀도로 floor → 그 시각 포함 직전 N시간.
 * 예: now=2026-05-08 14:35 KST, hours=6 → KST { (5-8, 14), (5-8, 13), ..., (5-8, 9) } 6개.
 * 자정 cross 시 일자 자동 변경 (5-8 00:30 KST + hours=6 → 5-8 00, 5-7 23..19).
 *
 * date 는 "그 KST 일자 0시"의 절대 epoch (UTC 로는 -9h) — StatHourly.date 와 일치.
 * hour 는 0..23 (KST 시각) — StatHourly.hour 와 일치.
 *
 * 본 모듈 inline 헬퍼 (lib/stat-hourly/ingest.ts 의 previousHourKstAsUtc 와 같은 패턴).
 */
function recentHourPairsKst(
  now: Date,
  hours: number,
): { date: Date; hour: number }[] {
  if (hours <= 0) return []
  // now 의 KST 시각으로 환산.
  const kstNow = new Date(now.getTime() + KST_OFFSET_MS)
  // KST hour 단위 floor (정시).
  const kstHourFloor = new Date(kstNow.getTime())
  kstHourFloor.setUTCMinutes(0, 0, 0)

  const pairs: { date: Date; hour: number }[] = []
  for (let i = 0; i < hours; i++) {
    const slot = new Date(kstHourFloor.getTime() - i * 60 * 60 * 1000)
    const y = slot.getUTCFullYear()
    const m = slot.getUTCMonth()
    const d = slot.getUTCDate()
    const hour = slot.getUTCHours()
    const kstDay0 = new Date(Date.UTC(y, m, d))
    const date = new Date(kstDay0.getTime() - KST_OFFSET_MS)
    pairs.push({ date, hour })
  }
  return pairs
}

/**
 * 광고주의 StatHourly 최근 N시간 keyword level 행을 노출수 가중으로 집계.
 *
 * 가중평균 = Σ(impressions * recentAvgRnk) / Σ(impressions).
 * 노출 0 / recentAvgRnk NULL 행은 자연 제외 (분모/분자 0 가산 — Map 미등록).
 *
 * 결과: nccKeywordId → { weightedAvgRnk, impressions } Map.
 *
 * Prisma `(date, hour)` 페어 OR 조회 — 광고주당 ~5,000 키워드 × 6시간 ≈ 30k 행 fetch.
 * `[advertiserId, date, hour]` 인덱스 활용. 메모리 부담 수백 KB.
 *
 * raw SQL groupBy 가중평균 최적화는 후속 PR (1차는 메모리 집계 OK).
 */
async function loadWeightedRankMap(args: {
  advertiserId: string
  cronStartedAt: Date
  hours: number
}): Promise<Map<string, { weightedAvgRnk: number; impressions: number }>> {
  const { advertiserId, cronStartedAt, hours } = args
  const result = new Map<string, { weightedAvgRnk: number; impressions: number }>()
  const pairs = recentHourPairsKst(cronStartedAt, hours)
  if (pairs.length === 0) return result

  const rows = await prisma.statHourly.findMany({
    where: {
      advertiserId,
      level: "keyword",
      // device='ALL' 명시 — lib/stat-hourly/ingest.ts 의 단일 적재 정책 (schema StatDevice
      // 주석 참조). 향후 PC/MOBILE 분리 적재가 도입되면 같은 (date, hour, level, refId)
      // 조합에 ALL + PC + MOBILE 3행 공존 → device 필터 누락 시 impressions 가 ~3배로
      // 부풀어 가중평균 왜곡. StatDaily 가 STAT_DAILY_DEVICE_FILTER (PC + MOBILE) 로 같은
      // 가드를 적용하는 것과 같은 사유.
      device: "ALL",
      OR: pairs.map((p) => ({ date: p.date, hour: p.hour })),
      // recentAvgRnk null 행은 Prisma 가 어차피 가중평균에서 제외하므로 SQL 가드 생략.
      // impressions 도 0 행 다수 존재 — 메모리에서 0 가산은 noop.
    },
    select: {
      refId: true,
      impressions: true,
      recentAvgRnk: true,
    },
  })

  // refId → { sumWeighted, sumImp }
  const accum = new Map<string, { sumWeighted: number; sumImp: number }>()
  for (const r of rows) {
    if (r.recentAvgRnk == null) continue
    const imp = r.impressions
    if (imp <= 0) continue
    const rnk = Number(r.recentAvgRnk)
    if (!Number.isFinite(rnk) || rnk <= 0) continue
    const cur = accum.get(r.refId) ?? { sumWeighted: 0, sumImp: 0 }
    cur.sumWeighted += imp * rnk
    cur.sumImp += imp
    accum.set(r.refId, cur)
  }
  for (const [refId, agg] of accum) {
    if (agg.sumImp <= 0) continue
    const weighted = agg.sumWeighted / agg.sumImp
    if (!Number.isFinite(weighted) || weighted <= 0) continue
    result.set(refId, {
      weightedAvgRnk: weighted,
      impressions: agg.sumImp,
    })
  }
  return result
}

async function processRankSuggestions(args: {
  advertiserId: string
  customerId: string
  targetAvgRank: number | Prisma.Decimal | null
  maxCpc: number | null
  policyKeywordIds: Set<string>
  cronStartedAt: Date
  /**
   * 호출자가 미리 빌드한 StatHourly 가중평균 Map (Phase 2A).
   * 키워드 단위 / 광고그룹 단위 권고가 같은 광고주에서 동일 데이터에 두 번 fetch 하지 않도록
   * processAdvertiser 가 한 번 빌드하고 두 함수에 전달. 미전달 시 fallback 으로 자체 빌드.
   */
  weightedMap?: Map<string, { weightedAvgRnk: number; impressions: number }>
}): Promise<RankSuggestionStats> {
  const {
    advertiserId,
    customerId,
    targetAvgRank,
    maxCpc,
    policyKeywordIds,
    cronStartedAt,
  } = args
  const stats: RankSuggestionStats = {
    candidatesScanned: 0,
    created: 0,
    updated: 0,
    holdNotReached: 0,
    cappedAtMaxCpc: 0,
    estimateFailed: 0,
    weightedSourceCount: 0,
    fallbackSourceCount: 0,
    staleDismissed: 0,
  }

  // -- 후보 추출 ------------------------------------------------------------
  // schema.prisma 기준 enum 값:
  //   KeywordStatus / AdGroupStatus / CampaignStatus = 'on' / 'off' / 'deleted'
  // BiddingPolicy 는 1:N (Keyword.biddingPolicies) — Set 차단 (호출부가 전달).
  // recentAvgRnk Decimal 비교: targetAvgRank Number 정규화 후 prisma.Decimal 비교 가능하도록
  // findMany 에서 raw Decimal 그대로 받고 decideRankSuggestion 호출 직전 Number 변환.
  const target =
    targetAvgRank == null
      ? 5
      : typeof targetAvgRank === "number"
        ? targetAvgRank
        : Number(targetAvgRank)

  // -- StatHourly 6h 가중평균 — 후보 보정 / OR 후보 포함 --------------------
  // last non-null `recentAvgRnk` 만 보면 단일 시간대 노이즈 / 입찰 직후 일시 부진이 권고에
  // 그대로 반영됨. 6시간 노출 가중평균을 산출해 effectiveRank 결정에 우선 적용 — 더 안정.
  // 가중평균 행이 없는 키워드 (StatHourly 노출 0 / NULL only) 는 Keyword.recentAvgRnk fallback.
  const weightedMap =
    args.weightedMap ??
    (await loadWeightedRankMap({
      advertiserId,
      cronStartedAt,
      hours: BID_RANK_RECENT_HOURS,
    }))
  // 가중평균이 target 미달인 nccKeywordId 셋 — SQL OR 후보로 추가 (last non-null 은 도달했지만
  // 가중평균은 미달인 키워드도 Phase 2 메모리 컷으로 진입).
  const weightedMissedNccIds: string[] = []
  for (const [refId, w] of weightedMap) {
    if (w.weightedAvgRnk > target) weightedMissedNccIds.push(refId)
  }

  const candidates = await prisma.keyword.findMany({
    where: {
      adgroup: {
        is: {
          status: "on",
          campaign: { is: { status: "on" } },
        },
      },
      status: "on",
      useGroupBidAmt: false,
      userLock: false,
      bidAmt: { not: null, gt: 0 },
      OR: [
        // 기존: last non-null > target.
        { recentAvgRnk: { not: null, gt: target } },
        // 신규: 6h 가중평균 > target — last non-null 이 target 도달인 키워드도 포함.
        ...(weightedMissedNccIds.length > 0
          ? [{ nccKeywordId: { in: weightedMissedNccIds } }]
          : []),
      ],
    },
    select: {
      id: true,
      nccKeywordId: true,
      keyword: true,
      bidAmt: true,
      recentAvgRnk: true,
      adgroup: {
        select: {
          id: true,
          name: true,
          campaign: { select: { advertiserId: true } },
        },
      },
    },
    // SQL 1차 정렬은 last non-null desc — 메모리에서 effectiveRank desc 로 재정렬.
    orderBy: { recentAvgRnk: "desc" },
    // SQL 정렬·cap 은 effectiveRank 와 어긋날 수 있어 take 를 ×2 로 늘려 메모리 컷 보호.
    // 운영 부담 ↑ 우려 시 후속 PR 에서 raw SQL CTE 로 단일 정렬 + cap 으로 대체.
    take: BID_RANK_PER_ADV_CAP * 2,
  })

  // 광고주 횡단 차단 — Keyword 에는 advertiserId 없음. AdGroup -> Campaign.advertiserId 비교.
  // schema 상 adgroup.campaign 은 항상 존재하지만 일부 mock 구성 (campaign 필드 누락) 방어.
  const filtered = candidates.filter(
    (k) =>
      k.adgroup?.campaign?.advertiserId === advertiserId &&
      !policyKeywordIds.has(k.id),
  )

  // filtered.length === 0 이어도 마지막 stale dismiss (W4) 흐름까지 도달해야 함.
  // 모든 운영 중 키워드가 5위 도달했거나 비활성화된 경우 — 기존 below_target_rank pending 정리.

  // -- effectiveRank 산출 + 메모리 정렬·cap ----------------------------------
  // weightedMap 우선 — 없으면 last non-null fallback. effectiveRank <= target 인 키워드는
  // (가중평균 보정으로 도달 가능) 권고 비대상 — 컷.
  type EnrichedCandidate = {
    k: (typeof filtered)[number]
    effectiveRank: number
    source: "weighted_6h" | "last_non_null"
    sampleImpressions: number | null
  }
  const enriched: EnrichedCandidate[] = []
  for (const k of filtered) {
    const w = weightedMap.get(k.nccKeywordId)
    let effectiveRank: number
    let source: "weighted_6h" | "last_non_null"
    let sampleImpressions: number | null
    if (w != null) {
      effectiveRank = w.weightedAvgRnk
      source = "weighted_6h"
      sampleImpressions = w.impressions
    } else if (k.recentAvgRnk != null) {
      effectiveRank = Number(k.recentAvgRnk)
      source = "last_non_null"
      sampleImpressions = null
    } else {
      // 둘 다 없음 — 권고 비대상 (이론상 OR 조건상 도달 안 함).
      continue
    }
    if (!Number.isFinite(effectiveRank) || effectiveRank <= target) continue
    enriched.push({ k, effectiveRank, source, sampleImpressions })
  }
  enriched.sort((a, b) => b.effectiveRank - a.effectiveRank)
  const limited = enriched.slice(0, BID_RANK_PER_ADV_CAP)

  // limited.length === 0 도 stale dismiss 흐름까지 도달 (W4).
  const expiresAt = addDays(new Date(), SUGGESTION_TTL_DAYS)

  for (const cand of limited) {
    const { k, effectiveRank, source, sampleImpressions } = cand
    stats.candidatesScanned++
    if (k.bidAmt == null || k.bidAmt <= 0) continue

    // -- Estimate 호출 (PC + MOBILE) — 키워드 단위 try/catch ----------------
    // PC throw 시 키워드 1건 흡수 (기존 흐름). MOBILE 만 throw 시 PC 결과로 진행 (가용성 fallback).
    let estimateRowsPc: AveragePositionBidRow[]
    try {
      const cached = await getCachedAveragePositionBid({
        advertiserId,
        customerId,
        keywordId: k.id,
        keywordText: k.keyword,
        device: "PC",
      })
      estimateRowsPc = cached.data
    } catch (e) {
      stats.estimateFailed++
      console.warn(
        `[cron/bid-suggest] rank estimate (PC) failed advertiser=${advertiserId} keyword=${k.id}: ${safeError(e)}`,
      )
      continue
    }

    let estimateRowsMobile: AveragePositionBidRow[] | undefined
    if (BID_RANK_DEVICE_SCOPE === "BOTH") {
      try {
        const cached = await getCachedAveragePositionBid({
          advertiserId,
          customerId,
          keywordId: k.id,
          keywordText: k.keyword,
          device: "MOBILE",
        })
        estimateRowsMobile = cached.data
      } catch (e) {
        // MOBILE 호출만 실패 → PC 만으로 진행 (가용성 우선). 카운트는 PC와 통합 — 1차 PR.
        console.warn(
          `[cron/bid-suggest] rank estimate (MOBILE) failed advertiser=${advertiserId} keyword=${k.id}: ${safeError(e)}`,
        )
      }
    }

    // -- 결정 ----------------------------------------------------------------
    // effectiveRank 를 keyword.recentAvgRnk 로 전달 — decideRankSuggestion 시그니처 유지.
    // rankWindowHours / rankSampleImpressions 은 action 으로 passthrough (UI 라벨).
    const rankWindowHours = source === "weighted_6h" ? BID_RANK_RECENT_HOURS : null
    const decision = decideRankSuggestion({
      keyword: {
        keywordId: k.id,
        nccKeywordId: k.nccKeywordId,
        currentBid: k.bidAmt,
        recentAvgRnk: effectiveRank,
      },
      targetAvgRank,
      maxCpc,
      estimateRows: estimateRowsPc,
      estimateRowsMobile,
      rankWindowHours,
      rankSampleImpressions: sampleImpressions,
    })

    if (decision.decision === "hold") {
      // capped_at_max_cpc 는 별도 카운트 — Phase 2 'unreachable' 표시 가능성.
      if (decision.reason === "capped_at_max_cpc") {
        stats.cappedAtMaxCpc++
      } else {
        stats.holdNotReached++
      }
      continue
    }

    // -- reason 본문 출처 suffix (텔레그램 / 감사 로그용) ---------------------
    // action.rankWindowHours / rankSampleImpressions 은 UI 라벨용 — reason 본문은
    // 운영자가 inbox 에서 한눈에 출처를 보도록 명시.
    const reasonWithSource =
      source === "weighted_6h"
        ? `${decision.reason} (최근 ${BID_RANK_RECENT_HOURS}시간 가중평균, 노출 ${(sampleImpressions ?? 0).toLocaleString()}회 기반)`
        : `${decision.reason} (최근 1시간 측정값)`

    // -- 적재 (upsert: 같은 키워드 pending 1개 보장) ------------------------
    // marginal 권고 (engineSource='bid', scope='keyword', status='pending') 가 있으면
    // 같은 row 를 rank 결과로 덮어쓴다. 사용자 의도: rank 우선.
    const existing = await prisma.bidSuggestion.findFirst({
      where: {
        keywordId: k.id,
        engineSource: "bid",
        scope: "keyword",
        status: "pending",
      },
      select: { id: true },
    })

    const data = {
      advertiserId,
      keywordId: k.id,
      adgroupId: k.adgroup.id,
      engineSource: "bid" as const,
      action: decision.action as unknown as Prisma.InputJsonValue,
      reason: reasonWithSource,
      severity: decision.severity,
      status: "pending" as const,
      scope: "keyword" as const,
      affectedCount: 1,
      expiresAt,
    }

    if (existing) {
      await prisma.bidSuggestion.update({
        where: { id: existing.id },
        data: {
          adgroupId: data.adgroupId,
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
    if (source === "weighted_6h") stats.weightedSourceCount++
    else stats.fallbackSourceCount++
  }

  // -- stale 정리 (W4) ------------------------------------------------------
  // 이번 cron run 에서 effectiveRank > target 후보로 진입한 키워드 (`enriched`) 만
  // handledKeywordIds 로 보존 — cap 에 안 들어가 처리 안 된 키워드도 미달은 미달 → 보존.
  // 그 외 키워드 (도달 / 비활성화 / 그룹입찰 / 정책 등록 / userLock / 광고그룹·캠페인 OFF) 는
  // 후보 SQL 에서 빠져 enriched 에도 없음 → 기존 below_target_rank pending 권고는 stale.
  //
  // action JSON path 매칭 (`reasonCode='below_target_rank'`) 으로 marginal 권고 (다른
  // reasonCode 또는 reasonCode 부재) 는 영향 없음 — 광고주 격리 + scope='keyword' + status='pending'
  // 으로 광고주 횡단 / 묶음 / dismissed 이력 보호.
  const handledKeywordIds = enriched.map((e) => e.k.id)
  const staleResult = await prisma.bidSuggestion.updateMany({
    where: {
      advertiserId,
      engineSource: "bid",
      scope: "keyword",
      status: "pending",
      keywordId: { notIn: handledKeywordIds },
      action: {
        path: ["reasonCode"],
        equals: "below_target_rank",
      },
    },
    data: { status: "dismissed" },
  })
  stats.staleDismissed = staleResult.count

  return stats
}

// =============================================================================
// processAdgroupRankSuggestions — 광고그룹 default bid 인상 권고 (Phase 2A)
// =============================================================================
//
// 트리거:
//   - 광고그룹 단위 평균 노출 순위 미달 (target 디폴트 5위) → AdGroup.bidAmt 인상 권고
//   - 적용 단위: useGroupBidAmt=true 키워드 (그룹입찰가 사용)
//
// 후보 추출:
//   - 운영 중 (Campaign.status='on' AND AdGroup.status='on')
//   - AdGroup.bidAmt > 0
//   - useGroupBidAmt=true / userLock=false / status='on' 키워드 1+ 보유
//   - 그 키워드의 last non-null recentAvgRnk > target (1차 SQL 컷)
//
// effectiveRank 산출:
//   - weightedMap (StatHourly 6h 가중평균) 우선 — 광고그룹 단위로 재집계
//     (광고그룹 = Σ_keyword (weightedAvgRnk × impressions) / Σ_keyword impressions)
//   - weightedMap 미존재 → 광고그룹의 last non-null recentAvgRnk 단순 평균 (impressions 가중 불가)
//
// effectiveRank > target 인 광고그룹만 enriched. desc 정렬 + cap.
//
// 대표 키워드 선정:
//   - useGroupBidAmt=true 키워드 중 weightedMap 의 impressions TOP 1
//   - weightedMap 에 없으면 fallback (광고그룹의 첫 키워드)
//
// 처리:
//   - 대표 키워드로 PC Estimate (캐시 우선)
//   - decideAdgroupRankSuggestion → suggest 면 BidSuggestion upsert
//     (scope='adgroup', engineSource='bid', action.kind='adgroup_default_bid_update')
//   - 같은 광고그룹의 같은 kind pending 행만 update (kind='keyword_bid_bundle' 묶음 권고는 별개)
//   - Estimate throw 흡수 → adgroupRankEstimateFailed++
//
// stale 정리: 후보에서 빠진 광고그룹의 reasonCode='adgroup_below_target_rank' pending dismiss.

type AdgroupRankStats = {
  candidatesScanned: number
  created: number
  updated: number
  holdNotReached: number
  cappedAtMaxCpc: number
  estimateFailed: number
  weightedSourceCount: number
  fallbackSourceCount: number
  staleDismissed: number
}

/**
 * 광고그룹 단위 가중평균 산출 — weightedMap (키워드별) 을 광고그룹 단위로 재집계.
 *
 * 광고그룹 가중평균 = Σ_keyword (weightedAvgRnk × impressions) / Σ_keyword impressions
 *   (per_keyword: weightedAvgRnk × impressions = Σ_h(imp_h × rnk_h) — 키워드의 sumWeighted)
 *
 * useGroupBidAmt=true 키워드만 누적 (광고그룹 default bid 영향 키워드 한정).
 * 노출 0 / weightedMap 미등록 키워드는 자연 제외.
 */
function computeAdgroupWeighted(
  weightedMap: Map<string, { weightedAvgRnk: number; impressions: number }>,
  adgroupKeywords: { nccKeywordId: string }[],
): { weightedAvgRnk: number; impressions: number } | null {
  let sumWeighted = 0
  let sumImp = 0
  for (const k of adgroupKeywords) {
    const w = weightedMap.get(k.nccKeywordId)
    if (w == null) continue
    sumWeighted += w.weightedAvgRnk * w.impressions
    sumImp += w.impressions
  }
  if (sumImp <= 0) return null
  const weighted = sumWeighted / sumImp
  if (!Number.isFinite(weighted) || weighted <= 0) return null
  return { weightedAvgRnk: weighted, impressions: sumImp }
}

async function processAdgroupRankSuggestions(args: {
  advertiserId: string
  customerId: string
  targetAvgRank: number | Prisma.Decimal | null
  maxCpc: number | null
  weightedMap: Map<string, { weightedAvgRnk: number; impressions: number }>
  cronStartedAt: Date
}): Promise<AdgroupRankStats> {
  const {
    advertiserId,
    customerId,
    targetAvgRank,
    maxCpc,
    weightedMap,
  } = args
  const stats: AdgroupRankStats = {
    candidatesScanned: 0,
    created: 0,
    updated: 0,
    holdNotReached: 0,
    cappedAtMaxCpc: 0,
    estimateFailed: 0,
    weightedSourceCount: 0,
    fallbackSourceCount: 0,
    staleDismissed: 0,
  }

  const target =
    targetAvgRank == null
      ? 5
      : typeof targetAvgRank === "number"
        ? targetAvgRank
        : Number(targetAvgRank)

  // -- 후보 추출 ------------------------------------------------------------
  // 1차 SQL 컷: 광고그룹 내 useGroupBidAmt=true 키워드의 last non-null recentAvgRnk > target.
  // 가중평균 미달 광고그룹 OR 후보 SQL 확장은 1차 PR 비대상 — 메모리 보정으로 effectiveRank 결정.
  const adgroups = await prisma.adGroup.findMany({
    where: {
      campaign: { is: { advertiserId, status: "on" } },
      status: "on",
      bidAmt: { not: null, gt: 0 },
      keywords: {
        some: {
          status: "on",
          useGroupBidAmt: true,
          userLock: false,
          recentAvgRnk: { not: null, gt: target },
        },
      },
    },
    select: {
      id: true,
      nccAdgroupId: true,
      name: true,
      bidAmt: true,
      keywords: {
        where: {
          status: "on",
          useGroupBidAmt: true,
          userLock: false,
        },
        select: {
          id: true,
          nccKeywordId: true,
          keyword: true,
          recentAvgRnk: true,
        },
      },
    },
    take: BID_RANK_ADGROUP_PER_ADV_CAP * 2,
  })

  // -- effectiveRank 산출 + 메모리 cap --------------------------------------
  type EnrichedAdgroup = {
    adgroup: (typeof adgroups)[number]
    effectiveRank: number
    source: "weighted_6h" | "last_non_null"
    sampleImpressions: number | null
    /** 대표 키워드 (Estimate 호출 대상). useGroupBidAmt=true 키워드 중 노출 TOP 1. */
    representativeKeyword: (typeof adgroups)[number]["keywords"][number]
    /** useGroupBidAmt=true 키워드 수 (affectedCount). */
    affectedCount: number
  }
  const enriched: EnrichedAdgroup[] = []
  for (const ag of adgroups) {
    if (ag.keywords.length === 0) continue
    if (ag.bidAmt == null || ag.bidAmt <= 0) continue

    // -- effectiveRank ------------------------------------------------------
    const weighted = computeAdgroupWeighted(weightedMap, ag.keywords)
    let effectiveRank: number
    let source: "weighted_6h" | "last_non_null"
    let sampleImpressions: number | null
    if (weighted != null) {
      effectiveRank = weighted.weightedAvgRnk
      source = "weighted_6h"
      sampleImpressions = weighted.impressions
    } else {
      // fallback: last non-null 단순 평균 (impressions 가중 불가 — DB 에 없음).
      const ranks = ag.keywords
        .map((k) => (k.recentAvgRnk == null ? null : Number(k.recentAvgRnk)))
        .filter((r): r is number => r != null && Number.isFinite(r) && r > 0)
      if (ranks.length === 0) continue
      effectiveRank = ranks.reduce((s, r) => s + r, 0) / ranks.length
      source = "last_non_null"
      sampleImpressions = null
    }
    if (!Number.isFinite(effectiveRank) || effectiveRank <= target) continue

    // -- 대표 키워드 (노출 TOP 1) -------------------------------------------
    let representative = ag.keywords[0]
    let bestImp = -1
    for (const k of ag.keywords) {
      const w = weightedMap.get(k.nccKeywordId)
      if (w != null && w.impressions > bestImp) {
        bestImp = w.impressions
        representative = k
      }
    }

    enriched.push({
      adgroup: ag,
      effectiveRank,
      source,
      sampleImpressions,
      representativeKeyword: representative,
      affectedCount: ag.keywords.length,
    })
  }
  enriched.sort((a, b) => b.effectiveRank - a.effectiveRank)
  const limited = enriched.slice(0, BID_RANK_ADGROUP_PER_ADV_CAP)

  const expiresAt = addDays(new Date(), SUGGESTION_TTL_DAYS)

  for (const cand of limited) {
    const { adgroup, effectiveRank, source, sampleImpressions, representativeKeyword, affectedCount } = cand
    stats.candidatesScanned++
    if (adgroup.bidAmt == null || adgroup.bidAmt <= 0) continue

    // -- Estimate 호출 (PC + MOBILE) — 대표 키워드로 ------------------------
    // PC throw → 광고그룹 1건 흡수. MOBILE 만 throw → PC 결과로 진행 (가용성 우선).
    let estimateRowsPc: AveragePositionBidRow[]
    try {
      const cached = await getCachedAveragePositionBid({
        advertiserId,
        customerId,
        keywordId: representativeKeyword.id,
        keywordText: representativeKeyword.keyword,
        device: "PC",
      })
      estimateRowsPc = cached.data
    } catch (e) {
      stats.estimateFailed++
      console.warn(
        `[cron/bid-suggest] adgroup rank estimate (PC) failed advertiser=${advertiserId} adgroup=${adgroup.id} keyword=${representativeKeyword.id}: ${safeError(e)}`,
      )
      continue
    }

    let estimateRowsMobile: AveragePositionBidRow[] | undefined
    if (BID_RANK_DEVICE_SCOPE === "BOTH") {
      try {
        const cached = await getCachedAveragePositionBid({
          advertiserId,
          customerId,
          keywordId: representativeKeyword.id,
          keywordText: representativeKeyword.keyword,
          device: "MOBILE",
        })
        estimateRowsMobile = cached.data
      } catch (e) {
        console.warn(
          `[cron/bid-suggest] adgroup rank estimate (MOBILE) failed advertiser=${advertiserId} adgroup=${adgroup.id} keyword=${representativeKeyword.id}: ${safeError(e)}`,
        )
      }
    }

    // -- 결정 -----------------------------------------------------------------
    const rankWindowHours = source === "weighted_6h" ? BID_RANK_RECENT_HOURS : null
    const decision = decideAdgroupRankSuggestion({
      adgroup: {
        adgroupId: adgroup.id,
        nccAdgroupId: adgroup.nccAdgroupId,
        currentBid: adgroup.bidAmt,
        recentAvgRnk: effectiveRank,
      },
      targetAvgRank,
      maxCpc,
      estimateRows: estimateRowsPc,
      estimateRowsMobile,
      rankWindowHours,
      rankSampleImpressions: sampleImpressions,
    })

    if (decision.decision === "hold") {
      if (decision.reason === "capped_at_max_cpc") {
        stats.cappedAtMaxCpc++
      } else {
        stats.holdNotReached++
      }
      continue
    }

    // -- reason suffix (출처 / affectedCount) -------------------------------
    const reasonWithSource =
      source === "weighted_6h"
        ? `${decision.reason} (광고그룹 ${affectedCount}개 키워드 / 최근 ${BID_RANK_RECENT_HOURS}시간 가중평균, 노출 ${(sampleImpressions ?? 0).toLocaleString()}회 기반)`
        : `${decision.reason} (광고그룹 ${affectedCount}개 키워드 / 최근 1시간 측정값 단순 평균)`

    // -- upsert (같은 광고그룹의 같은 kind pending 행만 1개 보장) -------------
    // 묶음 권고 (kind='keyword_bid_bundle') 와 광고그룹 default bid 권고 (kind='adgroup_default_bid_update')
    // 는 같은 scope='adgroup' 행이지만 kind 가 다름 → action.kind path 매칭으로 분리.
    const existing = await prisma.bidSuggestion.findFirst({
      where: {
        adgroupId: adgroup.id,
        engineSource: "bid",
        scope: "adgroup",
        status: "pending",
        action: {
          path: ["kind"],
          equals: "adgroup_default_bid_update",
        },
      },
      select: { id: true },
    })

    const data = {
      advertiserId,
      keywordId: null,
      adgroupId: adgroup.id,
      engineSource: "bid" as const,
      action: decision.action as unknown as Prisma.InputJsonValue,
      reason: reasonWithSource,
      severity: decision.severity,
      status: "pending" as const,
      scope: "adgroup" as const,
      affectedCount,
      targetName: adgroup.name,
      expiresAt,
    }

    if (existing) {
      await prisma.bidSuggestion.update({
        where: { id: existing.id },
        data: {
          action: data.action,
          reason: data.reason,
          severity: data.severity,
          targetName: data.targetName,
          affectedCount: data.affectedCount,
          expiresAt,
        },
      })
      stats.updated++
    } else {
      await prisma.bidSuggestion.create({ data })
      stats.created++
    }
    if (source === "weighted_6h") stats.weightedSourceCount++
    else stats.fallbackSourceCount++
  }

  // -- stale 정리 (W4) ------------------------------------------------------
  // 이번 cron run 에서 effectiveRank > target 후보로 진입한 광고그룹 (`enriched`) 만
  // handledAdgroupIds 로 보존. 그 외 광고그룹 (도달 / 비활성화 / bidAmt=0) 의 기존
  // adgroup_below_target_rank pending 권고는 stale → dismiss.
  //
  // action JSON path 매칭 (`reasonCode='adgroup_below_target_rank'`) 으로 묶음 권고
  // (`reasonCode` 다름) 보존.
  const handledAdgroupIds = enriched.map((e) => e.adgroup.id)
  const staleResult = await prisma.bidSuggestion.updateMany({
    where: {
      advertiserId,
      engineSource: "bid",
      scope: "adgroup",
      status: "pending",
      adgroupId: { notIn: handledAdgroupIds },
      action: {
        path: ["reasonCode"],
        equals: "adgroup_below_target_rank",
      },
    },
    data: { status: "dismissed" },
  })
  stats.staleDismissed = staleResult.count

  return stats
}

async function processAdvertiser(
  advertiserId: string,
  customerId: string,
  cronStartedAt: Date,
): Promise<AdvertiserStats> {
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
    rankCandidatesScanned: 0,
    rankCreated: 0,
    rankUpdated: 0,
    rankHoldNotReached: 0,
    rankCappedAtMaxCpc: 0,
    rankEstimateFailed: 0,
    rankWeightedSourceCount: 0,
    rankFallbackSourceCount: 0,
    rankStaleDismissed: 0,
    adgroupRankCandidatesScanned: 0,
    adgroupRankCreated: 0,
    adgroupRankUpdated: 0,
    adgroupRankHoldNotReached: 0,
    adgroupRankCappedAtMaxCpc: 0,
    adgroupRankEstimateFailed: 0,
    adgroupRankWeightedSourceCount: 0,
    adgroupRankFallbackSourceCount: 0,
    adgroupRankStaleDismissed: 0,
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
  // 잘못된 권고 생성 위험.
  //   1순위: Advertiser.lastSyncAt['stat_daily'] (stat-daily cron 적재 성공 시 갱신).
  //   2순위(fallback): StatDaily.updatedAt 광고주별 max — lastSyncAt 키 도입 전
  //     광고주 호환. 모든 광고주에 키가 채워지면 자연 소멸.
  // 신규 광고주 (어느 쪽도 없음) → skip 안 함. baseline 가드(KeywordPerformanceProfile
  // dataDays=0) 가 따로 처리.
  const adv = await prisma.advertiser.findUnique({
    where: { id: advertiserId },
    select: { lastSyncAt: true },
  })
  const lastSyncMap =
    adv?.lastSyncAt && typeof adv.lastSyncAt === "object" && !Array.isArray(adv.lastSyncAt)
      ? (adv.lastSyncAt as Record<string, string>)
      : {}
  const lastStatIso = lastSyncMap["stat_daily"]
  let lastStatTime: Date | null = lastStatIso ? new Date(lastStatIso) : null
  if (!lastStatTime) {
    const lastStat = await prisma.statDaily.findFirst({
      where: { advertiserId },
      select: { updatedAt: true },
      orderBy: { updatedAt: "desc" },
    })
    lastStatTime = lastStat?.updatedAt ?? null
  }
  if (lastStatTime) {
    const ageHours =
      (Date.now() - lastStatTime.getTime()) / (1000 * 60 * 60)
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
  const confidenceDays = Math.max(1, Math.min(kpp.dataDays, STATS_WINDOW_DAYS))
  const confidenceProgress =
    STATS_WINDOW_DAYS <= 1
      ? 1
      : (confidenceDays - 1) / (STATS_WINDOW_DAYS - 1)
  const confidenceConfig =
    confidenceDays < STATS_WINDOW_DAYS
      ? {
          minClicksForConfidence: Math.ceil(
            5 +
              (DEFAULT_MARGINAL_CONFIG.minClicksForConfidence - 5) *
                confidenceProgress,
          ),
          minImpressionsForConfidence: Math.ceil(
            100 +
              (DEFAULT_MARGINAL_CONFIG.minImpressionsForConfidence - 100) *
                confidenceProgress,
          ),
        }
      : undefined

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
      // device 이중집계 방지 — 옵션 B (PC + MOBILE). 같은 (date, level, refId) 에
      // ALL 행이 공존하여 device 필터 누락 시 cost 가 ~2배로 부풀어 TOP N 권고 왜곡.
      ...STAT_DAILY_DEVICE_FILTER,
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
    // marginal 흐름 데이터 없음 — bid 엔진은 skip 하지만 rank 단계는 실행.
    // (rank 권고는 StatDaily TOP 의존 X — Keyword.recentAvgRnk 측정값 기반)
    //
    // weightedMap 을 한 번 빌드 후 두 rank 함수에 전달 — 같은 광고주의 StatHourly
    // 가중평균 fetch 가 한 cron 한 번만 발생.
    const sharedWeightedMap = await loadWeightedRankMap({
      advertiserId,
      cronStartedAt,
      hours: BID_RANK_RECENT_HOURS,
    })
    const rankStatsOnly = await processRankSuggestions({
      advertiserId,
      customerId,
      targetAvgRank: cfg.targetAvgRank ?? null,
      maxCpc: cfg.maxCpc ?? null,
      policyKeywordIds,
      cronStartedAt,
      weightedMap: sharedWeightedMap,
    })
    stats.rankCandidatesScanned += rankStatsOnly.candidatesScanned
    stats.rankCreated += rankStatsOnly.created
    stats.rankUpdated += rankStatsOnly.updated
    stats.rankHoldNotReached += rankStatsOnly.holdNotReached
    stats.rankCappedAtMaxCpc += rankStatsOnly.cappedAtMaxCpc
    stats.rankEstimateFailed += rankStatsOnly.estimateFailed
    stats.rankWeightedSourceCount += rankStatsOnly.weightedSourceCount
    stats.rankFallbackSourceCount += rankStatsOnly.fallbackSourceCount
    stats.rankStaleDismissed += rankStatsOnly.staleDismissed
    stats.created += rankStatsOnly.created
    stats.updated += rankStatsOnly.updated

    // 광고그룹 단위 rank 권고 (Phase 2A) — top=0 분기에서도 실행
    const adgroupRankStatsOnly = await processAdgroupRankSuggestions({
      advertiserId,
      customerId,
      targetAvgRank: cfg.targetAvgRank ?? null,
      maxCpc: cfg.maxCpc ?? null,
      weightedMap: sharedWeightedMap,
      cronStartedAt,
    })
    stats.adgroupRankCandidatesScanned += adgroupRankStatsOnly.candidatesScanned
    stats.adgroupRankCreated += adgroupRankStatsOnly.created
    stats.adgroupRankUpdated += adgroupRankStatsOnly.updated
    stats.adgroupRankHoldNotReached += adgroupRankStatsOnly.holdNotReached
    stats.adgroupRankCappedAtMaxCpc += adgroupRankStatsOnly.cappedAtMaxCpc
    stats.adgroupRankEstimateFailed += adgroupRankStatsOnly.estimateFailed
    stats.adgroupRankWeightedSourceCount += adgroupRankStatsOnly.weightedSourceCount
    stats.adgroupRankFallbackSourceCount += adgroupRankStatsOnly.fallbackSourceCount
    stats.adgroupRankStaleDismissed += adgroupRankStatsOnly.staleDismissed
    stats.created += adgroupRankStatsOnly.created
    stats.updated += adgroupRankStatsOnly.updated
    return stats
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
      config: confidenceConfig,
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
  // 같은 광고주의 status='pending' AND scope='adgroup' AND engineSource='bid' AND
  // action.kind='keyword_bid_bundle' 묶음을 dismiss 처리. 이번 cron 결과가 새로운 진실.
  // 묶음 키워드 셋이 변동돼도 안전.
  //
  // action.kind 필터 (Phase 2A) — 광고그룹 default bid 권고 (kind='adgroup_default_bid_update') 보호.
  // 같은 scope='adgroup' 행이지만 reasonCode 가 다른 행은 보존.
  const supersededBundles = await prisma.bidSuggestion.updateMany({
    where: {
      advertiserId,
      engineSource: "bid",
      scope: "adgroup",
      status: "pending",
      action: {
        path: ["kind"],
        equals: "keyword_bid_bundle",
      },
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

  // -- m. rank 권고 단계 — 5순위 미달 키워드 인상 권고 -----------------------
  // marginal/budget 흐름 후 별도 스캔. 같은 키워드의 marginal 권고가 있으면
  // rank 결과로 update 덮어쓰기 (사용자 의도: rank 우선).
  //
  // weightedMap 을 한 번 빌드 후 두 rank 함수에 전달 — 같은 광고주의 StatHourly
  // 가중평균 fetch 가 한 cron 한 번만 발생 (Phase 2A 광고그룹 권고 도입에 따른 최적화).
  const sharedWeightedMap = await loadWeightedRankMap({
    advertiserId,
    cronStartedAt,
    hours: BID_RANK_RECENT_HOURS,
  })
  const rankStats = await processRankSuggestions({
    advertiserId,
    customerId,
    targetAvgRank: cfg.targetAvgRank ?? null,
    maxCpc: cfg.maxCpc ?? null,
    policyKeywordIds,
    cronStartedAt,
    weightedMap: sharedWeightedMap,
  })
  stats.rankCandidatesScanned += rankStats.candidatesScanned
  stats.rankCreated += rankStats.created
  stats.rankUpdated += rankStats.updated
  stats.rankHoldNotReached += rankStats.holdNotReached
  stats.rankCappedAtMaxCpc += rankStats.cappedAtMaxCpc
  stats.rankEstimateFailed += rankStats.estimateFailed
  stats.rankWeightedSourceCount += rankStats.weightedSourceCount
  stats.rankFallbackSourceCount += rankStats.fallbackSourceCount
  stats.rankStaleDismissed += rankStats.staleDismissed
  // 응답 호환 — 기존 created/updated 누적에도 합산.
  stats.created += rankStats.created
  stats.updated += rankStats.updated

  // -- n. 광고그룹 단위 rank 권고 (Phase 2A) ---------------------------------
  // useGroupBidAmt=true 키워드 보유 광고그룹의 평균 순위 미달 → AdGroup.bidAmt 인상 권고.
  // 키워드 단위 rank 권고와 별도 — 적용 단위가 다름 (그룹 default bid vs 키워드 bid).
  const adgroupRankStats = await processAdgroupRankSuggestions({
    advertiserId,
    customerId,
    targetAvgRank: cfg.targetAvgRank ?? null,
    maxCpc: cfg.maxCpc ?? null,
    weightedMap: sharedWeightedMap,
    cronStartedAt,
  })
  stats.adgroupRankCandidatesScanned += adgroupRankStats.candidatesScanned
  stats.adgroupRankCreated += adgroupRankStats.created
  stats.adgroupRankUpdated += adgroupRankStats.updated
  stats.adgroupRankHoldNotReached += adgroupRankStats.holdNotReached
  stats.adgroupRankCappedAtMaxCpc += adgroupRankStats.cappedAtMaxCpc
  stats.adgroupRankEstimateFailed += adgroupRankStats.estimateFailed
  stats.adgroupRankWeightedSourceCount += adgroupRankStats.weightedSourceCount
  stats.adgroupRankFallbackSourceCount += adgroupRankStats.fallbackSourceCount
  stats.adgroupRankStaleDismissed += adgroupRankStats.staleDismissed
  stats.created += adgroupRankStats.created
  stats.updated += adgroupRankStats.updated

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
        rankCandidatesScanned: 0,
        rankCreated: 0,
        rankUpdated: 0,
        rankHoldNotReached: 0,
        rankCappedAtMaxCpc: 0,
        rankEstimateFailed: 0,
        rankWeightedSourceCount: 0,
        rankFallbackSourceCount: 0,
        rankStaleDismissed: 0,
        adgroupRankCandidatesScanned: 0,
        adgroupRankCreated: 0,
        adgroupRankUpdated: 0,
        adgroupRankHoldNotReached: 0,
        adgroupRankCappedAtMaxCpc: 0,
        adgroupRankEstimateFailed: 0,
        adgroupRankWeightedSourceCount: 0,
        adgroupRankFallbackSourceCount: 0,
        adgroupRankStaleDismissed: 0,
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
      name: true,
      customerId: true,
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

  // 본 cron run 시작 시각 — 광고주별 신규 BidSuggestion 카운트 기준점.
  // processAdvertiser 가 createdAt >= cronStartedAt 인 행만 "이번 run 신규" 로 판정.
  const cronStartedAt = new Date()

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
  let rankCandidatesScanned = 0
  let rankCreated = 0
  let rankUpdated = 0
  let rankHoldNotReached = 0
  let rankCappedAtMaxCpc = 0
  let rankEstimateFailed = 0
  let rankWeightedSourceCount = 0
  let rankFallbackSourceCount = 0
  let rankStaleDismissed = 0
  let adgroupRankCandidatesScanned = 0
  let adgroupRankCreated = 0
  let adgroupRankUpdated = 0
  let adgroupRankHoldNotReached = 0
  let adgroupRankCappedAtMaxCpc = 0
  let adgroupRankEstimateFailed = 0
  let adgroupRankWeightedSourceCount = 0
  let adgroupRankFallbackSourceCount = 0
  let adgroupRankStaleDismissed = 0
  const errors: CronError[] = []

  for (const adv of eligible) {
    try {
      const r = await processAdvertiser(adv.id, adv.customerId, cronStartedAt)
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
      rankCandidatesScanned += r.rankCandidatesScanned
      rankCreated += r.rankCreated
      rankUpdated += r.rankUpdated
      rankHoldNotReached += r.rankHoldNotReached
      rankCappedAtMaxCpc += r.rankCappedAtMaxCpc
      rankEstimateFailed += r.rankEstimateFailed
      rankWeightedSourceCount += r.rankWeightedSourceCount
      rankFallbackSourceCount += r.rankFallbackSourceCount
      rankStaleDismissed += r.rankStaleDismissed
      adgroupRankCandidatesScanned += r.adgroupRankCandidatesScanned
      adgroupRankCreated += r.adgroupRankCreated
      adgroupRankUpdated += r.adgroupRankUpdated
      adgroupRankHoldNotReached += r.adgroupRankHoldNotReached
      adgroupRankCappedAtMaxCpc += r.adgroupRankCappedAtMaxCpc
      adgroupRankEstimateFailed += r.adgroupRankEstimateFailed
      adgroupRankWeightedSourceCount += r.adgroupRankWeightedSourceCount
      adgroupRankFallbackSourceCount += r.adgroupRankFallbackSourceCount
      adgroupRankStaleDismissed += r.adgroupRankStaleDismissed
      if (r.stale) advertisersStale++
      else if (
        r.scanned > 0 ||
        r.budgetScanned > 0 ||
        r.rankCandidatesScanned > 0 ||
        r.adgroupRankCandidatesScanned > 0
      )
        advertisersOk++
      else advertisersSkipped++

      // -- bid_suggestion_new 알림 (Event 1) ---------------------------------
      // 본 cron run 에서 status='pending' 으로 신규 생성된 BidSuggestion 이 1+ 면
      // 광고주당 1회 dispatch. 광고주별 1 cron 1 dispatch (cron 매시간 = 광고주당
      // 시간당 최대 1회 — 자연 throttle).
      if (r.created > 0) {
        await maybeNotifyBidSuggestionNew({
          advertiserId: adv.id,
          advertiserName: adv.name,
          customerId: adv.customerId,
          cronStartedAt,
        })
      }
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
    rankCandidatesScanned,
    rankCreated,
    rankUpdated,
    rankHoldNotReached,
    rankCappedAtMaxCpc,
    rankEstimateFailed,
    rankWeightedSourceCount,
    rankFallbackSourceCount,
    rankStaleDismissed,
    adgroupRankCandidatesScanned,
    adgroupRankCreated,
    adgroupRankUpdated,
    adgroupRankHoldNotReached,
    adgroupRankCappedAtMaxCpc,
    adgroupRankEstimateFailed,
    adgroupRankWeightedSourceCount,
    adgroupRankFallbackSourceCount,
    adgroupRankStaleDismissed,
    ts,
    errors,
  })
}

// =============================================================================
// maybeNotifyBidSuggestionNew — 본 cron run 신규 BidSuggestion 알림 (Event 1)
// =============================================================================
//
// 동작:
//   - status='pending' AND createdAt >= cronStartedAt AND advertiserId 매치 행 조회
//   - count / groupCount(adgroupId distinct, null 제외) / sample 키워드 텍스트 추출
//   - count===0 이면 발송 생략 (호출부가 r.created>0 가드. 방어 코드)
//   - dispatch payload: 광고주명 / 카운트 / 묶음 그룹 수 / sampleKeywords (시크릿 X)
//   - throttle: 광고주별 50분 키 — 광고주당 시간당 최대 1회 (cron schedule 매시간 분 20)
//
// 시크릿 정책:
//   - title/body/meta 에 BOT_TOKEN / API key 평문 X
//   - sampleKeywords 는 키워드 텍스트만 (외부 검색어 — 시크릿 아님)
//
// 실패 격리:
//   - dispatch throw 는 호출부 try/catch 가 흡수 — cron 다른 광고주 진행 막지 않음.

async function maybeNotifyBidSuggestionNew(args: {
  advertiserId: string
  advertiserName: string
  customerId: string
  cronStartedAt: Date
}): Promise<void> {
  const { advertiserId, advertiserName, customerId, cronStartedAt } = args

  // 50분 throttle — cron schedule "20 * * * *" 매시간 1회. 50분이면 다음 cron 시점에 풀림.
  const throttled = await shouldThrottle(
    `nsa:notify:bid_suggestion_new:${advertiserId}`,
    50 * 60,
  )
  if (throttled) return

  const fresh = await prisma.bidSuggestion.findMany({
    where: {
      advertiserId,
      status: "pending",
      createdAt: { gte: cronStartedAt },
    },
    select: {
      adgroupId: true,
      keywordId: true,
      // targetName 은 묶음 권고의 광고그룹명 캐시 — sample 표시에 적합
      targetName: true,
      keyword: { select: { keyword: true } },
    },
    take: 200, // 묶음 + 단건 합산 — 알림 sample 추출용 캡 (전체 카운트는 r.created 기준)
  })

  if (fresh.length === 0) {
    // r.created>0 인데 조회 0 — 다른 cron 의 cleanup 으로 사라진 케이스. 발송 스킵.
    return
  }

  const count = fresh.length
  const groupSet = new Set<string>()
  for (const s of fresh) {
    if (s.adgroupId) groupSet.add(s.adgroupId)
  }
  const groupCount = groupSet.size

  const sampleKeywords: string[] = []
  for (const s of fresh) {
    const kw = s.keyword?.keyword ?? s.targetName
    if (kw && !sampleKeywords.includes(kw)) {
      sampleKeywords.push(kw)
      if (sampleKeywords.length >= 3) break
    }
  }

  console.info(
    `[cron/bid-suggest] notify bid_suggestion_new advertiser=${advertiserId} count=${count} groupCount=${groupCount}`,
  )

  await dispatch({
    ruleType: "bid_suggestion_new",
    severity: "info",
    title: `신규 권고 ${count}건 (광고주 ${advertiserName})`,
    body:
      `광고그룹 ${groupCount}개 / 전체 ${count}건. ` +
      `운영 Inbox 에서 확인 후 적용/거절`,
    meta: {
      advertiserId,
      customerId,
      count,
      groupCount,
      sampleKeywords,
    },
  })
}
