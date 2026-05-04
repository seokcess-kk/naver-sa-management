/**
 * lib/sync/runners.ts 단위 테스트 (Phase A.3 — 품질지수 추출)
 *
 * 검증 범위:
 *   - extractQualityScore: 다양한 nccQi shape 에서 1~7 추출 / 범위 밖 / 미포함 → null
 *
 * 본 테스트는 sync runner 전체가 아닌 helper 단일 함수만 검증.
 * runner 흐름은 e2e/통합에서 검증 (외부 SA 호출 + Prisma 의존).
 */

import { describe, expect, it } from "vitest"

import { extractQualityScore } from "./runners"

describe("extractQualityScore", () => {
  it("number 직접 — 1~7 범위 → 정수", () => {
    expect(extractQualityScore(5)).toBe(5)
    expect(extractQualityScore(1)).toBe(1)
    expect(extractQualityScore(7)).toBe(7)
  })

  it("number 직접 — 1~7 범위 + 소수 → 반올림", () => {
    expect(extractQualityScore(4.4)).toBe(4)
    expect(extractQualityScore(4.5)).toBe(5)
    expect(extractQualityScore(6.7)).toBe(7)
  })

  it("number 직접 — 범위 밖 → null", () => {
    expect(extractQualityScore(0)).toBeNull()
    expect(extractQualityScore(8)).toBeNull()
    expect(extractQualityScore(-1)).toBeNull()
    expect(extractQualityScore(100)).toBeNull()
  })

  it("number 직접 — NaN / Infinity → null", () => {
    expect(extractQualityScore(NaN)).toBeNull()
    expect(extractQualityScore(Infinity)).toBeNull()
    expect(extractQualityScore(-Infinity)).toBeNull()
  })

  it("object with qiGrade — 가장 흔한 shape", () => {
    expect(extractQualityScore({ qiGrade: 5 })).toBe(5)
  })

  it("object with qualityScore", () => {
    expect(extractQualityScore({ qualityScore: 6 })).toBe(6)
  })

  it("object with qScoreEstm", () => {
    expect(extractQualityScore({ qScoreEstm: 4 })).toBe(4)
  })

  it("object with score (마지막 폴백)", () => {
    expect(extractQualityScore({ score: 3 })).toBe(3)
  })

  it("우선순위 — qiGrade > qualityScore > qScoreEstm > score", () => {
    expect(
      extractQualityScore({
        qiGrade: 1,
        qualityScore: 7,
        qScoreEstm: 5,
        score: 3,
      }),
    ).toBe(1)
    expect(
      extractQualityScore({
        qualityScore: 7,
        qScoreEstm: 5,
        score: 3,
      }),
    ).toBe(7)
    expect(
      extractQualityScore({
        qScoreEstm: 5,
        score: 3,
      }),
    ).toBe(5)
  })

  it("object with non-number 후보 → null", () => {
    expect(extractQualityScore({ qiGrade: "5" })).toBeNull()
    expect(extractQualityScore({ qiGrade: null })).toBeNull()
    expect(extractQualityScore({ qiGrade: {} })).toBeNull()
  })

  it("object 없음 / null / undefined → null", () => {
    expect(extractQualityScore(null)).toBeNull()
    expect(extractQualityScore(undefined)).toBeNull()
    expect(extractQualityScore({})).toBeNull()
  })

  it("string / boolean / array → null", () => {
    expect(extractQualityScore("5")).toBeNull()
    expect(extractQualityScore(true)).toBeNull()
    expect(extractQualityScore([5])).toBeNull()
  })
})
