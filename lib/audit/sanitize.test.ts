/**
 * lib/audit/sanitize.ts 단위 테스트
 *
 * 검증 핵심 (시크릿 마스킹 회귀 가드):
 *  - isSecretKey 정규식 매칭/비매칭
 *  - sanitize: primitive / 시크릿 키 / 중첩 / 배열 / 깊이 제한
 *  - 직렬화 후 평문 시크릿이 절대 남지 않음 (CI 회귀 가드)
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { isSecretKey, sanitize } from "@/lib/audit/sanitize"

// mask가 ENCRYPTION_KEY 의존은 없지만 동일 모듈 import 시점에 문제 없게 설정
const TEST_KEY = "0".repeat(64)
const originalKey = process.env.ENCRYPTION_KEY

beforeAll(() => {
  process.env.ENCRYPTION_KEY = TEST_KEY
})

afterAll(() => {
  if (originalKey === undefined) {
    delete process.env.ENCRYPTION_KEY
  } else {
    process.env.ENCRYPTION_KEY = originalKey
  }
})

describe("isSecretKey", () => {
  it("apiKey 변형 (대소문자/partial, camelCase) 매치 — 신규 PR 이후 snake/kebab 도 매치", () => {
    // 정규식은 /apikey/i (camelCase 연속) + /api[_-]key/i (분리) 두 가지로 모두 잡음.
    expect(isSecretKey("apiKey")).toBe(true)
    expect(isSecretKey("apikey")).toBe(true)
    expect(isSecretKey("APIKEY")).toBe(true)
    expect(isSecretKey("myApiKey")).toBe(true)
    // 신규: snake_case / kebab-case 도 매치 (snake_case 검증은 별도 it 블록에서 상세 단언)
    expect(isSecretKey("API_KEY")).toBe(true)
  })

  it("secretKey 변형 매치 — 'secret' 단독은 매치 X (신규 PR 이후 SECRET_KEY 는 매치)", () => {
    expect(isSecretKey("secretKey")).toBe(true)
    expect(isSecretKey("SECRETKEY")).toBe(true)
    expect(isSecretKey("clientSecretKey")).toBe(true)
    // 'secret' 단독은 의도적으로 매치 X — 너무 광범위
    expect(isSecretKey("secret")).toBe(false)
    // 신규: SECRET_KEY 매치
    expect(isSecretKey("SECRET_KEY")).toBe(true)
  })

  it("password 변형 매치", () => {
    expect(isSecretKey("password")).toBe(true)
    expect(isSecretKey("passwordHash")).toBe(true)
    expect(isSecretKey("PASSWORD")).toBe(true)
  })

  it("accessKey / refreshToken 변형 매치 — camelCase + snake/kebab 모두 매치 (신규 PR)", () => {
    expect(isSecretKey("accessKey")).toBe(true)
    expect(isSecretKey("AccessKeyId")).toBe(true)
    expect(isSecretKey("refreshToken")).toBe(true)
    expect(isSecretKey("REFRESHTOKEN")).toBe(true)
    // 신규: snake_case 도 매치
    expect(isSecretKey("REFRESH_TOKEN")).toBe(true)
  })

  it("token은 정확 매치(^token$/i)만 허용 — myToken / accessToken은 매치 X", () => {
    expect(isSecretKey("token")).toBe(true)
    expect(isSecretKey("TOKEN")).toBe(true)
    expect(isSecretKey("myToken")).toBe(false)
    expect(isSecretKey("accessToken")).toBe(false)
  })

  it("일반 키는 매치 X", () => {
    expect(isSecretKey("name")).toBe(false)
    expect(isSecretKey("id")).toBe(false)
    expect(isSecretKey("value")).toBe(false)
    expect(isSecretKey("customerId")).toBe(false)
  })

  it("snake_case / kebab-case 분리 시크릿 키 매치 (신규 패턴)", () => {
    // api_key 계열
    expect(isSecretKey("api_key")).toBe(true)
    expect(isSecretKey("API_KEY")).toBe(true)
    expect(isSecretKey("api-key")).toBe(true)
    // secret_key 계열
    expect(isSecretKey("secret_key")).toBe(true)
    expect(isSecretKey("SECRET_KEY")).toBe(true)
    expect(isSecretKey("secret-key")).toBe(true)
    // access_key 계열
    expect(isSecretKey("access_key")).toBe(true)
    expect(isSecretKey("ACCESS_KEY")).toBe(true)
    // refresh_token 계열
    expect(isSecretKey("refresh_token")).toBe(true)
    expect(isSecretKey("REFRESH_TOKEN")).toBe(true)
    expect(isSecretKey("refresh-token")).toBe(true)
  })

  it("헤더/시스템 시크릿 매치 — Authorization / Bearer / CRON_SECRET (신규 패턴)", () => {
    // Authorization 헤더 (정확 매치)
    expect(isSecretKey("authorization")).toBe(true)
    expect(isSecretKey("Authorization")).toBe(true)
    expect(isSecretKey("AUTHORIZATION")).toBe(true)
    // Bearer 필드 (정확 매치)
    expect(isSecretKey("bearer")).toBe(true)
    expect(isSecretKey("Bearer")).toBe(true)
    // CRON_SECRET 변형
    expect(isSecretKey("CRON_SECRET")).toBe(true)
    expect(isSecretKey("cron_secret")).toBe(true)
    expect(isSecretKey("cron-secret")).toBe(true)
    expect(isSecretKey("cronSecret")).toBe(true)
    expect(isSecretKey("cronsecret")).toBe(true)
  })

  it("정확 매치 가드 — Authorization*/Bearer* 합성어는 매치 X (false positive 방지)", () => {
    // /^authorization$/i 정확 매치 → 합성어 미매치
    expect(isSecretKey("authorizationLevel")).toBe(false)
    expect(isSecretKey("authorizationCode")).toBe(false)
    // /^bearer$/i 정확 매치 → 합성어 미매치
    expect(isSecretKey("bearerName")).toBe(false)
    expect(isSecretKey("bearerType")).toBe(false)
  })

  it("기존 동작 유지 — apiKeyVersion / apiKeyEnc 키 자체는 매치 (값이 number/Buffer 라 sanitize 가 마스킹 미적용)", () => {
    // 직전 PR 동작 그대로. /apikey/i 가 'apiKey' 부분 문자열을 잡음.
    // 실제 값이 number(version) / Buffer(enc) 면 sanitize 의 typeof === "string" 가드로 마스킹 미적용 → 안전.
    expect(isSecretKey("apiKeyVersion")).toBe(true)
    expect(isSecretKey("apiKeyEnc")).toBe(true)
    expect(isSecretKey("secretKeyVersion")).toBe(true)
    expect(isSecretKey("secretKeyEnc")).toBe(true)
  })
})

