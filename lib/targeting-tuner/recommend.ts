/**
 * 디바이스/시간대 가중치 추천 엔진 (Phase E.3).
 *
 * 책임:
 *   - 광고주의 28일 StatHourly 데이터 → 묶음(평일오전/평일오후/저녁/그외) 4종 가중치 추천
 *   - 출력: TargetingRecommendation — cron 호출자가 BidSuggestion(engineSource='targeting') 으로 적재
 *
 * 핵심 원칙 (사용자 검토 반영):
 *   - 168칸 직접 최적화 X — 묶음 단위로 시작 → 점진 세분화 (slot 데이터 부족 회피)
 *   - 표본 부족 묶음은 weight=1.0 (변경 없음) — 잘못된 권고 차단
 *   - 절대 임계 X — "ROAS 기반 비율" 형태의 보조 신호. 적용은 운영자 승인 필수
 *   - 가중치 clamp 0.5 ~ 1.5 (운영 권장 단계 — 단계 인상 100% → 130% → 150%)
 *
 * 비대상:
 *   - 디바이스(PC/MOBILE) 가중치 — TargetingRule.deviceWeights 별도 컬럼. 본 PR 은 시간대만
 *   - 168칸 정밀 가중 — 데이터 신뢰 확보 후 후속 PR
 *   - 매출 / 전환 기반 비교 — 본 PR 은 클릭 효율(CTR)만 (P1 매출 미적재 환경 대응)
 */

import { prisma } from "@/lib/db/prisma"

// =============================================================================
// 타입
// =============================================================================

export type TargetingBucket =
  | "weekday_morning"   // 월~금 09~12시
  | "weekday_afternoon" // 월~금 13~17시
  | "evening"           // 전체 18~23시
  | "off_peak"          // 그 외 (주말 + 새벽)

export type BucketMetrics = {
  impressions: number
  clicks: number
  cost: number
  /** 슬롯 표본 수 (해당 묶음에 데이터 있는 (date, hour) row 수). */
  sampleCount: number
  /** % (예: 1.23 = 1.23%). impressions=0 → null. */
  ctr: number | null
}

export type TargetingRecommendation = {
  /** 광고주 전체 평균 (4 묶음 합산) — 비교 baseline. */
  baseline: {
    impressions: number
    clicks: number
    cost: number
    ctr: number | null
  }
  /** 묶음별 메트릭 + 추천 가중치. */
  buckets: Record<
    TargetingBucket,
    {
      metrics: BucketMetrics
      /** 추천 weight (0.5 ~ 1.5 clamp). 표본 부족 → 1.0. baseline ctr null → 1.0. */
      recommendedWeight: number
      /** 적용 여부 — 표본 부족 등으로 기본값 적용 시 false. */
      hasSignal: boolean
    }
  >
}

export type TargetingTunerConfig = {
  /** 윈도 일수. 기본 28. */
  windowDays: number
  /** 묶음 표본 슬롯 최소 수 (데이터 있는 (date, hour) row). 기본 14. */
  minSamples: number
  /** 가중치 clamp 하한. 기본 0.5. */
  weightFloor: number
  /** 가중치 clamp 상한. 기본 1.5. */
  weightCeil: number
}

export const DEFAULT_TARGETING_TUNER_CONFIG: TargetingTunerConfig = {
  windowDays: 28,
  minSamples: 14,
  weightFloor: 0.5,
  weightCeil: 1.5,
}

// =============================================================================
// 묶음 분류
// =============================================================================

/**
 * (요일, 시간) → 묶음 키.
 *
 * dayOfWeek: 0(일) ~ 6(토). KST 기준.
 * hour: 0..23. KST 기준.
 */
export function bucketOf(dayOfWeek: number, hour: number): TargetingBucket {
  // 평일 = 1(월) ~ 5(금)
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5
  if (hour >= 18 && hour <= 23) return "evening"
  if (isWeekday && hour >= 9 && hour <= 12) return "weekday_morning"
  if (isWeekday && hour >= 13 && hour <= 17) return "weekday_afternoon"
  return "off_peak"
}

// =============================================================================
// 추천 엔진
// =============================================================================

const ALL_BUCKETS: TargetingBucket[] = [
  "weekday_morning",
  "weekday_afternoon",
  "evening",
  "off_peak",
]

