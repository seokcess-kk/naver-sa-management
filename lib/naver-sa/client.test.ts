/**
 * lib/naver-sa/client.ts 단위 테스트
 *
 * 검증 범위 (CLAUDE.md "네이버 SA API 인증" 섹션):
 *   A. sign        — HMAC-SHA256 결정론·정확성
 *   B. backoffMs   — 지수 백오프 + jitter + 8000ms 캡
 *   C. token bucket — tryConsumeToken / consumeToken Redis mock 기반
 *   D. request     — fetch mock 기반 happy / 401 / 1014 / 429 / 500 / 1016 / network / exhausted / customerId
 *
 * 외부 호출 0 보장:
 *   - fetch: vi.stubGlobal 로 100% 차단
 *   - Redis: vi.mock 으로 in-memory map
 *   - credentialsResolver: setCredentialsResolver 로 mock 주입 (DB 0 / decrypt 0)
 *   - ENCRYPTION_KEY env 불필요
 */

import { createHmac } from "node:crypto"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import {
  __test__,
  naverSaClient,
  setCredentialsResolver,
  type NaverSaCredentials,
} from "@/lib/naver-sa/client"
import {
  NaverSaAuthError,
  NaverSaRateLimitError,
  NaverSaUnknownError,
  NaverSaValidationError,
} from "@/lib/naver-sa/errors"

// =============================================================================
// Redis mock — in-memory map. cached() 는 캐시 우회 (fn 직호출).
// =============================================================================

const redisStore = new Map<string, unknown>()

vi.mock("@/lib/cache/redis", () => {
  return {
    getRedis: () => ({
      get: vi.fn(async (k: string) =>
        redisStore.has(k) ? redisStore.get(k) : null,
      ),
      set: vi.fn(async (k: string, v: unknown) => {
        redisStore.set(k, v)
      }),
      del: vi.fn(async (k: string) => {
        redisStore.delete(k)
      }),
    }),
    cached: vi.fn(
      async <T,>(_k: string, _ttl: number, fn: () => Promise<T>): Promise<T> =>
        fn(),
    ),
  }
})

// =============================================================================
// 공통 setup
// =============================================================================

const TEST_CREDS: NaverSaCredentials = {
  apiKey: "test-api-key",
  secretKey: "test-secret-key",
}

beforeEach(() => {
  redisStore.clear()
  // credentialsResolver mock — 어떤 customerId 든 동일한 자격증명 반환
  setCredentialsResolver(async () => TEST_CREDS)
  // fetch 기본 차단 — 각 테스트가 명시적으로 mockFetch 호출
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("fetch was called without mock setup")
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

// 응답 시퀀스 mock helper. 각 호출마다 하나씩 소비, 마지막 항목은 반복 사용.
type FakeResponse = { status: number; body: unknown; throwError?: boolean }

function mockFetch(responses: FakeResponse[]): {
  fetchSpy: ReturnType<typeof vi.fn>
  getCalls: () => Array<{ url: string; init: RequestInit }>
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  let i = 0
  const fetchSpy = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = responses[Math.min(i, responses.length - 1)]
    i++
    if (r.throwError) {
      throw new Error("network error")
    }
    return new Response(
      typeof r.body === "string" ? r.body : JSON.stringify(r.body),
      { status: r.status, headers: { "Content-Type": "application/json" } },
    )
  })
  vi.stubGlobal("fetch", fetchSpy)
  return { fetchSpy, getCalls: () => calls }
}

