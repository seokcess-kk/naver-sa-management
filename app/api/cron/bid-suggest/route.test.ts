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
const mockBidSuggestionFindMany = vi.fn()
const mockBidSuggestionCreate = vi.fn()
const mockBidSuggestionUpdate = vi.fn()
const mockBidSuggestionUpdateMany = vi.fn()
const mockCampaignFindMany = vi.fn()
const mockStatHourlyFindMany = vi.fn()
const mockAdGroupFindMany = vi.fn()

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
    statHourly: {
      findMany: (...args: unknown[]) => mockStatHourlyFindMany(...args),
    },
    keyword: {
      findMany: (...args: unknown[]) => mockKeywordFindMany(...args),
    },
    campaign: {
      findMany: (...args: unknown[]) => mockCampaignFindMany(...args),
    },
    adGroup: {
      findMany: (...args: unknown[]) => mockAdGroupFindMany(...args),
    },
    bidSuggestion: {
      findFirst: (...args: unknown[]) => mockBidSuggestionFindFirst(...args),
      findMany: (...args: unknown[]) => mockBidSuggestionFindMany(...args),
      create: (...args: unknown[]) => mockBidSuggestionCreate(...args),
      update: (...args: unknown[]) => mockBidSuggestionUpdate(...args),
      updateMany: (...args: unknown[]) => mockBidSuggestionUpdateMany(...args),
    },
  },
}))