function emptyMetrics(): BucketMetrics {
  return {
    impressions: 0,
    clicks: 0,
    cost: 0,
    sampleCount: 0,
    ctr: null,
  }
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return 1.0
  return Math.min(max, Math.max(min, n))
}

/**
 * 광고주 단위 4 묶음 가중치 추천.
 *
 * 흐름:
 *   1. StatHourly 28일 ALL device 합산 (date+hour 별 row)
 *   2. 각 row → 묶음 분류 + 합산
 *   3. 광고주 전체 평균 CTR 산출
 *   4. 묶음 평균 CTR / baseline → 가중치 비율
 *   5. clamp 0.5~1.5 + 표본 부족 묶음은 1.0 (기본값)
 */
export async function recommendTargetingWeights(
  advertiserId: string,
  cfg: TargetingTunerConfig = DEFAULT_TARGETING_TUNER_CONFIG,
): Promise<TargetingRecommendation> {
  const since = new Date()
  since.setUTCDate(since.getUTCDate() - cfg.windowDays)

  // StatHourly 광고주 28일 — date+hour 단위 ALL 디바이스 합산.
  // refId / level 필터 X — 광고주 전체 ALL device 합산이라 광고주별 합산 곧 광고주 stat.
  // 본 모듈은 단순화 — campaign level groupBy 후 합산 (refId 차원 무관).
  const rows = await prisma.statHourly.groupBy({
    by: ["date", "hour"],
    where: {
      advertiserId,
      level: "campaign", // baseline 동일 — KPP 패턴 일관
      device: "ALL",
      date: { gte: since },
    },
    _sum: { impressions: true, clicks: true, cost: true },
  })

  // 묶음 합산
  const buckets: Record<TargetingBucket, BucketMetrics> = {
    weekday_morning: emptyMetrics(),
    weekday_afternoon: emptyMetrics(),
    evening: emptyMetrics(),
    off_peak: emptyMetrics(),
  }

  let totalImps = 0
  let totalClicks = 0
  let totalCost = 0

  for (const r of rows) {
    const day = new Date(r.date).getUTCDay()
    const key = bucketOf(day, r.hour)
    const b = buckets[key]
    const imps = r._sum.impressions ?? 0
    const clicks = r._sum.clicks ?? 0
    const cost = r._sum.cost ? Number(r._sum.cost) : 0
    b.impressions += imps
    b.clicks += clicks
    b.cost += cost
    b.sampleCount += 1
    totalImps += imps
    totalClicks += clicks
    totalCost += cost
  }

  // 묶음 CTR
  for (const k of ALL_BUCKETS) {
    const b = buckets[k]
    b.ctr =
      b.impressions > 0 ? Number(((b.clicks / b.impressions) * 100).toFixed(3)) : null
  }

  const baselineCtr =
    totalImps > 0 ? Number(((totalClicks / totalImps) * 100).toFixed(3)) : null

  // 가중치 산출
  const result: TargetingRecommendation = {
    baseline: {
      impressions: totalImps,
      clicks: totalClicks,
      cost: totalCost,
      ctr: baselineCtr,
    },
    buckets: {
      weekday_morning: {
        metrics: buckets.weekday_morning,
        recommendedWeight: 1.0,
        hasSignal: false,
      },
      weekday_afternoon: {
        metrics: buckets.weekday_afternoon,
        recommendedWeight: 1.0,
        hasSignal: false,
      },
      evening: {
        metrics: buckets.evening,
        recommendedWeight: 1.0,
        hasSignal: false,
      },
      off_peak: {
        metrics: buckets.off_peak,
        recommendedWeight: 1.0,
        hasSignal: false,
      },
    },
  }

  for (const k of ALL_BUCKETS) {
    const b = buckets[k]
    // 표본 부족 또는 baseline 없음 → 기본 weight 1.0 / hasSignal=false
    if (
      b.sampleCount < cfg.minSamples ||
      baselineCtr === null ||
      b.ctr === null ||
      baselineCtr <= 0
    ) {
      continue
    }
    const ratio = b.ctr / baselineCtr
    result.buckets[k].recommendedWeight = Number(
      clamp(ratio, cfg.weightFloor, cfg.weightCeil).toFixed(2),
    )
    result.buckets[k].hasSignal = true
  }

  return result
}
