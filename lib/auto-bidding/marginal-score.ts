/**
 * 한계효용 / 증분이익 기반 입찰 권고 엔진 (Phase B.1)
 *
 * 책임:
 *   - 키워드 1개에 대한 7일 stats + 광고주 baseline + 목표(CPA/ROAS) → 입찰 변경 권고
 *   - 출력: BidSuggestion 적재 페이로드 (호출자가 DB upsert)
 *
 * 핵심 원칙 (사용자 검토 반영):
 *   - 자동 실행 X. 본 함수 출력은 항상 Inbox 권고 (운영자 명시 승인 필요)
 *   - 의사결정 기준: **CPA/ROAS → CPC/CTR → baseline 폴백** (절대 순위 X)
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
  /** 7일 평균 노출 순위. 낮을수록 좋음. 미수집 → null. */
  avgRank7d?: number | null
}

/** 광고주 단위 baseline — KeywordPerformanceProfile 1행. */
export type AdvertiserBaselineInput = {
  avgCtr: Prisma.Decimal | null
  avgCvr: Prisma.Decimal | null
  avgCpc: Prisma.Decimal | null
}

/** BidAutomationConfig 의 목표 — 모두 null 허용. */
export type AutomationTargets = {
  /** 목표 CPC(원). null = 미설정. */
  targetCpc?: number | null
  /** 최대 CPC(원). null = 시스템 기본 상한 사용. */
  maxCpc?: number | null
  /** CTR 하한(%). 예: 0.3 = 0.30%. null = 미설정. */
  minCtr?: Prisma.Decimal | null
  /** 목표 평균 노출 순위. 현재 marginal-score 직접 판단에는 미사용. */
  targetAvgRank?: Prisma.Decimal | null
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
  /** 현재 키워드 CTR(%). 노출 0 → null. */
  keywordCtr: number | null
  /** 7일 평균 노출 순위. 낮을수록 좋음. */
  avgRank7d: number | null
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
 *   4. targetAvgRank 설정 + 평균 순위 데이터 → CPC/CTR 안전 조건 안에서 순위 개선/절감 비교
 *   5. targetCpc 설정 + CPC 데이터 → CPC 비교
 *   6. minCtr 설정 + CTR 데이터 → 저CTR 키워드 down 권고
 *   7. 그래도 없으면 baseline avgCpc 대비 키워드 CPC 비교 (이상 케이스만 down 권고)
 *   8. clamp 후 currentBid 와 동일 → hold
 */
export function decideMarginalSuggestion(
  input: MarginalScoreInput,
): MarginalDecision {
  const config = { ...DEFAULT_MARGINAL_CONFIG, ...input.config }
  const { keyword, baseline, targets } = input
  const {
    clicks7d,
    impressions7d,
    cost7d,
    conversions7d,
    revenue7d,
    currentBid,
    avgRank7d = null,
  } = keyword

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
  const keywordCtr = impressions7d > 0 ? (clicks7d / impressions7d) * 100 : null

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
  } else if (targets.targetAvgRank != null && avgRank7d != null) {
    const target = Number(targets.targetAvgRank)
    const minCtr = targets.minCtr != null ? Number(targets.minCtr) : null
    const ctrOk = minCtr == null || (keywordCtr != null && keywordCtr >= minCtr)
    const maxCpcOk = targets.maxCpc == null || currentBid < targets.maxCpc
    const targetCpcOk =
      targets.targetCpc == null ||
      keywordCpc == null ||
      keywordCpc <= targets.targetCpc * 1.1
    const baselineCpc = baseline.avgCpc != null ? Number(baseline.avgCpc) : null
    const rankTooGood = avgRank7d < Math.max(1, target - 1)
    const cpcHighForRankDown =
      keywordCpc != null &&
      (targets.targetCpc != null
        ? keywordCpc > targets.targetCpc
        : baselineCpc != null && keywordCpc > baselineCpc * 1.2)

    if (avgRank7d > target + 1 && ctrOk && maxCpcOk && targetCpcOk) {
      direction = "up"
      reasonCore = `평균 순위 ${avgRank7d.toFixed(1)}위 > 목표 ${target.toFixed(1)}위 + 1 — CPC/CTR 안전 조건 내 입찰 인상 권고`
      severity = avgRank7d > target + 3 ? "warn" : "info"
    } else if (rankTooGood && cpcHighForRankDown) {
      direction = "down"
      reasonCore = `평균 순위 ${avgRank7d.toFixed(1)}위가 목표 ${target.toFixed(1)}위보다 충분히 높고 CPC 부담이 있어 입찰 인하 권고`
    } else if (targets.targetCpc == null && targets.minCtr == null) {
      return {
        decision: "hold",
        reason: `rank_within_guardrails:${avgRank7d.toFixed(1)}vs${target.toFixed(1)}`,
      }
    }
  }

  if (direction == null && targets.targetCpc != null && keywordCpc != null) {
    // CPC 비교: 목표보다 30% 이상 높으면 down, 20% 이상 낮고 CTR도 낮지 않으면 up.
    const target = targets.targetCpc
    const minCtr = targets.minCtr != null ? Number(targets.minCtr) : null
    const ctrOk = minCtr == null || (keywordCtr != null && keywordCtr >= minCtr)
    if (keywordCpc > target * 1.3) {
      direction = "down"
      reasonCore = `CPC ${Math.round(keywordCpc)}원 > 목표 ${target}원 × 1.3 — 입찰 인하 권고`
      severity = keywordCpc > target * 1.6 ? "warn" : "info"
    } else if (keywordCpc < target * 0.8 && ctrOk) {
      direction = "up"
      reasonCore = `CPC ${Math.round(keywordCpc)}원 < 목표 ${target}원 × 0.8 — 입찰 인상 여유`
    } else {
      return {
        decision: "hold",
        reason: `cpc_within_band:${Math.round(keywordCpc)}vs${target}`,
      }
    }
  } else if (
    direction == null &&
    targets.minCtr != null &&
    keywordCtr != null &&
    Number(targets.minCtr) > 0
  ) {
    const target = Number(targets.minCtr)
    if (keywordCtr < target) {
      direction = "down"
      reasonCore = `CTR ${keywordCtr.toFixed(2)}% < 하한 ${target.toFixed(2)}% — 입찰 인하 또는 소재 개선 권고`
      severity = keywordCtr < target * 0.5 ? "warn" : "info"
    } else {
      return {
        decision: "hold",
        reason: `ctr_above_floor:${keywordCtr.toFixed(2)}vs${target.toFixed(2)}`,
      }
    }
  } else if (direction == null) {
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
  const bidUpperBound =
    targets.maxCpc != null
      ? Math.min(config.bidUpperBound, targets.maxCpc)
      : config.bidUpperBound
  candidate = Math.max(
    config.bidLowerBound,
    Math.min(bidUpperBound, candidate),
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

// =============================================================================
// 묶음 권고 (광고그룹 단위 그룹화)
// =============================================================================

/**
 * 묶음 임계 / 균질성 설정.
 *
 * 사용자 결정 (2026-05-06):
 *   - bundleMinKeywords=5 — 4개 이하 묶음은 시각적 가치 < 단건 노출 가치
 *   - bundleBidStdMax=0.05 — ±5% 변동률 분산 안에서만 동일 권고 묶음
 *
 * 균질성 위반 시 그룹은 통째로 fallbackSingles 로 떨어져 기존 단건 흐름 유지.
 */
/** 묶음 임계 / 균질성 설정 — 호출자가 부분 override 가능. */
export type BundleConfig = {
  /** 묶음 생성 최소 키워드 수. 미만이면 단건 흐름 유지. */
  bundleMinKeywords: number
  /** bid 변동률 분산 허용 (절대값). 0.05 = ±5%. (max - min) / mean 비교. */
  bundleBidStdMax: number
}

export const DEFAULT_BUNDLE_CONFIG: BundleConfig = {
  bundleMinKeywords: 5,
  bundleBidStdMax: 0.05,
}

/** bundleSuggestions 호출자 입력 — 키워드 결정 + 광고그룹 메타. */
export type BundleInputDecision = {
  decision: MarginalDecision
  keywordId: string
  adgroupId: string
  adgroupName: string
}

/** 묶음 적재 후보 — BidSuggestion 1건으로 적재됨. */
export type BundleCandidate = {
  adgroupId: string
  adgroupName: string
  direction: "up" | "down"
  reasonCode: string
  /** 그룹 내 평균 변동률 (정률, 절대값). 예: 0.15 = 15%. action.suggestedBidPercent 표기에 사용. */
  avgDeltaPct: number
  /** 그룹 내 severity 의 최대값 (info < warn < critical). */
  maxSeverity: "info" | "warn" | "critical"
  items: Array<{
    keywordId: string
    beforeBid: number
    afterBid: number
    reason?: string
  }>
}

export type BundleResult = {
  /** 묶음 BidSuggestion 적재 대상 (5개+ 이고 균질). */
  bundles: BundleCandidate[]
  /** 묶음에 안 들어간 단건 결정들 (기존 흐름 유지). */
  fallbackSingles: BundleInputDecision[]
}

/** reasonCode 추출 — decision.reason 본문에서 케이스를 코드 식별자로 정규화. */
function extractReasonCode(reason: string): string {
  // decideMarginalSuggestion 본문은 한국어 자연어 + 일부 구간 패턴 (e.g. roas_within_band).
  // 묶음 키 안정성을 위해 첫 단어/패턴을 정규화.
  if (reason.startsWith("ROAS")) return "roas_target"
  if (reason.startsWith("CPA")) return "cpa_target"
  if (reason.startsWith("CPC")) return "cpc_target"
  if (reason.startsWith("CTR")) return "ctr_floor"
  if (reason.startsWith("평균 순위")) return "avg_rank_target"
  if (reason.startsWith("키워드 CPC")) return "baseline_cpc_outlier"
  // 알 수 없는 경우 — reason 본문 첫 32자 hash 대신 통째로 사용 (그룹화 키 안정성).
  return `other:${reason.slice(0, 32)}`
}

/** severity 우선순위 — 그룹 내 최댓값 산출. */
function severityRank(s: "info" | "warn" | "critical"): number {
  if (s === "critical") return 2
  if (s === "warn") return 1
  return 0
}

/**
 * 단건 결정 배열을 (adgroupId + direction + reasonCode) 키로 그룹화하고
 * 5개+ 이면서 변동률 분산이 ±bundleBidStdMax 이내일 때만 묶음으로 분리.
 *
 * 분리 결과:
 *   - bundles      : 묶음 적재 후보 (BidSuggestion scope='adgroup' 1건)
 *   - fallbackSingles : 묶음 비대상 (단건 BidSuggestion 으로 기존 흐름 유지)
 *
 * 분기 규칙:
 *   - decision.kind !== 'suggest' (hold) → 그룹화 비대상 → fallbackSingles 직행
 *   - 그룹 내 N < bundleMinKeywords → 그룹 통째로 fallbackSingles
 *   - 그룹 내 (max - min) / mean > bundleBidStdMax → 균질성 위반 → 그룹 통째로 fallbackSingles
 *
 * 호출자 책임:
 *   - adgroupName 주입 (Keyword → AdGroup 조인 책임은 cron 측)
 *   - decision.kind === 'hold' 도 그대로 전달 가능 (본 함수가 fallbackSingles 로 분리)
 */
export function bundleSuggestions(
  decisions: BundleInputDecision[],
  config?: Partial<BundleConfig>,
): BundleResult {
  const cfg = { ...DEFAULT_BUNDLE_CONFIG, ...config }

  const bundles: BundleCandidate[] = []
  const fallbackSingles: BundleInputDecision[] = []

  // -- 1. suggest 만 그룹화 후보. hold 는 즉시 fallback. ----------------------
  type GroupEntry = {
    adgroupId: string
    adgroupName: string
    direction: "up" | "down"
    reasonCode: string
    members: BundleInputDecision[]
  }
  const groups = new Map<string, GroupEntry>()

  for (const d of decisions) {
    if (d.decision.decision !== "suggest") {
      fallbackSingles.push(d)
      continue
    }
    const direction = d.decision.action.direction
    const reasonCode = extractReasonCode(d.decision.reason)
    const key = `${d.adgroupId}|${direction}|${reasonCode}`
    const existing = groups.get(key)
    if (existing) {
      existing.members.push(d)
    } else {
      groups.set(key, {
        adgroupId: d.adgroupId,
        adgroupName: d.adgroupName,
        direction,
        reasonCode,
        members: [d],
      })
    }
  }

  // -- 2. 그룹별 임계 / 균질성 검사 ------------------------------------------
  for (const g of groups.values()) {
    if (g.members.length < cfg.bundleMinKeywords) {
      // 임계 미만 — 그룹 통째로 단건 흐름.
      for (const m of g.members) fallbackSingles.push(m)
      continue
    }

    // 변동률 (afterBid - beforeBid) / beforeBid — 절대값. beforeBid=0 은 marginal-score
    // 가드(currentBid<=0 → hold)로 발생 불가하지만 안전상 스킵.
    const deltas: number[] = []
    let valid = true
    for (const m of g.members) {
      if (m.decision.decision !== "suggest") {
        valid = false
        break
      }
      const before = m.decision.action.currentBid
      const after = m.decision.action.suggestedBid
      if (before <= 0) {
        valid = false
        break
      }
      deltas.push(Math.abs((after - before) / before))
    }
    if (!valid || deltas.length === 0) {
      for (const m of g.members) fallbackSingles.push(m)
      continue
    }

    const min = Math.min(...deltas)
    const max = Math.max(...deltas)
    const mean = deltas.reduce((s, v) => s + v, 0) / deltas.length
    // mean=0 인 경우 (모두 동일 입찰 = 변동 없음) 는 정상 균질 → spread 0 으로 통과.
    const spread = mean > 0 ? (max - min) / mean : 0

    if (spread > cfg.bundleBidStdMax) {
      // 분산 위반 — 그룹 통째로 단건.
      for (const m of g.members) fallbackSingles.push(m)
      continue
    }

    // 균질 묶음 확정 — bundle candidate 생성.
    let maxSev: "info" | "warn" | "critical" = "info"
    const items: BundleCandidate["items"] = []
    for (const m of g.members) {
      // d.decision.decision === 'suggest' 는 위 valid 루프에서 보장.
      if (m.decision.decision !== "suggest") continue
      items.push({
        keywordId: m.keywordId,
        beforeBid: m.decision.action.currentBid,
        afterBid: m.decision.action.suggestedBid,
        reason: m.decision.reason,
      })
      if (severityRank(m.decision.severity) > severityRank(maxSev)) {
        maxSev = m.decision.severity
      }
    }

    bundles.push({
      adgroupId: g.adgroupId,
      adgroupName: g.adgroupName,
      direction: g.direction,
      reasonCode: g.reasonCode,
      avgDeltaPct: Number((mean * 100).toFixed(2)),
      maxSeverity: maxSev,
      items,
    })
  }

  return { bundles, fallbackSingles }
}
