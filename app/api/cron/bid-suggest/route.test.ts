/**
 * bid-suggest cron — budget suggestion coverage.
 *
 * 외부 호출 0:
 *   - @/lib/db/prisma mock
 *   - marginal bid decision mock (budget 테스트에서는 bid 엔진 비진입)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockAdvertiserFindMany = vi.fn()
const mockAdvertiserFindUnique = vi.fn()
const mockBidAutomationConfigFindUnique = vi.fn()
const mockKeywordPerformanceProfileFindUnique = vi.fn()
const mockBiddingPolicyFindMany = vi.fn()
const mockStatDailyGroupBy = vi.fn()
const mockStatDailyFindFirst = vi.fn()
const mockKeywordFindMany = vi.fn()
const mockBidSuggestionFindFirst = vi.fn()
const mockBidSuggestionCreate = vi.fn()
const mockBidSuggestionUpdate = vi.fn()
const mockBidSuggestionUpdateMany = vi.fn()
const mockCampaignFindMany = vi.fn()

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    advertiser: {
      findMany: (...args: unknown[]) => mockAdvertiserFindMany(...args),
      findUnique: (...args: unknown[]) => mockAdvertiserFindUnique(...args),
    },
    bidAutomationConfig: {
      findUnique: (...args: unknown[]) =>
        mockBidAutomationConfigFindUnique(...args),
    },
    keywordPerformanceProfile: {
      findUnique: (...args: unknown[]) =>
        mockKeywordPerformanceProfileFindUnique(...args),
    },
    biddingPolicy: {
      findMany: (...args: unknown[]) => mockBiddingPolicyFindMany(...args),
    },
    statDaily: {
      groupBy: (...args: unknown[]) => mockStatDailyGroupBy(...args),
      findFirst: (...args: unknown[]) => mockStatDailyFindFirst(...args),
    },
    keyword: {
      findMany: (...args: unknown[]) => mockKeywordFindMany(...args),
    },
    campaign: {
      findMany: (...args: unknown[]) => mockCampaignFindMany(...args),
    },
    bidSuggestion: {
      findFirst: (...args: unknown[]) => mockBidSuggestionFindFirst(...args),
      create: (...args: unknown[]) => mockBidSuggestionCreate(...args),
      update: (...args: unknown[]) => mockBidSuggestionUpdate(...args),
      updateMany: (...args: unknown[]) => mockBidSuggestionUpdateMany(...args),
    },
  },
}))

vi.mock("@/lib/auto-bidding/marginal-score", async () => {
  // 묶음 헬퍼는 실제 구현 필요 (cron 이 import) — bundleSuggestions 만 actual.
  const actual = await vi.importActual<
    typeof import("@/lib/auto-bidding/marginal-score")
  >("@/lib/auto-bidding/marginal-score")
  return {
    ...actual,
    decideMarginalSuggestion: vi.fn(() => ({
      decision: "hold",
      reason: "low_confidence_data",
    })),
  }
})

import { decideMarginalSuggestion as mockedDecideMarginal } from "@/lib/auto-bidding/marginal-score"

import { GET } from "@/app/api/cron/bid-suggest/route"

function makeReq(authHeader: string | null): {
  headers: { get: (name: string) => string | null }
} {
  return {
    headers: {
      get: (name: string) => (name === "authorization" ? authHeader : null),
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = "test-secret"
  mockAdvertiserFindMany.mockResolvedValue([
    { id: "adv_1", bidAutomationConfig: { mode: "inbox" } },
  ])
  mockBidAutomationConfigFindUnique.mockResolvedValue({
    mode: "inbox",
    budgetPacingMode: "focus",
    targetCpa: null,
    targetRoas: null,
    targetCpc: null,
    maxCpc: null,
    minCtr: null,
    targetAvgRank: null,
  })
  mockKeywordPerformanceProfileFindUnique.mockResolvedValue(null)
  mockBiddingPolicyFindMany.mockResolvedValue([])
  mockKeywordFindMany.mockResolvedValue([])
  // 기본: lastSyncAt 키 미보유 (fallback 경로 검증) — StatDaily.updatedAt 으로 판정.
  mockAdvertiserFindUnique.mockResolvedValue({ lastSyncAt: {} })
  // 기본: fresh stat (1시간 전) — Phase 7 stale 가드 통과.
  mockStatDailyFindFirst.mockResolvedValue({
    updatedAt: new Date(Date.now() - 60 * 60 * 1000),
  })
  mockBidSuggestionFindFirst.mockResolvedValue(null)
  mockBidSuggestionCreate.mockResolvedValue({ id: "s_budget" })
  mockBidSuggestionUpdate.mockResolvedValue({ id: "s_budget" })
  mockBidSuggestionUpdateMany.mockResolvedValue({ count: 1 })
  mockCampaignFindMany.mockResolvedValue([
    {
      id: "camp_1",
      nccCampaignId: "ncc_cmp_1",
      name: "브랜드 캠페인",
      dailyBudget: 100000,
    },
  ])
  mockStatDailyGroupBy.mockImplementation((args: { where: { level: string; date?: unknown } }) => {
    if (args.where.level === "campaign" && typeof args.where.date === "object") {
      return Promise.resolve([
        {
          refId: "ncc_cmp_1",
          _sum: { cost: 650000, conversions: 20, revenue: 3000000 },
        },
      ])
    }
    if (args.where.level === "campaign") {
      return Promise.resolve([
        {
          refId: "ncc_cmp_1",
          _sum: { cost: 99000 },
        },
      ])
    }
    return Promise.resolve([])
  })
})

afterEach(() => {
  delete process.env.CRON_SECRET
})

describe("cron bid-suggest — budget suggestions", () => {
  it("baseline 이 없어도 캠페인 예산 권고를 생성한다", async () => {
    const res = await GET(makeReq("Bearer test-secret") as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.budgetCampaignsScanned).toBe(1)
    expect(body.keywordsScanned).toBe(0)
    expect(body.suggestionsCreated).toBe(1)

    expect(mockBidSuggestionCreate).toHaveBeenCalledTimes(1)
    const arg = mockBidSuggestionCreate.mock.calls[0][0]
    expect(arg.data.engineSource).toBe("budget")
    expect(arg.data.keywordId).toBeNull()
    expect(arg.data.action.kind).toBe("campaign_budget_update")
    expect(arg.data.action.campaignId).toBe("camp_1")
    expect(arg.data.action.currentDailyBudget).toBe(100000)
    expect(arg.data.action.suggestedDailyBudget).toBe(120000)
    expect(arg.data.action.reasonCode).toBe("budget_exhausted_with_signal")
  })

  it("기존 pending 예산 권고가 있고 조건이 해소되면 dismissed 처리한다", async () => {
    mockBidSuggestionFindFirst.mockResolvedValue({ id: "s_existing" })
    mockStatDailyGroupBy.mockImplementation((args: { where: { level: string; date?: unknown } }) => {
      if (args.where.level !== "campaign") return Promise.resolve([])
      return Promise.resolve([
        {
          refId: "ncc_cmp_1",
          _sum: { cost: 30000, conversions: 2, revenue: 100000 },
        },
      ])
    })

    const res = await GET(makeReq("Bearer test-secret") as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.suggestionsDismissed).toBe(1)
    expect(mockBidSuggestionUpdateMany).toHaveBeenCalledWith({
      where: { id: "s_existing", status: "pending" },
      data: { status: "dismissed" },
    })
  })
})

// =============================================================================
// 묶음 권고 — bid suggestion bundle path
// =============================================================================
//
// 동일 광고그룹 + 동일 방향 + 동일 reasonCode 5개+ 균질 → 묶음 1건 (scope='adgroup').
// baseline (KeywordPerformanceProfile) + StatDaily keyword level + Keyword 매핑까지
// mock 채워야 bid 엔진 진입.

describe("cron bid-suggest — keyword bundle suggestions", () => {
  beforeEach(() => {
    // baseline 채움 — bid 엔진 진입 가능.
    mockKeywordPerformanceProfileFindUnique.mockResolvedValue({
      dataDays: 28,
      avgCtr: null,
      avgCvr: null,
      avgCpc: null,
    })
    // 캠페인 예산 권고는 비활성화 (캠페인 0건).
    mockCampaignFindMany.mockResolvedValue([])
    // bid 엔진용 stat groupBy (keyword level) — 5개 키워드, cost ↓ 정렬.
    mockStatDailyGroupBy.mockImplementation(
      (args: { where: { level: string } }) => {
        if (args.where.level === "keyword") {
          return Promise.resolve(
            Array.from({ length: 5 }, (_, i) => ({
              refId: `ncc_kw_${i}`,
              _sum: {
                impressions: 5000,
                clicks: 100,
                cost: 100_000,
                conversions: 5,
                revenue: 600_000, // ROAS 6.0 → up
              },
              _avg: { avgRnk: null },
            })),
          )
        }
        return Promise.resolve([])
      },
    )
    // Keyword 5개 — 모두 같은 광고그룹.
    mockKeywordFindMany.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({
        id: `kw_${i}`,
        nccKeywordId: `ncc_kw_${i}`,
        bidAmt: 1000,
        useGroupBidAmt: false,
        userLock: false,
        adgroup: { id: "ag_1", name: "광고그룹 A" },
      })),
    )
    // 자동화 config 에 targetRoas 추가 (ROAS 분기 활성).
    mockBidAutomationConfigFindUnique.mockResolvedValue({
      mode: "inbox",
      budgetPacingMode: "focus",
      targetCpa: null,
      targetRoas: 4.0,
      targetCpc: null,
      maxCpc: null,
      minCtr: null,
      targetAvgRank: null,
    })
  })

  it("5개 균질 키워드 → 묶음 BidSuggestion 1건 + 단건 0건", async () => {
    // mock 을 실제 결정 로직으로 교체 (mock factory 의 actual 사용).
    const actual = await vi.importActual<
      typeof import("@/lib/auto-bidding/marginal-score")
    >("@/lib/auto-bidding/marginal-score")
    ;(mockedDecideMarginal as unknown as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockImplementation(actual.decideMarginalSuggestion)

    const res = await GET(makeReq("Bearer test-secret") as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.keywordsScanned).toBe(5)
    expect(body.bundlesCreated).toBe(1)
    expect(body.singlesCreated).toBe(0)

    // 묶음 BidSuggestion create payload 검증.
    const bundleCalls = mockBidSuggestionCreate.mock.calls.filter(
      (c) => c[0].data.scope === "adgroup",
    )
    expect(bundleCalls).toHaveLength(1)
    const arg = bundleCalls[0][0]
    expect(arg.data.engineSource).toBe("bid")
    expect(arg.data.keywordId).toBeNull()
    expect(arg.data.adgroupId).toBe("ag_1")
    expect(arg.data.scope).toBe("adgroup")
    expect(arg.data.affectedCount).toBe(5)
    expect(arg.data.targetName).toBe("광고그룹 A")
    expect(arg.data.action.kind).toBe("keyword_bid_bundle")
    expect(arg.data.action.adgroupId).toBe("ag_1")
    expect(arg.data.action.direction).toBe("up")
    expect(arg.data.action.reasonCode).toBe("roas_target")
    expect(arg.data.action.itemCount).toBe(5)
    expect(Array.isArray(arg.data.itemsJson)).toBe(true)
    expect(arg.data.itemsJson).toHaveLength(5)
  })

  it("4개 (임계 미만) → 단건 흐름 — bundlesCreated=0 / singlesCreated=4", async () => {
    mockStatDailyGroupBy.mockImplementation(
      (args: { where: { level: string } }) => {
        if (args.where.level === "keyword") {
          return Promise.resolve(
            Array.from({ length: 4 }, (_, i) => ({
              refId: `ncc_kw_${i}`,
              _sum: {
                impressions: 5000,
                clicks: 100,
                cost: 100_000,
                conversions: 5,
                revenue: 600_000,
              },
              _avg: { avgRnk: null },
            })),
          )
        }
        return Promise.resolve([])
      },
    )
    mockKeywordFindMany.mockResolvedValue(
      Array.from({ length: 4 }, (_, i) => ({
        id: `kw_${i}`,
        nccKeywordId: `ncc_kw_${i}`,
        bidAmt: 1000,
        useGroupBidAmt: false,
        userLock: false,
        adgroup: { id: "ag_1", name: "광고그룹 A" },
      })),
    )
    const actual = await vi.importActual<
      typeof import("@/lib/auto-bidding/marginal-score")
    >("@/lib/auto-bidding/marginal-score")
    ;(mockedDecideMarginal as unknown as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockImplementation(actual.decideMarginalSuggestion)

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.bundlesCreated).toBe(0)
    expect(body.singlesCreated).toBe(4)

    // 모든 create 가 scope='keyword' 인지 검증.
    const created = mockBidSuggestionCreate.mock.calls.filter(
      (c) => c[0].data.engineSource === "bid",
    )
    expect(created).toHaveLength(4)
    for (const c of created) {
      expect(c[0].data.scope).toBe("keyword")
      expect(c[0].data.affectedCount).toBe(1)
    }
  })

  it("기존 묶음 supersede — bundlesDismissed=1 (옵션 B 일괄 dismiss)", async () => {
    // bundle supersede updateMany 가 affected count 1 반환하도록 모킹.
    mockBidSuggestionUpdateMany.mockImplementation(
      (args: { where: { scope?: string } }) => {
        if (args.where.scope === "adgroup") return Promise.resolve({ count: 1 })
        return Promise.resolve({ count: 0 })
      },
    )
    const actual = await vi.importActual<
      typeof import("@/lib/auto-bidding/marginal-score")
    >("@/lib/auto-bidding/marginal-score")
    ;(mockedDecideMarginal as unknown as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockImplementation(actual.decideMarginalSuggestion)

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.bundlesDismissed).toBe(1)

    // updateMany 호출에 scope='adgroup' supersede 호출 포함됐는지 확인.
    const supersedeCalls = mockBidSuggestionUpdateMany.mock.calls.filter(
      (c) => c[0].where.scope === "adgroup",
    )
    expect(supersedeCalls).toHaveLength(1)
    expect(supersedeCalls[0][0].data.status).toBe("dismissed")
    expect(supersedeCalls[0][0].data.reason).toBe("superseded_by_new_bundle")
  })
})

// =============================================================================
// stat-daily stale 차단 (Phase 7 권고 품질 안전장치)
// =============================================================================
//
// processAdvertiser 진입부 가드:
//   - StatDaily.updatedAt 광고주별 max 가 30h 초과 → stats.stale=true → 권고 생성 skip.
//   - StatDaily 0행 (신규 광고주) → skip 안 함 (baseline 가드가 처리).
//   - 30h 이내 → 정상 진입 (24h 사이클 + 6h 여유).

describe("cron bid-suggest — stat-daily stale 차단", () => {
  it("StatDaily.updatedAt 31시간 전 → advertisersStale=1 + 권고 생성 0", async () => {
    mockStatDailyFindFirst.mockResolvedValue({
      updatedAt: new Date(Date.now() - 31 * 60 * 60 * 1000),
    })

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.advertisersStale).toBe(1)
    // stale 광고주는 budget 권고도 생성 안 함 (가드가 cfg 로드 직후).
    expect(body.suggestionsCreated).toBe(0)
    expect(body.budgetCampaignsScanned).toBe(0)
    expect(body.keywordsScanned).toBe(0)
    // bidSuggestion.create 미호출 검증.
    expect(mockBidSuggestionCreate).not.toHaveBeenCalled()
  })

  it("StatDaily.updatedAt 5시간 전 → fresh — 정상 진입 (advertisersStale=0)", async () => {
    mockStatDailyFindFirst.mockResolvedValue({
      updatedAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
    })

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.advertisersStale).toBe(0)
    // budget 권고는 생성 (default mock 시나리오).
    expect(body.suggestionsCreated).toBe(1)
    expect(body.budgetCampaignsScanned).toBe(1)
  })

  it("StatDaily 0행 (신규 광고주) → skip 안 함 (advertisersStale=0)", async () => {
    mockStatDailyFindFirst.mockResolvedValue(null)

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.advertisersStale).toBe(0)
    // 정상 진입 — budget 흐름은 default mock 으로 진행.
    expect(body.budgetCampaignsScanned).toBe(1)
  })

  it("lastSyncAt['stat_daily'] 31시간 전 → stale (StatDaily fallback 미호출)", async () => {
    mockAdvertiserFindUnique.mockResolvedValue({
      lastSyncAt: { stat_daily: new Date(Date.now() - 31 * 60 * 60 * 1000).toISOString() },
    })

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.advertisersStale).toBe(1)
    expect(body.budgetCampaignsScanned).toBe(0)
    // lastSyncAt 우선 — StatDaily fallback 호출 안 됨.
    expect(mockStatDailyFindFirst).not.toHaveBeenCalled()
  })

  it("lastSyncAt['stat_daily'] 5시간 전 + StatDaily.updatedAt 31시간 전 → fresh (lastSyncAt 우선)", async () => {
    mockAdvertiserFindUnique.mockResolvedValue({
      lastSyncAt: { stat_daily: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() },
    })
    mockStatDailyFindFirst.mockResolvedValue({
      updatedAt: new Date(Date.now() - 31 * 60 * 60 * 1000),
    })

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.advertisersStale).toBe(0)
    expect(body.budgetCampaignsScanned).toBe(1)
  })
})

// =============================================================================
// d) confidence threshold — kpp.dataDays 비례
// =============================================================================
// dataDays=1 (신규 광고주) 일 때 minClicksForConfidence / minImpressionsForConfidence 가
// 더 보수적(작은 임계 5/100)으로 적용되는지 검증. dataDays=7 이면 DEFAULT (50/1000).
//
// 검증 방식: cron 의 decideMarginalSuggestion 호출 시 config 인자를 캡처해 임계 수치 직접 비교.

describe("cron bid-suggest — confidence threshold (kpp.dataDays 비례)", () => {
  beforeEach(() => {
    // bid 엔진 진입 가능하도록 keyword level stat + Keyword 매핑 채움.
    mockStatDailyGroupBy.mockImplementation(
      (args: { where: { level: string } }) => {
        if (args.where.level === "keyword") {
          return Promise.resolve([
            {
              refId: "ncc_kw_1",
              _sum: {
                impressions: 5000,
                clicks: 100,
                cost: 100_000,
                conversions: 5,
                revenue: 600_000,
              },
              _avg: { avgRnk: null },
            },
          ])
        }
        return Promise.resolve([])
      },
    )
    mockKeywordFindMany.mockResolvedValue([
      {
        id: "kw_1",
        nccKeywordId: "ncc_kw_1",
        bidAmt: 1000,
        useGroupBidAmt: false,
        userLock: false,
        adgroup: { id: "ag_1", name: "광고그룹 A" },
      },
    ])
    // 캠페인 예산 권고 비활성화 (분기 격리).
    mockCampaignFindMany.mockResolvedValue([])
  })

  it("dataDays=1 → confidenceConfig 가 minClicks=5 / minImp=100 으로 보수적 적용", async () => {
    mockKeywordPerformanceProfileFindUnique.mockResolvedValue({
      dataDays: 1,
      avgCtr: null,
      avgCvr: null,
      avgCpc: null,
    })

    const res = await GET(makeReq("Bearer test-secret") as never)
    expect(res.status).toBe(200)

    // decideMarginalSuggestion 가 1회 이상 호출 — config 인자 캡처.
    expect(mockedDecideMarginal).toHaveBeenCalled()
    const arg = (mockedDecideMarginal as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as { config?: { minClicksForConfidence?: number; minImpressionsForConfidence?: number } }
    expect(arg.config).toBeDefined()
    // dataDays=1 → confidenceProgress=0 → 임계 5 / 100 (가장 보수적).
    expect(arg.config?.minClicksForConfidence).toBe(5)
    expect(arg.config?.minImpressionsForConfidence).toBe(100)
  })

  it("dataDays=7 (full window) → confidenceConfig=undefined (DEFAULT 50/1000 사용)", async () => {
    mockKeywordPerformanceProfileFindUnique.mockResolvedValue({
      dataDays: 7,
      avgCtr: null,
      avgCvr: null,
      avgCpc: null,
    })

    const res = await GET(makeReq("Bearer test-secret") as never)
    expect(res.status).toBe(200)

    expect(mockedDecideMarginal).toHaveBeenCalled()
    const arg = (mockedDecideMarginal as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as { config?: unknown }
    // 풀 윈도 → cron 은 config override 미전달 (decideMarginal 이 DEFAULT 사용).
    expect(arg.config).toBeUndefined()
  })

  it("dataDays=4 (중간) → 임계가 5..50 사이 / 100..1000 사이로 점진 보정", async () => {
    mockKeywordPerformanceProfileFindUnique.mockResolvedValue({
      dataDays: 4,
      avgCtr: null,
      avgCvr: null,
      avgCpc: null,
    })

    const res = await GET(makeReq("Bearer test-secret") as never)
    expect(res.status).toBe(200)

    const arg = (mockedDecideMarginal as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as { config?: { minClicksForConfidence?: number; minImpressionsForConfidence?: number } }
    expect(arg.config).toBeDefined()
    // dataDays=4 → progress = 3/6 = 0.5
    //   minClicks  = ceil(5 + (50-5)*0.5)  = ceil(27.5)  = 28
    //   minImpress = ceil(100 + (1000-100)*0.5) = 550
    expect(arg.config?.minClicksForConfidence).toBe(28)
    expect(arg.config?.minImpressionsForConfidence).toBe(550)
  })
})

// =============================================================================
// e) device 필터 가드 — top N groupBy 가 PC + MOBILE 만 합산
// =============================================================================
// device 이중집계 방지 정책 (lib/stat-daily/device-filter.ts) 회귀 가드.
// keyword level groupBy 호출의 where 에 device IN ('PC','MOBILE') 가 포함됐는지 검증.

describe("cron bid-suggest — device 필터 가드 (이중집계 방지)", () => {
  it("level='keyword' top groupBy 가 device IN ('PC','MOBILE') 필터 포함", async () => {
    mockKeywordPerformanceProfileFindUnique.mockResolvedValue({
      dataDays: 28,
      avgCtr: null,
      avgCvr: null,
      avgCpc: null,
    })
    mockCampaignFindMany.mockResolvedValue([])
    mockStatDailyGroupBy.mockImplementation(() => Promise.resolve([]))

    const res = await GET(makeReq("Bearer test-secret") as never)
    expect(res.status).toBe(200)

    // keyword level groupBy 호출 추출 — where.level='keyword'.
    const keywordCalls = mockStatDailyGroupBy.mock.calls.filter(
      (c) => (c[0] as { where: { level: string } }).where.level === "keyword",
    )
    expect(keywordCalls.length).toBeGreaterThan(0)
    for (const call of keywordCalls) {
      const where = (call[0] as { where: Record<string, unknown> }).where as {
        device?: { in?: string[] }
      }
      expect(where.device).toBeDefined()
      expect(where.device?.in).toEqual(expect.arrayContaining(["PC", "MOBILE"]))
      // ALL 미포함 — 이중집계 방지 핵심 가드.
      expect(where.device?.in).not.toContain("ALL")
    }
  })

  it("level='campaign' (예산 권고용) groupBy 도 동일 device 필터", async () => {
    mockKeywordPerformanceProfileFindUnique.mockResolvedValue(null)
    // default mock — campaign 1건 (mockCampaignFindMany default).

    const res = await GET(makeReq("Bearer test-secret") as never)
    expect(res.status).toBe(200)

    const campaignCalls = mockStatDailyGroupBy.mock.calls.filter(
      (c) => (c[0] as { where: { level: string } }).where.level === "campaign",
    )
    expect(campaignCalls.length).toBeGreaterThan(0)
    for (const call of campaignCalls) {
      const where = (call[0] as { where: Record<string, unknown> }).where as {
        device?: { in?: string[] }
      }
      expect(where.device?.in).toEqual(expect.arrayContaining(["PC", "MOBILE"]))
      expect(where.device?.in).not.toContain("ALL")
    }
  })
})