// notifier — bid_suggestion_new dispatch hook 테스트는 별도 파일.
// 본 파일은 dispatch 호출 자체를 막지 않되 외부 발송은 차단 (no-op mock).
const mockDispatch = vi.fn().mockResolvedValue({ ok: true, results: [] })
vi.mock("@/lib/notifier", () => ({
  dispatch: (...args: unknown[]) => mockDispatch(...args),
}))
vi.mock("@/lib/notifier/throttle", () => ({
  shouldThrottle: vi.fn().mockResolvedValue(false),
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

// rank 권고 단계 — Estimate 캐시 헬퍼 mock (cron 이 lib/auto-bidding/estimate-cached 호출).
const mockGetCachedAveragePositionBid = vi.fn()
vi.mock("@/lib/auto-bidding/estimate-cached", () => ({
  getCachedAveragePositionBid: (...args: unknown[]) =>
    mockGetCachedAveragePositionBid(...args),
}))

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
    {
      id: "adv_1",
      name: "광고주1",
      customerId: "1234567",
      bidAutomationConfig: { mode: "inbox" },
    },
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
  mockBidSuggestionFindMany.mockResolvedValue([])
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
  // rank 단계 — 기본 후보 0건 (rank describe 블록에서 override).
  mockGetCachedAveragePositionBid.mockResolvedValue({ data: [], cachedAll: false })
  // StatHourly 6h 가중평균 — 기본 0행 (rank describe 블록에서 override).
  // weightedMap 비어 있음 → 모든 후보가 last_non_null fallback (기존 6개 케이스 호환).
  mockStatHourlyFindMany.mockResolvedValue([])
  // 광고그룹 단위 rank 권고 (Phase 2A) — 기본 후보 0건 (adgroup 권고 describe 에서 override).
  mockAdGroupFindMany.mockResolvedValue([])
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
    // bundle supersede updateMany 만 affected count 1 반환 — kind='keyword_bid_bundle'
    // 매칭 호출만 카운트 (Phase 2A: scope='adgroup' updateMany 가 stale dismiss 와 분리).
    mockBidSuggestionUpdateMany.mockImplementation(
      (args: {
        where: { scope?: string; action?: { equals?: string } }
      }) => {
        if (
          args.where.scope === "adgroup" &&
          args.where.action?.equals === "keyword_bid_bundle"
        ) {
          return Promise.resolve({ count: 1 })
        }
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

    // updateMany 호출 필터 — Phase 2A 도입 후 scope='adgroup' 호출은 두 종류:
    //   1) 묶음 supersede: action.kind='keyword_bid_bundle' (본 테스트 대상)
    //   2) 광고그룹 단위 stale dismiss: action.reasonCode='adgroup_below_target_rank'
    // kind='keyword_bid_bundle' 필터로 묶음 supersede 호출만 검증.
    const supersedeCalls = mockBidSuggestionUpdateMany.mock.calls.filter(
      (c) =>
        c[0].where.scope === "adgroup" &&
        c[0].where.action?.equals === "keyword_bid_bundle",
    )
    expect(supersedeCalls).toHaveLength(1)
    expect(supersedeCalls[0][0].where.action.path).toEqual(["kind"])
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

// =============================================================================
// Event 1 — bid_suggestion_new 알림 hook
// =============================================================================

describe("cron bid-suggest — bid_suggestion_new dispatch", () => {
  it("신규 BidSuggestion 1+ 건 생성 시 광고주별 dispatch 호출 (info severity)", async () => {
    // 기본 setup 이 budget 1건 created — fresh suggestion 1건 mock
    mockBidSuggestionFindMany.mockResolvedValue([
      {
        adgroupId: "ag_1",
        keywordId: "kw_1",
        targetName: null,
        keyword: { keyword: "신발" },
      },
      {
        adgroupId: "ag_1",
        keywordId: "kw_2",
        targetName: null,
        keyword: { keyword: "운동화" },
      },
      {
        adgroupId: "ag_2",
        keywordId: "kw_3",
        targetName: null,
        keyword: { keyword: "가방" },
      },
    ])
    const res = await GET(makeReq("Bearer test-secret") as never)
    expect(res.status).toBe(200)

    expect(mockDispatch).toHaveBeenCalledTimes(1)
    const payload = mockDispatch.mock.calls[0][0]
    expect(payload.ruleType).toBe("bid_suggestion_new")
    expect(payload.severity).toBe("info")
    expect(payload.title).toContain("광고주1")
    expect(payload.title).toContain("3건")
    expect(payload.meta.advertiserId).toBe("adv_1")
    expect(payload.meta.customerId).toBe("1234567")
    expect(payload.meta.count).toBe(3)
    expect(payload.meta.groupCount).toBe(2)
    expect(payload.meta.sampleKeywords).toEqual(["신발", "운동화", "가방"])
  })

  it("created=0 이면 dispatch 호출 X", async () => {
    // budget create 자체를 막아 created=0 보장: 7d 비용을 0으로 (no_budget_signal hold)
    mockStatDailyGroupBy.mockImplementation(
      (args: { where: { level: string; date?: unknown } }) => {
        if (args.where.level !== "campaign") return Promise.resolve([])
        return Promise.resolve([])
      },
    )
    const res = await GET(makeReq("Bearer test-secret") as never)
    expect(res.status).toBe(200)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it("payload.meta 에 BOT_TOKEN / API key / secret 평문 노출 X", async () => {
    mockBidSuggestionFindMany.mockResolvedValue([
      {
        adgroupId: "ag_1",
        keywordId: "kw_1",
        targetName: null,
        keyword: { keyword: "테스트" },
      },
    ])
    await GET(makeReq("Bearer test-secret") as never)
    expect(mockDispatch).toHaveBeenCalledTimes(1)
    const payload = mockDispatch.mock.calls[0][0]
    const all = JSON.stringify(payload)
    // 1) Bearer 토큰
    expect(all).not.toMatch(/Bearer\s+[A-Za-z0-9._\-]{12,}/u)
    // 2) 32+ hex (HMAC / API key 패턴)
    expect(all).not.toMatch(/[A-Fa-f0-9]{32,}/u)
    // 3) 시크릿 키 환경변수명
    expect(all).not.toContain("ENCRYPTION_KEY")
    expect(all).not.toContain("TELEGRAM_BOT_TOKEN")
  })
})

// =============================================================================
// rank 권고 단계 — 5순위 미달 키워드 인상 권고 (Phase B.2 rank step)
// =============================================================================
//
// processRankSuggestions 는 marginal/budget 흐름 후 별도 keyword.findMany 를 호출.
// keyword.findMany mock 이 호출 횟수 / where 인자에 따라 다른 결과를 반환하도록 분기.
//
// rank 단계 keyword.findMany 식별:
//   - where.OR (last non-null > target / weightedMissedNccIds 분기)
//   - select.adgroup.select.campaign 정의됨 (광고주 횡단 차단용)
//
// marginal 단계 keyword.findMany 식별:
//   - where.nccKeywordId.in (매핑용)

describe("cron bid-suggest — rank suggestions (5순위 미달 인상 권고)", () => {
  beforeEach(() => {
    // baseline 채움 — bid 엔진 진입은 가능하지만 keyword level stat 0 → 권고 0 보장.
    mockKeywordPerformanceProfileFindUnique.mockResolvedValue({
      dataDays: 28,
      avgCtr: null,
      avgCvr: null,
      avgCpc: null,
    })
    // budget 흐름 비활성 — 분기 격리.
    mockCampaignFindMany.mockResolvedValue([])
    // marginal keyword level groupBy 0건 (rank 흐름만 검증).
    mockStatDailyGroupBy.mockImplementation(() => Promise.resolve([]))
  })

  it("후보 0건 → 통계 0 (no-op)", async () => {
    // rank findMany 호출에도 후보 0건.
    mockKeywordFindMany.mockImplementation(
      (args: { where?: { OR?: unknown } }) => {
        if (args?.where?.OR) {
          return Promise.resolve([])
        }
        return Promise.resolve([])
      },
    )

    const res = await GET(makeReq("Bearer test-secret") as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.rankCandidatesScanned).toBe(0)
    expect(body.rankCreated).toBe(0)
    expect(body.rankUpdated).toBe(0)
    expect(body.rankHoldNotReached).toBe(0)
    expect(body.rankCappedAtMaxCpc).toBe(0)
    expect(body.rankEstimateFailed).toBe(0)
    // Estimate 호출도 안 됨.
    expect(mockGetCachedAveragePositionBid).not.toHaveBeenCalled()
  })

  it("후보 1건 + Estimate 정상 → BidSuggestion create + rankCreated=1", async () => {
    // rank 후보 1건 — recentAvgRnk=8 (target=5 초과), bidAmt=500.
    mockKeywordFindMany.mockImplementation(
      (args: { where?: { OR?: unknown } }) => {
        if (args?.where?.OR) {
          return Promise.resolve([
            {
              id: "kw_rank_1",
              nccKeywordId: "ncc_kw_rank_1",
              keyword: "신발",
              bidAmt: 500,
              recentAvgRnk: 8,
              adgroup: {
                id: "ag_1",
                name: "광고그룹 A",
                campaign: { advertiserId: "adv_1" },
              },
            },
          ])
        }
        return Promise.resolve([])
      },
    )
    // Estimate 응답: position 5 도달 입찰가 1500원 (currentBid 500 보다 큼 → suggest).
    mockGetCachedAveragePositionBid.mockResolvedValue({
      data: [
        { keyword: "신발", position: 1, bid: 3000 },
        { keyword: "신발", position: 2, bid: 2500 },
        { keyword: "신발", position: 3, bid: 2000 },
        { keyword: "신발", position: 4, bid: 1700 },
        { keyword: "신발", position: 5, bid: 1500 },
      ],
      cachedAll: false,
    })

    const res = await GET(makeReq("Bearer test-secret") as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.rankCandidatesScanned).toBe(1)
    expect(body.rankCreated).toBe(1)
    expect(body.rankUpdated).toBe(0)

    // Estimate 호출 인자 검증.
    // BID_RANK_DEVICE_SCOPE 기본 'BOTH' → PC + MOBILE 둘 다 호출.
    expect(mockGetCachedAveragePositionBid).toHaveBeenCalledTimes(2)
    const pcCall = mockGetCachedAveragePositionBid.mock.calls.find(
      (c) => c[0].device === "PC",
    )
    const mobileCall = mockGetCachedAveragePositionBid.mock.calls.find(
      (c) => c[0].device === "MOBILE",
    )
    expect(pcCall).toBeTruthy()
    expect(mobileCall).toBeTruthy()
    const estArgs = pcCall![0]
    expect(estArgs.advertiserId).toBe("adv_1")
    expect(estArgs.customerId).toBe("1234567")
    expect(estArgs.keywordId).toBe("kw_rank_1")
    expect(estArgs.keywordText).toBe("신발")
    expect(estArgs.device).toBe("PC")
    expect(mobileCall![0].keywordId).toBe("kw_rank_1")
    expect(mobileCall![0].device).toBe("MOBILE")

    // BidSuggestion create payload 검증 — rank 단계는 scope='keyword' / engineSource='bid'.
    const rankCreates = mockBidSuggestionCreate.mock.calls.filter(
      (c) =>
        c[0].data.engineSource === "bid" &&
        c[0].data.keywordId === "kw_rank_1",
    )
    expect(rankCreates).toHaveLength(1)
    const arg = rankCreates[0][0]
    expect(arg.data.scope).toBe("keyword")
    expect(arg.data.adgroupId).toBe("ag_1")
    expect(arg.data.advertiserId).toBe("adv_1")
    expect(arg.data.affectedCount).toBe(1)
    expect(arg.data.action.kind).toBe("keyword_bid_update")
    expect(arg.data.action.reasonCode).toBe("below_target_rank")
    expect(arg.data.action.direction).toBe("up")
    expect(arg.data.action.currentBid).toBe(500)
    expect(arg.data.action.suggestedBid).toBe(1500)
    expect(arg.data.severity).toBe("info")
    // 신규 필드 — StatHourly 6h 가중평균 mock 0행(default) → fallback 경로.
    expect(arg.data.action.rankWindowHours).toBeNull()
    expect(arg.data.action.rankSampleImpressions).toBeNull()
    // reason 본문 fallback suffix.
    expect(arg.data.reason).toContain("최근 1시간 측정값")
  })

  it("Estimate < currentBid → hold (rankHoldNotReached=1, create 호출 X)", async () => {
    mockKeywordFindMany.mockImplementation(
      (args: { where?: { OR?: unknown } }) => {
        if (args?.where?.OR) {
          return Promise.resolve([
            {
              id: "kw_rank_2",
              nccKeywordId: "ncc_kw_rank_2",
              keyword: "운동화",
              bidAmt: 2000, // 이미 충분히 입찰
              recentAvgRnk: 7,
              adgroup: {
                id: "ag_1",
                name: "광고그룹 A",
                campaign: { advertiserId: "adv_1" },
              },
            },
          ])
        }
        return Promise.resolve([])
      },
    )
    mockGetCachedAveragePositionBid.mockResolvedValue({
      data: [
        { keyword: "운동화", position: 1, bid: 2500 },
        { keyword: "운동화", position: 2, bid: 2200 },
        { keyword: "운동화", position: 3, bid: 1900 },
        { keyword: "운동화", position: 4, bid: 1700 },
        { keyword: "운동화", position: 5, bid: 1500 }, // currentBid 2000 > Estimate
      ],
      cachedAll: false,
    })

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.rankCandidatesScanned).toBe(1)
    expect(body.rankCreated).toBe(0)
    expect(body.rankHoldNotReached).toBe(1)

    // rank 흐름의 BidSuggestion create 호출 없음.
    const rankCreates = mockBidSuggestionCreate.mock.calls.filter(
      (c) =>
        c[0].data.engineSource === "bid" &&
        c[0].data.keywordId === "kw_rank_2",
    )
    expect(rankCreates).toHaveLength(0)
  })

  it("Estimate throw → rankEstimateFailed=1 (cron 진행 계속)", async () => {
    mockKeywordFindMany.mockImplementation(
      (args: { where?: { OR?: unknown } }) => {
        if (args?.where?.OR) {
          return Promise.resolve([
            {
              id: "kw_rank_3",
              nccKeywordId: "ncc_kw_rank_3",
              keyword: "가방",
              bidAmt: 500,
              recentAvgRnk: 9,
              adgroup: {
                id: "ag_1",
                name: "광고그룹 A",
                campaign: { advertiserId: "adv_1" },
              },
            },
          ])
        }
        return Promise.resolve([])
      },
    )
    mockGetCachedAveragePositionBid.mockRejectedValue(
      new Error("naver-sa rate limit"),
    )

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    // cron 자체는 200 — 키워드 단위 흡수.
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.rankCandidatesScanned).toBe(1)
    expect(body.rankEstimateFailed).toBe(1)
    expect(body.rankCreated).toBe(0)
    // errors 배열은 비어 있어야 함 (광고주 단위 throw 가 아니라 키워드 단위 흡수).
    expect(body.errors).toEqual([])
  })

  it("기존 marginal pending 권고 있는 키워드 → rank 결과로 update 덮어쓰기 (rankUpdated=1)", async () => {
    mockKeywordFindMany.mockImplementation(
      (args: { where?: { OR?: unknown } }) => {
        if (args?.where?.OR) {
          return Promise.resolve([
            {
              id: "kw_rank_4",
              nccKeywordId: "ncc_kw_rank_4",
              keyword: "가방",
              bidAmt: 500,
              recentAvgRnk: 8,
              adgroup: {
                id: "ag_1",
                name: "광고그룹 A",
                campaign: { advertiserId: "adv_1" },
              },
            },
          ])
        }
        return Promise.resolve([])
      },
    )
    mockGetCachedAveragePositionBid.mockResolvedValue({
      data: [
        { keyword: "가방", position: 1, bid: 3000 },
        { keyword: "가방", position: 2, bid: 2500 },
        { keyword: "가방", position: 3, bid: 2000 },
        { keyword: "가방", position: 4, bid: 1700 },
        { keyword: "가방", position: 5, bid: 1500 },
      ],
      cachedAll: false,
    })
    // 같은 키워드의 기존 pending 권고 1건 있음 — rank findFirst 가 그 row 반환.
    mockBidSuggestionFindFirst.mockImplementation(
      (args: { where: { keywordId?: string; engineSource?: string; scope?: string } }) => {
        if (
          args.where.keywordId === "kw_rank_4" &&
          args.where.engineSource === "bid" &&
          args.where.scope === "keyword"
        ) {
          return Promise.resolve({ id: "s_existing_marginal" })
        }
        return Promise.resolve(null)
      },
    )

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.rankCreated).toBe(0)
    expect(body.rankUpdated).toBe(1)

    // bidSuggestion.update 가 기존 row 를 덮어쓴 인자 검증.
    const rankUpdates = mockBidSuggestionUpdate.mock.calls.filter(
      (c) => c[0].where.id === "s_existing_marginal",
    )
    expect(rankUpdates).toHaveLength(1)
    const upd = rankUpdates[0][0]
    expect(upd.data.action.kind).toBe("keyword_bid_update")
    expect(upd.data.action.reasonCode).toBe("below_target_rank")
    expect(upd.data.severity).toBe("info")
  })

  it("BiddingPolicy 등록 키워드 (자동 실행 대상) → rank 단계 제외", async () => {
    mockBiddingPolicyFindMany.mockResolvedValue([{ keywordId: "kw_rank_5" }])
    mockKeywordFindMany.mockImplementation(
      (args: { where?: { OR?: unknown } }) => {
        if (args?.where?.OR) {
          return Promise.resolve([
            {
              id: "kw_rank_5", // policy 등록됨
              nccKeywordId: "ncc_kw_rank_5",
              keyword: "신발",
              bidAmt: 500,
              recentAvgRnk: 8,
              adgroup: {
                id: "ag_1",
                name: "광고그룹 A",
                campaign: { advertiserId: "adv_1" },
              },
            },
          ])
        }
        return Promise.resolve([])
      },
    )

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    // policy 등록 키워드 — 후보 자체에서 제외.
    expect(body.rankCandidatesScanned).toBe(0)
    expect(body.rankCreated).toBe(0)
    expect(mockGetCachedAveragePositionBid).not.toHaveBeenCalled()
  })
})

// =============================================================================
// rank 권고 단계 — StatHourly 6h 노출 가중평균 보정 (신규 5개 케이스)
// =============================================================================
//
// 정책:
//   - last non-null `Keyword.recentAvgRnk` 만 보면 단일 시간 노이즈가 그대로 권고에 반영됨.
//   - StatHourly 최근 6시간 (impressions × recentAvgRnk) / Σimpressions 가중평균이 더 안정.
//   - 가중평균이 target 미달인 키워드도 OR 조건으로 후보 진입 (last non-null 도달이어도).
//   - 가중평균 행이 없는 키워드 (노출 0 / NULL) 는 last non-null fallback.
//   - action.rankWindowHours / rankSampleImpressions + reason 본문 출처 suffix.
//
// mock 식별:
//   - mockStatHourlyFindMany 가 광고주 keyword level 6h 행을 반환.
//   - refId === Keyword.nccKeywordId 매칭 (loadWeightedRankMap 의 accum key).

describe("cron bid-suggest — rank suggestions (StatHourly 6h 가중평균)", () => {
  beforeEach(() => {
    mockKeywordPerformanceProfileFindUnique.mockResolvedValue({
      dataDays: 28,
      avgCtr: null,
      avgCvr: null,
      avgCpc: null,
    })
    mockCampaignFindMany.mockResolvedValue([])
    mockStatDailyGroupBy.mockImplementation(() => Promise.resolve([]))
  })

  it("가중평균이 target 이하 → effectiveRank 컷 → 권고 0 (false positive 제거)", async () => {
    // 후보: last non-null=8 (target=5 초과 → SQL 통과)
    mockKeywordFindMany.mockImplementation(
      (args: { where?: { OR?: unknown } }) => {
        if (args?.where?.OR) {
          return Promise.resolve([
            {
              id: "kw_w_1",
              nccKeywordId: "ncc_kw_w_1",
              keyword: "신발",
              bidAmt: 500,
              recentAvgRnk: 8,
              adgroup: {
                id: "ag_1",
                name: "광고그룹 A",
                campaign: { advertiserId: "adv_1" },
              },
            },
          ])
        }
        return Promise.resolve([])
      },
    )
    // StatHourly 6h: impressions 10000 × rnk 4.5 → weighted=4.5 ≤ target=5
    mockStatHourlyFindMany.mockResolvedValue([
      { refId: "ncc_kw_w_1", impressions: 10000, recentAvgRnk: 4.5 },
    ])

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    // SQL 후보로는 1건 진입했지만 메모리에서 effectiveRank 컷 → candidatesScanned 0.
    expect(body.rankCandidatesScanned).toBe(0)
    expect(body.rankCreated).toBe(0)
    // Estimate 호출도 안 됨 (effectiveRank 컷이 Estimate 전).
    expect(mockGetCachedAveragePositionBid).not.toHaveBeenCalled()
  })

  it("가중평균 미달 + last non-null 미달 → suggest. action.rankWindowHours=6 + weighted 카운트", async () => {
    mockKeywordFindMany.mockImplementation(
      (args: { where?: { OR?: unknown } }) => {
        if (args?.where?.OR) {
          return Promise.resolve([
            {
              id: "kw_w_2",
              nccKeywordId: "ncc_kw_w_2",
              keyword: "신발",
              bidAmt: 500,
              recentAvgRnk: 8, // last non-null 도 미달
              adgroup: {
                id: "ag_1",
                name: "광고그룹 A",
                campaign: { advertiserId: "adv_1" },
              },
            },
          ])
        }
        return Promise.resolve([])
      },
    )
    // 가중평균 = (10000*7 + 5000*9) / 15000 = (70000+45000)/15000 = 7.6666
    mockStatHourlyFindMany.mockResolvedValue([
      { refId: "ncc_kw_w_2", impressions: 10000, recentAvgRnk: 7 },
      { refId: "ncc_kw_w_2", impressions: 5000, recentAvgRnk: 9 },
    ])
    mockGetCachedAveragePositionBid.mockResolvedValue({
      data: [
        { keyword: "신발", position: 1, bid: 3000 },
        { keyword: "신발", position: 2, bid: 2500 },
        { keyword: "신발", position: 3, bid: 2000 },
        { keyword: "신발", position: 4, bid: 1700 },
        { keyword: "신발", position: 5, bid: 1500 },
      ],
      cachedAll: false,
    })

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.rankCandidatesScanned).toBe(1)
    expect(body.rankCreated).toBe(1)
    expect(body.rankWeightedSourceCount).toBe(1)
    expect(body.rankFallbackSourceCount).toBe(0)

    // W1 — StatHourly findMany where 절에 device='ALL' 명시 (lib/stat-hourly/ingest.ts
    // 의 단일 적재 정책 고정). 향후 PC/MOBILE 분리 적재 도입 시 device 필터 누락으로
    // 인한 가중평균 왜곡(impressions ~3배 부풀림) 방지.
    expect(mockStatHourlyFindMany).toHaveBeenCalled()
    const statHourlyCallArgs = mockStatHourlyFindMany.mock.calls[0][0]
    expect(statHourlyCallArgs.where.device).toBe("ALL")
    expect(statHourlyCallArgs.where.level).toBe("keyword")

    // BidSuggestion.create payload — action 필드 검증.
    const rankCreates = mockBidSuggestionCreate.mock.calls.filter(
      (c) =>
        c[0].data.engineSource === "bid" &&
        c[0].data.keywordId === "kw_w_2",
    )
    expect(rankCreates).toHaveLength(1)
    const arg = rankCreates[0][0]
    expect(arg.data.action.rankWindowHours).toBe(6)
    expect(arg.data.action.rankSampleImpressions).toBe(15000)
    // currentAvgRank 는 effectiveRank (가중평균) — last non-null 8 이 아닌 ~7.67.
    expect(arg.data.action.currentAvgRank).toBeCloseTo(7.6666, 2)
    // reason 본문 출처 suffix.
    expect(arg.data.reason).toContain("최근 6시간 가중평균")
    expect(arg.data.reason).toContain("15,000")
  })

  it("StatHourly 데이터 없음(노출 0) → fallback. action.rankWindowHours=null + fallback 카운트", async () => {
    mockKeywordFindMany.mockImplementation(
      (args: { where?: { OR?: unknown } }) => {
        if (args?.where?.OR) {
          return Promise.resolve([
            {
              id: "kw_w_3",
              nccKeywordId: "ncc_kw_w_3",
              keyword: "운동화",
              bidAmt: 500,
              recentAvgRnk: 8,
              adgroup: {
                id: "ag_1",
                name: "광고그룹 A",
                campaign: { advertiserId: "adv_1" },
              },
            },
          ])
        }
        return Promise.resolve([])
      },
    )
    // 가중평균 행 없음 — fallback 경로.
    mockStatHourlyFindMany.mockResolvedValue([])
    mockGetCachedAveragePositionBid.mockResolvedValue({
      data: [
        { keyword: "운동화", position: 1, bid: 3000 },
        { keyword: "운동화", position: 2, bid: 2500 },
        { keyword: "운동화", position: 3, bid: 2000 },
        { keyword: "운동화", position: 4, bid: 1700 },
        { keyword: "운동화", position: 5, bid: 1500 },
      ],
      cachedAll: false,
    })

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.rankCreated).toBe(1)
    expect(body.rankWeightedSourceCount).toBe(0)
    expect(body.rankFallbackSourceCount).toBe(1)

    const rankCreates = mockBidSuggestionCreate.mock.calls.filter(
      (c) =>
        c[0].data.engineSource === "bid" &&
        c[0].data.keywordId === "kw_w_3",
    )
    expect(rankCreates).toHaveLength(1)
    const arg = rankCreates[0][0]
    expect(arg.data.action.rankWindowHours).toBeNull()
    expect(arg.data.action.rankSampleImpressions).toBeNull()
    expect(arg.data.action.currentAvgRank).toBe(8)
    expect(arg.data.reason).toContain("최근 1시간 측정값")
  })

  it("가중평균만 미달 (last non-null 도달) → OR 후보 진입 후 권고 적재", async () => {
    // last non-null=4 (target=5 도달 — 기존 SQL 만으로는 후보 제외)
    // 가중평균=7 (target=5 초과 — OR 분기로 진입)
    mockKeywordFindMany.mockImplementation(
      (args: { where?: { OR?: unknown; nccKeywordId?: unknown } }) => {
        if (args?.where?.OR) {
          // SQL 결과: weightedMissedNccIds OR 분기로 후보 진입.
          return Promise.resolve([
            {
              id: "kw_w_4",
              nccKeywordId: "ncc_kw_w_4",
              keyword: "가방",
              bidAmt: 500,
              recentAvgRnk: 4, // last non-null 은 도달
              adgroup: {
                id: "ag_1",
                name: "광고그룹 A",
                campaign: { advertiserId: "adv_1" },
              },
            },
          ])
        }
        return Promise.resolve([])
      },
    )
    // 가중평균 = 7 — target 5 초과 → weightedMissedNccIds 진입.
    mockStatHourlyFindMany.mockResolvedValue([
      { refId: "ncc_kw_w_4", impressions: 8000, recentAvgRnk: 7 },
    ])
    mockGetCachedAveragePositionBid.mockResolvedValue({
      data: [
        { keyword: "가방", position: 1, bid: 3000 },
        { keyword: "가방", position: 2, bid: 2500 },
        { keyword: "가방", position: 3, bid: 2000 },
        { keyword: "가방", position: 4, bid: 1700 },
        { keyword: "가방", position: 5, bid: 1500 },
      ],
      cachedAll: false,
    })

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.rankCreated).toBe(1)
    expect(body.rankWeightedSourceCount).toBe(1)

    // SQL 호출의 where.OR 안에 weightedMissedNccIds 분기 포함됐는지 검증.
    const rankCalls = mockKeywordFindMany.mock.calls.filter(
      (c) => (c[0] as { where?: { OR?: unknown } })?.where?.OR,
    )
    expect(rankCalls.length).toBeGreaterThan(0)
    const orArg = (rankCalls[0][0] as { where: { OR: unknown[] } }).where.OR
    expect(Array.isArray(orArg)).toBe(true)
    // weightedMissedNccIds 분기 — { nccKeywordId: { in: [...] } }
    const hasWeightedBranch = (orArg as Array<Record<string, unknown>>).some(
      (b) =>
        typeof b.nccKeywordId === "object" &&
        b.nccKeywordId !== null &&
        Array.isArray((b.nccKeywordId as { in?: unknown }).in) &&
        ((b.nccKeywordId as { in: string[] }).in).includes("ncc_kw_w_4"),
    )
    expect(hasWeightedBranch).toBe(true)
  })

  it("StatHourly 가중평균 행이 NULL only (impressions=0 / NULL) → fallback", async () => {
    // 모든 행이 가중평균 비대상 — impressions=0 또는 recentAvgRnk=NULL.
    mockKeywordFindMany.mockImplementation(
      (args: { where?: { OR?: unknown } }) => {
        if (args?.where?.OR) {
          return Promise.resolve([
            {
              id: "kw_w_5",
              nccKeywordId: "ncc_kw_w_5",
              keyword: "신발",
              bidAmt: 500,
              recentAvgRnk: 8,
              adgroup: {
                id: "ag_1",
                name: "광고그룹 A",
                campaign: { advertiserId: "adv_1" },
              },
            },
          ])
        }
        return Promise.resolve([])
      },
    )
    mockStatHourlyFindMany.mockResolvedValue([
      // impressions=0 → 가중평균 비대상.
      { refId: "ncc_kw_w_5", impressions: 0, recentAvgRnk: 7 },
      // recentAvgRnk=NULL → 가중평균 비대상.
      { refId: "ncc_kw_w_5", impressions: 5000, recentAvgRnk: null },
    ])
    mockGetCachedAveragePositionBid.mockResolvedValue({
      data: [
        { keyword: "신발", position: 1, bid: 3000 },
        { keyword: "신발", position: 5, bid: 1500 },
      ],
      cachedAll: false,
    })

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.rankCreated).toBe(1)
    expect(body.rankWeightedSourceCount).toBe(0)
    expect(body.rankFallbackSourceCount).toBe(1)

    const rankCreates = mockBidSuggestionCreate.mock.calls.filter(
      (c) =>
        c[0].data.engineSource === "bid" &&
        c[0].data.keywordId === "kw_w_5",
    )
    expect(rankCreates).toHaveLength(1)
    expect(rankCreates[0][0].data.action.rankWindowHours).toBeNull()
    expect(rankCreates[0][0].data.action.rankSampleImpressions).toBeNull()
  })

  it("stale 정리 (W4) — 후보 빠진 키워드의 below_target_rank pending dismiss", async () => {
    // 모든 키워드가 5위 도달 → 후보 SQL OR 양쪽 다 매칭 안 됨 → enriched=[].
    // 그럼에도 stale 정리는 실행되어야 함 — handledKeywordIds=[] → 모든 below_target_rank pending dismiss.
    mockKeywordFindMany.mockImplementation(
      (args: { where?: { OR?: unknown } }) => {
        if (args?.where?.OR) {
          return Promise.resolve([])
        }
        return Promise.resolve([])
      },
    )
    mockStatHourlyFindMany.mockResolvedValue([])

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.rankCandidatesScanned).toBe(0)
    expect(body.rankCreated).toBe(0)
    expect(body.rankUpdated).toBe(0)
    // mockBidSuggestionUpdateMany 기본값 { count: 1 } — stale dismiss 1건 카운트.
    expect(body.rankStaleDismissed).toBeGreaterThanOrEqual(1)

    // updateMany 호출 인자 — rank stale dismiss 만 필터.
    const staleCalls = mockBidSuggestionUpdateMany.mock.calls.filter((c) => {
      const where = c[0]?.where
      return (
        where?.engineSource === "bid" &&
        where?.scope === "keyword" &&
        where?.action?.path?.[0] === "reasonCode" &&
        where?.action?.equals === "below_target_rank"
      )
    })
    expect(staleCalls).toHaveLength(1)
    const staleCall = staleCalls[0][0]
    // selective dismiss 보장 — marginal 권고 (다른 reasonCode) 는 영향 없음.
    expect(staleCall.where.action.equals).toBe("below_target_rank")
    expect(staleCall.where.status).toBe("pending")
    expect(staleCall.where.scope).toBe("keyword")
    expect(staleCall.where.advertiserId).toBe("adv_1")
    // handled 0 → notIn: []
    expect(staleCall.where.keywordId.notIn).toEqual([])
    expect(staleCall.data).toEqual({ status: "dismissed" })
  })
})

