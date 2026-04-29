/**
 * F-10.1 / F-10.2 / F-10.3 Server Actions + EstimateCache 단위 테스트
 *
 * 검증 범위:
 *   A. getAveragePositionBid    — cache hit / cache miss / 만료 / 입력 검증 / 권한 거부 / 광고주 횡단
 *   B. getExposureMinimumBid    — cache hit / cache miss / SA 0 row throw 처리
 *   C. getPerformanceBulk       — cache 전체 hit / 전체 miss / 부분 hit·miss / bids 검증
 *   D. safeErrorMessage         — scrubString 통과 + 200자 절단 (간접 — error 응답 검증)
 *
 * 외부 호출 0:
 *   - vi.mock("@/lib/auth/access", ...)         — getCurrentAdvertiser stub
 *   - vi.mock("@/lib/db/prisma", ...)           — keyword.findFirst, estimateCache 메서드 stub
 *   - vi.mock("@/lib/naver-sa/estimate", ...)   — 3개 endpoint stub
 *
 * Prisma 7 enum (EstimateType / StatDevice) 은 lib/generated/prisma/enums.ts 에서 import — 실 client X.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// =============================================================================
// Mocks (전역 — import 전에 hoist 됨)
// =============================================================================

const mockGetCurrentAdvertiser = vi.fn()

vi.mock("@/lib/auth/access", () => ({
  getCurrentAdvertiser: (...args: unknown[]) => mockGetCurrentAdvertiser(...args),
}))

const mockKeywordFindFirst = vi.fn()
const mockEstimateCacheFindUnique = vi.fn()
const mockEstimateCacheUpsert = vi.fn()

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    keyword: {
      findFirst: (...args: unknown[]) => mockKeywordFindFirst(...args),
    },
    estimateCache: {
      findUnique: (...args: unknown[]) => mockEstimateCacheFindUnique(...args),
      upsert: (...args: unknown[]) => mockEstimateCacheUpsert(...args),
    },
  },
}))

const mockEstimateAvg = vi.fn()
const mockEstimateMin = vi.fn()
const mockEstimateBulk = vi.fn()

vi.mock("@/lib/naver-sa/estimate", () => ({
  estimateAveragePositionBid: (...args: unknown[]) => mockEstimateAvg(...args),
  estimateExposureMinimumBid: (...args: unknown[]) => mockEstimateMin(...args),
  estimatePerformanceBulk: (...args: unknown[]) => mockEstimateBulk(...args),
}))

// import 본체 — mock 등록 이후
import {
  getAveragePositionBid,
  getExposureMinimumBid,
  getPerformanceBulk,
} from "@/app/(dashboard)/[advertiserId]/keywords/estimate-actions"

// =============================================================================
// 공통 setup
// =============================================================================

const ADV_ID = "adv_1"
const KEYWORD_ID = "kw_1"
const CUSTOMER_ID = "c-1"
const KEYWORD_TEXT = "신발"

beforeEach(() => {
  vi.clearAllMocks()

  // 기본 stub: 권한 OK + 키워드 존재
  mockGetCurrentAdvertiser.mockResolvedValue({
    advertiser: {
      id: ADV_ID,
      customerId: CUSTOMER_ID,
      name: "Adv",
      status: "active",
      hasKeys: true,
    },
    user: { id: "u_1", role: "operator" },
  })

  mockKeywordFindFirst.mockResolvedValue({
    id: KEYWORD_ID,
    nccKeywordId: "ncc-kw-1",
    keyword: KEYWORD_TEXT,
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

// =============================================================================
// A. getAveragePositionBid (F-10.1)
// =============================================================================

describe("getAveragePositionBid", () => {
  it("cache miss: SA 1회 호출 + upsert 1회 + cachedAll=false", async () => {
    mockEstimateCacheFindUnique.mockResolvedValue(null)
    const rows = [
      { keyword: KEYWORD_TEXT, position: 1, bid: 1500 },
      { keyword: KEYWORD_TEXT, position: 2, bid: 1100 },
      { keyword: KEYWORD_TEXT, position: 3, bid: 800 },
      { keyword: KEYWORD_TEXT, position: 4, bid: 600 },
      { keyword: KEYWORD_TEXT, position: 5, bid: 400 },
    ]
    mockEstimateAvg.mockResolvedValue(rows)
    mockEstimateCacheUpsert.mockResolvedValue({ id: "cache-1" })

    const r = await getAveragePositionBid({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
    })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data).toEqual(rows)
    expect(r.cachedAll).toBe(false)
    expect(r.cachedCount).toBe(0)
    expect(mockEstimateAvg).toHaveBeenCalledTimes(1)
    expect(mockEstimateAvg).toHaveBeenCalledWith(CUSTOMER_ID, {
      keyword: KEYWORD_TEXT,
      device: "PC",
      positions: [1, 2, 3, 4, 5],
    })
    expect(mockEstimateCacheUpsert).toHaveBeenCalledTimes(1)
  })

  it("cache hit (미만료): SA 호출 0 + cachedAll=true", async () => {
    const rows = [
      { keyword: KEYWORD_TEXT, position: 1, bid: 1500 },
      { keyword: KEYWORD_TEXT, position: 5, bid: 400 },
    ]
    // expiresAt 1분 뒤 (미만료)
    mockEstimateCacheFindUnique.mockResolvedValue({
      result: rows,
      expiresAt: new Date(Date.now() + 60_000),
    })

    const r = await getAveragePositionBid({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "MOBILE",
    })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data).toEqual(rows)
    expect(r.cachedAll).toBe(true)
    expect(r.cachedCount).toBe(1)
    expect(mockEstimateAvg).not.toHaveBeenCalled()
    expect(mockEstimateCacheUpsert).not.toHaveBeenCalled()
  })

  it("만료된 캐시: SA 호출 1회 + 새 entry upsert (만료를 hit 처리하면 안 됨)", async () => {
    const oldRows = [{ keyword: KEYWORD_TEXT, position: 1, bid: 100 }]
    // expiresAt 1분 전 (만료)
    mockEstimateCacheFindUnique.mockResolvedValue({
      result: oldRows,
      expiresAt: new Date(Date.now() - 60_000),
    })

    const newRows = [{ keyword: KEYWORD_TEXT, position: 1, bid: 999 }]
    mockEstimateAvg.mockResolvedValue(newRows)
    mockEstimateCacheUpsert.mockResolvedValue({ id: "cache-1" })

    const r = await getAveragePositionBid({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
    })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data).toEqual(newRows)
    expect(r.cachedAll).toBe(false)
    expect(mockEstimateAvg).toHaveBeenCalledTimes(1)
    expect(mockEstimateCacheUpsert).toHaveBeenCalledTimes(1)
  })

  it("권한 거부: getCurrentAdvertiser throw → ok=false", async () => {
    mockGetCurrentAdvertiser.mockRejectedValue(new Error("권한 부족"))

    const r = await getAveragePositionBid({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
    })

    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("권한 부족")
    expect(mockEstimateAvg).not.toHaveBeenCalled()
  })

  it("hasKeys=false: API 키 미입력 안내", async () => {
    mockGetCurrentAdvertiser.mockResolvedValue({
      advertiser: {
        id: ADV_ID,
        customerId: CUSTOMER_ID,
        name: "Adv",
        status: "active",
        hasKeys: false,
      },
      user: { id: "u_1", role: "operator" },
    })

    const r = await getAveragePositionBid({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
    })

    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("API 키")
    expect(mockEstimateAvg).not.toHaveBeenCalled()
  })

  it("광고주 횡단 차단: keyword.findFirst null → ok=false", async () => {
    mockKeywordFindFirst.mockResolvedValue(null)

    const r = await getAveragePositionBid({
      advertiserId: ADV_ID,
      keywordId: "kw_other_advertiser",
      device: "PC",
    })

    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("키워드를 찾을 수 없")
    expect(mockEstimateAvg).not.toHaveBeenCalled()
  })

  it("입력 검증: device 잘못된 값 → ok=false", async () => {
    const r = await getAveragePositionBid({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      // @ts-expect-error — 의도적 잘못된 enum
      device: "INVALID",
    })

    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("입력 검증 실패")
    expect(mockGetCurrentAdvertiser).not.toHaveBeenCalled()
  })

  it("입력 검증: keywordId 빈 문자열 → ok=false", async () => {
    const r = await getAveragePositionBid({
      advertiserId: ADV_ID,
      keywordId: "",
      device: "PC",
    })

    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("입력 검증 실패")
  })
})

// =============================================================================
// B. getExposureMinimumBid (F-10.2)
// =============================================================================

describe("getExposureMinimumBid", () => {
  it("cache miss: SA 1회 호출 + upsert 1회", async () => {
    mockEstimateCacheFindUnique.mockResolvedValue(null)
    const row = { keyword: KEYWORD_TEXT, minBid: 70 }
    mockEstimateMin.mockResolvedValue(row)
    mockEstimateCacheUpsert.mockResolvedValue({ id: "cache-1" })

    const r = await getExposureMinimumBid({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
    })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data).toEqual(row)
    expect(r.cachedAll).toBe(false)
    expect(mockEstimateMin).toHaveBeenCalledTimes(1)
    expect(mockEstimateCacheUpsert).toHaveBeenCalledTimes(1)
  })

  it("cache hit: SA 호출 0", async () => {
    const row = { keyword: KEYWORD_TEXT, minBid: 70 }
    mockEstimateCacheFindUnique.mockResolvedValue({
      result: row,
      expiresAt: new Date(Date.now() + 60_000),
    })

    const r = await getExposureMinimumBid({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "MOBILE",
    })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data).toEqual(row)
    expect(r.cachedAll).toBe(true)
    expect(mockEstimateMin).not.toHaveBeenCalled()
  })

  it("SA 가 throw (0 row 등): ok=false + 에러 메시지", async () => {
    mockEstimateCacheFindUnique.mockResolvedValue(null)
    mockEstimateMin.mockRejectedValue(
      new Error("exposure-minimum-bid returned 0 rows (insufficient data)"),
    )

    const r = await getExposureMinimumBid({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
    })

    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("0 rows")
    expect(mockEstimateCacheUpsert).not.toHaveBeenCalled()
  })
})

// =============================================================================
// C. getPerformanceBulk (F-10.3)
// =============================================================================

describe("getPerformanceBulk", () => {
  it("전체 cache miss: SA 1회 호출 + bid 별 upsert N회", async () => {
    mockEstimateCacheFindUnique.mockResolvedValue(null)
    const rows = [
      { keyword: KEYWORD_TEXT, bid: 100, impressions: 50, clicks: 5, cost: 500, cpc: 100 },
      { keyword: KEYWORD_TEXT, bid: 200, impressions: 80, clicks: 8, cost: 1600, cpc: 200 },
      { keyword: KEYWORD_TEXT, bid: 500, impressions: 200, clicks: 18, cost: 9000, cpc: 500 },
    ]
    mockEstimateBulk.mockResolvedValue(rows)
    mockEstimateCacheUpsert.mockResolvedValue({ id: "cache-x" })

    const r = await getPerformanceBulk({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
      bids: [200, 100, 500], // 정렬 무관 입력
    })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.map((x) => x.bid)).toEqual([100, 200, 500]) // 정렬 출력
    expect(r.cachedAll).toBe(false)
    expect(r.cachedCount).toBe(0)
    expect(mockEstimateBulk).toHaveBeenCalledTimes(1)
    // SA 에는 sortedBids 가 들어감
    expect(mockEstimateBulk).toHaveBeenCalledWith(CUSTOMER_ID, {
      keyword: KEYWORD_TEXT,
      device: "PC",
      bids: [100, 200, 500],
    })
    expect(mockEstimateCacheUpsert).toHaveBeenCalledTimes(3)
  })

  it("전체 cache hit: SA 호출 0 + cachedAll=true", async () => {
    // bid 별 hit 응답 (Promise.all 순서)
    mockEstimateCacheFindUnique
      .mockResolvedValueOnce({
        result: { keyword: KEYWORD_TEXT, bid: 100, impressions: 50, clicks: 5, cost: 500, cpc: 100 },
        expiresAt: new Date(Date.now() + 60_000),
      })
      .mockResolvedValueOnce({
        result: { keyword: KEYWORD_TEXT, bid: 200, impressions: 80, clicks: 8, cost: 1600, cpc: 200 },
        expiresAt: new Date(Date.now() + 60_000),
      })

    const r = await getPerformanceBulk({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
      bids: [100, 200],
    })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.length).toBe(2)
    expect(r.cachedAll).toBe(true)
    expect(r.cachedCount).toBe(2)
    expect(mockEstimateBulk).not.toHaveBeenCalled()
    expect(mockEstimateCacheUpsert).not.toHaveBeenCalled()
  })

  it("부분 hit/miss: 일부 bid 만 hit → SA 는 miss bid 만 호출 + 누락 안 됨", async () => {
    // bid 100 hit, bid 200 miss, bid 500 miss
    mockEstimateCacheFindUnique
      .mockResolvedValueOnce({
        result: { keyword: KEYWORD_TEXT, bid: 100, impressions: 50, clicks: 5, cost: 500, cpc: 100 },
        expiresAt: new Date(Date.now() + 60_000),
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)

    const fresh = [
      { keyword: KEYWORD_TEXT, bid: 200, impressions: 80, clicks: 8, cost: 1600, cpc: 200 },
      { keyword: KEYWORD_TEXT, bid: 500, impressions: 200, clicks: 18, cost: 9000, cpc: 500 },
    ]
    mockEstimateBulk.mockResolvedValue(fresh)
    mockEstimateCacheUpsert.mockResolvedValue({ id: "cache-x" })

    const r = await getPerformanceBulk({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
      bids: [100, 200, 500],
    })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.length).toBe(3)
    expect(r.data.map((x) => x.bid)).toEqual([100, 200, 500])
    expect(r.cachedAll).toBe(false)
    expect(r.cachedCount).toBe(1)
    expect(mockEstimateBulk).toHaveBeenCalledTimes(1)
    // SA 에는 miss bids 만
    expect(mockEstimateBulk).toHaveBeenCalledWith(CUSTOMER_ID, {
      keyword: KEYWORD_TEXT,
      device: "PC",
      bids: [200, 500],
    })
    // upsert 는 fresh 만 (hit 은 다시 upsert X)
    expect(mockEstimateCacheUpsert).toHaveBeenCalledTimes(2)
  })

  it("SA 응답 row 일부 누락: 결과 배열에 누락 bid 미포함, 다른 bid 캐시는 정상 저장", async () => {
    mockEstimateCacheFindUnique.mockResolvedValue(null)
    // bid 200 의 row 는 누락 (네이버 데이터 부족)
    const fresh = [
      { keyword: KEYWORD_TEXT, bid: 100, impressions: 50, clicks: 5, cost: 500, cpc: 100 },
      { keyword: KEYWORD_TEXT, bid: 500, impressions: 200, clicks: 18, cost: 9000, cpc: 500 },
    ]
    mockEstimateBulk.mockResolvedValue(fresh)
    mockEstimateCacheUpsert.mockResolvedValue({ id: "cache-x" })

    const r = await getPerformanceBulk({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
      bids: [100, 200, 500],
    })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 결과는 SA 가 돌려준 것만 (bid 200 제외)
    expect(r.data.map((x) => x.bid)).toEqual([100, 500])
    // upsert 는 SA 가 돌려준 row 만 (bid 200 안 들어감)
    expect(mockEstimateCacheUpsert).toHaveBeenCalledTimes(2)
  })

  it("입력 검증: bids 빈 배열 → ok=false (Zod min(1))", async () => {
    const r = await getPerformanceBulk({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
      bids: [],
    })

    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("입력 검증 실패")
    expect(mockGetCurrentAdvertiser).not.toHaveBeenCalled()
  })

  it("입력 검증: bids length 21 → ok=false (Zod max(20))", async () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => i + 1)
    const r = await getPerformanceBulk({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
      bids: tooMany,
    })

    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("입력 검증 실패")
  })

  it("입력 검증: bids 음수 → ok=false (Zod positive)", async () => {
    const r = await getPerformanceBulk({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
      bids: [-100, 200],
    })

    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("입력 검증 실패")
  })

  it("입력 검증: bids 중복 → ok=false (refine unique)", async () => {
    const r = await getPerformanceBulk({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
      bids: [100, 100, 200],
    })

    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("입력 검증 실패")
  })
})

// =============================================================================
// D. safeErrorMessage 간접 검증 — 긴 에러 + scrubString 패턴
// =============================================================================

describe("error message 마스킹 / 절단 (간접)", () => {
  it("Bearer 토큰이 들어간 에러 메시지는 [REDACTED] 로 치환", async () => {
    mockEstimateCacheFindUnique.mockResolvedValue(null)
    mockEstimateMin.mockRejectedValue(
      new Error(
        "request failed with Authorization: Bearer abcdef1234567890abcdef header",
      ),
    )

    const r = await getExposureMinimumBid({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
    })

    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("[REDACTED]")
    expect(r.error).not.toContain("abcdef1234567890abcdef")
  })

  it("200자 초과 에러 메시지는 절단 + 말줄임표", async () => {
    mockEstimateCacheFindUnique.mockResolvedValue(null)
    const longMsg = "X".repeat(500)
    mockEstimateMin.mockRejectedValue(new Error(longMsg))

    const r = await getExposureMinimumBid({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
    })

    expect(r.ok).toBe(false)
    if (r.ok) return
    // 200자 + 말줄임표("…")
    expect(r.error.length).toBeLessThanOrEqual(201)
    expect(r.error.endsWith("…")).toBe(true)
  })
})
