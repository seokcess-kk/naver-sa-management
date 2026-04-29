/**
 * Sentry scrub 단위 테스트.
 *
 * 검증 정책 (CLAUDE.md 안전장치 #4):
 *   1. event.request.* 안 시크릿 키 마스킹
 *   2. event.extra / contexts / tags / user 안 시크릿 키 마스킹
 *   3. exception.values[].value / event.message 의 토큰 패턴 마스킹
 *   4. breadcrumb.data 안 시크릿 키 마스킹 + message 의 토큰 패턴 마스킹
 *   5. 회귀 가드 — 처리 결과의 JSON.stringify 에 평문 시크릿 미포함
 */

import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs"
import { describe, expect, it } from "vitest"
import { scrubBreadcrumb, scrubEvent } from "./scrub"

/**
 * 테스트 fixture 생성기.
 * Sentry ErrorEvent 의 모든 필드 옵셔널이라 일부만 채움.
 */
function makeEvent(partial: Partial<ErrorEvent> = {}): ErrorEvent {
  return { type: undefined, ...partial } as ErrorEvent
}

describe("scrubEvent — request 필드", () => {
  it("event.request.headers.Authorization 키 마스킹", () => {
    const ev = makeEvent({
      request: {
        headers: {
          Authorization: "Bearer SUPER_SECRET_TOKEN_PLAIN_VALUE",
          "User-Agent": "test/1.0",
        },
      },
    })
    const out = scrubEvent(ev)
    expect(out).not.toBeNull()
    const hdrs = out!.request!.headers!
    expect(hdrs.Authorization).not.toContain("SUPER_SECRET_TOKEN_PLAIN_VALUE")
    expect(hdrs["User-Agent"]).toBe("test/1.0")
  })

  it("event.request.cookies 안 secretKey/apiKey 마스킹", () => {
    const ev = makeEvent({
      request: {
        cookies: {
          sessionId: "abc123",
          api_key: "PLAIN_API_KEY_VALUE_123456",
        },
      },
    })
    const out = scrubEvent(ev)
    const cookies = out!.request!.cookies!
    expect(cookies.api_key).not.toContain("PLAIN_API_KEY_VALUE_123456")
    expect(cookies.sessionId).toBe("abc123")
  })

  it("event.request.data 안 password 키 마스킹", () => {
    const ev = makeEvent({
      request: {
        data: { username: "u1", password: "PLAIN_PASSWORD_HERE" },
      },
    })
    const out = scrubEvent(ev)
    const data = out!.request!.data as Record<string, unknown>
    expect(data.password).not.toBe("PLAIN_PASSWORD_HERE")
    expect(data.username).toBe("u1")
  })

  it("event.request.query_string 안 Bearer 토큰 패턴 마스킹", () => {
    const ev = makeEvent({
      request: {
        query_string: "ref=Bearer abcdef1234567890ABCDEF&keep=1",
      },
    })
    const out = scrubEvent(ev)
    expect(out!.request!.query_string).toContain("[REDACTED]")
    expect(out!.request!.query_string).toContain("keep=1")
  })
})

describe("scrubEvent — extra/contexts/tags/user", () => {
  it("event.extra.apiKey 마스킹", () => {
    const ev = makeEvent({
      extra: {
        apiKey: "PLAIN_API_KEY_LONG",
        otherField: "ok",
      },
    })
    const out = scrubEvent(ev)
    expect(out!.extra!.apiKey).not.toBe("PLAIN_API_KEY_LONG")
    expect(out!.extra!.otherField).toBe("ok")
  })

  it("event.extra 안 중첩 secretKey 마스킹", () => {
    const ev = makeEvent({
      extra: {
        creds: { secretKey: "PLAIN_SECRET_INSIDE_OBJ", apiKey: "PLAIN_API" },
      },
    })
    const out = scrubEvent(ev)
    const creds = out!.extra!.creds as Record<string, unknown>
    expect(creds.secretKey).not.toBe("PLAIN_SECRET_INSIDE_OBJ")
    expect(creds.apiKey).not.toBe("PLAIN_API")
  })

  it("event.user.api_key (snake_case) 마스킹", () => {
    const ev = makeEvent({
      user: {
        id: "user-1",
        email: "u@example.com",
        // user는 인덱스 시그니처 any
        api_key: "PLAIN_USER_API_KEY",
      } as ErrorEvent["user"],
    })
    const out = scrubEvent(ev)
    expect((out!.user as Record<string, unknown>).api_key).not.toBe("PLAIN_USER_API_KEY")
    expect(out!.user!.id).toBe("user-1")
  })

  it("event.tags.cron_secret 마스킹", () => {
    const ev = makeEvent({
      tags: {
        env: "test",
        cron_secret: "PLAIN_CRON_SECRET_XYZ",
      },
    })
    const out = scrubEvent(ev)
    expect(out!.tags!.cron_secret).not.toBe("PLAIN_CRON_SECRET_XYZ")
    expect(out!.tags!.env).toBe("test")
  })

  it("event.contexts.app 안 시크릿 키 마스킹", () => {
    const ev = makeEvent({
      contexts: {
        app: { app_name: "naver-sa", refresh_token: "PLAIN_REFRESH_TOKEN" },
      },
    })
    const out = scrubEvent(ev)
    const app = out!.contexts!.app as Record<string, unknown>
    expect(app.refresh_token).not.toBe("PLAIN_REFRESH_TOKEN")
    expect(app.app_name).toBe("naver-sa")
  })
})

