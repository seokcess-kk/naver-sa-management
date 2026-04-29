/**
 * F-11.3 — calculateMarginalUtility 단위 테스트.
 *
 * 외부 호출 0:
 *   - vi.mock("@/lib/db/prisma", ...)                      — statDaily.aggregate stub
 *   - vi.mock("@/lib/auto-bidding/estimate-cached", ...)   — getCachedAveragePositionBid stub
 *   - vi.mock("@/lib/naver-sa/estimate", ...)              — estimatePerformanceBulk stub
 *
 * 검증 매트릭스:
 *   1. 7일 합계 정확 (mock _sum)
 *   2. clicks < minClicks → insufficientData + Estimate 호출 0
 *   3. clicks 정확히 minClicks → 정상 흐름 진입
 *   4. avg-position cache hit/miss 모두 작동 (cachedAll 무관)
 *   5. perf-bulk bid 매핑 (응답 순서 무관)
 *   6. marginalUtility 양수 — 권장 순위 결정
 *   7. marginalUtility 0/음수 → null + 권장 X
 *   8. dCost <= 0 가드 (비단조 Estimate 응답)
 *   9. 모든 marginal null → recommendedPosition=null
 *   10. clicks=0 / cost=0 → cpc=null 처리
 *   11. perf row 없는 position → expected* null
 *   12. avg-position 응답에서 bid<=0 row 무시
 *   13. cost Decimal 입력(toString 객체) 정상 변환
 *   14. daysWindow 커스텀 (3..30) — period.days 반영
 *   15. minClicks 커스텀 — 임계 변동
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// =============================================================================
// Mocks (전역 — import 전에 hoist)
// =============================================================================

const mockAggregate = vi.fn()
vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    statDaily: {
      aggregate: (...args: unknown[]) => mockAggregate(...args),
    },
  },
}))

const mockAvgPosition = vi.fn()
vi.mock("@/lib/auto-bidding/estimate-cached", () => ({
  getCachedAveragePositionBid: (...args: unknown[]) => mockAvgPosition(...args),
}))

const mockPerfBulk = vi.fn()
vi.mock("@/lib/naver-sa/estimate", () => ({
  estimatePerformanceBulk: (...args: unknown[]) => mockPerfBulk(...args),
}))

// import 본체 — mock 등록 이후
import {
  calculateMarginalUtility,
  DEFAULT_MIN_CLICKS,
  DEFAULT_DAYS_WINDOW,
} from "@/lib/marginal-utility/calculate"

// =============================================================================
// 공통 fixture
// =============================================================================

const baseArgs = {
  advertiserId: "adv_1",
  customerId: "c-1",
  keywordId: "kw_1",
  nccKeywordId: "ncc-kw-1",
  keywordText: "신발",
  currentBid: 500,
  recentAvgRnk: 3.2,
  device: "PC" as const,
}

/** 1..5위 입찰가 — 순위가 높을수록(낮은 숫자) bid 가 큼. */
const standardAvgRows = [
  { keyword: "신발", position: 1, bid: 1500 },
  { keyword: "신발", position: 2, bid: 1100 },
  { keyword: "신발", position: 3, bid: 800 },
  { keyword: "신발", position: 4, bid: 600 },
  { keyword: "신발", position: 5, bid: 400 },
]

/** monotone 증가 perf — 순위가 높아질수록 클릭/비용 증가, marginal 양수. */
const monotonePerfRows = [
  { keyword: "신발", bid: 400, impressions: 500, clicks: 20, cost: 8000 }, // 5위
  { keyword: "신발", bid: 600, impressions: 800, clicks: 40, cost: 24000 }, // 4위
  { keyword: "신발", bid: 800, impressions: 1100, clicks: 60, cost: 48000 }, // 3위
  { keyword: "신발", bid: 1100, impressions: 1500, clicks: 80, cost: 88000 }, // 2위
  { keyword: "신발", bid: 1500, impressions: 2000, clicks: 100, cost: 150000 }, // 1위
]

