/**
 * F-11.2 / F-10.1 — getCachedAveragePositionBid 단위 테스트.
 *
 * 외부 호출 0:
 *   - vi.mock("@/lib/db/prisma", ...)            — estimateCache.findUnique / upsert stub
 *   - vi.mock("@/lib/naver-sa/estimate", ...)    — estimateAveragePositionBid stub
 *
 * 검증:
 *   1. cache hit (미만료) → SA 호출 0 + cachedAll=true
 *   2. cache miss → SA 1회 호출 + upsert 1회 + cachedAll=false
 *   3. 만료된 캐시 (expiresAt <= now) → miss 처리 + SA 호출
 *   4. SA throw 시 그대로 전파 (호출부가 catch + OptimizationRun.failed)
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const mockFindUnique = vi.fn()
const mockUpsert = vi.fn()
vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    estimateCache: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      upsert: (...args: unknown[]) => mockUpsert(...args),
    },
  },
}))

const mockEstimate = vi.fn()
vi.mock("@/lib/naver-sa/estimate", () => ({
  estimateAveragePositionBid: (...args: unknown[]) => mockEstimate(...args),
}))

import { getCachedAveragePositionBid } from "@/lib/auto-bidding/estimate-cached"

beforeEach(() => {
  vi.clearAllMocks()
})

const args = {
  advertiserId: "adv_1",
  customerId: "c-1",
  keywordId: "kw_1",
  keywordText: "신발",
  device: "PC" as const,
}

describe("getCachedAveragePositionBid", () => {
  it("cache hit (미만료) — SA 호출 0 + cachedAll=true", async () => {
    const rows = [
      { keyword: "신발", position: 1, bid: 1500 },
      { keyword: "신발", position: 5, bid: 400 },
    ]
    mockFindUnique.mockResolvedValue({
      result: rows,
      expiresAt: new Date(Date.now() + 60_000),
    })

    const r = await getCachedAveragePositionBid(args)

    expect(r.cachedAll).toBe(true)
    expect(r.data).toEqual(rows)
    expect(mockEstimate).not.toHaveBeenCalled()
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it("cache miss — SA 1회 + upsert 1회 + cachedAll=false", async () => {
    mockFindUnique.mockResolvedValue(null)
    const rows = [
      { keyword: "신발", position: 1, bid: 1500 },
      { keyword: "신발", position: 2, bid: 1100 },
      { keyword: "신발", position: 3, bid: 800 },
      { keyword: "신발", position: 4, bid: 600 },
      { keyword: "신발", position: 5, bid: 400 },
    ]
    mockEstimate.mockResolvedValue(rows)
    mockUpsert.mockResolvedValue({ id: "cache-1" })

    const r = await getCachedAveragePositionBid(args)

    expect(r.cachedAll).toBe(false)
    expect(r.data).toEqual(rows)
    expect(mockEstimate).toHaveBeenCalledTimes(1)
    expect(mockEstimate).toHaveBeenCalledWith("c-1", {
      keyword: "신발",
      device: "PC",
      positions: [1, 2, 3, 4, 5],
    })
    expect(mockUpsert).toHaveBeenCalledTimes(1)
    const upsertArg = mockUpsert.mock.calls[0][0] as {
      create: { result: unknown; expiresAt: Date }
    }
    expect(upsertArg.create.result).toEqual(rows)
    expect(upsertArg.create.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it("만료된 캐시 (expiresAt <= now) — SA 1회 호출 + 새 entry upsert", async () => {
    mockFindUnique.mockResolvedValue({
      result: [{ keyword: "신발", position: 1, bid: 100 }],
      expiresAt: new Date(Date.now() - 60_000),
    })
    const fresh = [{ keyword: "신발", position: 1, bid: 999 }]
    mockEstimate.mockResolvedValue(fresh)
    mockUpsert.mockResolvedValue({ id: "cache-1" })

    const r = await getCachedAveragePositionBid(args)

    expect(r.cachedAll).toBe(false)
    expect(r.data).toEqual(fresh)
    expect(mockEstimate).toHaveBeenCalledTimes(1)
    expect(mockUpsert).toHaveBeenCalledTimes(1)
  })

  it("SA throw 시 그대로 전파 (호출부 catch 책임)", async () => {
    mockFindUnique.mockResolvedValue(null)
    mockEstimate.mockRejectedValue(new Error("SA timeout"))

    await expect(getCachedAveragePositionBid(args)).rejects.toThrow("SA timeout")
    // upsert 는 SA 성공 시에만 호출
    expect(mockUpsert).not.toHaveBeenCalled()
  })
})
