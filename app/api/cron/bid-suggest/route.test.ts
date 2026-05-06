/**
 * bid-suggest cron — budget suggestion coverage.
 *
 * 외부 호출 0:
 *   - @/lib/db/prisma mock
 *   - marginal bid decision mock (budget 테스트에서는 bid 엔진 비진입)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockAdvertiserFindMany = vi.fn()
const mockBidAutomationConfigFindUnique = vi.fn()
const mockKeywordPerformanceProfileFindUnique = vi.fn()
const mockBiddingPolicyFindMany = vi.fn()
const mockStatDailyGroupBy = vi.fn()
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

vi.mock("@/lib/auto-bidding/marginal-score", () => ({
  decideMarginalSuggestion: vi.fn(() => ({
    decision: "hold",
    reason: "low_confidence_data",
  })),
}))

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
