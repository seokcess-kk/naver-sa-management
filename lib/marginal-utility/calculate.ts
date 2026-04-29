/**
 * F-11.3 — 한계효용 분석 (CPC 기반 단순화 버전).
 *
 * 알고리즘:
 *   1. 키워드 N일 합계 (기본 7일):
 *      - StatDaily.aggregate { _sum: { impressions, clicks, cost } }
 *      - where: advertiserId + level=keyword + refId=keyword.nccKeywordId + device + date >= since
 *      - cost 컬럼은 Decimal → Number(decimal.toString()) 변환
 *   2. 클릭 < minClicks (기본 50) → insufficientData (positions 미산출)
 *   3. Estimate average-position-bid 1..5 (캐시 활용 — getCachedAveragePositionBid)
 *   4. Estimate performance-bulk(bids: 1..5위 입찰가들) — 예상 impressions/clicks/cost
 *   5. 각 순위 r 에 대해 단계별 한계효용 계산:
 *      - r=5위 → r=4위 → ... → r=1위 (낮은 숫자가 더 높은 순위)
 *      - marginalUtility_r = (clicks_r - clicks_{r+1}) / (cost_r - cost_{r+1})
 *      - 단위: clicks/원 (1원당 추가 획득 클릭 수)
 *      - r=5위(가장 낮은 순위)는 비교 대상 없음 → marginalUtility = null
 *   6. 권장 순위 결정:
 *      - 한계효용이 양수인 가장 높은(낮은 숫자) 순위 = 가장 효율적인 클릭 추가가 가능한 순위
 *      - 모두 음수/0/null 이면 null (운영 판단 위임)
 *
 * 본 PR 비대상 (P2 후속):
 *   - 매출/전환 조인 — StatDaily.revenue 가 null (P1) → CPC/클릭 기반 분석만 가능
 *   - ROAS / ROI 정밀화 — 매출 조인 시 (Δrevenue / Δcost) 기준으로 재계산 가능
 *   - 신뢰구간 / 표본 크기 보정 — Estimate API 자체 신뢰도 미공개
 *
 * 외부 호출:
 *   - estimateAveragePositionBid (캐시 hit 시 0)
 *   - estimatePerformanceBulk (1회 — bids 5개)
 *   - 시크릿: customerId 만 (HMAC 서명은 client.ts 책임)
 *
 * SPEC: SPEC v0.2.1 F-11.3
 */

import { prisma } from "@/lib/db/prisma"
import { getCachedAveragePositionBid } from "@/lib/auto-bidding/estimate-cached"
import { estimatePerformanceBulk } from "@/lib/naver-sa/estimate"
import { StatDevice, StatLevel } from "@/lib/generated/prisma/enums"

// =============================================================================
// 상수
// =============================================================================

/** 분석 가능 최소 클릭 수 — N일 합계가 본 값 미만이면 insufficientData. */
export const DEFAULT_MIN_CLICKS = 50

/** 기본 분석 기간 (일). 3..30 범위. */
export const DEFAULT_DAYS_WINDOW = 7

/** 분석 대상 순위 — 1..5위 고정. */
const POSITIONS = [1, 2, 3, 4, 5] as const

// =============================================================================
// 타입
// =============================================================================

export type MarginalUtilityArgs = {
  /** 광고주 내부 id (FK). */
  advertiserId: string
  /** 광고주 customerId (Estimate 호출 헤더). */
  customerId: string
  /** Keyword 내부 id. */
  keywordId: string
  /** nccKeywordId — StatDaily.refId 매칭. */
  nccKeywordId: string
  /** Keyword 텍스트 — Estimate body. */
  keywordText: string
  /** 현재 입찰가 (UI 표시용). useGroupBidAmt=true 면 null. */
  currentBid: number | null
  /** 최근 평균 노출 순위 (UI 표시용). 데이터 부족 시 null. */
  recentAvgRnk: number | null
  /** PC / MOBILE — Estimate 분리 호출. */
  device: "PC" | "MOBILE"
  /** 분석 기간 (일). 미지정 시 7. */
  daysWindow?: number
  /** 분석 가능 최소 클릭. 미지정 시 50. */
  minClicks?: number
}

