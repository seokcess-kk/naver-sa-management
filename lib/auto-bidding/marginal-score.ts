/**
 * 한계효용 / 증분이익 기반 입찰 권고 엔진 (Phase B.1)
 *
 * 책임:
 *   - 키워드 1개에 대한 7일 stats + 광고주 baseline + 목표(CPA/ROAS) → 입찰 변경 권고
 *   - 출력: BidSuggestion 적재 페이로드 (호출자가 DB upsert)
 *
 * 핵심 원칙 (사용자 검토 반영):
 *   - 자동 실행 X. 본 함수 출력은 항상 Inbox 권고 (운영자 명시 승인 필요)
 *   - 의사결정 기준: **목표 CPA/ROAS 우선 → baseline 폴백** (절대 순위 X)
 *   - 절대 수치 사용 금지 — 모든 임계는 "사례·추정" 정책 기반 (운영 후 튜닝)
 *   - 데이터 신뢰도 부족 시 hold (Suggestion 미생성). 클릭 표본 < minClicks → 침묵
 *
 * 비대상 (본 PR):
 *   - Estimate API 활용 (suggestedBid 정확성 향상) — 후속 정련
 *   - 키워드별 baseline (광고주 평균만 사용) — 후속 PR
 *   - 디바이스(PC/MOBILE) 분리 권고 — 후속
 *
 * 단위 테스트(`marginal-score.test.ts`)가 분기 매트릭스 보장.
 */

import { Prisma } from "@/lib/generated/prisma/client"

// =============================================================================
// 입력 타입
// =============================================================================

/** 키워드 단위 7일 누적 + 현재 입찰가. */
export type KeywordPerfInput = {
  keywordId: string
  nccKeywordId: string
  /** 현재 키워드 입찰가(원). 0 또는 null = useGroupBidAmt 키워드 — 본 모듈은 명시 입찰만. */
  currentBid: number
  /** 광고주 baseline 7일 윈도 누적 — Stats API 또는 StatDaily 합산. */
  clicks7d: number
  impressions7d: number
  /** 비용(원). Decimal 입력 시 호출자가 Number 변환. */
  cost7d: number
  /** 전환 수. P1 미적재 광고주 → null (CPA / ROAS 계산 불가). */
  conversions7d: number | null
  /** 매출(원). 매출 조인 안 된 광고주 → null. */
  revenue7d: number | null
}

/** 광고주 단위 baseline — KeywordPerformanceProfile 1행. */
export type AdvertiserBaselineInput = {
  avgCtr: Prisma.Decimal | null
  avgCvr: Prisma.Decimal | null
  avgCpc: Prisma.Decimal | null
}

/** BidAutomationConfig 의 목표 — 둘 중 하나 또는 모두 null. */
export type AutomationTargets = {
  /** 목표 CPA(원). null = 미설정. */
  targetCpa: number | null
  /** 목표 ROAS 비율 (예: 4.5 = 450%). null = 미설정. */
  targetRoas: Prisma.Decimal | null
}

/** 시스템 한도 / 임계 — 호출자가 운영 데이터 누적 후 튜닝. */
export type MarginalConfig = {
  /** 신뢰도 임계 — 클릭 표본 < N → hold. 기본 50. */
  minClicksForConfidence: number
  /** 1회 변경 폭 (정률, %). 기본 15 — SPEC 운영 권장 ±10~20% 중간값. */
  maxBidChangePct: number
  /** 입찰가 하한(원) — 네이버 SA 공식 한도 70원. */
  bidLowerBound: number
  /** 입찰가 상한(원) — 네이버 SA 공식 한도 100,000원. */
  bidUpperBound: number
}

export const DEFAULT_MARGINAL_CONFIG: MarginalConfig = {
  minClicksForConfidence: 50,
  maxBidChangePct: 15,
  bidLowerBound: 70,
  bidUpperBound: 100_000,
}

export type MarginalScoreInput = {
  keyword: KeywordPerfInput
  baseline: AdvertiserBaselineInput
  targets: AutomationTargets
  config?: Partial<MarginalConfig>
}

// =============================================================================
// 출력 타입
// =============================================================================

/** 권고 메트릭 — Suggestion.action / reason 본문에 활용. */
export type DecisionMetrics = {
  clicks7d: number
  cost7d: number
  revenue7d: number | null
  /** 현재 ROAS 비율 (예: 4.5 = 450%). 매출 0/null → null. */
  currentRoas: number | null
  /** 현재 CPA(원). 전환 0/null → null. */
  currentCpa: number | null
  /** 현재 키워드 CPC(원). 클릭 0 → null. */
  keywordCpc: number | null
}

/** 변경 권고 페이로드 — BidSuggestion.action JSON 으로 직렬화. */
export type SuggestAction = {
  currentBid: number
  suggestedBid: number
  /** 항상 양수. 방향은 direction 으로 별도 표시. */
  deltaPct: number
  direction: "up" | "down"
}

export type MarginalDecision =
  | { decision: "hold"; reason: string }
  | {
      decision: "suggest"
      reason: string
      action: SuggestAction
      severity: "info" | "warn" | "critical"
      confidence: "low" | "medium" | "high"
      metrics: DecisionMetrics
    }

// =============================================================================
// 핵심 로직
// =============================================================================

