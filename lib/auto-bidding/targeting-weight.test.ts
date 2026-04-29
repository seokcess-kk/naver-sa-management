/**
 * F-11.4 — getTargetingWeight 단위 테스트.
 *
 * 외부 호출 0 — 순수 함수 테스트.
 *
 * 검증 분기:
 *   1. rule null → 1.0
 *   2. rule.enabled=false → 1.0
 *   3. hourWeights 키 매칭 (mon-9 / fri-22)
 *   4. defaultWeight 폴백 (hourKey 누락)
 *   5. deviceWeights PC/MOBILE
 *   6. deviceWeights 미설정 → 1.0 폴백
 *   7. weight 곱 (hour × device)
 *   8. clamp 0.1..3.0 (3배 / 0)
 *   9. 비정상 값 (음수 / NaN / 문자열 / Infinity)
 *  10. KST 변환 (UTC+9h)
 *  11. makeHourKey 별도
 */

import { describe, it, expect } from "vitest"

import {
  getTargetingWeight,
  makeHourKey,
  type TargetingRuleSlice,
} from "@/lib/auto-bidding/targeting-weight"

// =============================================================================
// 테스트 데이터
// =============================================================================

function rule(over?: Partial<TargetingRuleSlice>): TargetingRuleSlice {
  return {
    enabled: true,
    defaultWeight: 1.0,
    hourWeights: {},
    deviceWeights: {},
    ...over,
  }
}

// UTC 0시 = KST 9시. 2026-04-29 수요일.
const UTC_WED_0 = new Date("2026-04-29T00:00:00.000Z") // KST 수요일 9시
// UTC 13시 = KST 22시 = 같은 날 (수요일).
const UTC_WED_13 = new Date("2026-04-29T13:00:00.000Z") // KST 수요일 22시
// UTC 16시 = KST 1시 (다음날 == 목요일 새벽).
const UTC_WED_16 = new Date("2026-04-29T16:00:00.000Z") // KST 목요일 1시

// =============================================================================
// makeHourKey
// =============================================================================

describe("makeHourKey", () => {
  it("UTC 0시 → KST 9시 (수요일)", () => {
    expect(makeHourKey(UTC_WED_0)).toBe("wed-9")
  })

  it("UTC 13시 → KST 22시 (수요일)", () => {
    expect(makeHourKey(UTC_WED_13)).toBe("wed-22")
  })

  it("UTC 16시 → KST 1시 (목요일로 day 변경)", () => {
    expect(makeHourKey(UTC_WED_16)).toBe("thu-1")
  })

  it("UTC 일요일 0시 → KST 일요일 9시", () => {
    // 2026-04-26 (일)
    expect(makeHourKey(new Date("2026-04-26T00:00:00.000Z"))).toBe("sun-9")
  })
})

// =============================================================================
// getTargetingWeight
// =============================================================================

