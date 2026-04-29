/**
 * F-11.2 — 자동 비딩 결정 로직 (decideBidAdjustment).
 *
 * 입력:
 *   - BiddingPolicy (targetRank / maxBid / minBid / device)
 *   - Keyword (recentAvgRnk / bidAmt)
 *   - Estimate average-position-bid 결과 (순위별 입찰가)
 *   - Guardrail (maxBidChangePct — 1회 ±N% 한도)
 *
 * 출력:
 *   - skip 결정 ({ skip:true, reason })  — OptimizationRun.result = 'skipped_*' 로 적재
 *   - 적용 결정 ({ skip:false, newBidAmt, reason }) — SA bidAmt update + result='success'
 *
 * 본 함수는 순수 함수 (DB / 외부 호출 X). 단위 테스트로 분기 매트릭스 보장.
 *
 * 결정 정책 (단순화 버전):
 *   1. recentAvgRnk == null → skip "rank_unavailable"
 *   2. |recentAvgRnk - targetRank| <= 1 → skip "on_target" (toleranceRank=1 하드코딩)
 *   3. estimateBids 에서 targetRank position row 검색 → 없으면 skip "estimate_unavailable"
 *      - 동일 position 의 bid 가 0 또는 음수면 skip "estimate_invalid"
 *   4. base = Estimate row.bid
 *      - policy.maxBid != null && base > maxBid → base = maxBid
 *      - policy.minBid != null && base < minBid → base = minBid
 *   4.5 (F-11.4) Targeting weight 곱:
 *      - input.targetingWeight (default 1.0) 곱
 *      - 곱 결과를 다시 maxBid / minBid 로 cap (weight × maxBid 초과 방지)
 *      - weight 적용은 "Estimate 기반 base" 위에 하므로 cron 이 산출한 시간/디바이스 강도 반영
 *   5. Guardrail (currentBid 기준 ±maxBidChangePct):
 *      - currentBid != null && currentBid > 0:
 *          upper = floor(currentBid * (100 + pct) / 100)
 *          lower = ceil(currentBid * (100 - pct) / 100)
 *          base 를 [lower, upper] 로 clamp
 *      - currentBid <= 0 또는 null → 가드레일 skip (Estimate 그대로)
 *   6. base === currentBid → skip "no_change"
 *   7. → { skip:false, newBidAmt: base, reason: "estimate_target_rank" }
 *
 * 본 PR 비대상:
 *   - 점진 ±10% 이동 (Estimate 신뢰성 부족 시) — 운영 후 추가 검토
 *   - toleranceRank 의 BiddingPolicy 컬럼 승격 — 운영 후 결정
 *
 * SPEC: SPEC v0.2.1 F-11.2 / F-11.5
 */

import type { AveragePositionBidRow } from "@/lib/naver-sa/estimate"

// =============================================================================
// 타입
// =============================================================================

export type DecidePolicy = {
  id: string
  advertiserId: string
  keywordId: string
  device: "PC" | "MOBILE"
  targetRank: number
  maxBid: number | null
  minBid: number | null
}

export type DecideKeyword = {
  id: string
  nccKeywordId: string
  /** 현재 입찰가. null = 광고그룹 기본가 사용 (useGroupBidAmt=true) — 가드레일 skip. */
  bidAmt: number | null
  /** 최근 평균 노출 순위 — Decimal 1자리 정밀도. null = 데이터 부족. */
  recentAvgRnk: number | null
}

export type DecideGuardrail = {
  /** 1회 자동 조정 입찰가 ±N% 한도 (1..100). currentBid 기반 clamp. */
  maxBidChangePct: number
}

export type DecideInput = {
  policy: DecidePolicy
  keyword: DecideKeyword
  /** Estimate.estimateAveragePositionBid 결과 (1..5위 입찰가). */
  estimateBids: AveragePositionBidRow[]
  guardrail: DecideGuardrail
  /**
   * F-11.4 Targeting weight (TargetingRule 기반 시간/디바이스 가중치).
   * 미지정 시 1.0 (default — 기존 호출부 무회귀). Estimate base 위에 곱.
   * 호출부(`lib/auto-bidding/targeting-weight.ts`)가 [0.1, 3.0] clamp 보장.
   */
  targetingWeight?: number
}

