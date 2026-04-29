/**
 * F-11.3 — analyzeMarginalUtility / listAnalyzableKeywords Server Action 단위 테스트.
 *
 * 검증:
 *   A. analyzeMarginalUtility
 *      - 권한 throw 전파 (getCurrentAdvertiser)
 *      - hasKeys=false 차단
 *      - 광고주 횡단 차단 (다른 광고주 키워드)
 *      - Zod 검증 (device / keywordId / daysWindow 범위)
 *      - 정상 흐름: calculateMarginalUtility 위임 + 결과 반환
 *      - 외부 호출 실패 → ok:false (마스킹 로깅)
 *      - recentAvgRnk Decimal → number 변환
 *   B. listAnalyzableKeywords
 *      - 7일 클릭 desc 정렬 + limit 200
 *      - groupBy 결과 매핑 (refId → clicks)
 *      - 클릭 0 키워드도 포함 (insufficientData 는 UI/계산 단계 안내)
 *      - device 별 필터 (groupBy where.device)
 *      - Zod 실패 시 빈 배열
 *
 * 외부 호출 0:
 *   - vi.mock("@/lib/auth/access", ...)
 *   - vi.mock("@/lib/db/prisma", ...)
 *   - vi.mock("@/lib/marginal-utility/calculate", ...)
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// =============================================================================
// Mocks (전역 hoist)
// =============================================================================

const mockGetCurrentAdvertiser = vi.fn()
vi.mock("@/lib/auth/access", () => ({
  getCurrentAdvertiser: (...args: unknown[]) =>
    mockGetCurrentAdvertiser(...args),
}))

const mockKeywordFindFirst = vi.fn()
const mockKeywordFindMany = vi.fn()
const mockStatDailyGroupBy = vi.fn()

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    keyword: {
      findFirst: (...args: unknown[]) => mockKeywordFindFirst(...args),
      findMany: (...args: unknown[]) => mockKeywordFindMany(...args),
    },
    statDaily: {
      groupBy: (...args: unknown[]) => mockStatDailyGroupBy(...args),
    },
  },
}))

const mockCalculate = vi.fn()
vi.mock("@/lib/marginal-utility/calculate", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/marginal-utility/calculate")
  >("@/lib/marginal-utility/calculate")
  return {
    ...actual,
    calculateMarginalUtility: (...args: unknown[]) => mockCalculate(...args),
  }
})

// import 본체 — mock 등록 후
import {
  analyzeMarginalUtility,
  listAnalyzableKeywords,
} from "@/app/(dashboard)/[advertiserId]/bidding-policies/marginal-actions"

// =============================================================================
// 공통 setup
// =============================================================================

const ADV_ID = "adv_1"
const KEYWORD_ID = "kw_1"

function setActiveAdvertiserWithKeys(): void {
  mockGetCurrentAdvertiser.mockResolvedValue({
    advertiser: {
      id: ADV_ID,
      customerId: "1234",
      name: "Adv",
      status: "active",
      hasKeys: true,
    },
    user: { id: "u_op", role: "operator" },
  })
}

function setActiveAdvertiserWithoutKeys(): void {
  mockGetCurrentAdvertiser.mockResolvedValue({
    advertiser: {
      id: ADV_ID,
      customerId: "1234",
      name: "Adv",
      status: "active",
      hasKeys: false,
    },
    user: { id: "u_op", role: "operator" },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  setActiveAdvertiserWithKeys()
})

// =============================================================================
// A. analyzeMarginalUtility
// =============================================================================

describe("analyzeMarginalUtility", () => {
  it("[A1] Zod — device 검증 실패 시 ok:false + DB 호출 0", async () => {
    const r = await analyzeMarginalUtility({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "ALL" as "PC" | "MOBILE",
    })
    expect(r.ok).toBe(false)
    expect(mockGetCurrentAdvertiser).not.toHaveBeenCalled()
    expect(mockCalculate).not.toHaveBeenCalled()
  })

  it("[A2] Zod — daysWindow 범위 (3..30) 위반 거부", async () => {
    const r = await analyzeMarginalUtility({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
      daysWindow: 60,
    })
    expect(r.ok).toBe(false)
    expect(mockCalculate).not.toHaveBeenCalled()
  })

  it("[A3] 권한 throw 전파 (getCurrentAdvertiser)", async () => {
    mockGetCurrentAdvertiser.mockRejectedValueOnce(
      new Error("해당 광고주에 대한 접근 권한이 없습니다"),
    )
    await expect(
      analyzeMarginalUtility({
        advertiserId: ADV_ID,
        keywordId: KEYWORD_ID,
        device: "PC",
      }),
    ).rejects.toThrow(/접근 권한이 없습니다/)
  })

  it("[A4] hasKeys=false → ok:false + Estimate 호출 0", async () => {
    setActiveAdvertiserWithoutKeys()

    const r = await analyzeMarginalUtility({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/API 키/u)
    expect(mockKeywordFindFirst).not.toHaveBeenCalled()
    expect(mockCalculate).not.toHaveBeenCalled()
  })

  it("[A5] 광고주 횡단 차단 — 다른 광고주 키워드는 거부", async () => {
    mockKeywordFindFirst.mockResolvedValue(null)

    const r = await analyzeMarginalUtility({
      advertiserId: ADV_ID,
      keywordId: "kw_other",
      device: "PC",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/광고주의 키워드/u)
    expect(mockCalculate).not.toHaveBeenCalled()

    // findFirst where 인자 — adgroup.campaign.advertiserId 격리
    const findArgs = mockKeywordFindFirst.mock.calls[0][0] as {
      where: { id: string; adgroup: { campaign: { advertiserId: string } } }
    }
    expect(findArgs.where.id).toBe("kw_other")
    expect(findArgs.where.adgroup.campaign.advertiserId).toBe(ADV_ID)
  })

  it("[A6] happy path — calculateMarginalUtility 위임 + 결과 통과 (recentAvgRnk Decimal 변환)", async () => {
    mockKeywordFindFirst.mockResolvedValue({
      id: KEYWORD_ID,
      nccKeywordId: "ncc-kw-1",
      keyword: "신발",
      bidAmt: 500,
      // Decimal 객체 흉내
      recentAvgRnk: { toString: () => "3.20" },
    })
    const fakeResult = {
      keyword: {
        id: KEYWORD_ID,
        nccKeywordId: "ncc-kw-1",
        keyword: "신발",
        currentBid: 500,
        recentAvgRnk: 3.2,
      },
      device: "PC" as const,
      period: { since: "iso", until: "iso", days: 7 },
      last7d: { impressions: 1000, clicks: 100, cost: 50000, cpc: 500 },
      insufficientData: null,
      positions: [],
      recommendedPosition: null,
    }
    mockCalculate.mockResolvedValue(fakeResult)

    const r = await analyzeMarginalUtility({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
    })

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toEqual(fakeResult)

    // calculate 호출 인자 — recentAvgRnk: Decimal → 3.2 변환 통과
    const calcArgs = mockCalculate.mock.calls[0][0] as {
      advertiserId: string
      customerId: string
      keywordId: string
      nccKeywordId: string
      keywordText: string
      currentBid: number | null
      recentAvgRnk: number | null
      device: string
      daysWindow: number
    }
    expect(calcArgs).toMatchObject({
      advertiserId: ADV_ID,
      customerId: "1234",
      keywordId: KEYWORD_ID,
      nccKeywordId: "ncc-kw-1",
      keywordText: "신발",
      currentBid: 500,
      device: "PC",
      daysWindow: 7,
    })
    expect(calcArgs.recentAvgRnk).toBeCloseTo(3.2, 2)
  })

  it("[A7] recentAvgRnk null + bidAmt null → 그대로 통과", async () => {
    mockKeywordFindFirst.mockResolvedValue({
      id: KEYWORD_ID,
      nccKeywordId: "ncc-kw-1",
      keyword: "신발",
      bidAmt: null,
      recentAvgRnk: null,
    })
    mockCalculate.mockResolvedValue({
      keyword: {
        id: KEYWORD_ID,
        nccKeywordId: "ncc-kw-1",
        keyword: "신발",
        currentBid: null,
        recentAvgRnk: null,
      },
      device: "PC",
      period: { since: "x", until: "x", days: 7 },
      last7d: { impressions: 0, clicks: 0, cost: 0, cpc: null },
      insufficientData: { reason: "min_clicks", actualClicks: 0 },
    })

    const r = await analyzeMarginalUtility({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
    })
    expect(r.ok).toBe(true)

    const calcArgs = mockCalculate.mock.calls[0][0] as {
      currentBid: number | null
      recentAvgRnk: number | null
    }
    expect(calcArgs.currentBid).toBeNull()
    expect(calcArgs.recentAvgRnk).toBeNull()
  })

  it("[A8] daysWindow 명시 (14) → calculate 에 전달", async () => {
    mockKeywordFindFirst.mockResolvedValue({
      id: KEYWORD_ID,
      nccKeywordId: "ncc-kw-1",
      keyword: "신발",
      bidAmt: 500,
      recentAvgRnk: null,
    })
    mockCalculate.mockResolvedValue({
      keyword: {
        id: KEYWORD_ID,
        nccKeywordId: "ncc-kw-1",
        keyword: "신발",
        currentBid: 500,
        recentAvgRnk: null,
      },
      device: "PC",
      period: { since: "x", until: "x", days: 14 },
      last7d: { impressions: 0, clicks: 0, cost: 0, cpc: null },
      insufficientData: { reason: "min_clicks", actualClicks: 0 },
    })

    const r = await analyzeMarginalUtility({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
      daysWindow: 14,
    })
    expect(r.ok).toBe(true)

    const calcArgs = mockCalculate.mock.calls[0][0] as { daysWindow: number }
    expect(calcArgs.daysWindow).toBe(14)
  })

  it("[A9] calculate throw → ok:false + 호출자에게 친화 메시지", async () => {
    mockKeywordFindFirst.mockResolvedValue({
      id: KEYWORD_ID,
      nccKeywordId: "ncc-kw-1",
      keyword: "신발",
      bidAmt: 500,
      recentAvgRnk: null,
    })
    mockCalculate.mockRejectedValueOnce(new Error("SA timeout"))

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const r = await analyzeMarginalUtility({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/한계효용 분석 실패/u)

    expect(errorSpy).toHaveBeenCalledTimes(1)
    // 로깅 객체에 평문 키 / customerId 가 노출되지 않는지 (advertiserId/keywordId/device/message 만)
    const logged = errorSpy.mock.calls[0][1] as Record<string, unknown>
    expect(Object.keys(logged).sort()).toEqual(
      ["advertiserId", "device", "keywordId", "message"].sort(),
    )
    errorSpy.mockRestore()
  })
})

// =============================================================================
// B. listAnalyzableKeywords
// =============================================================================

describe("listAnalyzableKeywords", () => {
  it("[B1] Zod 실패 (빈 advertiserId) → 빈 배열 + DB 호출 0", async () => {
    const r = await listAnalyzableKeywords("", "PC")
    expect(r).toEqual([])
    expect(mockGetCurrentAdvertiser).not.toHaveBeenCalled()
    expect(mockKeywordFindMany).not.toHaveBeenCalled()
  })

  it("[B2] 키워드 0건 → 빈 배열 (groupBy 호출 0)", async () => {
    mockKeywordFindMany.mockResolvedValue([])

    const r = await listAnalyzableKeywords(ADV_ID, "PC")
    expect(r).toEqual([])
    expect(mockStatDailyGroupBy).not.toHaveBeenCalled()
  })

  it("[B3] 7일 클릭 desc 정렬 + groupBy 결과 매핑 + adgroupName", async () => {
    mockKeywordFindMany.mockResolvedValue([
      {
        id: "k1",
        nccKeywordId: "ncc-1",
        keyword: "가방",
        adgroup: { name: "AG-1" },
      },
      {
        id: "k2",
        nccKeywordId: "ncc-2",
        keyword: "신발",
        adgroup: { name: "AG-2" },
      },
      {
        id: "k3",
        nccKeywordId: "ncc-3",
        keyword: "모자",
        adgroup: { name: "AG-3" },
      },
    ])
    mockStatDailyGroupBy.mockResolvedValue([
      { refId: "ncc-1", _sum: { clicks: 30 } },
      { refId: "ncc-2", _sum: { clicks: 100 } },
      // ncc-3 누락 (7일 클릭 0)
    ])

    const r = await listAnalyzableKeywords(ADV_ID, "PC")

    expect(r).toHaveLength(3)
    expect(r[0]).toEqual({
      id: "k2",
      nccKeywordId: "ncc-2",
      keyword: "신발",
      last7dClicks: 100,
      adgroupName: "AG-2",
    })
    expect(r[1].keyword).toBe("가방")
    expect(r[1].last7dClicks).toBe(30)
    // 클릭 0 키워드도 포함 (UI 가 분석 시도 후 insufficientData 안내)
    expect(r[2].keyword).toBe("모자")
    expect(r[2].last7dClicks).toBe(0)
  })

  it("[B4] device 별 필터 — groupBy where.device 통과", async () => {
    mockKeywordFindMany.mockResolvedValue([
      {
        id: "k1",
        nccKeywordId: "ncc-1",
        keyword: "가방",
        adgroup: { name: "AG-1" },
      },
    ])
    mockStatDailyGroupBy.mockResolvedValue([])

    await listAnalyzableKeywords(ADV_ID, "MOBILE")

    const groupByArgs = mockStatDailyGroupBy.mock.calls[0][0] as {
      where: { device: string; advertiserId: string; level: string }
    }
    expect(groupByArgs.where.device).toBe("MOBILE")
    expect(groupByArgs.where.advertiserId).toBe(ADV_ID)
    expect(groupByArgs.where.level).toBe("keyword")
  })

  it("[B5] keyword findMany 광고주 격리 (adgroup.campaign.advertiserId)", async () => {
    mockKeywordFindMany.mockResolvedValue([])

    await listAnalyzableKeywords(ADV_ID, "PC")

    const findArgs = mockKeywordFindMany.mock.calls[0][0] as {
      where: { adgroup: { campaign: { advertiserId: string } } }
      take: number
    }
    expect(findArgs.where.adgroup.campaign.advertiserId).toBe(ADV_ID)
    expect(findArgs.take).toBe(5000)
  })

  it("[B6] 결과 limit 200 — 키워드 250개여도 최상위 200개만", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      id: `k${i}`,
      nccKeywordId: `ncc-${i}`,
      keyword: `kw-${i}`,
      adgroup: { name: "AG" },
    }))
    mockKeywordFindMany.mockResolvedValue(many)
    mockStatDailyGroupBy.mockResolvedValue(
      many.map((k, i) => ({ refId: k.nccKeywordId, _sum: { clicks: i } })),
    )

    const r = await listAnalyzableKeywords(ADV_ID, "PC")
    expect(r).toHaveLength(200)
    // 정렬 desc — 가장 높은 클릭 (i=249) 이 첫번째
    expect(r[0].last7dClicks).toBe(249)
    expect(r[199].last7dClicks).toBe(50)
  })
})