beforeEach(() => {
  vi.clearAllMocks()
})

// =============================================================================
// Group A — 7일 합계 / insufficientData
// =============================================================================

describe("calculateMarginalUtility — 7일 합계 / insufficientData", () => {
  it("[1] 7일 합계 정확: _sum 통과 + cpc 계산", async () => {
    mockAggregate.mockResolvedValue({
      _sum: { impressions: 1000, clicks: 100, cost: 50000 },
    })
    mockAvgPosition.mockResolvedValue({
      data: standardAvgRows,
      cachedAll: true,
    })
    mockPerfBulk.mockResolvedValue(monotonePerfRows)

    const r = await calculateMarginalUtility(baseArgs)

    expect(r.last7d).toEqual({
      impressions: 1000,
      clicks: 100,
      cost: 50000,
      cpc: 500,
    })
    expect(r.period.days).toBe(DEFAULT_DAYS_WINDOW)
    expect(r.insufficientData).toBeNull()
    // aggregate where 인자 검증
    const aggArgs = mockAggregate.mock.calls[0][0] as {
      where: Record<string, unknown>
    }
    expect(aggArgs.where).toMatchObject({
      advertiserId: "adv_1",
      level: "keyword",
      refId: "ncc-kw-1",
      device: "PC",
    })
  })

  it("[2] clicks < minClicks → insufficientData + Estimate 호출 0", async () => {
    mockAggregate.mockResolvedValue({
      _sum: { impressions: 200, clicks: 10, cost: 5000 },
    })

    const r = await calculateMarginalUtility(baseArgs)

    expect(r.insufficientData).toEqual({
      reason: "min_clicks",
      actualClicks: 10,
    })
    expect(r.positions).toBeUndefined()
    expect(r.recommendedPosition).toBeUndefined()
    expect(mockAvgPosition).not.toHaveBeenCalled()
    expect(mockPerfBulk).not.toHaveBeenCalled()
  })

  it("[3] clicks === minClicks 경계: 정상 흐름 진입 (Estimate 호출)", async () => {
    mockAggregate.mockResolvedValue({
      _sum: { impressions: 1000, clicks: DEFAULT_MIN_CLICKS, cost: 25000 },
    })
    mockAvgPosition.mockResolvedValue({
      data: standardAvgRows,
      cachedAll: false,
    })
    mockPerfBulk.mockResolvedValue(monotonePerfRows)

    const r = await calculateMarginalUtility(baseArgs)

    expect(r.insufficientData).toBeNull()
    expect(mockAvgPosition).toHaveBeenCalledTimes(1)
    expect(mockPerfBulk).toHaveBeenCalledTimes(1)
    expect(r.positions).toBeDefined()
  })

  it("[4] _sum 값이 모두 null/undefined → 0 / cpc=null", async () => {
    mockAggregate.mockResolvedValue({
      _sum: { impressions: null, clicks: null, cost: null },
    })

    const r = await calculateMarginalUtility(baseArgs)

    expect(r.last7d).toEqual({
      impressions: 0,
      clicks: 0,
      cost: 0,
      cpc: null,
    })
    expect(r.insufficientData?.actualClicks).toBe(0)
  })

  it("[5] cost 가 Decimal 객체(toString) — Number 변환 정확", async () => {
    // Prisma Decimal 객체를 toString 가능한 객체로 흉내
    mockAggregate.mockResolvedValue({
      _sum: {
        impressions: 1000,
        clicks: 100,
        cost: { toString: () => "12345.67" },
      },
    })
    mockAvgPosition.mockResolvedValue({
      data: standardAvgRows,
      cachedAll: true,
    })
    mockPerfBulk.mockResolvedValue(monotonePerfRows)

    const r = await calculateMarginalUtility(baseArgs)

    expect(r.last7d.cost).toBeCloseTo(12345.67, 2)
    expect(r.last7d.cpc).toBeCloseTo(123.4567, 2)
  })

  it("[6] daysWindow 커스텀 (14일) — period.days 반영 + since 변동", async () => {
    mockAggregate.mockResolvedValue({
      _sum: { impressions: 100, clicks: 5, cost: 1000 },
    })

    const r = await calculateMarginalUtility({ ...baseArgs, daysWindow: 14 })

    expect(r.period.days).toBe(14)
    const sinceMs = new Date(r.period.since).getTime()
    const untilMs = new Date(r.period.until).getTime()
    const diffDays = Math.round((untilMs - sinceMs) / (24 * 60 * 60 * 1000))
    expect(diffDays).toBe(14)
  })

  it("[7] minClicks 커스텀 — 임계 변동 (10 으로 낮추면 통과)", async () => {
    mockAggregate.mockResolvedValue({
      _sum: { impressions: 200, clicks: 10, cost: 5000 },
    })
    mockAvgPosition.mockResolvedValue({
      data: standardAvgRows,
      cachedAll: true,
    })
    mockPerfBulk.mockResolvedValue(monotonePerfRows)

    const r = await calculateMarginalUtility({ ...baseArgs, minClicks: 10 })

    expect(r.insufficientData).toBeNull()
    expect(r.positions).toBeDefined()
  })
})