// setTimeout 즉시 실행 — backoff sleep 을 실제로 기다리지 않음.
// fake timers 보다 단순하고 안정적 (vi.useFakeTimers 의 micro-batch 진행 이슈 회피).
function stubSetTimeoutImmediate(): void {
  vi.stubGlobal("setTimeout", ((fn: () => void) => {
    // 즉시 microtask 로 실행
    Promise.resolve().then(fn)
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout)
}

// =============================================================================
// A. sign
// =============================================================================

describe("sign (HMAC-SHA256)", () => {
  it("동일 입력 → 동일 결과 (결정론)", () => {
    const args = {
      timestamp: "1234567890",
      method: "GET" as const,
      path: "/foo",
      secretKey: "abc",
    }
    const a = __test__.sign(args)
    const b = __test__.sign(args)
    expect(a).toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/) // base64
  })

  it("secretKey 가 다르면 결과도 다름", () => {
    const base = {
      timestamp: "1234567890",
      method: "GET" as const,
      path: "/foo",
    }
    const a = __test__.sign({ ...base, secretKey: "abc" })
    const b = __test__.sign({ ...base, secretKey: "xyz" })
    expect(a).not.toBe(b)
  })

  it("path 가 다르면 결과도 다름", () => {
    const base = {
      timestamp: "1234567890",
      method: "GET" as const,
      secretKey: "abc",
    }
    const a = __test__.sign({ ...base, path: "/foo" })
    const b = __test__.sign({ ...base, path: "/bar" })
    expect(a).not.toBe(b)
  })

  it("method 가 다르면 결과도 다름", () => {
    const base = {
      timestamp: "1234567890",
      path: "/foo",
      secretKey: "abc",
    }
    const a = __test__.sign({ ...base, method: "GET" })
    const b = __test__.sign({ ...base, method: "POST" })
    expect(a).not.toBe(b)
  })

  it("알려진 입력 → createHmac 직접 계산값과 일치", () => {
    const args = {
      timestamp: "1234567890",
      method: "GET" as const,
      path: "/foo",
      secretKey: "abc",
    }
    const expected = createHmac("sha256", "abc")
      .update("1234567890.GET./foo")
      .digest("base64")
    expect(__test__.sign(args)).toBe(expected)
  })
})

// =============================================================================
// B. backoffMs
// =============================================================================

describe("backoffMs (exponential + jitter + 8000ms cap)", () => {
  it("attempt=0 → 250..350 (250 base + jitter 0..99)", () => {
    for (let i = 0; i < 50; i++) {
      const v = __test__.backoffMs(0)
      expect(v).toBeGreaterThanOrEqual(250)
      expect(v).toBeLessThan(350)
    }
  })

  it("attempt=1 → 500..600", () => {
    for (let i = 0; i < 50; i++) {
      const v = __test__.backoffMs(1)
      expect(v).toBeGreaterThanOrEqual(500)
      expect(v).toBeLessThan(600)
    }
  })

  it("attempt=4 → 4000..4100", () => {
    for (let i = 0; i < 50; i++) {
      const v = __test__.backoffMs(4)
      expect(v).toBeGreaterThanOrEqual(4000)
      expect(v).toBeLessThan(4100)
    }
  })

  it("attempt=5 이상 → 8000ms 로 캡", () => {
    // base = 250 * 32 = 8000, +jitter → cap 8000
    for (let i = 0; i < 50; i++) {
      expect(__test__.backoffMs(5)).toBe(8000)
      expect(__test__.backoffMs(10)).toBe(8000)
      expect(__test__.backoffMs(20)).toBe(8000)
    }
  })

  it("어떤 attempt 든 ≤ 8000", () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      expect(__test__.backoffMs(attempt)).toBeLessThanOrEqual(8000)
    }
  })
})

// =============================================================================
// C. tryConsumeToken / consumeToken
// =============================================================================

