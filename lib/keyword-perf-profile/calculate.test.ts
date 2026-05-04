/**
 * lib/keyword-perf-profile/calculate.ts 단위 테스트 (Phase A.2)
 *
 * 검증 범위:
 *   A. calculateBaseline — 정상 / 노출 0 / 클릭 0 / 데이터 없음 / dataDays 산출
 *   B. upsertBaseline    — prisma upsert 호출 shape
 *
 * 외부 호출 0 보장:
 *   - vi.mock("@/lib/db/prisma", ...) — 실 DB 호출 0
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "@/lib/generated/prisma/client"

// =============================================================================
// Mocks
// =============================================================================

const mockAggregate = vi.fn()
const mockFindMany = vi.fn()
const mockUpsert = vi.fn()

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    statDaily: {
      aggregate: (...args: unknown[]) => mockAggregate(...args),
      findMany: (...args: unknown[]) => mockFindMany(...args),
    },
    keywordPerformanceProfile: {
      upsert: (...args: unknown[]) => mockUpsert(...args),
    },
  },
}))

// =============================================================================
// 테스트 진입
// =============================================================================

import {
  calculateBaseline,
  upsertBaseline,
  DEFAULT_BASELINE_DAYS,
} from "./calculate"

beforeEach(() => {
  mockAggregate.mockReset()
  mockFindMany.mockReset()
  mockUpsert.mockReset()
})

// 28개의 distinct 일자 행 — dataDays=28 시뮬레이션
const distinctDates28 = Array.from({ length: 28 }, (_, i) => ({
  date: new Date(`2026-04-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
}))

describe("calculateBaseline", () => {
  it("정상 — imps/clicks/cost/conversions 모두 양수 → ctr/cvr/cpc Decimal 산출", async () => {
    mockAggregate.mockResolvedValueOnce({
      _sum: {
        impressions: 10_000,
        clicks: 500,
        cost: new Prisma.Decimal(500_000),
        conversions: 50,
      },
    })
    mockFindMany.mockResolvedValueOnce(distinctDates28)

    const r = await calculateBaseline("adv1")

    expect(r.advertiserId).toBe("adv1")
    expect(r.dataDays).toBe(28)
    // 500 / 10,000 = 0.05
    expect(r.avgCtr?.toString()).toBe("0.05")
    // 50 / 500 = 0.1
    expect(r.avgCvr?.toString()).toBe("0.1")
    // 500,000 / 500 = 1,000
    expect(r.avgCpc?.toString()).toBe("1000")
  })

  it("노출 0 — ctr null, clicks 0 → cvr/cpc null", async () => {
    mockAggregate.mockResolvedValueOnce({
      _sum: {
        impressions: 0,
        clicks: 0,
        cost: new Prisma.Decimal(0),
        conversions: 0,
      },
    })
    mockFindMany.mockResolvedValueOnce([])

    const r = await calculateBaseline("adv2")

    expect(r.dataDays).toBe(0)
    expect(r.avgCtr).toBeNull()
    expect(r.avgCvr).toBeNull()
    expect(r.avgCpc).toBeNull()
  })

  it("노출은 있으나 클릭 0 — ctr=0, cvr/cpc null", async () => {
    mockAggregate.mockResolvedValueOnce({
      _sum: {
        impressions: 1000,
        clicks: 0,
        cost: new Prisma.Decimal(0),
        conversions: 0,
      },
    })
    mockFindMany.mockResolvedValueOnce(distinctDates28.slice(0, 10))

    const r = await calculateBaseline("adv3")

    expect(r.dataDays).toBe(10)
    expect(r.avgCtr?.toString()).toBe("0")
    expect(r.avgCvr).toBeNull()
    expect(r.avgCpc).toBeNull()
  })

  it("conversions 미적재 (P1 광고주) — _sum.conversions null → cvr=0", async () => {
    mockAggregate.mockResolvedValueOnce({
      _sum: {
        impressions: 1000,
        clicks: 50,
        cost: new Prisma.Decimal(50_000),
        conversions: null,
      },
    })
    mockFindMany.mockResolvedValueOnce(distinctDates28)

    const r = await calculateBaseline("adv4")

    expect(r.avgCtr?.toString()).toBe("0.05")
    // null → 0 으로 처리 — 의미상 "전환 미측정" 이지만 Decimal 0 으로 기록
    expect(r.avgCvr?.toString()).toBe("0")
    expect(r.avgCpc?.toString()).toBe("1000")
  })

  it("days 옵션 커스텀 — since = now - days", async () => {
    mockAggregate.mockResolvedValueOnce({
      _sum: {
        impressions: 0,
        clicks: 0,
        cost: new Prisma.Decimal(0),
        conversions: 0,
      },
    })
    mockFindMany.mockResolvedValueOnce([])

    const fixedNow = new Date("2026-05-01T00:00:00Z")
    await calculateBaseline("adv5", { days: 7, now: fixedNow })

    // aggregate where.date.gte 가 7일 전인지 검증
    const aggCall = mockAggregate.mock.calls[0][0]
    const sinceArg = aggCall.where.date.gte as Date
    const expectedSince = new Date("2026-04-24T00:00:00Z")
    expect(sinceArg.toISOString()).toBe(expectedSince.toISOString())
  })

  it("기본 윈도 = DEFAULT_BASELINE_DAYS (28)", () => {
    expect(DEFAULT_BASELINE_DAYS).toBe(28)
  })

  it("aggregate / findMany 모두 level='campaign' 사용", async () => {
    mockAggregate.mockResolvedValueOnce({
      _sum: {
        impressions: 0,
        clicks: 0,
        cost: new Prisma.Decimal(0),
        conversions: 0,
      },
    })
    mockFindMany.mockResolvedValueOnce([])

    await calculateBaseline("adv6")

    expect(mockAggregate.mock.calls[0][0].where.level).toBe("campaign")
    expect(mockFindMany.mock.calls[0][0].where.level).toBe("campaign")
    expect(mockFindMany.mock.calls[0][0].distinct).toEqual(["date"])
  })
})

describe("upsertBaseline", () => {
  it("prisma.keywordPerformanceProfile.upsert — where + create + update 동일 페이로드", async () => {
    const input = {
      advertiserId: "adv1",
      dataDays: 28,
      avgCtr: new Prisma.Decimal("0.0123"),
      avgCvr: new Prisma.Decimal("0.05"),
      avgCpc: new Prisma.Decimal("250.5"),
      refreshedAt: new Date("2026-05-04T03:00:00Z"),
    }

    await upsertBaseline(input)

    expect(mockUpsert).toHaveBeenCalledTimes(1)
    const call = mockUpsert.mock.calls[0][0]
    expect(call.where).toEqual({ advertiserId: "adv1" })
    expect(call.create.advertiserId).toBe("adv1")
    expect(call.create.dataDays).toBe(28)
    expect(call.create.avgCtr.toString()).toBe("0.0123")
    expect(call.update.avgCpc.toString()).toBe("250.5")
    expect(call.update.refreshedAt).toEqual(input.refreshedAt)
  })

  it("null 값 그대로 전달 (DB 컬럼 nullable)", async () => {
    const input = {
      advertiserId: "adv2",
      dataDays: 0,
      avgCtr: null,
      avgCvr: null,
      avgCpc: null,
      refreshedAt: new Date(),
    }

    await upsertBaseline(input)

    const call = mockUpsert.mock.calls[0][0]
    expect(call.create.avgCtr).toBeNull()
    expect(call.create.avgCvr).toBeNull()
    expect(call.create.avgCpc).toBeNull()
    expect(call.update.avgCtr).toBeNull()
  })
})