export type DecideResult =
  | {
      skip: false
      /** 적용할 새 입찰가 (정수). */
      newBidAmt: number
      /** 결정 사유 (현재 단일: "estimate_target_rank"). */
      reason: string
    }
  | {
      skip: true
      /**
       * skip 사유 — OptimizationRun.result 매핑:
       *   "rank_unavailable"     → "skipped_rank_unavailable"
       *   "on_target"            → "skipped_on_target"
       *   "estimate_unavailable" → "skipped_estimate_unavailable"
       *   "estimate_invalid"     → "skipped_estimate_invalid"
       *   "no_change"            → "skipped_no_change"
       */
      reason: string
    }

// =============================================================================
// 상수
// =============================================================================

/** 목표 순위 ± 본 값 안에 들어오면 skip (on_target).
 *  recentAvgRnk Decimal 1자리 정밀도 기준 1.0 차이까지는 무시 (폭주 방지). */
const TOLERANCE_RANK = 1

// =============================================================================
// 핵심 로직
// =============================================================================

export function decideBidAdjustment(input: DecideInput): DecideResult {
  const { policy, keyword, estimateBids, guardrail } = input

  // 1. recentAvgRnk null
  if (keyword.recentAvgRnk == null) {
    return { skip: true, reason: "rank_unavailable" }
  }

  // 2. on target
  if (Math.abs(keyword.recentAvgRnk - policy.targetRank) <= TOLERANCE_RANK) {
    return { skip: true, reason: "on_target" }
  }

  // 3. Estimate 매칭
  const row = estimateBids.find((r) => r.position === policy.targetRank)
  if (!row) {
    return { skip: true, reason: "estimate_unavailable" }
  }
  if (typeof row.bid !== "number" || row.bid <= 0) {
    return { skip: true, reason: "estimate_invalid" }
  }

  // 4. policy max/min cap (1차)
  let base = row.bid
  if (policy.maxBid != null && base > policy.maxBid) {
    base = policy.maxBid
  }
  if (policy.minBid != null && base < policy.minBid) {
    base = policy.minBid
  }

  // 4.5 Targeting weight 곱 (F-11.4) — 미지정 또는 비정상 시 1.0 (default).
  //    Estimate-base 위에 시간/디바이스 강도 반영.
  //    호출부 clamp 와 별도로 본 함수도 한 번 더 방어 (NaN/Infinity/음수 차단).
  const rawWeight = input.targetingWeight
  const weight =
    typeof rawWeight === "number" &&
    Number.isFinite(rawWeight) &&
    rawWeight > 0
      ? rawWeight
      : 1.0
  if (weight !== 1.0) {
    base = base * weight
    // weight 곱 후 maxBid / minBid 로 다시 cap (weight × Estimate 가 maxBid 를 초과하지 않게).
    if (policy.maxBid != null && base > policy.maxBid) {
      base = policy.maxBid
    }
    if (policy.minBid != null && base < policy.minBid) {
      base = policy.minBid
    }
  }

  // 5. Guardrail ±N% (currentBid 기반) — weight 적용 후 base 위에 다시 적용.
  //    weight 가 큰 변동을 일으켜도 ±N% 내로 강제 수렴.
  const currentBid = keyword.bidAmt
  if (currentBid != null && currentBid > 0) {
    const pct = guardrail.maxBidChangePct
    const upper = Math.floor((currentBid * (100 + pct)) / 100)
    const lower = Math.ceil((currentBid * (100 - pct)) / 100)
    if (base > upper) base = upper
    if (base < lower) base = lower
  }

  // 결정 정수 보장 (clamp 결과가 음수가 되거나 기존과 동일하면 skip)
  base = Math.round(base)
  if (base <= 0) {
    return { skip: true, reason: "estimate_invalid" }
  }

  // 6. no change
  if (currentBid != null && base === currentBid) {
    return { skip: true, reason: "no_change" }
  }

  return { skip: false, newBidAmt: base, reason: "estimate_target_rank" }
}

// =============================================================================
// skip reason → OptimizationRun.result 매핑 (cron 호출부 헬퍼)
// =============================================================================

export function skipReasonToRunResult(reason: string): string {
  switch (reason) {
    case "rank_unavailable":
      return "skipped_rank_unavailable"
    case "on_target":
      return "skipped_on_target"
    case "estimate_unavailable":
      return "skipped_estimate_unavailable"
    case "estimate_invalid":
      return "skipped_estimate_invalid"
    case "no_change":
      return "skipped_no_change"
    default:
      return "skipped_unknown"
  }
}