describe("tryConsumeToken (Redis mock)", () => {
  it("빈 버킷(state=null) → 첫 호출 즉시 통과(0 반환) + 토큰 저장", async () => {
    const wait = await __test__.tryConsumeToken("cust-1")
    expect(wait).toBe(0)

    const key = __test__.bucketKey("cust-1")
    const stored = redisStore.get(key) as
      | { tokens: number; updatedMs: number }
      | undefined
    expect(stored).toBeDefined()
    // RATE_BURST 50 default → 1 소비 후 49 저장
    expect(stored!.tokens).toBeCloseTo(49, 0)
  })

  it("토큰 0 + updatedMs=now → 부족하므로 wait > 0 반환", async () => {
    const key = __test__.bucketKey("cust-2")
    redisStore.set(key, { tokens: 0, updatedMs: Date.now() })
    const wait = await __test__.tryConsumeToken("cust-2")
    expect(wait).toBeGreaterThan(0)
  })

  it("토큰 0 + updatedMs 가 충분히 과거 → 재충전 후 통과", async () => {
    const key = __test__.bucketKey("cust-3")
    // 10초 전 갱신, 50/60 토큰/sec → ~8.3 토큰 충전 → 1 소비 가능
    redisStore.set(key, { tokens: 0, updatedMs: Date.now() - 10_000 })
    const wait = await __test__.tryConsumeToken("cust-3")
    expect(wait).toBe(0)
  })
})

describe("consumeToken (rate limit starvation)", () => {
  it("매 시도 wait > 0 면 10회 후 NaverSaRateLimitError throw", async () => {
    // 토큰 0 으로 강제. updatedMs 는 절대 미래 (충전 안 되도록) — Date.now() 기반
    // 충전 계산이 음수가 되어 max(0, ...) 로 클램프되므로 wait > 0 유지.
    const cust = "cust-starve"
    const key = __test__.bucketKey(cust)
    redisStore.set(key, {
      tokens: 0,
      updatedMs: Date.now() + 10_000_000, // 미래
    })

    // sleep 즉시 실행 — 실제 대기 없음
    stubSetTimeoutImmediate()

    await expect(__test__.consumeToken(cust)).rejects.toBeInstanceOf(
      NaverSaRateLimitError,
    )
  })
})

// =============================================================================
// D. request (fetch mock)
// =============================================================================

describe("request — happy path", () => {
  it("200 OK → 파싱된 JSON 반환 + 모든 서명 헤더 부착", async () => {
    const { getCalls } = mockFetch([
      { status: 200, body: { ok: true } },
    ])

    const result = await naverSaClient.request<{ ok: boolean }>({
      customerId: "cust-100",
      method: "GET",
      path: "/keywords",
    })
    expect(result).toEqual({ ok: true })

    const calls = getCalls()
    expect(calls).toHaveLength(1)
    const headers = (calls[0].init.headers ?? {}) as Record<string, string>
    expect(headers["X-Timestamp"]).toMatch(/^\d+$/)
    expect(headers["X-API-KEY"]).toBe(TEST_CREDS.apiKey)
    expect(headers["X-Customer"]).toBe("cust-100")
    expect(headers["X-Signature"]).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(headers["Accept"]).toBe("application/json")
    // GET 이므로 Content-Type 부재
    expect(headers["Content-Type"]).toBeUndefined()
  })

  it("POST + body → Content-Type: application/json 자동 부착", async () => {
    const { getCalls } = mockFetch([
      { status: 200, body: { id: "abc" } },
    ])

    await naverSaClient.request({
      customerId: "cust-101",
      method: "POST",
      path: "/keywords",
      body: { name: "x" },
    })

    const calls = getCalls()
    const headers = (calls[0].init.headers ?? {}) as Record<string, string>
    expect(headers["Content-Type"]).toBe("application/json")
    expect(calls[0].init.body).toBe(JSON.stringify({ name: "x" }))
  })
})