export type MarginalUtilityPosition = {
  position: number
  estimatedBid: number
  expectedImpressions: number | null
  expectedClicks: number | null
  expectedCost: number | null
  expectedCpc: number | null
  /** 직전 순위(현재보다 1 높은 숫자, 즉 한 단계 낮은 순위) 대비 marginal utility (Δclicks/Δcost). */
  marginalUtility: number | null
}

export type MarginalUtilityResult = {
  keyword: {
    id: string
    nccKeywordId: string
    keyword: string
    currentBid: number | null
    recentAvgRnk: number | null
  }
  device: "PC" | "MOBILE"
  period: {
    /** ISO datetime — since (포함). */
    since: string
    /** ISO datetime — until (현재 시각, 미포함 상한). */
    until: string
    days: number
  }
  last7d: {
    impressions: number
    clicks: number
    cost: number
    /** clicks > 0 이면 cost/clicks, 아니면 null. */
    cpc: number | null
  }
  insufficientData: { reason: "min_clicks"; actualClicks: number } | null
  /** insufficientData 가 null 일 때만 채워짐. */
  positions?: MarginalUtilityPosition[]
  /** 권장 순위 — 양수 marginal 의 가장 높은 순위 (낮은 숫자). 없으면 null. */
  recommendedPosition?: number | null
}

// =============================================================================
// 핵심 로직
// =============================================================================

/**
 * 한계효용 분석 본체.
 *
 * 권한 / 광고주 횡단 차단은 호출부(Server Action) 책임 — 본 함수는 순수 계산.
 *
 * throw 정책:
 *   - Estimate 호출 실패는 그대로 전파 (Server Action 이 catch + ActionResult.ok=false)
 *   - StatDaily 집계 실패는 그대로 전파 (DB 장애)
 */
