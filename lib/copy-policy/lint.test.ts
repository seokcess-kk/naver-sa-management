/**
 * lib/copy-policy/lint.ts 단위 테스트 (Phase F.1).
 */

import { describe, expect, it } from "vitest"

import {
  lintCopyText,
  lintCopyFields,
  hasBlockingIssues,
} from "./lint"

describe("lintCopyText — 일반 룰", () => {
  it("'최고' 단일 매치 → superlative_top error", () => {
    const r = lintCopyText("국내 최고 품질")
    expect(r).toHaveLength(1)
    expect(r[0].ruleId).toBe("superlative_top")
    expect(r[0].severity).toBe("error")
    expect(r[0].match).toBe("최고")
  })

  it("'1위' / '1순위' 매치", () => {
    const r1 = lintCopyText("업계 1위 기업")
    expect(r1.some((i) => i.ruleId === "superlative_top")).toBe(true)
    const r2 = lintCopyText("판매 1순위")
    expect(r2.some((i) => i.ruleId === "superlative_top")).toBe(true)
  })

  it("'국내 유일' → superlative_unique", () => {
    const r = lintCopyText("국내 유일의 솔루션")
    expect(r.some((i) => i.ruleId === "superlative_unique")).toBe(true)
  })

  it("'세계 최초' / '업계 최초' → superlative_unique", () => {
    expect(
      lintCopyText("세계 최초 출시").some((i) => i.ruleId === "superlative_unique"),
    ).toBe(true)
    expect(
      lintCopyText("업계 최초 도입").some((i) => i.ruleId === "superlative_unique"),
    ).toBe(true)
  })

  it("'보장' → guarantee_absolute", () => {
    const r = lintCopyText("100% 만족 보장")
    expect(r.some((i) => i.ruleId === "guarantee_absolute")).toBe(true)
  })

  it("'무조건' → guarantee_absolute", () => {
    const r = lintCopyText("무조건 환불")
    expect(r.some((i) => i.ruleId === "guarantee_absolute")).toBe(true)
  })

  it("'최저가' → fastest_cheapest", () => {
    const r = lintCopyText("국내 최저가")
    expect(r.some((i) => i.ruleId === "fastest_cheapest")).toBe(true)
  })

  it("'가장 빠른' / '가장 저렴' → fastest_cheapest", () => {
    expect(
      lintCopyText("가장 빠른 배송").some(
        (i) => i.ruleId === "fastest_cheapest",
      ),
    ).toBe(true)
    expect(
      lintCopyText("가장 저렴한 가격").some(
        (i) => i.ruleId === "fastest_cheapest",
      ),
    ).toBe(true)
  })

  it("'쿠팡' / '네이버' 등 경쟁사 → competitor_brand warn", () => {
    const r = lintCopyText("쿠팡보다 저렴")
    expect(r.some((i) => i.ruleId === "competitor_brand")).toBe(true)
    const competitor = r.find((i) => i.ruleId === "competitor_brand")
    expect(competitor?.severity).toBe("warn")
  })

  it("정상 카피 — 매치 0", () => {
    const r = lintCopyText("렌터카 합리적인 가격에 빌려보세요")
    expect(r).toEqual([])
  })

  it("빈 문자열 → 빈 배열", () => {
    expect(lintCopyText("")).toEqual([])
  })

  it("여러 룰 동시 매치", () => {
    const r = lintCopyText("국내 최고 1위 무조건 보장")
    // superlative_top (최고) + superlative_top (1위) + guarantee_absolute (무조건, 보장) + ...
    expect(r.length).toBeGreaterThanOrEqual(3)
  })
})

describe("lintCopyText — 의료 industry", () => {
  it("'완치' → medical_effect_claim", () => {
    const r = lintCopyText("완치 보장", "medical")
    expect(r.some((i) => i.ruleId === "medical_effect_claim")).toBe(true)
  })

  it("'즉시 효과' → medical_effect_claim", () => {
    const r = lintCopyText("즉시 효과 발현", "medical")
    expect(r.some((i) => i.ruleId === "medical_effect_claim")).toBe(true)
  })

  it("'치료 전후' → medical_before_after warn", () => {
    const r = lintCopyText("치료 전후 비교 사진", "medical")
    expect(r.some((i) => i.ruleId === "medical_before_after")).toBe(true)
  })

  it("medical 룰은 industry='general'에서 매치 X", () => {
    const r = lintCopyText("완치 보장", "general")
    expect(r.some((i) => i.ruleId === "medical_effect_claim")).toBe(false)
  })
})

describe("lintCopyText — 금융 industry", () => {
  it("'무위험' → finance_no_risk", () => {
    const r = lintCopyText("무위험 투자 상품", "finance")
    expect(r.some((i) => i.ruleId === "finance_no_risk")).toBe(true)
  })

  it("'원금 보장' → finance_no_risk", () => {
    const r = lintCopyText("원금 보장 상품", "finance")
    expect(r.some((i) => i.ruleId === "finance_no_risk")).toBe(true)
  })

  it("'연 10%' 같은 구체 수익률 → finance_high_return warn", () => {
    const r = lintCopyText("연 10% 수익", "finance")
    expect(r.some((i) => i.ruleId === "finance_high_return")).toBe(true)
  })
})

describe("lintCopyText — 건강기능식품 industry", () => {
  it("'예방' / '치료' → health_food_treatment", () => {
    const r = lintCopyText("질병 예방 효과", "health_food")
    expect(r.some((i) => i.ruleId === "health_food_treatment")).toBe(true)
  })

  it("'약 효과' → health_food_medical_claim", () => {
    const r = lintCopyText("약 효과 같은", "health_food")
    expect(r.some((i) => i.ruleId === "health_food_medical_claim")).toBe(true)
  })
})

describe("lintCopyFields", () => {
  it("필드별 매치 + field 정보 포함", () => {
    const r = lintCopyFields({
      title: "국내 1위 기업",
      description: "최고 품질",
    })
    expect(r.length).toBeGreaterThanOrEqual(2)
    const titleIssue = r.find((i) => i.field === "title")
    const descIssue = r.find((i) => i.field === "description")
    expect(titleIssue).toBeDefined()
    expect(descIssue).toBeDefined()
  })

  it("빈 텍스트 필드는 skip", () => {
    const r = lintCopyFields({
      title: "정상 텍스트",
      description: "",
    })
    expect(r).toEqual([])
  })
})

describe("hasBlockingIssues", () => {
  it("error 1건 이상 → true", () => {
    expect(
      hasBlockingIssues([
        {
          ruleId: "x",
          match: "x",
          message: "x",
          severity: "error",
        },
      ]),
    ).toBe(true)
  })

  it("warn 만 → false", () => {
    expect(
      hasBlockingIssues([
        {
          ruleId: "x",
          match: "x",
          message: "x",
          severity: "warn",
        },
      ]),
    ).toBe(false)
  })

  it("빈 배열 → false", () => {
    expect(hasBlockingIssues([])).toBe(false)
  })
})
