/**
 * lib/crypto/secret.ts 단위 테스트
 *
 * 검증 범위 (CLAUDE.md "핵심 안전장치 4"):
 *  - mask: 8자 미만 전체 마스킹 / 8자 이상 앞4·뒤4 + "****"
 *  - encrypt/decrypt round-trip (한글/이모지/큰 평문 포함)
 *  - 가드: 비문자열 / 미지원 version / 짧은 buffer / 위변조 ciphertext
 *  - loadKey 음성: ENCRYPTION_KEY 미설정 / 길이 불일치
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { decrypt, encrypt, mask } from "@/lib/crypto/secret"

// 테스트 전용 키 (32바이트 = 64 hex chars). 실제 운영 키와 무관.
const TEST_KEY = "0".repeat(64)

describe("mask", () => {
  it("빈 문자열은 전체 마스킹으로 처리", () => {
    expect(mask("")).toBe("********")
  })

  it("7자(8자 미만)는 전체 마스킹", () => {
    expect(mask("abcdefg")).toBe("********")
  })

  it("8자는 앞4 + **** + 뒤4", () => {
    expect(mask("ABCDEFGH")).toBe("ABCD****EFGH")
  })

  it("16자는 앞4 + **** + 뒤4", () => {
    expect(mask("ABCDEFGHIJKLMNOP")).toBe("ABCD****MNOP")
  })

  it("비문자열(number/null/undefined/object)은 전체 마스킹", () => {
    // mask 시그니처는 string이지만 내부 가드를 검증.
    expect(mask(undefined as unknown as string)).toBe("********")
    expect(mask(null as unknown as string)).toBe("********")
    expect(mask(12345678 as unknown as string)).toBe("********")
    expect(mask({ k: "v" } as unknown as string)).toBe("********")
  })
})

describe("encrypt / decrypt", () => {
  // 격리: 테스트마다 ENCRYPTION_KEY 명시 설정 (다른 테스트에서 덮어쓴 경우 복원)
  const originalKey = process.env.ENCRYPTION_KEY

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = TEST_KEY
  })

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = TEST_KEY
  })

  afterAll(() => {
    if (originalKey === undefined) {
      delete process.env.ENCRYPTION_KEY
    } else {
      process.env.ENCRYPTION_KEY = originalKey
    }
  })

  it("ASCII round-trip", () => {
    const out = encrypt("hello")
    expect(out.version).toBe(1)
    expect(decrypt(out.enc, out.version)).toBe("hello")
  })

  it("한글/이모지 round-trip", () => {
    const text = "네이버 SA 운영 어드민 🚀"
    const out = encrypt(text)
    expect(decrypt(out.enc, out.version)).toBe(text)
  })

  it("1자 round-trip (decrypt는 ciphertext 길이 1 이상 요구)", () => {
    // decrypt 가드 `enc.length < IV_LEN + TAG_LEN + 1` 때문에
    // 빈 평문(ciphertext 0B)은 round-trip 불가 — 의도된 가드.
    const out = encrypt("a")
    expect(decrypt(out.enc, out.version)).toBe("a")
  })

  it("10KB 큰 평문 round-trip", () => {
    const big = "x".repeat(10 * 1024)
    const out = encrypt(big)
    expect(decrypt(out.enc, out.version)).toBe(big)
  })

  it("encrypt: 비문자열 인자는 throw", () => {
    expect(() => encrypt(123 as unknown as string)).toThrow(/must be a string/)
    expect(() => encrypt(undefined as unknown as string)).toThrow(/must be a string/)
    expect(() => encrypt(null as unknown as string)).toThrow(/must be a string/)
  })

  it("decrypt: 미지원 version은 throw", () => {
    const out = encrypt("payload")
    expect(() => decrypt(out.enc, 2)).toThrow(/unsupported secret version/)
    expect(() => decrypt(out.enc, 0)).toThrow(/unsupported secret version/)
  })

  it("decrypt: IV+TAG보다 짧은 buffer는 invalid payload로 throw", () => {
    const tooShort = Buffer.alloc(10) // < 12 + 16 + 1
    expect(() => decrypt(tooShort, 1)).toThrow(/invalid encrypted payload/)
  })

  it("decrypt: 위변조된 ciphertext는 authentication failed로 throw", () => {
    const out = encrypt("tamper-me")
    // 마지막 ciphertext 바이트의 1비트만 뒤집어 GCM 인증 실패 유도
    const tampered = Buffer.from(out.enc)
    tampered[tampered.length - 1] = tampered[tampered.length - 1] ^ 0x01
    expect(() => decrypt(tampered, out.version)).toThrow(/authentication failed/)
  })
})

describe("loadKey 가드 (encrypt 경유)", () => {
  const originalKey = process.env.ENCRYPTION_KEY

  afterAll(() => {
    if (originalKey === undefined) {
      delete process.env.ENCRYPTION_KEY
    } else {
      process.env.ENCRYPTION_KEY = originalKey
    }
  })

  it("ENCRYPTION_KEY 미설정 시 throw", () => {
    delete process.env.ENCRYPTION_KEY
    expect(() => encrypt("x")).toThrow(/ENCRYPTION_KEY is not set/)
  })

  it("ENCRYPTION_KEY가 32바이트가 아니면 throw (64 hex 미만)", () => {
    // 30바이트 = 60 hex chars
    process.env.ENCRYPTION_KEY = "0".repeat(60)
    expect(() => encrypt("x")).toThrow(/must be 32 bytes/)
  })

  it("비 hex 문자열도 길이 검증에서 차단 (Buffer.from(hex)는 무음 무시)", () => {
    // "zz..." 64자 — Buffer.from(_, "hex")는 모두 무시하여 0바이트 결과
    process.env.ENCRYPTION_KEY = "z".repeat(64)
    expect(() => encrypt("x")).toThrow(/must be 32 bytes/)
  })
})
