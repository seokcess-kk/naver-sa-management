/**
 * adgroups/actions.ts 헬퍼 단위 테스트.
 *
 * 본 파일은 Server Action 본체(bulkUpdateAdgroups / syncAdgroups) 통합 테스트는 담당 X.
 * 외부 의존(prisma / SA / auth) 없는 순수 헬퍼 — extractActualUserLock — 만 검증.
 *
 * SPEC TODO(F-6.4 롤백 정확도) 1차 적용:
 *   - SA 응답의 `userLock` 이 `raw` 에 보존되어 있으면 그 값 신뢰
 *   - 없으면 `status==='off'` 폴백 (기존 단순화 표현식)
 *   - PAUSED + userLock=false 광고그룹의 before 가 잘못 true 로 기록되던 시나리오 회귀 방지
 */

import { describe, expect, it } from "vitest"

import { extractActualUserLock } from "./actions"
import type { AdGroupStatus } from "@/lib/generated/prisma/client"

describe("extractActualUserLock — F-6.4 롤백 정확도 1차", () => {
  it("raw.userLock=true → true (status 무시)", () => {
    expect(
      extractActualUserLock({
        status: "on" as AdGroupStatus,
        raw: { userLock: true, status: "ELIGIBLE" },
      }),
    ).toBe(true)
  })

  it("raw.userLock=false + status='off' (PAUSED 시스템 정지) → false", () => {
    // 회귀 핵심: status='off' 인데 raw.userLock=false 인 PAUSED 광고그룹.
    // 기존 단순 표현식은 true 로 기록 → 본 1차 개선으로 false 정확.
    expect(
      extractActualUserLock({
        status: "off" as AdGroupStatus,
        raw: { userLock: false, status: "PAUSED", statusReason: "BUDGET_EXCEEDED" },
      }),
    ).toBe(false)
  })

  it("raw.userLock=true + status='off' (사용자 명시 OFF) → true", () => {
    expect(
      extractActualUserLock({
        status: "off" as AdGroupStatus,
        raw: { userLock: true, status: "PAUSED" },
      }),
    ).toBe(true)
  })

  it("raw 없음 + status='off' → 폴백 true", () => {
    expect(
      extractActualUserLock({
        status: "off" as AdGroupStatus,
        raw: null,
      }),
    ).toBe(true)
  })

  it("raw 없음 + status='on' → 폴백 false", () => {
    expect(
      extractActualUserLock({
        status: "on" as AdGroupStatus,
        raw: null,
      }),
    ).toBe(false)
  })

  it("raw 에 userLock 키 없음 → 폴백 (status='off' → true)", () => {
    expect(
      extractActualUserLock({
        status: "off" as AdGroupStatus,
        raw: { status: "PAUSED" },
      }),
    ).toBe(true)
  })

  it("raw 가 배열이면 폴백 (방어적 — SA 응답이 배열일 일 없으나 타입 가드)", () => {
    expect(
      extractActualUserLock({
        status: "on" as AdGroupStatus,
        raw: [{ userLock: true }],
      }),
    ).toBe(false) // status==='on' 폴백
  })

  it("raw.userLock 이 boolean 아닌 값(string) → 폴백", () => {
    expect(
      extractActualUserLock({
        status: "off" as AdGroupStatus,
        raw: { userLock: "true" }, // 문자열 — 신뢰 X
      }),
    ).toBe(true) // status==='off' 폴백
  })
})