export async function calculateMarginalUtility(
  args: MarginalUtilityArgs,
): Promise<MarginalUtilityResult> {
  const daysWindow = args.daysWindow ?? DEFAULT_DAYS_WINDOW
  const minClicks = args.minClicks ?? DEFAULT_MIN_CLICKS

  const until = new Date()
  const since = new Date(until.getTime() - daysWindow * 24 * 60 * 60 * 1000)

  // 1. StatDaily 합계 (광고주 격리 + level=keyword + refId=nccKeywordId + device + 기간)
  const agg = await prisma.statDaily.aggregate({
    where: {
      advertiserId: args.advertiserId,
      level: StatLevel.keyword,
      refId: args.nccKeywordId,
      device: args.device as StatDevice,
      date: { gte: since },
    },
    _sum: {
      impressions: true,
      clicks: true,
      cost: true,
    },
  })

  const impressions = agg._sum.impressions ?? 0
  const clicks = agg._sum.clicks ?? 0
  // Decimal → number — toString 경유로 정밀도 손실 최소화
  const costRaw = agg._sum.cost
  const cost =
    costRaw == null
      ? 0
      : typeof costRaw === "number"
        ? costRaw
        : Number(costRaw.toString())
  const cpc = clicks > 0 ? cost / clicks : null

  const baseResult: Omit<
    MarginalUtilityResult,
    "positions" | "recommendedPosition"
  > = {
    keyword: {
      id: args.keywordId,
      nccKeywordId: args.nccKeywordId,
      keyword: args.keywordText,
      currentBid: args.currentBid,
      recentAvgRnk: args.recentAvgRnk,
    },
    device: args.device,
    period: {
      since: since.toISOString(),
      until: until.toISOString(),
      days: daysWindow,
    },
    last7d: { impressions, clicks, cost, cpc },
    insufficientData: null,
  }

  // 2. 클릭 부족 — Estimate 호출 0 으로 조기 반환
  if (clicks < minClicks) {
    return {
      ...baseResult,
      insufficientData: { reason: "min_clicks", actualClicks: clicks },
    }
  }

  // 3. Estimate 평균 순위 입찰가 (1..5) — 캐시 hit 시 SA 호출 0
  const { data: avgRows } = await getCachedAveragePositionBid({
    advertiserId: args.advertiserId,
    customerId: args.customerId,
    keywordId: args.keywordId,
    keywordText: args.keywordText,
    device: args.device,
  })

  // position → bid 매핑 (응답 누락 / 0 / 음수 방어)
  const bidByPosition = new Map<number, number>()
  for (const r of avgRows) {
    if (
      typeof r.position === "number" &&
      typeof r.bid === "number" &&
      r.bid > 0
    ) {
      bidByPosition.set(r.position, r.bid)
    }
  }

  // 4. Estimate performance-bulk — 1..5위 입찰가들로 일괄 호출
  const bids: number[] = []
  for (const p of POSITIONS) {
    const b = bidByPosition.get(p)
    if (typeof b === "number" && b > 0) bids.push(b)
  }

  const perfRows =
    bids.length > 0
      ? await estimatePerformanceBulk(args.customerId, {
          keyword: args.keywordText,
          device: args.device,
          bids,
        })
      : []

  // bid → row 매핑 (Estimate 응답이 input 순서를 보장하지 않을 수 있음)
  const perfByBid = new Map<number, (typeof perfRows)[number]>()
  for (const r of perfRows) {
    if (typeof r.bid === "number") perfByBid.set(r.bid, r)
  }

  // 5. position 별 expected 채우기 (낮은 순위 → 높은 순위 순으로 marginal 계산)
  // 정렬: position desc (5 → 1) — Δclicks/Δcost 는 "1단계 위로 올라갔을 때 추가 효용"
  type Row = MarginalUtilityPosition & {
    _clicksNum: number | null
    _costNum: number | null
  }
  const rows: Row[] = POSITIONS.map((position) => {
    const estimatedBid = bidByPosition.get(position) ?? 0
    const perf = perfByBid.get(estimatedBid)
    const expectedImpressions =
      perf && typeof perf.impressions === "number" ? perf.impressions : null
    const expectedClicks =
      perf && typeof perf.clicks === "number" ? perf.clicks : null
    const expectedCost =
      perf && typeof perf.cost === "number" ? perf.cost : null
    const expectedCpc =
      expectedClicks != null && expectedClicks > 0 && expectedCost != null
        ? expectedCost / expectedClicks
        : null

    return {
      position,
      estimatedBid,
      expectedImpressions,
      expectedClicks,
      expectedCost,
      expectedCpc,
      marginalUtility: null,
      _clicksNum: expectedClicks,
      _costNum: expectedCost,
    }
  })

  // marginal: position p (오름차순 1→5) 기준 — 직전 순위(p+1) 대비
  // 즉 "5위 → 4위 추가 효용" 은 row[3](position=4).marginalUtility 에 적재.
  // 가장 낮은 순위(5위) 는 비교 대상이 없으므로 null.
  for (let i = 0; i < rows.length - 1; i++) {
    const higher = rows[i] // 더 높은 순위 (낮은 숫자, e.g. 1위)
    const lower = rows[i + 1] // 더 낮은 순위 (높은 숫자, e.g. 2위)
    if (
      higher._clicksNum == null ||
      higher._costNum == null ||
      lower._clicksNum == null ||
      lower._costNum == null
    ) {
      continue
    }
    const dClicks = higher._clicksNum - lower._clicksNum
    const dCost = higher._costNum - lower._costNum
    if (dCost <= 0) {
      // 비용 차이가 0 이거나 음수 — 의미 없는 비교 (Estimate 비단조 응답 가능성)
      continue
    }
    higher.marginalUtility = dClicks / dCost
  }

  // 6. 권장 순위 — marginal 양수인 가장 높은 순위 (낮은 숫자). i 오름차순 first match.
  let recommendedPosition: number | null = null
  for (const r of rows) {
    if (r.marginalUtility != null && r.marginalUtility > 0) {
      recommendedPosition = r.position
      break
    }
  }

  // 내부 필드 (_clicksNum/_costNum) 노출 X — public shape 으로 슬라이스
  const positions: MarginalUtilityPosition[] = rows.map((r) => ({
    position: r.position,
    estimatedBid: r.estimatedBid,
    expectedImpressions: r.expectedImpressions,
    expectedClicks: r.expectedClicks,
    expectedCost: r.expectedCost,
    expectedCpc: r.expectedCpc,
    marginalUtility: r.marginalUtility,
  }))

  return {
    ...baseResult,
    positions,
    recommendedPosition,
  }
}