describe("getTargetingWeight", () => {
  it("1. rule null → 1.0", () => {
    expect(getTargetingWeight(null, { now: UTC_WED_0, device: "PC" })).toBe(1.0)
  })

  it("1b. rule undefined → 1.0", () => {
    expect(
      getTargetingWeight(undefined, { now: UTC_WED_0, device: "PC" }),
    ).toBe(1.0)
  })

  it("2. enabled=false → 1.0 (다른 weight 무시)", () => {
    const r = rule({
      enabled: false,
      defaultWeight: 2.5,
      hourWeights: { "wed-9": 2.0 },
      deviceWeights: { PC: 2.0 },
    })
    expect(getTargetingWeight(r, { now: UTC_WED_0, device: "PC" })).toBe(1.0)
  })

  it("3. hourKey 매칭 (KST wed-9)", () => {
    const r = rule({ hourWeights: { "wed-9": 1.5 } })
    expect(getTargetingWeight(r, { now: UTC_WED_0, device: "PC" })).toBe(1.5)
  })

  it("3b. hourKey 매칭 (KST wed-22 = UTC 13시)", () => {
    const r = rule({ hourWeights: { "wed-22": 0.7 } })
    // device 1.0 fallback → 0.7
    expect(getTargetingWeight(r, { now: UTC_WED_13, device: "PC" })).toBeCloseTo(
      0.7,
      5,
    )
  })

  it("4. hourKey 누락 → defaultWeight 폴백", () => {
    const r = rule({
      defaultWeight: 1.3,
      hourWeights: { "mon-0": 2.0 }, // 수요일 9시는 미설정
    })
    expect(
      getTargetingWeight(r, { now: UTC_WED_0, device: "PC" }),
    ).toBeCloseTo(1.3, 5)
  })

  it("5. deviceWeights PC", () => {
    const r = rule({
      hourWeights: { "wed-9": 1.0 },
      deviceWeights: { PC: 1.2, MOBILE: 0.8 },
    })
    expect(getTargetingWeight(r, { now: UTC_WED_0, device: "PC" })).toBeCloseTo(
      1.2,
      5,
    )
  })

  it("5b. deviceWeights MOBILE", () => {
    const r = rule({
      hourWeights: { "wed-9": 1.0 },
      deviceWeights: { PC: 1.2, MOBILE: 0.8 },
    })
    expect(
      getTargetingWeight(r, { now: UTC_WED_0, device: "MOBILE" }),
    ).toBeCloseTo(0.8, 5)
  })

  it("6. deviceWeights 미설정 → 1.0 폴백 (defaultWeight 무시)", () => {
    const r = rule({
      defaultWeight: 2.0,
      hourWeights: { "wed-9": 1.0 },
      deviceWeights: {},
    })
    // hour 1.0 × device 1.0 (fallback) = 1.0 (defaultWeight 2.0 미적용)
    expect(getTargetingWeight(r, { now: UTC_WED_0, device: "PC" })).toBe(1.0)
  })

  it("7. weight 곱 (hour × device)", () => {
    const r = rule({
      hourWeights: { "wed-9": 1.5 },
      deviceWeights: { PC: 1.2 },
    })
    expect(getTargetingWeight(r, { now: UTC_WED_0, device: "PC" })).toBeCloseTo(
      1.8, // 1.5 * 1.2
      5,
    )
  })

  it("8a. clamp 상한 3.0 (2.0 × 2.0 = 4.0 → 3.0)", () => {
    const r = rule({
      hourWeights: { "wed-9": 2.0 },
      deviceWeights: { PC: 2.0 },
    })
    expect(getTargetingWeight(r, { now: UTC_WED_0, device: "PC" })).toBe(3.0)
  })

  it("8b. clamp 하한 0.1 (0.05 × 1.0 = 0.05 → 0.1)", () => {
    const r = rule({
      hourWeights: { "wed-9": 0.05 },
    })
    expect(getTargetingWeight(r, { now: UTC_WED_0, device: "PC" })).toBe(0.1)
  })

  it("8c. 0 곱 → 하한 0.1 (입찰 정지 안전 차단)", () => {
    const r = rule({
      hourWeights: { "wed-9": 0 },
      deviceWeights: { PC: 1.0 },
    })
    expect(getTargetingWeight(r, { now: UTC_WED_0, device: "PC" })).toBe(0.1)
  })

  it("9a. hourWeights 비정상 값(음수) → defaultWeight 폴백", () => {
    const r = rule({
      defaultWeight: 1.5,
      hourWeights: { "wed-9": -1.0 } as unknown as Record<string, number>,
    })
    expect(
      getTargetingWeight(r, { now: UTC_WED_0, device: "PC" }),
    ).toBeCloseTo(1.5, 5)
  })

  it("9b. hourWeights NaN → defaultWeight 폴백", () => {
    const r = rule({
      defaultWeight: 1.4,
      hourWeights: { "wed-9": Number.NaN } as unknown as Record<string, number>,
    })
    expect(
      getTargetingWeight(r, { now: UTC_WED_0, device: "PC" }),
    ).toBeCloseTo(1.4, 5)
  })

  it("9c. hourWeights 문자열 → defaultWeight 폴백", () => {
    const r = rule({
      defaultWeight: 1.2,
      hourWeights: { "wed-9": "1.5" as unknown as number },
    })
    expect(
      getTargetingWeight(r, { now: UTC_WED_0, device: "PC" }),
    ).toBeCloseTo(1.2, 5)
  })

  it("9d. hourWeights Infinity → defaultWeight 폴백", () => {
    const r = rule({
      defaultWeight: 1.0,
      hourWeights: { "wed-9": Number.POSITIVE_INFINITY } as unknown as Record<
        string,
        number
      >,
    })
    expect(getTargetingWeight(r, { now: UTC_WED_0, device: "PC" })).toBe(1.0)
  })

  it("9e. hourWeights DB 한계 초과 (10.0) → defaultWeight 폴백", () => {
    const r = rule({
      defaultWeight: 1.0,
      hourWeights: { "wed-9": 10.0 },
    })
    expect(getTargetingWeight(r, { now: UTC_WED_0, device: "PC" })).toBe(1.0)
  })

  it("9f. defaultWeight 자체가 비정상(음수) → 1.0 으로 강제", () => {
    const r = rule({
      defaultWeight: -1 as unknown as number,
      hourWeights: {}, // hourKey 누락 → defaultWeight 폴백 시도 → 안전 1.0
    })
    expect(getTargetingWeight(r, { now: UTC_WED_0, device: "PC" })).toBe(1.0)
  })

  it("9g. defaultWeight NaN → 1.0", () => {
    const r = rule({
      defaultWeight: Number.NaN,
      hourWeights: {},
    })
    expect(getTargetingWeight(r, { now: UTC_WED_0, device: "PC" })).toBe(1.0)
  })

  it("10. KST 일요일 (UTC 토요일 16시 = KST 일요일 1시)", () => {
    // 2026-04-25 토요일 UTC 16시 = 2026-04-26 일요일 KST 1시
    const r = rule({ hourWeights: { "sun-1": 1.5 } })
    expect(
      getTargetingWeight(r, {
        now: new Date("2026-04-25T16:00:00.000Z"),
        device: "PC",
      }),
    ).toBeCloseTo(1.5, 5)
  })

  it("11. happy path — hour 1.5 × device 1.2 = 1.8", () => {
    const r = rule({
      hourWeights: { "wed-9": 1.5 },
      deviceWeights: { PC: 1.2, MOBILE: 0.8 },
    })
    expect(getTargetingWeight(r, { now: UTC_WED_0, device: "PC" })).toBeCloseTo(
      1.8,
      5,
    )
  })
})
