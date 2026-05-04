/**
 * 검색어 마이닝 분류 엔진 (Phase D.2).
 *
 * 책임:
 *   - 검색어 보고서 row 1건을 KPP baseline + 룰 임계와 비교 → new / exclude / neutral 분류
 *   - 출력: ClassificationResult — cron 호출자가 ApprovalQueue 적재
 *
 * 핵심 원칙 (사용자 검토 반영):
 *   - 자동 실행 X — 모든 분류는 ApprovalQueue 거쳐 운영자 승인 (신규/제외 자동 등록 위험)
 *   - 임계는 광고주별 baseline 기반 동적 산출 — 절대 수치 X
 *   - 의도 분류(브랜드/경쟁사/무료/공짜) 는 본 모듈 비대상 — 후속 PR (LLM 또는 키워드 사전)
 *   - 데이터 신뢰도 부족 행은 neutral (자동 분류 침묵)
 *
 * 입력 source 무관:
 *   - SearchTermRow shape 만 충족하면 SA API / CSV / 수동 입력 모두 동일 동작
 *   - 본 모듈은 외부 호출 0 (DB / SA / fetch 모두 X)
 */

import type { Prisma } from "@/lib/generated/prisma/client"

// =============================================================================
// 입력 타입
// =============================================================================

/** 검색어 보고서 1행. */
export type SearchTermRow = {
  /** 검색어 원문. */
  searchTerm: string
  /** 어떤 광고그룹에서 발생했는지 (제외키워드 등록 / 신규 키워드 등록 대상 그룹). */
  adgroupId: string
  impressions: number
  clicks: number
  /** 원. Decimal 입력 시 호출자가 Number 변환. */
  cost: number
  /** 전환. P1 미적재 광고주 → null. */
  conversions: number | null
}

/** 광고주 baseline (KeywordPerformanceProfile). */
export type AdvertiserBaselineForMining = {
  avgCtr: Prisma.Decimal | null
  avgCvr: Prisma.Decimal | null
  avgCpc: Prisma.Decimal | null
}

/** 시스템 임계 — 운영 데이터 누적 후 튜닝. */
export type ClassifyConfig = {
  /** 신규 후보 임계 — 노출 N 이상 + 클릭 M 이상. 기본 50/3. */
  newImpressions: number
  newClicks: number
  /** 신규 후보 — 전환 1 이상이면 무조건 승격. 기본 1. */
  newConversionsBypass: number
  /** 제외 후보 — 노출 N 이상 + 클릭 0. 기본 100. */
  excludeNoClickImpressions: number
  /** 제외 후보 — 클릭 N 이상 + 전환 0 + CPA > baseline avgCpc × multiplier. 기본 10 / 3.0 */
  excludeHighCpaClicks: number
  excludeHighCpaMultiplier: number
}

export const DEFAULT_CLASSIFY_CONFIG: ClassifyConfig = {
  newImpressions: 50,
  newClicks: 3,
  newConversionsBypass: 1,
  excludeNoClickImpressions: 100,
  excludeHighCpaClicks: 10,
  excludeHighCpaMultiplier: 3.0,
}

// =============================================================================
// 출력 타입
// =============================================================================

export type Classification = "new" | "exclude" | "neutral"

export type ClassificationResult = {
  searchTerm: string
  adgroupId: string
  classification: Classification
  /** 분류 사유 코드 — 운영자 표시 + 디버깅 용. */
  reasonCode:
    | "conversions_bypass"
    | "high_traffic_clicks"
    | "no_clicks_high_impressions"
    | "high_cpa_no_conversions"
    | "insufficient_data"
    | "neutral_below_thresholds"
  /** 분류 메트릭 — UI 본문 enrich. */
  metrics: {
    impressions: number
    clicks: number
    cost: number
    conversions: number | null
    /** %. impressions=0 → null. */
    ctr: number | null
    /** 원. clicks=0 → null. */
    cpc: number | null
    /** 원. conversions ≤ 0 / null → null. */
    cpa: number | null
  }
}

// =============================================================================
// 핵심 로직
// =============================================================================

