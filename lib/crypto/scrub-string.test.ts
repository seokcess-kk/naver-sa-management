/**
 * lib/crypto/scrub-string.ts 단위 테스트.
 *
 * 검증 정책:
 *   1. Bearer 토큰 (12 자 이상) 패턴 마스킹
 *   2. 32+ hex 문자열 마스킹
 *   3. 일반 문자열은 변경 없음 (false positive 방지)
 *   4. 짧은 토큰 (12 자 미만) 은 패턴 매칭 X (의도된 한계)
 *   5. 여러 시크릿이 한 문자열에 있을 때 모두 치환
 *   6. 빈 문자열 / 시크릿 없는 문자열 항등성
 */

import { describe, expect, it } from "vitest"
import { SECRET_VALUE_PATTERNS, scrubString } from "./scrub-string"

describe("scrubString — Bearer 토큰 패턴", () => {
  it("'Bearer xxx' (12 자 이상) → [REDACTED]", () => {
    const out = scrubString("Authorization: Bearer abcdef1234567890ABCDEF")
    expect(out).toContain("[REDACTED]")
    expect(out).not.toContain("abcdef1234567890ABCDEF")
  })

  it("Bearer 뒤 alpha-num + dot/dash/underscore 까지 매칭", () => {
    const out = scrubString("Bearer eyJhbGciOi.JIUzI1.NiI_xX-Y--Z__token")
    expect(out).toContain("[REDACTED]")
    expect(out).not.toContain("eyJhbGciOi")
  })

  it("문자열 중간 Bearer 토큰도 매칭", () => {
    const out = scrubString("error before Bearer ABCDEF1234567890_X and after")
    expect(out).toContain("before [REDACTED] and after")
  })

  it("Bearer 뒤 토큰이 12 자 미만이면 매칭 X (false positive 방지)", () => {
    const out = scrubString("Bearer short")
    expect(out).toBe("Bearer short")
  })
})

describe("scrubString — 32+ hex 패턴", () => {
  it("32 자 hex 문자열 → [REDACTED]", () => {
    const out = scrubString("hmac=abcdef0123456789abcdef0123456789")
    expect(out).toContain("[REDACTED]")
    expect(out).not.toContain("abcdef0123456789abcdef0123456789")
  })

  it("64 자 hex (SHA-256) → [REDACTED]", () => {
    const sha256 = "a".repeat(64)
    const out = scrubString(`signature=${sha256}`)
    expect(out).toContain("[REDACTED]")
    expect(out).not.toContain(sha256)
  })

  it("31 자 hex 는 매칭 X (경계)", () => {
    const hex31 = "a".repeat(31)
    const out = scrubString(hex31)
    expect(out).toBe(hex31)
  })

  it("대소문자 혼합 hex 매칭", () => {
    const out = scrubString("ABCdef0123456789ABCDEF0123456789")
    expect(out).toBe("[REDACTED]")
  })
})

describe("scrubString — 일반 문자열 항등성", () => {
  it("빈 문자열", () => {
    expect(scrubString("")).toBe("")
  })

  it("시크릿 없는 일반 문자열은 변경 X", () => {
    const s = "Failed to connect to advertiser id=abc-123 customer=4567890"
    expect(scrubString(s)).toBe(s)
  })

  it("한국어 / 특수문자 항등성", () => {
    const s = "키워드 등록 실패: 광고그룹 ID 가 유효하지 않습니다."
    expect(scrubString(s)).toBe(s)
  })
})

describe("scrubString — 다중 시크릿 한 문자열", () => {
  it("Bearer + hex 두 개 모두 치환", () => {
    const out = scrubString(
      "Authorization: Bearer abcdef1234567890ABCDEF; sig=fedcba0987654321fedcba0987654321",
    )
    expect(out).not.toContain("abcdef1234567890ABCDEF")
    expect(out).not.toContain("fedcba0987654321fedcba0987654321")
    // 두 개 모두 [REDACTED] 로 치환
    const matches = out.match(/\[REDACTED\]/g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBeGreaterThanOrEqual(2)
  })

  it("연속된 hex 두 블록 모두 치환", () => {
    const out = scrubString(
      "abcdef0123456789abcdef0123456789 / fedcba0987654321fedcba0987654321",
    )
    expect(out).not.toContain("abcdef0123456789abcdef0123456789")
    expect(out).not.toContain("fedcba0987654321fedcba0987654321")
  })
})

describe("SECRET_VALUE_PATTERNS export", () => {
  it("배열 길이 2 (Bearer + hex)", () => {
    expect(SECRET_VALUE_PATTERNS).toHaveLength(2)
  })

  it("readonly 보장 (RegExp 객체 배열)", () => {
    for (const re of SECRET_VALUE_PATTERNS) {
      expect(re).toBeInstanceOf(RegExp)
    }
  })
})
