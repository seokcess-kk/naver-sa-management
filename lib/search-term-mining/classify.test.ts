/**
 * lib/search-term-mining/classify.ts 단위 테스트 (Phase D.2).
 *
 * 검증 매트릭스:
 *   A. 전환 1+ 무조건 new (conversions_bypass)
 *   B. 노출 50+ 클릭 3+ → new (high_traffic_clicks)
 *   C. 노출 100+ 클릭 0 → exclude (no_clicks_high_impressions)
 *   D. 클릭 10+ 전환 0 + cpc > baseline × 3 → exclude (high_cpa_no_conversions)
 *   E. 데이터 부족 → neutral (insufficient_data)
 *   F. 임계 미달 → neutral (neutral_below_thresholds)
 *   G. classifySearchTerms 일괄 — neutral 제외
 *   H. metrics 계산 정확성 (ctr/cpc/cpa)
 */

import { describe, expect, it } from "vitest"
import { Prisma } from "@/lib/generated/prisma/client"

import {
  classifySearchTerm,
  classifySearchTerms,
  DEFAULT_CLASSIFY_CONFIG,
} from "./classify"

const baseline = {
  avgCtr: new Prisma.Decimal("0.02"),
  avgCvr: new Prisma.Decimal("0.05"),
  avgCpc: new Prisma.Decimal("1000"),
}

function row(over: Partial<{
  searchTerm: string
  adgroupId: string
  impressions: number
  clicks: number
  cost: number
  conversions: number | null
}> = {}) {
  return {
    searchTerm: over.searchTerm ?? "테스트키워드",
    adgroupId: over.adgroupId ?? "adg1",
    impressions: over.impressions ?? 0,
    clicks: over.clicks ?? 0,
    cost: over.cost ?? 0,
    conversions: over.conversions ?? null,
  }
}

describe("A. conversions_bypass", () => {
  it("conversions=1 → new (트래픽 임계 무관)", () => {
    const r = classifySearchTerm(
      row({ impressions: 10, clicks: 1, cost: 1000, conversions: 1 }),
      baseline,
    )
    expect(r.classification).toBe("new")
    expect(r.reasonCode).toBe("conversions_bypass")
  })
  it("conversions=10 + 노출 적음 → new", () => {
    const r = classifySearchTerm(
      row({ impressions: 5, clicks: 1, cost: 100, conversions: 10 }),
      baseline,
    )
    expect(r.classification).toBe("new")
  })
})

describe("B. high_traffic_clicks", () => {
  it("imps=50 clicks=3 conversions=null → new", () => {
    const r = classifySearchTerm(
      row({ impressions: 50, clicks: 3, cost: 3000 }),
      baseline,
    )
    expect(r.classification).toBe("new")
    expect(r.reasonCode).toBe("high_traffic_clicks")
  })
  it("imps=49 clicks=3 → 임계 미달 → exclude/neutral 분기", () => {
    const r = classifySearchTerm(
      row({ impressions: 49, clicks: 3, cost: 3000 }),
      baseline,
    )
    expect(r.classification).not.toBe("new")
  })
  it("imps=50 clicks=2 → 임계 미달", () => {
    const r = classifySearchTerm(
      row({ impressions: 50, clicks: 2, cost: 2000 }),
      baseline,
    )
    expect(r.classification).not.toBe("new")
  })
})

describe("C. no_clicks_high_impressions", () => {
  it("imps=100 clicks=0 → exclude", () => {
    const r = classifySearchTerm(
      row({ impressions: 100, clicks: 0 }),
      baseline,
    )
    expect(r.classification).toBe("exclude")
    expect(r.reasonCode).toBe("no_clicks_high_impressions")
  })
  it("imps=99 clicks=0 → 임계 미달 → neutral", () => {
    const r = classifySearchTerm(
      row({ impressions: 99, clicks: 0 }),
      baseline,
    )
    expect(r.classification).toBe("neutral")
  })
})

