/**
 * lib/budget-pacer/vat.ts 단위 테스트 (Phase E.2).
 */

import { describe, expect, it } from "vitest"

import {
  withVat,
  withoutVat,
  isBizmoneyBelowDays,
  KOREAN_VAT_RATE,
} from "./vat"

describe("withVat", () => {
  it("정수 — 10000원 → 11000원", () => {
    expect(withVat(10_000)).toBe(11_000)
  })
  it("소수 반올림", () => {
    // 1234 × 1.1 = 1357.4 → 1357
    expect(withVat(1_234)).toBe(1_357)
  })
  it("0 → 0", () => {
    expect(withVat(0)).toBe(0)
  })
  it("NaN → throw", () => {
    expect(() => withVat(NaN)).toThrow()
    expect(() => withVat(Infinity)).toThrow()
  })
})

describe("withoutVat", () => {
  it("11000원 → 10000원", () => {
    expect(withoutVat(11_000)).toBe(10_000)
  })
  it("소수 반올림 — 1357 / 1.1 = 1233.6 → 1234", () => {
    expect(withoutVat(1_357)).toBe(1_234)
  })
  it("withVat → withoutVat 라운드트립 (반올림 오차 1원 이내)", () => {
    for (const x of [100, 1000, 10_000, 12345, 999_999]) {
      expect(Math.abs(withoutVat(withVat(x)) - x)).toBeLessThanOrEqual(1)
    }
  })
})

describe("KOREAN_VAT_RATE", () => {
  it("0.1 (10%)", () => {
    expect(KOREAN_VAT_RATE).toBe(0.1)
  })
})

describe("isBizmoneyBelowDays", () => {
  it("비즈머니 100,000원 (VAT 포함) vs 일예산 10,000원 (VAT 별도) × 7일 = 77,000원 → 부족 X", () => {
    expect(
      isBizmoneyBelowDays({
        bizmoneyIncVat: 100_000,
        dailyBudgetSumExVat: 10_000,
        days: 7,
      }),
    ).toBe(false)
  })
  it("비즈머니 50,000원 vs 일예산 10,000원 × 7일 = 77,000원 → 부족", () => {
    expect(
      isBizmoneyBelowDays({
        bizmoneyIncVat: 50_000,
        dailyBudgetSumExVat: 10_000,
        days: 7,
      }),
    ).toBe(true)
  })
  it("일예산 0 → 평가 의미 없음 (false)", () => {
    expect(
      isBizmoneyBelowDays({
        bizmoneyIncVat: 0,
        dailyBudgetSumExVat: 0,
        days: 7,
      }),
    ).toBe(false)
  })
  it("경계 — bizmoney 정확히 required 와 동일 → 부족 아님", () => {
    // 일예산 10000 × 7일 = 70000 (VAT 별도) → withVat = 77000
    expect(
      isBizmoneyBelowDays({
        bizmoneyIncVat: 77_000,
        dailyBudgetSumExVat: 10_000,
        days: 7,
      }),
    ).toBe(false)
  })
  it("경계 — bizmoney 76999 (1원 부족) → 부족", () => {
    expect(
      isBizmoneyBelowDays({
        bizmoneyIncVat: 76_999,
        dailyBudgetSumExVat: 10_000,
        days: 7,
      }),
    ).toBe(true)
  })
})