describe("sanitize", () => {
  it("primitive(number/boolean/null/undefined/string)는 그대로 통과", () => {
    expect(sanitize(123)).toBe(123)
    expect(sanitize(true)).toBe(true)
    expect(sanitize(null)).toBe(null)
    expect(sanitize(undefined)).toBe(undefined)
    expect(sanitize("plain")).toBe("plain")
  })

  it("시크릿 키 + 문자열 값은 마스킹", () => {
    const out = sanitize({ apiKey: "abcdefghij" }) as Record<string, unknown>
    expect(out.apiKey).toBe("abcd****ghij")
  })

  it("시크릿 키 + 비문자열 값은 마스킹 미적용 (typeof === string 조건)", () => {
    // number / object는 sanitize 재귀로 처리되며 키 마스킹 분기 진입 X
    const num = sanitize({ apiKey: 12345678 }) as Record<string, unknown>
    expect(num.apiKey).toBe(12345678)

    const obj = sanitize({ apiKey: { nested: "ok" } }) as Record<string, unknown>
    expect(obj.apiKey).toEqual({ nested: "ok" })
  })

  it("일반 키 + 문자열 값은 그대로 보존", () => {
    const out = sanitize({ name: "kim", id: "abc" }) as Record<string, unknown>
    expect(out.name).toBe("kim")
    expect(out.id).toBe("abc")
  })

  it("중첩 객체 안의 시크릿도 재귀 마스킹", () => {
    const out = sanitize({
      user: { apiKey: "0123456789ABCDEF" },
    }) as Record<string, Record<string, unknown>>
    expect(out.user.apiKey).toBe("0123****CDEF")
  })

  it("배열 내부 객체도 마스킹", () => {
    const out = sanitize([
      { password: "12345678" },
      { password: "abcdefgh" },
    ]) as Array<Record<string, unknown>>
    expect(out[0].password).toBe("1234****5678")
    expect(out[1].password).toBe("abcd****efgh")
  })

  it("깊이 6 초과는 [depth-limit]", () => {
    // 8중 중첩
    const deep: Record<string, unknown> = {}
    let cur: Record<string, unknown> = deep
    for (let i = 0; i < 8; i++) {
      const next: Record<string, unknown> = {}
      cur.next = next
      cur = next
    }
    cur.apiKey = "should-not-reach"

    const result = sanitize(deep) as Record<string, unknown>
    // 8중 중첩 끝까지 따라가다 [depth-limit] 문자열에 도달
    let walker: unknown = result
    let foundLimit = false
    for (let i = 0; i < 10; i++) {
      if (walker === "[depth-limit]") {
        foundLimit = true
        break
      }
      if (typeof walker === "object" && walker !== null && "next" in walker) {
        walker = (walker as { next: unknown }).next
      } else {
        break
      }
    }
    expect(foundLimit).toBe(true)
  })

  it("function/symbol/bigint는 String() 변환 fallback", () => {
    expect(sanitize(() => "x")).toMatch(/=>/)
    expect(sanitize(Symbol("s"))).toBe("Symbol(s)")
    expect(sanitize(BigInt(10))).toBe("10")
  })

  it("회귀 가드: JSON 직렬화 결과에 평문 시크릿이 남지 않음", () => {
    const input = {
      apiKey: "PLAINTEXT_API_KEY_12345",
      secretKey: "PLAINTEXT_SECRET_KEY_67890",
      nested: { password: "VERYSECRETVALUE" },
      tokens: [{ token: "TOPSECRETTOKEN1234" }],
    }

    const out = JSON.stringify(sanitize(input))

    // 평문은 절대 포함 X
    expect(out).not.toContain("PLAINTEXT_API_KEY_12345")
    expect(out).not.toContain("PLAINTEXT_SECRET_KEY_67890")
    expect(out).not.toContain("VERYSECRETVALUE")
    expect(out).not.toContain("TOPSECRETTOKEN1234")

    // 마스킹 형태(앞4 + **** + 뒤4)는 포함
    expect(out).toContain("PLAI****2345")
    expect(out).toContain("PLAI****7890")
    // VERYSECRETVALUE(15자) → VERY + **** + ALUE
    expect(out).toContain("VERY****ALUE")
    expect(out).toContain("TOPS****1234")
  })

  it("회귀 가드 (신규): snake_case / 헤더 / CRON_SECRET 평문 누설 차단", () => {
    const input = {
      api_key: "PLAIN_API_KEY_VALUE",
      secret_key: "PLAIN_SECRET_KEY_VALUE",
      access_key: "PLAIN_ACCESS_KEY_VALUE",
      refresh_token: "PLAIN_REFRESH_TOKEN_VALUE",
      Authorization: "Bearer PLAIN_TOKEN_HERE",
      CRON_SECRET: "PLAIN_CRON_SECRET",
      cron_secret: "PLAIN_CRON_SECRET_LOWER",
    }

    const out = JSON.stringify(sanitize(input))

    // 평문은 절대 포함 X
    expect(out).not.toContain("PLAIN_API_KEY_VALUE")
    expect(out).not.toContain("PLAIN_SECRET_KEY_VALUE")
    expect(out).not.toContain("PLAIN_ACCESS_KEY_VALUE")
    expect(out).not.toContain("PLAIN_REFRESH_TOKEN_VALUE")
    expect(out).not.toContain("PLAIN_TOKEN_HERE")
    expect(out).not.toContain("PLAIN_CRON_SECRET")
    expect(out).not.toContain("PLAIN_CRON_SECRET_LOWER")

    // 마스킹 형태(앞4 + **** + 뒤4) 포함 확인
    // PLAIN_API_KEY_VALUE(19자) → PLAI + **** + ALUE
    expect(out).toContain("PLAI****ALUE")
  })
})