describe("D. high_cpa_no_conversions", () => {
  it("clicks=10 conversions=0 + cpc 3500 > baseline 1000 × 3 → exclude", () => {
    const r = classifySearchTerm(
      row({
        impressions: 1000,
        clicks: 10,
        cost: 35_000, // cpc 3500
        conversions: 0,
      }),
      baseline,
    )
    expect(r.classification).toBe("exclude")
    expect(r.reasonCode).toBe("high_cpa_no_conversions")
  })
  it("clicks=10 conversions=0 + cpc 2000 ≤ baseline × 3 (=3000) → high_cpa 분기 X → new (트래픽 충족)", () => {
    const r = classifySearchTerm(
      row({
        impressions: 1000,
        clicks: 10,
        cost: 20_000, // cpc 2000
        conversions: 0,
      }),
      baseline,
    )
    // exclude high_cpa 임계 미달 → 다음 분기(high_traffic_clicks: imps≥50 clicks≥3)에 매치 → new
    expect(r.classification).toBe("new")
    expect(r.reasonCode).toBe("high_traffic_clicks")
  })
  it("baseline avgCpc null → high_cpa 분기 비활성 → new (트래픽 충족)", () => {
    const r = classifySearchTerm(
      row({
        impressions: 1000,
        clicks: 10,
        cost: 100_000,
        conversions: 0,
      }),
      { avgCtr: null, avgCvr: null, avgCpc: null },
    )
    // baseline 없으면 high_cpa 분기 비활성 → 트래픽 임계 통과로 new
    expect(r.classification).toBe("new")
  })
  it("trafficMissing 검증 — clicks=2 (트래픽 미달) + high_cpa 미달 → neutral", () => {
    const r = classifySearchTerm(
      row({
        impressions: 80,
        clicks: 2,
        cost: 4000, // cpc 2000
        conversions: 0,
      }),
      baseline,
    )
    expect(r.classification).toBe("neutral")
  })
  it("conversions=null (미적재) + cpc 높음 → exclude (null 도 0 처럼 처리)", () => {
    const r = classifySearchTerm(
      row({
        impressions: 1000,
        clicks: 10,
        cost: 35_000,
        conversions: null,
      }),
      baseline,
    )
    expect(r.classification).toBe("exclude")
  })
})

describe("E/F. neutral", () => {
  it("imps=20 clicks=0 → insufficient_data", () => {
    const r = classifySearchTerm(
      row({ impressions: 20, clicks: 0 }),
      baseline,
    )
    expect(r.classification).toBe("neutral")
    expect(r.reasonCode).toBe("insufficient_data")
  })
  it("임계 사이 (imps=80 clicks=2) → neutral_below_thresholds", () => {
    const r = classifySearchTerm(
      row({ impressions: 80, clicks: 2, cost: 2000 }),
      baseline,
    )
    expect(r.classification).toBe("neutral")
  })
})

describe("H. metrics 정확성", () => {
  it("ctr / cpc / cpa 계산", () => {
    const r = classifySearchTerm(
      row({
        impressions: 1000,
        clicks: 50,
        cost: 100_000,
        conversions: 5,
      }),
      baseline,
    )
    expect(r.metrics.ctr).toBe(5) // 50/1000 * 100
    expect(r.metrics.cpc).toBe(2000) // 100000 / 50
    expect(r.metrics.cpa).toBe(20_000) // 100000 / 5
  })
  it("imps=0 → ctr null", () => {
    const r = classifySearchTerm(row({ impressions: 0 }), baseline)
    expect(r.metrics.ctr).toBeNull()
  })
  it("clicks=0 → cpc null", () => {
    const r = classifySearchTerm(
      row({ impressions: 100, clicks: 0 }),
      baseline,
    )
    expect(r.metrics.cpc).toBeNull()
  })
  it("conversions null → cpa null", () => {
    const r = classifySearchTerm(
      row({ impressions: 100, clicks: 5, cost: 5000, conversions: null }),
      baseline,
    )
    expect(r.metrics.cpa).toBeNull()
  })
})

describe("G. classifySearchTerms 일괄", () => {
  it("neutral 행 제외하고 new/exclude 만 반환", () => {
    const rows = [
      row({ searchTerm: "A", impressions: 50, clicks: 3, cost: 3000 }), // new
      row({ searchTerm: "B", impressions: 100, clicks: 0 }), // exclude
      row({ searchTerm: "C", impressions: 30, clicks: 1, cost: 1000 }), // neutral
    ]
    const results = classifySearchTerms(rows, baseline)
    expect(results).toHaveLength(2)
    expect(results.map((r) => r.searchTerm).sort()).toEqual(["A", "B"])
  })
  it("빈 입력 → 빈 결과", () => {
    expect(classifySearchTerms([], baseline)).toEqual([])
  })
})

describe("DEFAULT_CLASSIFY_CONFIG", () => {
  it("기본 임계 노출", () => {
    expect(DEFAULT_CLASSIFY_CONFIG.newImpressions).toBe(50)
    expect(DEFAULT_CLASSIFY_CONFIG.newClicks).toBe(3)
    expect(DEFAULT_CLASSIFY_CONFIG.newConversionsBypass).toBe(1)
    expect(DEFAULT_CLASSIFY_CONFIG.excludeNoClickImpressions).toBe(100)
    expect(DEFAULT_CLASSIFY_CONFIG.excludeHighCpaClicks).toBe(10)
    expect(DEFAULT_CLASSIFY_CONFIG.excludeHighCpaMultiplier).toBe(3.0)
  })
})