// =============================================================================
// 광고그룹 단위 rank 권고 — adgroup default bid 인상 (Phase 2A)
// =============================================================================
//
// processAdgroupRankSuggestions 검증:
//   - useGroupBidAmt=true 키워드 평균 순위 미달 광고그룹 → AdGroup.bidAmt 인상 권고
//   - 대표 키워드 1개 (노출 TOP 1) Estimate 호출
//   - scope='adgroup', action.kind='adgroup_default_bid_update', reasonCode='adgroup_below_target_rank'
//   - marginal 묶음 supersede 보호 (action.kind='keyword_bid_bundle' 만 dismiss)
//   - stale 정리 (handled 외 광고그룹의 adgroup_below_target_rank pending dismiss)

describe("cron bid-suggest — adgroup rank suggestions (Phase 2A)", () => {
  beforeEach(() => {
    mockKeywordPerformanceProfileFindUnique.mockResolvedValue({
      dataDays: 28,
      avgCtr: null,
      avgCvr: null,
      avgCpc: null,
    })
    mockCampaignFindMany.mockResolvedValue([])
    mockStatDailyGroupBy.mockImplementation(() => Promise.resolve([]))
    // 키워드 단위 rank 단계 비활성 (분기 격리).
    mockKeywordFindMany.mockImplementation(() => Promise.resolve([]))
  })

  it("후보 0건 → no-op (adgroupRankCandidatesScanned=0, Estimate 미호출)", async () => {
    mockAdGroupFindMany.mockResolvedValue([])

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.adgroupRankCandidatesScanned).toBe(0)
    expect(body.adgroupRankCreated).toBe(0)
    expect(body.adgroupRankUpdated).toBe(0)
    expect(mockGetCachedAveragePositionBid).not.toHaveBeenCalled()
  })

  it("광고그룹 가중평균 미달 → suggest, scope='adgroup', kind='adgroup_default_bid_update'", async () => {
    mockAdGroupFindMany.mockResolvedValue([
      {
        id: "ag_a",
        nccAdgroupId: "ncc_ag_a",
        name: "광고그룹 A",
        bidAmt: 500,
        keywords: [
          { id: "kw_a1", nccKeywordId: "ncc_kw_a1", keyword: "신발", recentAvgRnk: 8 },
          { id: "kw_a2", nccKeywordId: "ncc_kw_a2", keyword: "운동화", recentAvgRnk: 7 },
        ],
      },
    ])
    // 가중평균 산출 — kw_a1: imp 10000 × rnk 8, kw_a2: imp 5000 × rnk 7
    // 광고그룹 = (10000*8 + 5000*7) / 15000 = (80000+35000)/15000 = 7.6666
    mockStatHourlyFindMany.mockResolvedValue([
      { refId: "ncc_kw_a1", impressions: 10000, recentAvgRnk: 8 },
      { refId: "ncc_kw_a2", impressions: 5000, recentAvgRnk: 7 },
    ])
    mockGetCachedAveragePositionBid.mockResolvedValue({
      data: [
        { keyword: "신발", position: 1, bid: 3000 },
        { keyword: "신발", position: 2, bid: 2500 },
        { keyword: "신발", position: 3, bid: 2000 },
        { keyword: "신발", position: 4, bid: 1700 },
        { keyword: "신발", position: 5, bid: 1500 },
      ],
      cachedAll: false,
    })

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.adgroupRankCandidatesScanned).toBe(1)
    expect(body.adgroupRankCreated).toBe(1)
    expect(body.adgroupRankWeightedSourceCount).toBe(1)
    expect(body.adgroupRankFallbackSourceCount).toBe(0)

    // BidSuggestion.create payload — scope='adgroup', kind='adgroup_default_bid_update'.
    const adgroupCreates = mockBidSuggestionCreate.mock.calls.filter(
      (c) =>
        c[0].data.engineSource === "bid" &&
        c[0].data.scope === "adgroup" &&
        c[0].data.adgroupId === "ag_a",
    )
    expect(adgroupCreates).toHaveLength(1)
    const arg = adgroupCreates[0][0]
    expect(arg.data.advertiserId).toBe("adv_1")
    expect(arg.data.keywordId).toBeNull()
    expect(arg.data.scope).toBe("adgroup")
    expect(arg.data.targetName).toBe("광고그룹 A")
    expect(arg.data.affectedCount).toBe(2)
    expect(arg.data.action.kind).toBe("adgroup_default_bid_update")
    expect(arg.data.action.reasonCode).toBe("adgroup_below_target_rank")
    expect(arg.data.action.adgroupId).toBe("ag_a")
    expect(arg.data.action.nccAdgroupId).toBe("ncc_ag_a")
    expect(arg.data.action.direction).toBe("up")
    expect(arg.data.action.currentBid).toBe(500)
    expect(arg.data.action.suggestedBid).toBe(1500)
    expect(arg.data.action.rankWindowHours).toBe(6)
    expect(arg.data.action.rankSampleImpressions).toBe(15000)
    expect(arg.data.action.currentAvgRank).toBeCloseTo(7.6666, 2)
    expect(arg.data.severity).toBe("info")
    expect(arg.data.reason).toContain("광고그룹 평균 순위")
    expect(arg.data.reason).toContain("광고그룹 2개 키워드")
    expect(arg.data.reason).toContain("최근 6시간 가중평균")
    expect(arg.data.reason).toContain("15,000")
  })

  it("대표 키워드 — 노출 TOP 1 (Estimate 호출이 그 키워드로 발동)", async () => {
    mockAdGroupFindMany.mockResolvedValue([
      {
        id: "ag_b",
        nccAdgroupId: "ncc_ag_b",
        name: "광고그룹 B",
        bidAmt: 500,
        keywords: [
          // kw_b1: imp 1000 (TOP 아님)
          { id: "kw_b1", nccKeywordId: "ncc_kw_b1", keyword: "낮은노출", recentAvgRnk: 8 },
          // kw_b2: imp 50000 (TOP — 대표 키워드)
          { id: "kw_b2", nccKeywordId: "ncc_kw_b2", keyword: "대표키워드", recentAvgRnk: 7 },
          // kw_b3: imp 5000
          { id: "kw_b3", nccKeywordId: "ncc_kw_b3", keyword: "중간노출", recentAvgRnk: 9 },
        ],
      },
    ])
    mockStatHourlyFindMany.mockResolvedValue([
      { refId: "ncc_kw_b1", impressions: 1000, recentAvgRnk: 8 },
      { refId: "ncc_kw_b2", impressions: 50000, recentAvgRnk: 7 },
      { refId: "ncc_kw_b3", impressions: 5000, recentAvgRnk: 9 },
    ])
    mockGetCachedAveragePositionBid.mockResolvedValue({
      data: [
        { keyword: "대표키워드", position: 1, bid: 3000 },
        { keyword: "대표키워드", position: 5, bid: 1500 },
      ],
      cachedAll: false,
    })

    await GET(makeReq("Bearer test-secret") as never)

    // Estimate 호출 인자 — 대표 키워드 = kw_b2.
    // BID_RANK_DEVICE_SCOPE 기본 'BOTH' → PC + MOBILE 둘 다 호출.
    expect(mockGetCachedAveragePositionBid).toHaveBeenCalled()
    const adgroupEstimateCalls = mockGetCachedAveragePositionBid.mock.calls.filter(
      (c) => c[0].keywordId === "kw_b2",
    )
    expect(adgroupEstimateCalls).toHaveLength(2)
    const pcCall = adgroupEstimateCalls.find((c) => c[0].device === "PC")
    const mobileCall = adgroupEstimateCalls.find((c) => c[0].device === "MOBILE")
    expect(pcCall).toBeTruthy()
    expect(mobileCall).toBeTruthy()
    const estArgs = pcCall![0]
    expect(estArgs.advertiserId).toBe("adv_1")
    expect(estArgs.customerId).toBe("1234567")
    expect(estArgs.keywordText).toBe("대표키워드")
    expect(estArgs.device).toBe("PC")
    expect(mobileCall![0].keywordText).toBe("대표키워드")
    expect(mobileCall![0].device).toBe("MOBILE")
  })

  it("StatHourly 데이터 없음 → fallback (last non-null 단순 평균, rankWindowHours=null)", async () => {
    mockAdGroupFindMany.mockResolvedValue([
      {
        id: "ag_c",
        nccAdgroupId: "ncc_ag_c",
        name: "광고그룹 C",
        bidAmt: 500,
        keywords: [
          // last non-null 평균 = (8+6)/2 = 7 > target=5
          { id: "kw_c1", nccKeywordId: "ncc_kw_c1", keyword: "키워드1", recentAvgRnk: 8 },
          { id: "kw_c2", nccKeywordId: "ncc_kw_c2", keyword: "키워드2", recentAvgRnk: 6 },
        ],
      },
    ])
    // 가중평균 산출 데이터 없음 → fallback.
    mockStatHourlyFindMany.mockResolvedValue([])
    mockGetCachedAveragePositionBid.mockResolvedValue({
      data: [
        { keyword: "키워드1", position: 1, bid: 3000 },
        { keyword: "키워드1", position: 5, bid: 1500 },
      ],
      cachedAll: false,
    })

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.adgroupRankCreated).toBe(1)
    expect(body.adgroupRankWeightedSourceCount).toBe(0)
    expect(body.adgroupRankFallbackSourceCount).toBe(1)

    const adgroupCreates = mockBidSuggestionCreate.mock.calls.filter(
      (c) =>
        c[0].data.engineSource === "bid" &&
        c[0].data.scope === "adgroup" &&
        c[0].data.adgroupId === "ag_c",
    )
    expect(adgroupCreates).toHaveLength(1)
    const arg = adgroupCreates[0][0]
    expect(arg.data.action.rankWindowHours).toBeNull()
    expect(arg.data.action.rankSampleImpressions).toBeNull()
    // last non-null 단순 평균 7
    expect(arg.data.action.currentAvgRank).toBe(7)
    expect(arg.data.reason).toContain("최근 1시간 측정값 단순 평균")
    expect(arg.data.reason).toContain("광고그룹 2개 키워드")
  })

  it("Estimate throw → adgroupRankEstimateFailed=1 (cron 진행 계속)", async () => {
    mockAdGroupFindMany.mockResolvedValue([
      {
        id: "ag_d",
        nccAdgroupId: "ncc_ag_d",
        name: "광고그룹 D",
        bidAmt: 500,
        keywords: [
          { id: "kw_d1", nccKeywordId: "ncc_kw_d1", keyword: "키워드1", recentAvgRnk: 9 },
        ],
      },
    ])
    mockStatHourlyFindMany.mockResolvedValue([])
    mockGetCachedAveragePositionBid.mockRejectedValue(
      new Error("naver-sa rate limit"),
    )

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.adgroupRankCandidatesScanned).toBe(1)
    expect(body.adgroupRankEstimateFailed).toBe(1)
    expect(body.adgroupRankCreated).toBe(0)
    expect(body.errors).toEqual([])
  })

  it("기존 adgroup_default_bid_update pending 권고 → update 덮어쓰기 (adgroupRankUpdated=1)", async () => {
    mockAdGroupFindMany.mockResolvedValue([
      {
        id: "ag_e",
        nccAdgroupId: "ncc_ag_e",
        name: "광고그룹 E",
        bidAmt: 500,
        keywords: [
          { id: "kw_e1", nccKeywordId: "ncc_kw_e1", keyword: "키워드1", recentAvgRnk: 8 },
        ],
      },
    ])
    mockStatHourlyFindMany.mockResolvedValue([])
    mockGetCachedAveragePositionBid.mockResolvedValue({
      data: [{ keyword: "키워드1", position: 5, bid: 1500 }],
      cachedAll: false,
    })
    // 같은 광고그룹의 기존 adgroup_default_bid_update pending 1건 — findFirst 가 반환.
    mockBidSuggestionFindFirst.mockImplementation(
      (args: { where: { adgroupId?: string; scope?: string; action?: { equals?: string } } }) => {
        if (
          args.where.adgroupId === "ag_e" &&
          args.where.scope === "adgroup" &&
          args.where.action?.equals === "adgroup_default_bid_update"
        ) {
          return Promise.resolve({ id: "s_existing_adgroup" })
        }
        return Promise.resolve(null)
      },
    )

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.adgroupRankCreated).toBe(0)
    expect(body.adgroupRankUpdated).toBe(1)

    const adgroupUpdates = mockBidSuggestionUpdate.mock.calls.filter(
      (c) => c[0].where.id === "s_existing_adgroup",
    )
    expect(adgroupUpdates).toHaveLength(1)
    const upd = adgroupUpdates[0][0]
    expect(upd.data.action.kind).toBe("adgroup_default_bid_update")
    expect(upd.data.action.reasonCode).toBe("adgroup_below_target_rank")
    expect(upd.data.targetName).toBe("광고그룹 E")
    expect(upd.data.affectedCount).toBe(1)
  })

  it("stale 정리 (W4) — handled 외 광고그룹의 adgroup_below_target_rank pending dismiss", async () => {
    // 후보 SQL 0건 — handledAdgroupIds=[].
    mockAdGroupFindMany.mockResolvedValue([])
    mockStatHourlyFindMany.mockResolvedValue([])

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    // mockBidSuggestionUpdateMany 기본 { count: 1 } — adgroup stale dismiss 1건 카운트.
    expect(body.adgroupRankStaleDismissed).toBeGreaterThanOrEqual(1)

    // updateMany 호출 인자 — adgroup stale dismiss 만 필터.
    const staleCalls = mockBidSuggestionUpdateMany.mock.calls.filter((c) => {
      const where = c[0]?.where
      return (
        where?.engineSource === "bid" &&
        where?.scope === "adgroup" &&
        where?.action?.path?.[0] === "reasonCode" &&
        where?.action?.equals === "adgroup_below_target_rank"
      )
    })
    expect(staleCalls).toHaveLength(1)
    const staleCall = staleCalls[0][0]
    expect(staleCall.where.action.equals).toBe("adgroup_below_target_rank")
    expect(staleCall.where.status).toBe("pending")
    expect(staleCall.where.scope).toBe("adgroup")
    expect(staleCall.where.advertiserId).toBe("adv_1")
    // handled 0 → notIn: []
    expect(staleCall.where.adgroupId.notIn).toEqual([])
    expect(staleCall.data).toEqual({ status: "dismissed" })
  })

  it("marginal 묶음 supersede 보호 — keyword_bid_bundle 만 dismiss / adgroup_default_bid_update 보존", async () => {
    // bid 엔진 진입 가능하도록 keyword level stat + Keyword 매핑 채움 (묶음 흐름 활성).
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
                revenue: 600_000,
              },
              _avg: { avgRnk: null },
            })),
          )
        }
        return Promise.resolve([])
      },
    )
    mockKeywordFindMany.mockImplementation(
      (args: { where?: { OR?: unknown; nccKeywordId?: unknown } }) => {
        // marginal 매핑 호출 — nccKeywordId.in
        if (args?.where?.nccKeywordId) {
          return Promise.resolve(
            Array.from({ length: 5 }, (_, i) => ({
              id: `kw_${i}`,
              nccKeywordId: `ncc_kw_${i}`,
              bidAmt: 1000,
              useGroupBidAmt: false,
              userLock: false,
              adgroup: { id: "ag_super_1", name: "광고그룹 A" },
            })),
          )
        }
        return Promise.resolve([])
      },
    )
    // 묶음 supersede 가 enable 되도록 marginal mock 을 actual 로 교체.
    const actual = await vi.importActual<
      typeof import("@/lib/auto-bidding/marginal-score")
    >("@/lib/auto-bidding/marginal-score")
    ;(mockedDecideMarginal as unknown as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockImplementation(actual.decideMarginalSuggestion)
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

    await GET(makeReq("Bearer test-secret") as never)

    // 묶음 supersede 호출 — where.action.path[0]='kind' AND equals='keyword_bid_bundle'.
    const supersedeCalls = mockBidSuggestionUpdateMany.mock.calls.filter((c) => {
      const where = c[0]?.where
      return (
        where?.scope === "adgroup" &&
        where?.engineSource === "bid" &&
        where?.action?.path?.[0] === "kind" &&
        where?.action?.equals === "keyword_bid_bundle"
      )
    })
    expect(supersedeCalls).toHaveLength(1)
    const args = supersedeCalls[0][0]
    expect(args.where.action.path).toEqual(["kind"])
    expect(args.where.action.equals).toBe("keyword_bid_bundle")
    expect(args.data.status).toBe("dismissed")
    expect(args.data.reason).toBe("superseded_by_new_bundle")

    // adgroup_default_bid_update 행은 별도 stale 흐름으로 처리 — 봉인용 supersede 는 영향 없음.
    // 확인: kind='adgroup_default_bid_update' equals 가 있는 updateMany 호출은 없어야 함
    // (stale 정리는 reasonCode='adgroup_below_target_rank' 매칭).
    const wrongSupersede = mockBidSuggestionUpdateMany.mock.calls.filter((c) => {
      const where = c[0]?.where
      return (
        where?.scope === "adgroup" &&
        where?.action?.path?.[0] === "kind" &&
        where?.action?.equals === "adgroup_default_bid_update"
      )
    })
    expect(wrongSupersede).toHaveLength(0)
  })
})