describe("scrubEvent — exception/message 패턴 마스킹", () => {
  it("exception.values[0].value 안 Bearer 토큰 마스킹", () => {
    const ev = makeEvent({
      exception: {
        values: [
          {
            type: "Error",
            value: "Unauthorized: Bearer abcdef1234567890ABCDEF token expired",
          },
        ],
      },
    })
    const out = scrubEvent(ev)
    const v = out!.exception!.values![0].value!
    expect(v).toContain("[REDACTED]")
    expect(v).not.toContain("abcdef1234567890ABCDEF")
  })

  it("event.message 안 32자 hex 패턴 마스킹", () => {
    const ev = makeEvent({
      message: "Failed to verify HMAC: abcdef0123456789abcdef0123456789",
    })
    const out = scrubEvent(ev)
    expect(out!.message).toContain("[REDACTED]")
    expect(out!.message).not.toContain("abcdef0123456789abcdef0123456789")
  })
})

describe("scrubBreadcrumb", () => {
  it("breadcrumb.data.password 마스킹", () => {
    const b: Breadcrumb = {
      category: "auth",
      data: { username: "u1", password: "PLAIN_PASSWORD_BREAD" },
    }
    const out = scrubBreadcrumb(b)
    expect(out).not.toBeNull()
    expect(out!.data!.password).not.toBe("PLAIN_PASSWORD_BREAD")
    expect(out!.data!.username).toBe("u1")
  })

  it("breadcrumb.message 안 Bearer 토큰 마스킹", () => {
    const b: Breadcrumb = {
      message: "outgoing fetch with Bearer abcdef1234567890ABCDEF",
    }
    const out = scrubBreadcrumb(b)
    expect(out!.message).toContain("[REDACTED]")
    expect(out!.message).not.toContain("abcdef1234567890ABCDEF")
  })

  it("breadcrumb.data 안 중첩 apiKey 마스킹", () => {
    const b: Breadcrumb = {
      category: "http",
      data: { req: { headers: { apiKey: "PLAIN_HEADER_API_KEY_VAL" } } },
    }
    const out = scrubBreadcrumb(b)
    const req = out!.data!.req as Record<string, unknown>
    const headers = req.headers as Record<string, unknown>
    expect(headers.apiKey).not.toBe("PLAIN_HEADER_API_KEY_VAL")
  })
})

describe("회귀 가드 — JSON.stringify 결과에 평문 시크릿 미포함", () => {
  it("종합 fixture: 모든 영역 평문 시크릿 → JSON 직렬화 결과에 0건", () => {
    const ev = makeEvent({
      request: {
        headers: { Authorization: "Bearer PLAIN_TOKEN_ALPHA_BETA" },
        cookies: { api_key: "PLAIN_COOKIE_KEY_VAL_LONG" },
        data: { password: "PLAIN_BODY_PWD_LONG" },
        query_string: "x=Bearer abcdef1234567890ABCDEF",
      },
      extra: {
        apiKey: "PLAIN_EXTRA_API_KEY_LONG",
        creds: { secretKey: "PLAIN_NESTED_SECRET_LONG" },
      },
      tags: { cronSecret: "PLAIN_CRON_TAG_VAL" },
      user: { id: "u1", refresh_token: "PLAIN_USER_RT_LONG" } as ErrorEvent["user"],
      exception: {
        values: [{ type: "E", value: "Bearer abcdef1234567890ABCDEF leaked" }],
      },
      message: "hmac=abcdef0123456789abcdef0123456789",
    })
    const out = scrubEvent(ev)
    const json = JSON.stringify(out)
    // 평문이 단 하나도 빠져나가지 않음
    expect(json).not.toContain("PLAIN_TOKEN_ALPHA_BETA")
    expect(json).not.toContain("PLAIN_COOKIE_KEY_VAL_LONG")
    expect(json).not.toContain("PLAIN_BODY_PWD_LONG")
    expect(json).not.toContain("PLAIN_EXTRA_API_KEY_LONG")
    expect(json).not.toContain("PLAIN_NESTED_SECRET_LONG")
    expect(json).not.toContain("PLAIN_CRON_TAG_VAL")
    expect(json).not.toContain("PLAIN_USER_RT_LONG")
    // exception.value / message / query_string 의 토큰 패턴
    expect(json).not.toContain("abcdef1234567890ABCDEF")
    expect(json).not.toContain("abcdef0123456789abcdef0123456789")
  })

  it("breadcrumb 종합 fixture: JSON 직렬화 결과 평문 0건", () => {
    const b: Breadcrumb = {
      category: "auth",
      message: "Authorization: Bearer abcdef1234567890ABCDEF",
      data: {
        password: "PLAIN_BC_PWD",
        nested: { apiKey: "PLAIN_BC_API_KEY_LONG" },
      },
    }
    const out = scrubBreadcrumb(b)
    const json = JSON.stringify(out)
    expect(json).not.toContain("PLAIN_BC_PWD")
    expect(json).not.toContain("PLAIN_BC_API_KEY_LONG")
    expect(json).not.toContain("abcdef1234567890ABCDEF")
  })
})
