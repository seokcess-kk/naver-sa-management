/**
 * app/api/cron/stat-cleanup/route.ts 단위 테스트.
 *
 * 검증 범위:
 *   A. CRON_SECRET 검증 — env 미설정 / 헤더 불일치 → 401
 *   B. resolveRetentionDays — env parsing / 범위 검증 / default
 *   C. deleteMany 호출 검증 — 두 테이블 + cutoff 계산 (90 일 전)
 *   D. STAT_RETENTION_DAYS env 오버라이드 — 60 일 적용 확인
 *   E. deleteMany 실패 시 500 + scrubString 마스킹
 *
 * 외부 호출 0 보장:
 *   - vi.mock("@/lib/db/prisma", ...) — 실 DB 호출 0
 *   - 외부 API 호출 자체가 코드 경로에 없음 (DB-only)
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

// =============================================================================
// Mocks (전역 — import 전에 hoist 됨)
// =============================================================================

const mockStatDailyDeleteMany = vi.fn()
const mockStatHourlyDeleteMany = vi.fn()

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    statDaily: {
      deleteMany: (...args: unknown[]) => mockStatDailyDeleteMany(...args),
    },
    statHourly: {
      deleteMany: (...args: unknown[]) => mockStatHourlyDeleteMany(...args),
    },
  },
}))

// import 본체 — mock 등록 이후
import { GET, resolveRetentionDays } from "./route"

// =============================================================================
// 헬퍼: NextRequest fixture
// =============================================================================

function makeReq(authHeader: string | null = null): Request {
  const headers = new Headers()
  if (authHeader !== null) headers.set("authorization", authHeader)
  return new Request("https://test.local/api/cron/stat-cleanup", { headers })
}

// =============================================================================
// A. CRON_SECRET 검증
// =============================================================================

describe("GET /api/cron/stat-cleanup — CRON_SECRET 검증", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.CRON_SECRET
    delete process.env.STAT_RETENTION_DAYS
  })

  it("CRON_SECRET env 미설정 → 401", async () => {
    delete process.env.CRON_SECRET
    const res = await GET(makeReq("Bearer anything") as never)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe("unauthorized")
    // DB 미접촉
    expect(mockStatDailyDeleteMany).not.toHaveBeenCalled()
    expect(mockStatHourlyDeleteMany).not.toHaveBeenCalled()
  })

  it("Authorization 헤더 불일치 → 401", async () => {
    process.env.CRON_SECRET = "correct-secret"
    const res = await GET(makeReq("Bearer wrong-secret") as never)
    expect(res.status).toBe(401)
    expect(mockStatDailyDeleteMany).not.toHaveBeenCalled()
  })

  it("Authorization 헤더 누락 → 401", async () => {
    process.env.CRON_SECRET = "correct-secret"
    const res = await GET(makeReq(null) as never)
    expect(res.status).toBe(401)
  })
})

// =============================================================================
// B. resolveRetentionDays
// =============================================================================

describe("resolveRetentionDays", () => {
  it("env 미설정 → default 90", () => {
    expect(resolveRetentionDays(undefined)).toBe(90)
  })

  it("env 빈 문자열 → default 90", () => {
    expect(resolveRetentionDays("")).toBe(90)
  })

  it("env=60 → 60 (범위 내)", () => {
    expect(resolveRetentionDays("60")).toBe(60)
  })

  it("env=30 → 30 (경계 — 최소)", () => {
    expect(resolveRetentionDays("30")).toBe(30)
  })

  it("env=365 → 365 (경계 — 최대)", () => {
    expect(resolveRetentionDays("365")).toBe(365)
  })

  it("env=29 (범위 미달) → default 90", () => {
    expect(resolveRetentionDays("29")).toBe(90)
  })

  it("env=366 (범위 초과) → default 90", () => {
    expect(resolveRetentionDays("366")).toBe(90)
  })

  it("env=비정수 → default 90", () => {
    expect(resolveRetentionDays("abc")).toBe(90)
  })

  it("env=실수 → default 90 (정수 아님)", () => {
    expect(resolveRetentionDays("60.5")).toBe(90)
  })
})

// =============================================================================
// C. deleteMany 호출 검증 + cutoff 계산
// =============================================================================

describe("GET /api/cron/stat-cleanup — deleteMany 호출", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = "test-secret"
    delete process.env.STAT_RETENTION_DAYS
  })

  it("default 90 일 — deleteMany 두 테이블 호출 + cutoff 검증", async () => {
    mockStatDailyDeleteMany.mockResolvedValueOnce({ count: 12 })
    mockStatHourlyDeleteMany.mockResolvedValueOnce({ count: 345 })

    const before = Date.now()
    const res = await GET(makeReq("Bearer test-secret") as never)
    const after = Date.now()

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.retentionDays).toBe(90)
    expect(body.statDailyDeleted).toBe(12)
    expect(body.statHourlyDeleted).toBe(345)
    expect(typeof body.cutoff).toBe("string")
    expect(typeof body.ts).toBe("string")

    // cutoff 검증 — now - 90d (허용 오차 1초)
    const cutoffMs = new Date(body.cutoff).getTime()
    const expectedMin = before - 90 * 24 * 60 * 60 * 1000 - 1000
    const expectedMax = after - 90 * 24 * 60 * 60 * 1000 + 1000
    expect(cutoffMs).toBeGreaterThanOrEqual(expectedMin)
    expect(cutoffMs).toBeLessThanOrEqual(expectedMax)

    // deleteMany 호출 인자 검증 — where.date.lt = cutoff
    expect(mockStatDailyDeleteMany).toHaveBeenCalledTimes(1)
    expect(mockStatHourlyDeleteMany).toHaveBeenCalledTimes(1)
    const dailyArg = mockStatDailyDeleteMany.mock.calls[0][0]
    const hourlyArg = mockStatHourlyDeleteMany.mock.calls[0][0]
    expect(dailyArg.where.date.lt).toBeInstanceOf(Date)
    expect(hourlyArg.where.date.lt).toBeInstanceOf(Date)
    // 두 호출의 cutoff 동일 (같은 cutoff 변수 공유)
    expect((dailyArg.where.date.lt as Date).getTime()).toBe(
      (hourlyArg.where.date.lt as Date).getTime(),
    )
  })

  it("STAT_RETENTION_DAYS=60 오버라이드 — 60 일 cutoff 적용", async () => {
    process.env.STAT_RETENTION_DAYS = "60"
    mockStatDailyDeleteMany.mockResolvedValueOnce({ count: 0 })
    mockStatHourlyDeleteMany.mockResolvedValueOnce({ count: 0 })

    const before = Date.now()
    const res = await GET(makeReq("Bearer test-secret") as never)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.retentionDays).toBe(60)

    // cutoff = now - 60d
    const cutoffMs = new Date(body.cutoff).getTime()
    const expected = before - 60 * 24 * 60 * 60 * 1000
    expect(Math.abs(cutoffMs - expected)).toBeLessThan(2000)
  })

  it("count=0 (삭제 대상 없음) → ok=true", async () => {
    mockStatDailyDeleteMany.mockResolvedValueOnce({ count: 0 })
    mockStatHourlyDeleteMany.mockResolvedValueOnce({ count: 0 })

    const res = await GET(makeReq("Bearer test-secret") as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.statDailyDeleted).toBe(0)
    expect(body.statHourlyDeleted).toBe(0)
  })

  it("STAT_RETENTION_DAYS 범위 밖 (29) → default 90 적용", async () => {
    process.env.STAT_RETENTION_DAYS = "29"
    mockStatDailyDeleteMany.mockResolvedValueOnce({ count: 0 })
    mockStatHourlyDeleteMany.mockResolvedValueOnce({ count: 0 })

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.retentionDays).toBe(90)
  })
})

// =============================================================================
// D. deleteMany 실패 처리
// =============================================================================

describe("GET /api/cron/stat-cleanup — 실패 처리", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = "test-secret"
    delete process.env.STAT_RETENTION_DAYS
  })

  it("statDaily.deleteMany throw → 500 + error 메시지 마스킹", async () => {
    mockStatDailyDeleteMany.mockRejectedValueOnce(
      new Error("DB connection lost: token=Bearer abcdef1234567890ABCDEF"),
    )

    const res = await GET(makeReq("Bearer test-secret") as never)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBeDefined()
    // scrubString 적용 — Bearer 토큰 마스킹
    expect(body.error).not.toContain("abcdef1234567890ABCDEF")
    expect(body.error).toContain("[REDACTED]")
    // statHourly 는 호출되지 않음 (statDaily 먼저 throw)
    expect(mockStatHourlyDeleteMany).not.toHaveBeenCalled()
  })

  it("statHourly.deleteMany throw → 500 + statDaily count 보존", async () => {
    mockStatDailyDeleteMany.mockResolvedValueOnce({ count: 100 })
    mockStatHourlyDeleteMany.mockRejectedValueOnce(new Error("hourly fail"))

    const res = await GET(makeReq("Bearer test-secret") as never)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
    // statDaily 는 이미 100 건 삭제 완료 → 응답에 보존
    expect(body.statDailyDeleted).toBe(100)
    expect(body.statHourlyDeleted).toBe(0)
  })

  it("error 메시지 길이 500 자 cap", async () => {
    const longMsg = "x".repeat(600)
    mockStatDailyDeleteMany.mockRejectedValueOnce(new Error(longMsg))

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.error.length).toBeLessThanOrEqual(500)
  })
})

// =============================================================================
// E. 외부 호출 0 회귀 가드
// =============================================================================

describe("GET /api/cron/stat-cleanup — 외부 호출 0", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = "test-secret"
    delete process.env.STAT_RETENTION_DAYS
  })

  it("성공 경로에서 fetch 등 외부 API 호출 0 (DB-only)", async () => {
    mockStatDailyDeleteMany.mockResolvedValueOnce({ count: 5 })
    mockStatHourlyDeleteMany.mockResolvedValueOnce({ count: 7 })

    // global.fetch 가 호출되면 즉시 throw
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("UNEXPECTED FETCH CALL")
    })

    try {
      const res = await GET(makeReq("Bearer test-secret") as never)
      expect(res.status).toBe(200)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