/**
 * 입찰 권고 결정.
 *
 * 분기 우선순위:
 *   1. 신뢰도 임계 (clicks7d) — 부족 시 hold
 *   2. targetRoas 설정 + revenue 데이터 → ROAS 비교
 *   3. targetCpa 설정 + conversions 데이터 → CPA 비교
 *   4. 둘 다 없으면 baseline avgCpc 대비 키워드 CPC 비교 (이상 케이스만 down 권고)
 *   5. clamp 후 currentBid 와 동일 → hold
 */
export function decideMarginalSuggestion(
  input: MarginalScoreInput,
): MarginalDecision {
  const config = { ...DEFAULT_MARGINAL_CONFIG, ...input.config }
  const { keyword, baseline, targets } = input
  const { clicks7d, cost7d, conversions7d, revenue7d, currentBid } = keyword

  // -- 1. 명시 입찰 키워드만 처리 (useGroupBidAmt 키워드는 본 모듈 비대상) ----
  if (currentBid <= 0) {
    return { decision: "hold", reason: "use_group_bid_amt" }
  }

  // -- 2. 신뢰도 임계 ---------------------------------------------------------
  if (clicks7d < config.minClicksForConfidence) {
    return { decision: "hold", reason: "low_confidence_data" }
  }

  // -- 3. 메트릭 산출 ---------------------------------------------------------
  const currentRoas =
    cost7d > 0 && revenue7d != null && revenue7d > 0
      ? revenue7d / cost7d
      : null
  const currentCpa =
    conversions7d != null && conversions7d > 0 && cost7d > 0
      ? cost7d / conversions7d
      : null
  const keywordCpc = clicks7d > 0 ? cost7d / clicks7d : null

  const metrics: DecisionMetrics = {
    clicks7d,
    cost7d,
    revenue7d,
    currentRoas,
    currentCpa,
    keywordCpc,
  }

  // -- 4. 방향 결정 -----------------------------------------------------------
  let direction: "up" | "down" | null = null
  let reasonCore = ""
  let severity: "info" | "warn" | "critical" = "info"

  if (targets.targetRoas != null && currentRoas != null) {
    // ROAS 비교: 1.2배 위 → up, 0.7배 미만 → down. 사이는 hold.
    const target = Number(targets.targetRoas)
    if (currentRoas >= target * 1.2) {
      direction = "up"
      reasonCore = `ROAS ${currentRoas.toFixed(2)}x ≥ 목표 ${target.toFixed(2)}x × 1.2 — 입찰 인상 여유`
    } else if (currentRoas < target * 0.7) {
      direction = "down"
      reasonCore = `ROAS ${currentRoas.toFixed(2)}x < 목표 ${target.toFixed(2)}x × 0.7 — 입찰 인하 권고`
      severity = currentRoas < target * 0.5 ? "warn" : "info"
    } else {
      return {
        decision: "hold",
        reason: `roas_within_band:${currentRoas.toFixed(2)}vs${target.toFixed(2)}`,
      }
    }
  } else if (targets.targetCpa != null && currentCpa != null) {
    // CPA 비교: 0.8배 미만 → up (여유), 1.3배 초과 → down. 사이는 hold.
    const target = targets.targetCpa
    if (currentCpa <= target * 0.8) {
      direction = "up"
      reasonCore = `CPA ${Math.round(currentCpa)}원 ≤ 목표 ${target}원 × 0.8 — 입찰 인상 여유`
    } else if (currentCpa > target * 1.3) {
      direction = "down"
      reasonCore = `CPA ${Math.round(currentCpa)}원 > 목표 ${target}원 × 1.3 — 입찰 인하 권고`
      severity = currentCpa > target * 1.5 ? "warn" : "info"
    } else {
      return {
        decision: "hold",
        reason: `cpa_within_band:${Math.round(currentCpa)}vs${target}`,
      }
    }
  } else {
    // 목표 / 매출·전환 데이터 부족 — baseline avgCpc 대비 키워드 CPC 이상 케이스만
    if (
      baseline.avgCpc != null &&
      keywordCpc != null &&
      Number(baseline.avgCpc) > 0
    ) {
      const baselineCpc = Number(baseline.avgCpc)
      if (keywordCpc > baselineCpc * 1.5) {
        direction = "down"
        reasonCore = `키워드 CPC ${Math.round(keywordCpc)}원 > 광고주 평균 ${Math.round(
          baselineCpc,
        )}원 × 1.5 — 입찰 인하 권고`
      } else {
        return { decision: "hold", reason: "no_target_cpc_normal" }
      }
    } else {
      return { decision: "hold", reason: "insufficient_data_no_target" }
    }
  }

  // -- 5. suggestedBid 산출 + clamp -------------------------------------------
  const deltaPct = config.maxBidChangePct
  const factor = direction === "up" ? 1 + deltaPct / 100 : 1 - deltaPct / 100
  let candidate = Math.round(currentBid * factor)
  candidate = Math.max(
    config.bidLowerBound,
    Math.min(config.bidUpperBound, candidate),
  )

  // -- 6. clamp 후 동일 값 → hold --------------------------------------------
  if (candidate === currentBid) {
    return {
      decision: "hold",
      reason:
        direction === "up"
          ? "at_upper_bound"
          : "at_lower_bound",
    }
  }

  // -- 7. confidence 등급 ----------------------------------------------------
  let confidence: "low" | "medium" | "high" = "medium"
  if (clicks7d >= 200) confidence = "high"
  else if (clicks7d < config.minClicksForConfidence * 1.5) confidence = "low"

  return {
    decision: "suggest",
    reason: reasonCore,
    action: {
      currentBid,
      suggestedBid: candidate,
      deltaPct,
      direction,
    },
    severity,
    confidence,
    metrics,
  }
}