describe("request — non-retryable errors", () => {
  it("401 → NaverSaAuthError 즉시 throw (재시도 X)", async () => {
    const { fetchSpy } = mockFetch([
      { status: 401, body: { code: 401, title: "Unauthorized" } },
    ])

    await expect(
      naverSaClient.request({
        customerId: "cust-200",
        method: "GET",
        path: "/foo",
      }),
    ).rejects.toBeInstanceOf(NaverSaAuthError)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("400 + body.code=1014 → NaverSaValidationError 즉시 throw", async () => {
    const { fetchSpy } = mockFetch([
      {
        status: 400,
        body: { code: 1014, title: "Validation failed" },
      },
    ])

    await expect(
      naverSaClient.request({
        customerId: "cust-201",
        method: "POST",
        path: "/foo",
        body: { x: 1 },
      }),
    ).rejects.toBeInstanceOf(NaverSaValidationError)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("customerId 빈 문자열 → NaverSaValidationError 즉시 throw (fetch 호출 X)", async () => {
    const { fetchSpy } = mockFetch([{ status: 200, body: {} }])
    await expect(
      naverSaClient.request({
        customerId: "",
        method: "GET",
        path: "/foo",
      }),
    ).rejects.toBeInstanceOf(NaverSaValidationError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("request — retryable errors", () => {
  // backoff sleep 가속을 위해 setTimeout 즉시 실행 stub.
  // fake timer 보다 단순하고 안정적.
  beforeEach(() => {
    stubSetTimeoutImmediate()
  })

  it("429 → 재시도 후 200 → 통과 (fetch 2회)", async () => {
    const { fetchSpy } = mockFetch([
      { status: 429, body: { code: 429, title: "Too many" } },
      { status: 200, body: { ok: true } },
    ])

    const result = await naverSaClient.request<{ ok: boolean }>({
      customerId: "cust-300",
      method: "GET",
      path: "/foo",
    })
    expect(result).toEqual({ ok: true })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("500 → 재시도 후 200 → 통과", async () => {
    const { fetchSpy } = mockFetch([
      { status: 500, body: { title: "internal" } },
      { status: 200, body: { ok: true } },
    ])
    const result = await naverSaClient.request<{ ok: boolean }>({
      customerId: "cust-301",
      method: "GET",
      path: "/foo",
    })
    expect(result).toEqual({ ok: true })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("400 + body.code=1016 → 재시도 후 200 → 통과", async () => {
    const { fetchSpy } = mockFetch([
      { status: 400, body: { code: 1016, title: "rate" } },
      { status: 200, body: { ok: true } },
    ])
    const result = await naverSaClient.request<{ ok: boolean }>({
      customerId: "cust-302",
      method: "GET",
      path: "/foo",
    })
    expect(result).toEqual({ ok: true })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("네트워크 오류 → 재시도 후 200 → 통과", async () => {
    const { fetchSpy } = mockFetch([
      { status: 0, body: null, throwError: true },
      { status: 200, body: { ok: true } },
    ])
    const result = await naverSaClient.request<{ ok: boolean }>({
      customerId: "cust-303",
      method: "GET",
      path: "/foo",
    })
    expect(result).toEqual({ ok: true })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("5회 모두 5xx → 마지막 에러 throw (NaverSaError 계열)", async () => {
    const { fetchSpy } = mockFetch([
      { status: 500, body: { title: "boom" } },
      { status: 500, body: { title: "boom" } },
      { status: 500, body: { title: "boom" } },
      { status: 500, body: { title: "boom" } },
      { status: 500, body: { title: "boom" } },
    ])
    await expect(
      naverSaClient.request({
        customerId: "cust-304",
        method: "GET",
        path: "/foo",
        maxRetries: 5,
      }),
    ).rejects.toBeInstanceOf(NaverSaUnknownError)
    expect(fetchSpy).toHaveBeenCalledTimes(5)
  })

  it("연속 네트워크 오류 5회 → NaverSaUnknownError", async () => {
    const { fetchSpy } = mockFetch([
      { status: 0, body: null, throwError: true },
      { status: 0, body: null, throwError: true },
      { status: 0, body: null, throwError: true },
      { status: 0, body: null, throwError: true },
      { status: 0, body: null, throwError: true },
    ])
    await expect(
      naverSaClient.request({
        customerId: "cust-305",
        method: "GET",
        path: "/foo",
        maxRetries: 5,
      }),
    ).rejects.toBeInstanceOf(NaverSaUnknownError)
    expect(fetchSpy).toHaveBeenCalledTimes(5)
  })
})

