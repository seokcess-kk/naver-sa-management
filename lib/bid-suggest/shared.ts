/**
 * bid-suggest cron — 공통 타입 · 헬퍼 · 상수.
 *
 * app/api/cron/bid-suggest/route.ts 분해 (순수 구조 리팩터) 로 추출.
 * 여러 권고 엔진 모듈 (budget / rank-keyword / rank-adgroup / marginal) 이 공유.
 * 값 · 의미 불변 — route.ts 에서 그대로 이동.
 */

import { scrubString } from "@/lib/crypto/scrub-string"

// =============================================================================
// 상수 (여러 엔진 모듈 공유)
// =============================================================================

export const STATS_WINDOW_DAYS = 7
export const SUGGESTION_TTL_DAYS = 7
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
export const BID_RANK_DEVICE_SCOPE: "PC" | "BOTH" = (() => {
  const raw = process.env.BID_RANK_DEVICE_SCOPE ?? "BOTH"
  if (raw !== "PC" && raw !== "BOTH") return "BOTH"
  return raw as "PC" | "BOTH"
})()
/** KST = UTC+9. (ingest.ts 의 KST_OFFSET_MS 와 동일 — 본 모듈도 inline 사용). */
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000

// =============================================================================
// 헬퍼
// =============================================================================

export function safeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return scrubString(raw).slice(0, 500)
}

export function addDays(base: Date, days: number): Date {
  const d = new Date(base)
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

// =============================================================================
// 응답 타입
// =============================================================================

export type CronError = {
  advertiserId: string
  keywordId?: string
  message: string
}

export type CronResponse = {
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
  /** 광고그룹 권고 stale 정리 (W4) — 후보에서 빠진 광고그룹의 기존 pending dismiss 수. */
  adgroupRankStaleDismissed: number
  ts: string
  errors: CronError[]
  error?: string
}

export type AdvertiserStats = {
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
  /** rank 권고 단계 — stale 정리 (W4): 후보에서 빠진 키워드의 기존 below_target_rank pending dismiss 수. */
  rankStaleDismissed: number
  // -- 광고그룹 단위 rank 권고 (Phase 2A) ------------------------------------
  adgroupRankCandidatesScanned: number
  adgroupRankCreated: number
  adgroupRankUpdated: number
  adgroupRankHoldNotReached: number
  adgroupRankCappedAtMaxCpc: number
  adgroupRankEstimateFailed: number
  adgroupRankStaleDismissed: number
}