// =============================================================================
// MOBILE Estimate 확장 — BID_RANK_DEVICE_SCOPE='BOTH' (기본)
// =============================================================================
//
// 정책: PC + MOBILE 둘 다 호출 → max(pcBid, mobileBid) 적용.
// 측정값(StatHourly) 은 device='ALL' 만 적재 가능 (네이버 SA 한계) — 본 테스트 비대상.
// PC throw → 키워드/광고그룹 1건 흡수. MOBILE 만 throw → PC 결과로 진행 (가용성 우선).
// BID_RANK_DEVICE_SCOPE 토글은 module-level const 라 vi.stubEnv 후 재import 필요 — 1차 PR 비대상.

describe("cron bid-suggest — MOBILE Estimate 확장 (키워드)", () => {
  beforeEach(() => {
    mockKeywordPerformanceProfileFindUnique.mockResolvedValue({
      dataDays: 28,
      avgCtr: null,
      avgCvr: null,
      avgCpc: null,
    })
    mockCampaignFindMany.mockResolvedValue([])
    mockStatDailyGroupBy.mockImplementation(() => Promise.resolve([]))
    mockKeywordFindMany.mockImplementation(
      (args: { where?: { OR?: unknown } }) => {
        if (args?.where?.OR) {
          return Promise.resolve([
            {
              id: "kw_mobile_1",
              nccKeywordId: "ncc_kw_mobile_1",
              keyword: "신발",
              bidAmt: 1000,
              recentAvgRnk: 8,
              adgroup: {
                id: "ag_m",
                name: "광고그룹 M",
                campaign: { advertiserId: "adv_1" },
              },
            },
          ])
        }
        return Promise.resolve([])
      },
    )
  })

  it("BOTH 모드 (기본) — PC + MOBILE 둘 다 호출, max 정책으로 권고 생성", async () => {
    // PC: position=5 bid=1500. MOBILE: position=5 bid=1800. → max=1800 (MOBILE).
    mockGetCachedAveragePositionBid.mockImplementation(
      (args: { device: "PC" | "MOBILE" }) => {
        if (args.device === "PC") {
          return Promise.resolve({
            data: [
              { keyword: "신발", position: 1, bid: 3000 },
              { keyword: "신발", position: 5, bid: 1500 },
            ],
            cachedAll: false,
          })
        }
        return Promise.resolve({
          data: [
            { keyword: "신발", position: 1, bid: 3500 },
            { keyword: "신발", position: 5, bid: 1800 },
          ],
          cachedAll: false,
        })
      },
    )

    const res = await GET(makeReq("Bearer test-secret") as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.rankCreated).toBe(1)

    // PC + MOBILE 둘 다 호출됐는지 device 인자 검증.
    const devices = mockGetCachedAveragePositionBid.mock.calls
      .map((c) => c[0].device)
      .sort()
    expect(devices).toContain("PC")
    expect(devices).toContain("MOBILE")
    expect(
      mockGetCachedAveragePositionBid.mock.calls.filter(
        (c) => c[0].keywordId === "kw_mobile_1",
      ),
    ).toHaveLength(2)

    // BidSuggestion action — max 정책 (MOBILE 1800 채택), selectedDevice='MOBILE'.
    const create = mockBidSuggestionCreate.mock.calls.find(
      (c) =>
        c[0].data.engineSource === "bid" &&
        c[0].data.keywordId === "kw_mobile_1",
    )
    expect(create).toBeTruthy()
    const action = create![0].data.action
    expect(action.suggestedBid).toBe(1800)
    expect(action.selectedDevice).toBe("MOBILE")
    expect(action.estimatedBidPc).toBe(1500)
    expect(action.estimatedBidMobile).toBe(1800)
  })

  it("PC throw → 키워드 1건 흡수 (rankEstimateFailed=1, MOBILE 호출 안 함)", async () => {
    mockGetCachedAveragePositionBid.mockImplementation(
      (args: { device: "PC" | "MOBILE" }) => {
        if (args.device === "PC") return Promise.reject(new Error("PC fail"))
        return Promise.resolve({
          data: [{ keyword: "신발", position: 5, bid: 1800 }],
          cachedAll: false,
        })
      },
    )

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.rankEstimateFailed).toBe(1)
    expect(body.rankCreated).toBe(0)

    // PC throw → MOBILE 호출 진입 안 함 (continue).
    const mobileCalls = mockGetCachedAveragePositionBid.mock.calls.filter(
      (c) => c[0].device === "MOBILE",
    )
    expect(mobileCalls).toHaveLength(0)
  })

  it("MOBILE throw → PC 만으로 진행 (rankEstimateFailed=0, 권고 생성 + console.warn)", async () => {
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined)

    mockGetCachedAveragePositionBid.mockImplementation(
      (args: { device: "PC" | "MOBILE" }) => {
        if (args.device === "PC") {
          return Promise.resolve({
            data: [{ keyword: "신발", position: 5, bid: 1500 }],
            cachedAll: false,
          })
        }
        return Promise.reject(new Error("MOBILE fail"))
      },
    )

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    // PC 호출만 정상 — rankEstimateFailed 는 PC throw 카운트 (1차 PR 통합)
    expect(body.rankEstimateFailed).toBe(0)
    expect(body.rankCreated).toBe(1)

    // 권고 — PC 1500 채택, selectedDevice='PC', estimatedBidMobile=null.
    const create = mockBidSuggestionCreate.mock.calls.find(
      (c) =>
        c[0].data.engineSource === "bid" &&
        c[0].data.keywordId === "kw_mobile_1",
    )
    expect(create).toBeTruthy()
    const action = create![0].data.action
    expect(action.suggestedBid).toBe(1500)
    expect(action.selectedDevice).toBe("PC")
    expect(action.estimatedBidPc).toBe(1500)
    expect(action.estimatedBidMobile).toBeNull()

    // console.warn 호출 — MOBILE failed 로그 (시크릿 마스킹 통과 후 출력).
    const warnCalls = consoleWarnSpy.mock.calls.filter((c) =>
      typeof c[0] === "string" && c[0].includes("MOBILE"),
    )
    expect(warnCalls.length).toBeGreaterThan(0)

    consoleWarnSpy.mockRestore()
  })

  it("PC + MOBILE 둘 다 정상 + 동일 bid → selectedDevice='BOTH'", async () => {
    mockGetCachedAveragePositionBid.mockImplementation(() =>
      Promise.resolve({
        data: [{ keyword: "신발", position: 5, bid: 1500 }],
        cachedAll: false,
      }),
    )

    await GET(makeReq("Bearer test-secret") as never)

    const create = mockBidSuggestionCreate.mock.calls.find(
      (c) =>
        c[0].data.engineSource === "bid" &&
        c[0].data.keywordId === "kw_mobile_1",
    )
    expect(create).toBeTruthy()
    const action = create![0].data.action
    expect(action.suggestedBid).toBe(1500)
    expect(action.selectedDevice).toBe("BOTH")
    expect(action.estimatedBidPc).toBe(1500)
    expect(action.estimatedBidMobile).toBe(1500)
  })
})