export function classifySearchTerm(
  row: SearchTermRow,
  baseline: AdvertiserBaselineForMining,
  cfg: ClassifyConfig = DEFAULT_CLASSIFY_CONFIG,
): ClassificationResult {
  const { impressions, clicks, cost, conversions } = row
  const ctr =
    impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(3)) : null
  const cpc = clicks > 0 ? Math.round(cost / clicks) : null
  const cpa =
    conversions != null && conversions > 0
      ? Math.round(cost / conversions)
      : null

  const metrics: ClassificationResult["metrics"] = {
    impressions,
    clicks,
    cost,
    conversions,
    ctr,
    cpc,
    cpa,
  }

  // 분기 우선순위 (사용자 검토 반영):
  //   exclude 가 new 보다 우선 — "트래픽은 있는데 비효율" 검색어를 신규로 잘못 등록 차단.

  // -- 1. new 후보 (전환 1+ 무조건 승격) ------------------------------------
  if (
    conversions != null &&
    conversions >= cfg.newConversionsBypass
  ) {
    return {
      searchTerm: row.searchTerm,
      adgroupId: row.adgroupId,
      classification: "new",
      reasonCode: "conversions_bypass",
      metrics,
    }
  }

  // -- 2. exclude 후보 (노출 많은데 클릭 0 — 의도 불일치) -------------------
  if (
    impressions >= cfg.excludeNoClickImpressions &&
    clicks === 0
  ) {
    return {
      searchTerm: row.searchTerm,
      adgroupId: row.adgroupId,
      classification: "exclude",
      reasonCode: "no_clicks_high_impressions",
      metrics,
    }
  }

  // -- 3. exclude 후보 (클릭 충분 + 전환 0 + CPA 매우 높음) -----------------
  //    new (트래픽 임계) 보다 우선 — 전환 없는 비효율 검색어가 신규로 잘못 등록되지 않게.
  if (
    clicks >= cfg.excludeHighCpaClicks &&
    (conversions === 0 || conversions === null) &&
    baseline.avgCpc != null &&
    cpc != null
  ) {
    const baselineCpc = Number(baseline.avgCpc)
    if (
      baselineCpc > 0 &&
      cpc > baselineCpc * cfg.excludeHighCpaMultiplier
    ) {
      return {
        searchTerm: row.searchTerm,
        adgroupId: row.adgroupId,
        classification: "exclude",
        reasonCode: "high_cpa_no_conversions",
        metrics,
      }
    }
  }

  // -- 4. new 후보 (트래픽 임계 통과) ----------------------------------------
  if (
    impressions >= cfg.newImpressions &&
    clicks >= cfg.newClicks
  ) {
    return {
      searchTerm: row.searchTerm,
      adgroupId: row.adgroupId,
      classification: "new",
      reasonCode: "high_traffic_clicks",
      metrics,
    }
  }

  // -- 5. 데이터 부족 (impressions 임계 미달이라도 일부 클릭 + baseline 없음) ---
  if (
    impressions < cfg.newImpressions &&
    impressions < cfg.excludeNoClickImpressions
  ) {
    return {
      searchTerm: row.searchTerm,
      adgroupId: row.adgroupId,
      classification: "neutral",
      reasonCode: "insufficient_data",
      metrics,
    }
  }

  // -- 6. neutral (임계 통과 안 함) ------------------------------------------
  return {
    searchTerm: row.searchTerm,
    adgroupId: row.adgroupId,
    classification: "neutral",
    reasonCode: "neutral_below_thresholds",
    metrics,
  }
}

/** 다중 row 일괄 분류. neutral 은 결과에서 제외 (ApprovalQueue 적재 의미 없음). */
export function classifySearchTerms(
  rows: SearchTermRow[],
  baseline: AdvertiserBaselineForMining,
  cfg: ClassifyConfig = DEFAULT_CLASSIFY_CONFIG,
): ClassificationResult[] {
  return rows
    .map((r) => classifySearchTerm(r, baseline, cfg))
    .filter((c) => c.classification !== "neutral")
}
