/**
 * lib/quality-improver/scan.ts 단위 테스트 (Phase E.1).
 *
 * 검증 매트릭스:
 *   A. 비용 표본 부족 (cost < minCostKrw) → 평가 제외
 *   B. clicks=0 AND impressions>0 → no_clicks_14d
 *   C. ctr > 0 AND ctr < minCtrPct → low_ctr_14d
 *   D. 정상 (ctr >= minCtrPct) → candidate 미생성
 *   E. userLock=true 키워드 제외 (Keyword filter)
 *   F. status='deleted' 키워드 제외 (Keyword filter)
 *   G. config 부분 override
 *
 * 외부 호출 0:
 *   - vi.mock("@/lib/db/prisma", ...) — 실 DB 호출 0
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "@/lib/generated/prisma/client"

// =============================================================================
// Mocks
// =============================================================================

const mockGroupBy = vi.fn()
const mockFindMany = vi.fn()

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    statDaily: {
      groupBy: (...args: unknown[]) => mockGroupBy(...args),
    },
    keyword: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
    },
  },
}))

// =============================================================================
// 진입
// =============================================================================

import {
  scanQualityCandidates,
  DEFAULT_QUALITY_SCAN_CONFIG,
} from "./scan"

beforeEach(() => {
  mockGroupBy.mockReset()
  mockFindMany.mockReset()
})

function statRow(over: {
  refId: string
  imps?: number
  clicks?: number
  cost?: number
}) {
  return {
    refId: over.refId,
    _sum: {
      impressions: over.imps ?? 0,
      clicks: over.clicks ?? 0,
      cost: new Prisma.Decimal(over.cost ?? 0),
    },
  }
}

function keywordRow(nccKeywordId: string) {
  return {
    id: `int-${nccKeywordId}`,
    nccKeywordId,
    adgroupId: `adg-${nccKeywordId}`,
  }
}

describe("scanQualityCandidates", () => {
  it("A. 비용 표본 부족 (cost < minCostKrw) → 평가 제외", async () => {
    mockGroupBy.mockResolvedValueOnce([
      statRow({ refId: "k1", imps: 1000, clicks: 0, cost: 5000 }),
    ])
    // 비용 부족이라 keyword findMany 자체 호출 안 됨
    mockFindMany.mockResolvedValueOnce([])

    const r = await scanQualityCandidates("adv1")
    expect(r).toEqual([])
    // findMany 가 호출됐다면 (=비용 충족 keyword 있다면) nccIds 가 빈 배열로 호출됨
    if (mockFindMany.mock.calls.length > 0) {
      expect(mockFindMany.mock.calls[0][0].where.nccKeywordId.in).toEqual([])
    }
  })

  it("B. clicks=0 AND impressions>0 → no_clicks_14d", async () => {
    mockGroupBy.mockResolvedValueOnce([
      statRow({ refId: "k1", imps: 1000, clicks: 0, cost: 50_000 }),
    ])
    mockFindMany.mockResolvedValueOnce([keywordRow("k1")])

    const r = await scanQualityCandidates("adv1")
    expect(r).toHaveLength(1)
    expect(r[0].reasonCode).toBe("no_clicks_14d")
    expect(r[0].metrics.impressions14d).toBe(1000)
    expect(r[0].metrics.clicks14d).toBe(0)
  })

  it("C. ctr > 0 AND ctr < minCtrPct → low_ctr_14d", async () => {
    // 1000 imps / 1 click = 0.1% < 0.3%
    mockGroupBy.mockResolvedValueOnce([
      statRow({ refId: "k1", imps: 1000, clicks: 1, cost: 50_000 }),
    ])
    mockFindMany.mockResolvedValueOnce([keywordRow("k1")])

    const r = await scanQualityCandidates("adv1")
    expect(r).toHaveLength(1)
    expect(r[0].reasonCode).toBe("low_ctr_14d")
    expect(r[0].metrics.ctr14d).toBe(0.1)
  })

  it("D. 정상 (ctr >= minCtrPct) → candidate 미생성", async () => {
    // 1000 imps / 5 click = 0.5% >= 0.3%
    mockGroupBy.mockResolvedValueOnce([
      statRow({ refId: "k1", imps: 1000, clicks: 5, cost: 50_000 }),
    ])
    mockFindMany.mockResolvedValueOnce([keywordRow("k1")])

    const r = await scanQualityCandidates("adv1")
    expect(r).toEqual([])
  })

  it("E/F. userLock=true / status='deleted' 키워드 제외 (Prisma filter)", async () => {
    mockGroupBy.mockResolvedValueOnce([
      statRow({ refId: "k1", imps: 1000, clicks: 0, cost: 50_000 }),
    ])
    // findMany 가 빈 배열 반환 (DB filter 가 userLock/deleted 차단)
    mockFindMany.mockResolvedValueOnce([])

    const r = await scanQualityCandidates("adv1")
    expect(r).toEqual([])

    // Prisma where 가 status≠deleted AND userLock=false 포함하는지 검증
    const findManyCall = mockFindMany.mock.calls[0][0]
    expect(findManyCall.where.status).toEqual({ not: "deleted" })
    expect(findManyCall.where.userLock).toBe(false)
  })

  it("groupBy / findMany 모두 windowDays=14 since 사용", async () => {
    mockGroupBy.mockResolvedValueOnce([])
    mockFindMany.mockResolvedValueOnce([])
    await scanQualityCandidates("adv1")

    const since = mockGroupBy.mock.calls[0][0].where.date.gte
    const now = Date.now()
    const expected = new Date(now)
    expected.setUTCDate(expected.getUTCDate() - 14)
    // 1초 오차 허용
    expect(Math.abs(since.getTime() - expected.getTime())).toBeLessThan(2000)
  })

  it("G. config 부분 override (windowDays=7)", async () => {
    mockGroupBy.mockResolvedValueOnce([])
    mockFindMany.mockResolvedValueOnce([])
    await scanQualityCandidates("adv1", {
      windowDays: 7,
      minCtrPct: 0.3,
      minCostKrw: 10_000,
    })
    const since = mockGroupBy.mock.calls[0][0].where.date.gte
    const expected = new Date()
    expected.setUTCDate(expected.getUTCDate() - 7)
    expect(Math.abs(since.getTime() - expected.getTime())).toBeLessThan(2000)
  })

  it("DEFAULT_QUALITY_SCAN_CONFIG 노출", () => {
    expect(DEFAULT_QUALITY_SCAN_CONFIG.windowDays).toBe(14)
    expect(DEFAULT_QUALITY_SCAN_CONFIG.minCtrPct).toBe(0.3)
    expect(DEFAULT_QUALITY_SCAN_CONFIG.minCostKrw).toBe(10_000)
  })

  it("imps=0 AND clicks=0 → 침묵 (의미 없는 데이터)", async () => {
    mockGroupBy.mockResolvedValueOnce([
      statRow({ refId: "k1", imps: 0, clicks: 0, cost: 50_000 }),
    ])
    mockFindMany.mockResolvedValueOnce([keywordRow("k1")])
    const r = await scanQualityCandidates("adv1")
    expect(r).toEqual([])
  })
})