describe("cron bid-suggest — MOBILE Estimate 확장 (광고그룹)", () => {
  beforeEach(() => {
    mockKeywordPerformanceProfileFindUnique.mockResolvedValue({
      dataDays: 28,
      avgCtr: null,
      avgCvr: null,
      avgCpc: null,
    })
    mockCampaignFindMany.mockResolvedValue([])
    mockStatDailyGroupBy.mockImplementation(() => Promise.resolve([]))
    mockAdGroupFindMany.mockResolvedValue([
      {
        id: "ag_mobile",
        nccAdgroupId: "ncc_ag_mobile",
        name: "광고그룹 MOBILE",
        bidAmt: 800,
        keywords: [
          {
            id: "kw_rep",
            nccKeywordId: "ncc_kw_rep",
            keyword: "대표키워드",
            recentAvgRnk: 7,
          },
        ],
      },
    ])
  })

  it("광고그룹 권고도 PC + MOBILE 둘 다 호출, max 정책으로 권고 생성", async () => {
    mockGetCachedAveragePositionBid.mockImplementation(
      (args: { device: "PC" | "MOBILE" }) => {
        if (args.device === "PC") {
          return Promise.resolve({
            data: [{ keyword: "대표키워드", position: 5, bid: 1200 }],
            cachedAll: false,
          })
        }
        return Promise.resolve({
          data: [{ keyword: "대표키워드", position: 5, bid: 1500 }],
          cachedAll: false,
        })
      },
    )

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.adgroupRankCreated).toBe(1)

    // 대표 키워드 = kw_rep — PC + MOBILE 둘 다 호출.
    const repCalls = mockGetCachedAveragePositionBid.mock.calls.filter(
      (c) => c[0].keywordId === "kw_rep",
    )
    expect(repCalls).toHaveLength(2)
    const pcCall = repCalls.find((c) => c[0].device === "PC")
    const mobileCall = repCalls.find((c) => c[0].device === "MOBILE")
    expect(pcCall).toBeTruthy()
    expect(mobileCall).toBeTruthy()

    // 광고그룹 BidSuggestion action — max 1500 (MOBILE), selectedDevice='MOBILE'.
    const adgroupCreate = mockBidSuggestionCreate.mock.calls.find(
      (c) =>
        c[0].data.scope === "adgroup" &&
        c[0].data.action?.kind === "adgroup_default_bid_update",
    )
    expect(adgroupCreate).toBeTruthy()
    const action = adgroupCreate![0].data.action
    expect(action.suggestedBid).toBe(1500)
    expect(action.selectedDevice).toBe("MOBILE")
    expect(action.estimatedBidPc).toBe(1200)
    expect(action.estimatedBidMobile).toBe(1500)
  })

  it("광고그룹 — MOBILE throw → PC 만으로 진행 (estimateFailed=0)", async () => {
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined)

    mockGetCachedAveragePositionBid.mockImplementation(
      (args: { device: "PC" | "MOBILE" }) => {
        if (args.device === "PC") {
          return Promise.resolve({
            data: [{ keyword: "대표키워드", position: 5, bid: 1500 }],
            cachedAll: false,
          })
        }
        return Promise.reject(new Error("MOBILE fail"))
      },
    )

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.adgroupRankEstimateFailed).toBe(0)
    expect(body.adgroupRankCreated).toBe(1)

    const adgroupCreate = mockBidSuggestionCreate.mock.calls.find(
      (c) =>
        c[0].data.scope === "adgroup" &&
        c[0].data.action?.kind === "adgroup_default_bid_update",
    )
    expect(adgroupCreate).toBeTruthy()
    const action = adgroupCreate![0].data.action
    expect(action.selectedDevice).toBe("PC")
    expect(action.estimatedBidPc).toBe(1500)
    expect(action.estimatedBidMobile).toBeNull()

    consoleWarnSpy.mockRestore()
  })

  it("광고그룹 — PC throw → 광고그룹 1건 흡수 (adgroupRankEstimateFailed=1)", async () => {
    mockGetCachedAveragePositionBid.mockImplementation(
      (args: { device: "PC" | "MOBILE" }) => {
        if (args.device === "PC") return Promise.reject(new Error("PC fail"))
        return Promise.resolve({
          data: [{ keyword: "대표키워드", position: 5, bid: 1500 }],
          cachedAll: false,
        })
      },
    )

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.adgroupRankEstimateFailed).toBe(1)
    expect(body.adgroupRankCreated).toBe(0)

    // PC throw → MOBILE 호출 진입 안 함.
    const mobileCalls = mockGetCachedAveragePositionBid.mock.calls.filter(
      (c) => c[0].keywordId === "kw_rep" && c[0].device === "MOBILE",
    )
    expect(mobileCalls).toHaveLength(0)
  })
})