// =============================================================================
// Group B — Estimate 흐름 / 한계효용 / 권장 순위
// =============================================================================

describe("calculateMarginalUtility — Estimate 흐름 / 한계효용", () => {
  beforeEach(() => {
    mockAggregate.mockResolvedValue({
      _sum: { impressions: 1000, clicks: 100, cost: 50000 },
    })
  })

  it("[8] avg-position 호출 인자 검증 (advertiserId/customerId/device 통과)", async () => {
    mockAvgPosition.mockResolvedValue({
      data: standardAvgRows,
      cachedAll: true,
    })
    mockPerfBulk.mockResolvedValue(monotonePerfRows)

    await calculateMarginalUtility(baseArgs)

    expect(mockAvgPosition).toHaveBeenCalledWith({
      advertiserId: "adv_1",
      customerId: "c-1",
      keywordId: "kw_1",
      keywordText: "신발",
      device: "PC",
    })
  })

  it("[9] perf-bulk 호출 — bids 는 1..5위 입찰가 통째 전달", async () => {
    mockAvgPosition.mockResolvedValue({
      data: standardAvgRows,
      cachedAll: true,
    })
    mockPerfBulk.mockResolvedValue(monotonePerfRows)

    await calculateMarginalUtility(baseArgs)

    expect(mockPerfBulk).toHaveBeenCalledTimes(1)
    const [customerId, args] = mockPerfBulk.mock.calls[0]
    expect(customerId).toBe("c-1")
    expect(args).toMatchObject({
      keyword: "신발",
      device: "PC",
      bids: [1500, 1100, 800, 600, 400],
    })
  })

  it("[10] 단조 증가 perf → 모든 marginal 양수 → 권장 순위 = 1위", async () => {
    mockAvgPosition.mockResolvedValue({
      data: standardAvgRows,
      cachedAll: true,
    })
    mockPerfBulk.mockResolvedValue(monotonePerfRows)

    const r = await calculateMarginalUtility(baseArgs)

    expect(r.positions).toHaveLength(5)
    // position 1 (가장 높은 순위) 의 marginal: (100-80) / (150000-88000) = 20/62000
    const p1 = r.positions!.find((p) => p.position === 1)!
    expect(p1.marginalUtility).toBeCloseTo(20 / 62000, 6)
    expect(p1.expectedClicks).toBe(100)
    expect(p1.expectedCpc).toBe(1500)

    // position 5 (가장 낮은 순위) 는 비교 대상 없음 → null
    const p5 = r.positions!.find((p) => p.position === 5)!
    expect(p5.marginalUtility).toBeNull()
    expect(p5.expectedClicks).toBe(20)

    // 모든 marginal 양수 → 가장 높은 순위(1) 가 권장
    expect(r.recommendedPosition).toBe(1)
  })

  it("[11] 1위→2위 marginal 음수 (1위가 비효율) → 권장 = 2위", async () => {
    // 1위에서 비용은 폭증하지만 클릭은 감소(이상치)
    const perfRows = [
      ...monotonePerfRows.slice(0, 4), // 5..2위 정상
      // 1위: 클릭 감소 + 비용 폭증 → marginal 음수
      { keyword: "신발", bid: 1500, impressions: 2200, clicks: 70, cost: 200000 },
    ]
    mockAvgPosition.mockResolvedValue({
      data: standardAvgRows,
      cachedAll: true,
    })
    mockPerfBulk.mockResolvedValue(perfRows)

    const r = await calculateMarginalUtility(baseArgs)

    const p1 = r.positions!.find((p) => p.position === 1)!
    expect(p1.marginalUtility).toBeLessThan(0)

    const p2 = r.positions!.find((p) => p.position === 2)!
    expect(p2.marginalUtility).toBeGreaterThan(0)

    // 권장: 양수 marginal 의 가장 높은 순위 = 2위
    expect(r.recommendedPosition).toBe(2)
  })

  it("[12] dCost <= 0 가드 — Estimate 비단조 응답 시 marginal=null", async () => {
    // 2위 비용이 3위보다 작은 비단조 응답
    const perfRows = [
      { keyword: "신발", bid: 400, impressions: 500, clicks: 20, cost: 8000 },
      { keyword: "신발", bid: 600, impressions: 800, clicks: 40, cost: 24000 },
      { keyword: "신발", bid: 800, impressions: 1100, clicks: 60, cost: 48000 },
      // 2위 cost 가 3위 cost 보다 낮음 → dCost <= 0
      { keyword: "신발", bid: 1100, impressions: 1500, clicks: 80, cost: 40000 },
      { keyword: "신발", bid: 1500, impressions: 2000, clicks: 100, cost: 150000 },
    ]
    mockAvgPosition.mockResolvedValue({
      data: standardAvgRows,
      cachedAll: true,
    })
    mockPerfBulk.mockResolvedValue(perfRows)

    const r = await calculateMarginalUtility(baseArgs)

    // position 2 의 marginal — higher(2위) cost - lower(3위) cost = 40000-48000 = -8000 → null
    const p2 = r.positions!.find((p) => p.position === 2)!
    expect(p2.marginalUtility).toBeNull()
  })

  it("[13] 모든 marginal null/0/음수 → recommendedPosition=null", async () => {
    // 모든 순위에서 클릭 동일, 비용만 감소(이상) → dCost <= 0 → marginal null
    const perfRows = [
      { keyword: "신발", bid: 400, impressions: 500, clicks: 20, cost: 50000 },
      { keyword: "신발", bid: 600, impressions: 800, clicks: 20, cost: 40000 },
      { keyword: "신발", bid: 800, impressions: 1100, clicks: 20, cost: 30000 },
      { keyword: "신발", bid: 1100, impressions: 1500, clicks: 20, cost: 20000 },
      { keyword: "신발", bid: 1500, impressions: 2000, clicks: 20, cost: 10000 },
    ]
    mockAvgPosition.mockResolvedValue({
      data: standardAvgRows,
      cachedAll: true,
    })
    mockPerfBulk.mockResolvedValue(perfRows)

    const r = await calculateMarginalUtility(baseArgs)

    expect(r.recommendedPosition).toBeNull()
    // 모두 dCost <= 0 → 전부 null
    for (let i = 0; i < 4; i++) {
      expect(r.positions![i].marginalUtility).toBeNull()
    }
  })

  it("[14] perf 응답 누락 row → expected* null + marginal null", async () => {
    // 3위 perf 누락
    const perfRows = monotonePerfRows.filter((r) => r.bid !== 800)
    mockAvgPosition.mockResolvedValue({
      data: standardAvgRows,
      cachedAll: true,
    })
    mockPerfBulk.mockResolvedValue(perfRows)

    const r = await calculateMarginalUtility(baseArgs)

    const p3 = r.positions!.find((p) => p.position === 3)!
    expect(p3.expectedClicks).toBeNull()
    expect(p3.expectedCost).toBeNull()
    expect(p3.expectedCpc).toBeNull()
    // p3 의 marginal = p3 vs p4 비교 — p3 누락이므로 null
    expect(p3.marginalUtility).toBeNull()

    // 인접 순위(2위) 의 marginal = p2 vs p3 비교 — p3 누락이므로 null
    const p2 = r.positions!.find((p) => p.position === 2)!
    expect(p2.marginalUtility).toBeNull()

    // p4 의 marginal = p4 vs p5 비교 — 둘 다 있어 정상 계산
    const p4 = r.positions!.find((p) => p.position === 4)!
    expect(p4.marginalUtility).not.toBeNull()
  })

  it("[15] avg-position 응답에서 bid<=0 row 무시 → bids 배열에서 제외", async () => {
    const avgWithInvalid = [
      { keyword: "신발", position: 1, bid: 1500 },
      { keyword: "신발", position: 2, bid: 0 }, // 무시
      { keyword: "신발", position: 3, bid: -50 }, // 무시
      { keyword: "신발", position: 4, bid: 600 },
      { keyword: "신발", position: 5, bid: 400 },
    ]
    mockAvgPosition.mockResolvedValue({
      data: avgWithInvalid,
      cachedAll: true,
    })
    mockPerfBulk.mockResolvedValue([])

    await calculateMarginalUtility(baseArgs)

    const [, perfArgs] = mockPerfBulk.mock.calls[0]
    expect(perfArgs.bids).toEqual([1500, 600, 400])
  })

  it("[16] avg-position 응답이 빈 배열 → perf-bulk 호출 0 + position 5 row expected* null", async () => {
    mockAvgPosition.mockResolvedValue({
      data: [],
      cachedAll: false,
    })

    const r = await calculateMarginalUtility(baseArgs)

    expect(mockPerfBulk).not.toHaveBeenCalled()
    expect(r.positions).toHaveLength(5)
    for (const p of r.positions!) {
      expect(p.estimatedBid).toBe(0)
      expect(p.expectedClicks).toBeNull()
      expect(p.marginalUtility).toBeNull()
    }
    expect(r.recommendedPosition).toBeNull()
  })

  it("[17] expectedClicks=0 → cpc=null 가드 (0 division)", async () => {
    const perfRows = [
      { keyword: "신발", bid: 400, impressions: 100, clicks: 0, cost: 5000 },
      { keyword: "신발", bid: 600, impressions: 200, clicks: 5, cost: 6000 },
      { keyword: "신발", bid: 800, impressions: 400, clicks: 10, cost: 8000 },
      { keyword: "신발", bid: 1100, impressions: 600, clicks: 20, cost: 12000 },
      { keyword: "신발", bid: 1500, impressions: 800, clicks: 30, cost: 18000 },
    ]
    mockAvgPosition.mockResolvedValue({
      data: standardAvgRows,
      cachedAll: true,
    })
    mockPerfBulk.mockResolvedValue(perfRows)

    const r = await calculateMarginalUtility(baseArgs)

    const p5 = r.positions!.find((p) => p.position === 5)!
    expect(p5.expectedClicks).toBe(0)
    expect(p5.expectedCpc).toBeNull()
  })

  it("[18] keyword/device/period meta 가 결과에 정확 반영", async () => {
    mockAvgPosition.mockResolvedValue({
      data: standardAvgRows,
      cachedAll: true,
    })
    mockPerfBulk.mockResolvedValue(monotonePerfRows)

    const r = await calculateMarginalUtility(baseArgs)

    expect(r.keyword).toEqual({
      id: "kw_1",
      nccKeywordId: "ncc-kw-1",
      keyword: "신발",
      currentBid: 500,
      recentAvgRnk: 3.2,
    })
    expect(r.device).toBe("PC")
    expect(typeof r.period.since).toBe("string")
    expect(typeof r.period.until).toBe("string")
  })
})
