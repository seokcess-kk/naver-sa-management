/**
 * F-11.4 Phase B.3 — bid-inbox Server Actions 단위 테스트
 *
 * 검증 범위:
 *   A. listBidSuggestions       — 광고주 격리 / engineSource 필터 / shape (ISO)
 *   B. approveBidSuggestions    — viewer 차단 / 빈 입력 거부 / 사전 실패(invalid_keyword_state)
 *                                 / happy path (ChangeBatch + ChangeItem 적재 / suggestion applied)
 *                                 / 광고주 횡단 차단 (다른 광고주 ID 무시)
 *   C. dismissBidSuggestions    — viewer 차단 / 정상 dismiss / 광고주 격리
 *
 * 외부 호출 0:
 *   - vi.mock("@/lib/auth/access")   — getCurrentAdvertiser stub
 *   - vi.mock("@/lib/db/prisma")     — bidSuggestion / keyword / changeBatch / changeItem stub
 *   - vi.mock("@/lib/audit/log")     — logAudit stub
 *   - vi.mock("next/cache")          — revalidatePath stub
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// =============================================================================
// Mocks
// =============================================================================

const mockGetCurrentAdvertiser = vi.fn()

vi.mock("@/lib/auth/access", () => ({
  getCurrentAdvertiser: (...args: unknown[]) =>
    mockGetCurrentAdvertiser(...args),
}))

const mockBidSuggestionFindMany = vi.fn()
const mockBidSuggestionFindFirst = vi.fn()
const mockBidSuggestionUpdateMany = vi.fn()

const mockKeywordFindMany = vi.fn()
const mockTargetingRuleFindUnique = vi.fn()
const mockTargetingRuleUpsert = vi.fn()
const mockCampaignFindMany = vi.fn()
const mockCampaignUpdate = vi.fn()

const mockChangeBatchCreate = vi.fn()
const mockChangeBatchUpdate = vi.fn()

const mockChangeItemCreateMany = vi.fn()

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    bidSuggestion: {
      findMany: (...args: unknown[]) => mockBidSuggestionFindMany(...args),
      findFirst: (...args: unknown[]) => mockBidSuggestionFindFirst(...args),
      updateMany: (...args: unknown[]) =>
        mockBidSuggestionUpdateMany(...args),
    },
    keyword: {
      findMany: (...args: unknown[]) => mockKeywordFindMany(...args),
    },
    targetingRule: {
      findUnique: (...args: unknown[]) => mockTargetingRuleFindUnique(...args),
      upsert: (...args: unknown[]) => mockTargetingRuleUpsert(...args),
    },
    campaign: {
      findMany: (...args: unknown[]) => mockCampaignFindMany(...args),
      update: (...args: unknown[]) => mockCampaignUpdate(...args),
    },
    changeBatch: {
      create: (...args: unknown[]) => mockChangeBatchCreate(...args),
      update: (...args: unknown[]) => mockChangeBatchUpdate(...args),
    },
    changeItem: {
      createMany: (...args: unknown[]) => mockChangeItemCreateMany(...args),
    },
  },
}))

const mockUpdateCampaignsBulk = vi.fn()
vi.mock("@/lib/naver-sa/campaigns", () => ({
  updateCampaignsBulk: (...args: unknown[]) =>
    mockUpdateCampaignsBulk(...args),
}))

const mockLogAudit = vi.fn()
vi.mock("@/lib/audit/log", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}))

const mockRevalidatePath = vi.fn()
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}))

// import 본체 — mock 등록 이후
import {
  approveBidSuggestions,
  approveBundleSuggestion,
  dismissBidSuggestions,
  listBidSuggestions,
} from "@/app/(dashboard)/[advertiserId]/bid-inbox/actions"

// =============================================================================
// 공통 setup
// =============================================================================

const ADV_ID = "adv_1"
const USER_ID = "u_op"
const CUSTOMER_ID = "1234"

function setRole(role: "admin" | "operator" | "viewer"): void {
  mockGetCurrentAdvertiser.mockResolvedValue({
    advertiser: {
      id: ADV_ID,
      customerId: CUSTOMER_ID,
      name: "Adv",
      status: "active",
      hasKeys: true,
    },
    user: { id: USER_ID, role },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // 기본: operator
  setRole("operator")
  mockChangeBatchCreate.mockResolvedValue({ id: "batch_1" })
  mockChangeItemCreateMany.mockResolvedValue({ count: 0 })
  mockBidSuggestionUpdateMany.mockResolvedValue({ count: 0 })
  mockTargetingRuleFindUnique.mockResolvedValue(null)
  mockTargetingRuleUpsert.mockResolvedValue({
    id: "tr_1",
    enabled: true,
    defaultWeight: 1,
    hourWeights: {},
  })
  mockCampaignFindMany.mockResolvedValue([])
  mockCampaignUpdate.mockResolvedValue({})
  mockUpdateCampaignsBulk.mockResolvedValue([])
})

afterEach(() => {
  vi.clearAllMocks()
})

// =============================================================================
// A. listBidSuggestions
// =============================================================================

describe("listBidSuggestions", () => {
  it("광고주 + status='pending' + expiresAt > now 한정 조회", async () => {
    mockBidSuggestionFindMany.mockResolvedValue([])
    const r = await listBidSuggestions(ADV_ID)
    expect(r.ok).toBe(true)
    const args = mockBidSuggestionFindMany.mock.calls[0]?.[0]
    expect(args.where.advertiserId).toBe(ADV_ID)
    expect(args.where.status).toBe("pending")
    expect(args.where.expiresAt).toEqual({ gt: expect.any(Date) })
  })

  it("engineSource 필터 'bid' 시 where 에 반영", async () => {
    mockBidSuggestionFindMany.mockResolvedValue([])
    await listBidSuggestions(ADV_ID, { engineSource: "bid" })
    const args = mockBidSuggestionFindMany.mock.calls[0]?.[0]
    expect(args.where.engineSource).toBe("bid")
  })

  it("engineSource='all' 시 where 에 engineSource 미포함", async () => {
    mockBidSuggestionFindMany.mockResolvedValue([])
    await listBidSuggestions(ADV_ID, { engineSource: "all" })
    const args = mockBidSuggestionFindMany.mock.calls[0]?.[0]
    expect(args.where.engineSource).toBeUndefined()
  })

  it("Date / shape 직렬화 — keyword join 결과 매핑", async () => {
    const now = new Date("2026-05-01T00:00:00Z")
    mockBidSuggestionFindMany.mockResolvedValue([
      {
        id: "s1",
        engineSource: "bid",
        severity: "info",
        reason: "ROAS 좋음",
        action: { currentBid: 1000, suggestedBid: 1150, deltaPct: 15, direction: "up" },
        createdAt: now,
        expiresAt: now,
        keyword: {
          id: "kw1",
          nccKeywordId: "ncc_kw_1",
          keyword: "테스트",
          matchType: "EXACT",
          bidAmt: 1000,
          useGroupBidAmt: false,
          userLock: false,
          status: "on",
          adgroup: { name: "ag1", campaign: { name: "cam1" } },
        },
      },
    ])
    const r = await listBidSuggestions(ADV_ID)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data).toHaveLength(1)
    const row = r.data[0]
    expect(row.id).toBe("s1")
    expect(row.createdAt).toBe(now.toISOString())
    expect(row.keyword?.text).toBe("테스트")
    expect(row.keyword?.adgroupName).toBe("ag1")
    expect(row.action.deltaPct).toBe(15)
  })
})

// =============================================================================
// B. approveBidSuggestions
// =============================================================================

describe("approveBidSuggestions", () => {
  it("viewer 차단", async () => {
    setRole("viewer")
    const r = await approveBidSuggestions(ADV_ID, ["s1"])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/권한 부족/)
    expect(mockChangeBatchCreate).not.toHaveBeenCalled()
  })

  it("빈 입력 배열 거부 (Zod min(1))", async () => {
    const r = await approveBidSuggestions(ADV_ID, [])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/잘못된 입력/)
    expect(mockChangeBatchCreate).not.toHaveBeenCalled()
  })

  it("pending suggestion 0개 시 실패 응답", async () => {
    mockBidSuggestionFindMany.mockResolvedValue([])
    const r = await approveBidSuggestions(ADV_ID, ["s1"])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/유효한 pending suggestion/)
    expect(mockChangeBatchCreate).not.toHaveBeenCalled()
  })

  it("happy path — ChangeBatch + ChangeItem 1건 (UPDATE shape) + suggestion applied", async () => {
    mockBidSuggestionFindMany.mockResolvedValue([
      {
        id: "s1",
        keywordId: "kw1",
        engineSource: "bid",
        action: {
          currentBid: 1000,
          suggestedBid: 1150,
          deltaPct: 15,
          direction: "up",
        },
        reason: "ROAS 여유",
        severity: "info",
      },
    ])
    mockKeywordFindMany.mockResolvedValue([
      {
        id: "kw1",
        nccKeywordId: "ncc_kw_1",
        bidAmt: 1000,
        useGroupBidAmt: false,
        userLock: false,
        status: "on",
      },
    ])
    mockChangeBatchCreate.mockResolvedValue({ id: "batch_xyz" })
    mockBidSuggestionUpdateMany.mockResolvedValue({ count: 1 })

    const r = await approveBidSuggestions(ADV_ID, ["s1"])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.batchId).toBe("batch_xyz")
    expect(r.data.count).toBe(1)
    expect(r.data.preFailed).toBe(0)
    expect(r.data.enqueued).toBe(1)

    // ChangeBatch action 검증
    const batchArgs = mockChangeBatchCreate.mock.calls[0]?.[0]
    expect(batchArgs.data.action).toBe("bid_inbox.apply")
    expect(batchArgs.data.total).toBe(1)
    expect(batchArgs.data.userId).toBe(USER_ID)

    // ChangeItem shape 검증 (apply.ts 호환)
    const itemArgs = mockChangeItemCreateMany.mock.calls[0]?.[0]
    expect(itemArgs.data).toHaveLength(1)
    const seed = itemArgs.data[0]
    expect(seed.targetType).toBe("Keyword")
    expect(seed.targetId).toBe("ncc_kw_1")
    expect(seed.status).toBe("pending")
    expect(seed.after.operation).toBe("UPDATE")
    expect(seed.after.customerId).toBe(CUSTOMER_ID)
    expect(seed.after.nccKeywordId).toBe("ncc_kw_1")
    expect(seed.after.fields).toBe("bidAmt,useGroupBidAmt")
    expect(seed.after.patch.bidAmt).toBe(1150)
    expect(seed.after.patch.useGroupBidAmt).toBe(false)
    expect(seed.before.bidAmt).toBe(1000)

    // suggestion applied 마킹
    const updArgs = mockBidSuggestionUpdateMany.mock.calls[0]?.[0]
    expect(updArgs.where.id.in).toEqual(["s1"])
    expect(updArgs.where.advertiserId).toBe(ADV_ID)
    expect(updArgs.data.status).toBe("applied")
    expect(updArgs.data.appliedBatchId).toBe("batch_xyz")

    // AuditLog
    expect(mockLogAudit).toHaveBeenCalled()
    const auditArgs = mockLogAudit.mock.calls[0]?.[0]
    expect(auditArgs.action).toBe("bid_inbox.approve")
    expect(auditArgs.targetId).toBe("batch_xyz")
  })

  it("quality OFF 권고 — ChangeItem OFF shape 으로 적재", async () => {
    mockBidSuggestionFindMany.mockResolvedValue([
      {
        id: "s_quality",
        keywordId: "kw1",
        engineSource: "quality",
        action: {
          kind: "off",
          reasonCode: "low_ctr_14d",
          metrics: { impressions14d: 1000, clicks14d: 1, cost14d: 12000 },
        },
        reason: "14일 CTR 낮음 — OFF 권고",
        severity: "warn",
      },
    ])
    mockKeywordFindMany.mockResolvedValue([
      {
        id: "kw1",
        nccKeywordId: "ncc_kw_1",
        bidAmt: 1000,
        useGroupBidAmt: true,
        userLock: false,
        status: "on",
      },
    ])
    mockChangeBatchCreate.mockResolvedValue({ id: "batch_quality" })
    mockBidSuggestionUpdateMany.mockResolvedValue({ count: 1 })

    const r = await approveBidSuggestions(ADV_ID, ["s_quality"])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.preFailed).toBe(0)
    expect(r.data.enqueued).toBe(1)

    const itemArgs = mockChangeItemCreateMany.mock.calls[0]?.[0]
    expect(itemArgs.data).toHaveLength(1)
    const seed = itemArgs.data[0]
    expect(seed.targetType).toBe("Keyword")
    expect(seed.targetId).toBe("ncc_kw_1")
    expect(seed.status).toBe("pending")
    expect(seed.before.userLock).toBe(false)
    expect(seed.before.reasonCode).toBe("low_ctr_14d")
    expect(seed.after.operation).toBe("OFF")
    expect(seed.after.customerId).toBe(CUSTOMER_ID)
    expect(seed.after.nccKeywordId).toBe("ncc_kw_1")
    expect(seed.after.suggestionId).toBe("s_quality")
  })

  it("targeting 권고 — TargetingRule 갱신 후 done ChangeItem 적재", async () => {
    mockBidSuggestionFindMany.mockResolvedValue([
      {
        id: "s_targeting",
        keywordId: null,
        engineSource: "targeting",
        action: {
          kind: "hour_weights_recommendation",
          buckets: {
            weekday_morning: {
              recommendedWeight: 1.25,
              hasSignal: true,
              ctr: 2.1,
            },
            evening: {
              recommendedWeight: 0.8,
              hasSignal: false,
              ctr: 0.9,
            },
          },
        },
        reason: "28일 CTR 비교 — 권장 가중치: 평일 오전 1.25x",
        severity: "info",
      },
    ])
    mockKeywordFindMany.mockResolvedValue([])
    mockTargetingRuleFindUnique.mockResolvedValue({
      id: "tr_existing",
      enabled: true,
      defaultWeight: 1,
      hourWeights: { "mon-0": 0.9 },
    })
    mockTargetingRuleUpsert.mockResolvedValue({
      id: "tr_existing",
      enabled: true,
      defaultWeight: 1,
      hourWeights: { "mon-0": 0.9, "mon-9": 1.25, "fri-12": 1.25 },
    })
    mockChangeBatchCreate.mockResolvedValue({ id: "batch_targeting" })
    mockBidSuggestionUpdateMany.mockResolvedValue({ count: 1 })

    const r = await approveBidSuggestions(ADV_ID, ["s_targeting"])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.preFailed).toBe(0)
    expect(r.data.enqueued).toBe(0)

    const upsertArgs = mockTargetingRuleUpsert.mock.calls[0]?.[0]
    expect(upsertArgs.where.advertiserId).toBe(ADV_ID)
    expect(upsertArgs.update.enabled).toBe(true)
    expect(upsertArgs.update.hourWeights["mon-9"]).toBe(1.25)
    expect(upsertArgs.update.hourWeights["fri-12"]).toBe(1.25)
    expect(upsertArgs.update.hourWeights["mon-0"]).toBe(0.9)

    const itemArgs = mockChangeItemCreateMany.mock.calls[0]?.[0]
    const seed = itemArgs.data[0]
    expect(seed.targetType).toBe("TargetingRule")
    expect(seed.targetId).toBe("tr_existing")
    expect(seed.status).toBe("done")
    expect(seed.after.suggestionId).toBe("s_targeting")
    expect(seed.after.applied.appliedBuckets.weekday_morning).toBe(1.25)

    const batchUpd = mockChangeBatchUpdate.mock.calls[0]?.[0]
    expect(batchUpd.data.status).toBe("done")
    expect(batchUpd.data.processed).toBe(1)
  })

  it("budget 권고 — 캠페인 일예산 수정 후 done ChangeItem 적재", async () => {
    mockBidSuggestionFindMany.mockResolvedValue([
      {
        id: "s_budget",
        keywordId: null,
        engineSource: "budget",
        action: {
          kind: "campaign_budget_update",
          items: [
            {
              campaignId: "camp_1",
              currentDailyBudget: 100000,
              suggestedDailyBudget: 120000,
              reasonCode: "pacing_fast",
            },
          ],
        },
        reason: "예산 소진 속도를 맞추기 위한 일예산 조정",
        severity: "warn",
      },
    ])
    mockKeywordFindMany.mockResolvedValue([])
    mockCampaignFindMany.mockResolvedValue([
      {
        id: "camp_1",
        nccCampaignId: "ncc_cmp_1",
        name: "브랜드 캠페인",
        dailyBudget: 100000,
        status: "on",
      },
    ])
    mockUpdateCampaignsBulk.mockResolvedValue([
      {
        nccCampaignId: "ncc_cmp_1",
        customerId: CUSTOMER_ID,
        name: "브랜드 캠페인",
        dailyBudget: 120000,
      },
    ])
    mockChangeBatchCreate.mockResolvedValue({ id: "batch_budget" })
    mockBidSuggestionUpdateMany.mockResolvedValue({ count: 1 })

    const r = await approveBidSuggestions(ADV_ID, ["s_budget"])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.preFailed).toBe(0)
    expect(r.data.enqueued).toBe(0)

    expect(mockUpdateCampaignsBulk).toHaveBeenCalledWith(
      CUSTOMER_ID,
      [{ nccCampaignId: "ncc_cmp_1", dailyBudget: 120000 }],
      "dailyBudget",
    )
    expect(mockCampaignUpdate).toHaveBeenCalledWith({
      where: { id: "camp_1" },
      data: {
        dailyBudget: 120000,
        raw: expect.objectContaining({ nccCampaignId: "ncc_cmp_1" }),
      },
    })

    const itemArgs = mockChangeItemCreateMany.mock.calls[0]?.[0]
    const seed = itemArgs.data[0]
    expect(seed.targetType).toBe("Campaign")
    expect(seed.targetId).toBe("ncc_cmp_1")
    expect(seed.status).toBe("done")
    expect(seed.before.dailyBudget).toBe(100000)
    expect(seed.after.suggestionId).toBe("s_budget")
    expect(seed.after.fields).toBe("dailyBudget")
    expect(seed.after.dailyBudget).toBe(120000)

    const batchUpd = mockChangeBatchUpdate.mock.calls[0]?.[0]
    expect(batchUpd.data.status).toBe("done")
    expect(batchUpd.data.processed).toBe(1)
  })

  it("invalid_keyword_state — 잠금/삭제/그룹입찰가 행은 사전 실패", async () => {
    mockBidSuggestionFindMany.mockResolvedValue([
      {
        id: "s_lock",
        keywordId: "kw_locked",
        engineSource: "bid",
        action: { currentBid: 800, suggestedBid: 920, deltaPct: 15, direction: "up" },
        reason: "x",
        severity: "info",
      },
      {
        id: "s_del",
        keywordId: "kw_del",
        engineSource: "bid",
        action: { currentBid: 700, suggestedBid: 805, deltaPct: 15, direction: "up" },
        reason: "x",
        severity: "info",
      },
      {
        id: "s_group",
        keywordId: "kw_group",
        engineSource: "bid",
        action: { currentBid: 500, suggestedBid: 575, deltaPct: 15, direction: "up" },
        reason: "x",
        severity: "info",
      },
    ])
    mockKeywordFindMany.mockResolvedValue([
      {
        id: "kw_locked",
        nccKeywordId: "ncc_lock",
        bidAmt: 800,
        useGroupBidAmt: false,
        userLock: true,
        status: "off",
      },
      {
        id: "kw_del",
        nccKeywordId: "ncc_del",
        bidAmt: 700,
        useGroupBidAmt: false,
        userLock: false,
        status: "deleted",
      },
      {
        id: "kw_group",
        nccKeywordId: "ncc_group",
        bidAmt: 500,
        useGroupBidAmt: true,
        userLock: false,
        status: "on",
      },
    ])
    mockChangeBatchCreate.mockResolvedValue({ id: "batch_pre" })
    mockBidSuggestionUpdateMany.mockResolvedValue({ count: 3 })

    const r = await approveBidSuggestions(ADV_ID, ["s_lock", "s_del", "s_group"])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.preFailed).toBe(3)
    expect(r.data.enqueued).toBe(0)

    // 모든 ChangeItem 이 status='failed'
    const itemArgs = mockChangeItemCreateMany.mock.calls[0]?.[0]
    expect(itemArgs.data).toHaveLength(3)
    for (const seed of itemArgs.data) {
      expect(seed.status).toBe("failed")
      expect(seed.error).toBe("invalid_keyword_state")
    }

    // 모든 enqueue 0 → ChangeBatch 즉시 failed 마킹
    expect(mockChangeBatchUpdate).toHaveBeenCalled()
    const batchUpd = mockChangeBatchUpdate.mock.calls[0]?.[0]
    expect(batchUpd.data.status).toBe("failed")
  })

  it("키워드 미존재 (다른 광고주) — keyword_not_found 사전 실패", async () => {
    mockBidSuggestionFindMany.mockResolvedValue([
      {
        id: "s1",
        keywordId: "kw_other_adv",
        engineSource: "bid",
        action: { currentBid: 1000, suggestedBid: 1150, deltaPct: 15, direction: "up" },
        reason: "x",
        severity: "info",
      },
    ])
    // findMany 가 광고주 한정 — 다른 광고주 소속 키워드는 빈 배열 반환
    mockKeywordFindMany.mockResolvedValue([])
    mockChangeBatchCreate.mockResolvedValue({ id: "batch_x" })
    mockBidSuggestionUpdateMany.mockResolvedValue({ count: 1 })

    const r = await approveBidSuggestions(ADV_ID, ["s1"])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.preFailed).toBe(1)

    const itemArgs = mockChangeItemCreateMany.mock.calls[0]?.[0]
    expect(itemArgs.data[0].status).toBe("failed")
    expect(itemArgs.data[0].error).toBe("keyword_not_found")
  })

  it("API 키 미입력 광고주 차단", async () => {
    mockGetCurrentAdvertiser.mockResolvedValue({
      advertiser: {
        id: ADV_ID,
        customerId: CUSTOMER_ID,
        name: "Adv",
        status: "active",
        hasKeys: false,
      },
      user: { id: USER_ID, role: "operator" },
    })
    const r = await approveBidSuggestions(ADV_ID, ["s1"])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/API 키/)
    expect(mockChangeBatchCreate).not.toHaveBeenCalled()
  })
})

// =============================================================================
// C. dismissBidSuggestions
// =============================================================================

describe("dismissBidSuggestions", () => {
  it("viewer 차단", async () => {
    setRole("viewer")
    const r = await dismissBidSuggestions(ADV_ID, ["s1"])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/권한 부족/)
  })

  it("빈 입력 거부", async () => {
    const r = await dismissBidSuggestions(ADV_ID, [])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/잘못된 입력/)
  })

  it("정상 dismiss — updateMany 광고주+pending 한정", async () => {
    mockBidSuggestionUpdateMany.mockResolvedValue({ count: 2 })
    const r = await dismissBidSuggestions(ADV_ID, ["s1", "s2"])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.count).toBe(2)

    const args = mockBidSuggestionUpdateMany.mock.calls[0]?.[0]
    expect(args.where.advertiserId).toBe(ADV_ID)
    expect(args.where.status).toBe("pending")
    expect(args.where.id.in.sort()).toEqual(["s1", "s2"])
    expect(args.data.status).toBe("dismissed")

    expect(mockLogAudit).toHaveBeenCalled()
    const auditArgs = mockLogAudit.mock.calls[0]?.[0]
    expect(auditArgs.action).toBe("bid_inbox.dismiss")
  })
})

// =============================================================================
// D. approveBundleSuggestion — 묶음 권고 (scope='adgroup') 적용
// =============================================================================

describe("approveBundleSuggestion", () => {
  const SUGGESTION_ID = "sug_bundle"
  const FUTURE_EXPIRES = new Date(Date.now() + 24 * 60 * 60 * 1000)

  /** 5개 키워드 묶음 권고 — 기본 happy path baseline. */
  function makeBundleSuggestion(overrides?: Partial<{
    scope: string
    status: string
    engineSource: string
    expiresAt: Date | null
    items: Array<{ keywordId: string; beforeBid: number; afterBid: number }>
  }>) {
    const items = overrides?.items ?? [
      { keywordId: "kw1", beforeBid: 1000, afterBid: 1150 },
      { keywordId: "kw2", beforeBid: 800, afterBid: 920 },
      { keywordId: "kw3", beforeBid: 600, afterBid: 690 },
      { keywordId: "kw4", beforeBid: 500, afterBid: 575 },
      { keywordId: "kw5", beforeBid: 400, afterBid: 460 },
    ]
    return {
      id: SUGGESTION_ID,
      engineSource: overrides?.engineSource ?? "bid",
      scope: overrides?.scope ?? "adgroup",
      status: overrides?.status ?? "pending",
      reason: "테스트 묶음 권고",
      severity: "warn",
      action: {
        kind: "keyword_bid_bundle",
        adgroupId: "ag1",
        direction: "up",
        reasonCode: "test_bundle",
        avgDeltaPct: 15,
        itemCount: items.length,
      },
      itemsJson: items,
      affectedCount: items.length,
      expiresAt:
        overrides?.expiresAt === null
          ? null
          : (overrides?.expiresAt ?? FUTURE_EXPIRES),
      targetName: "ag1",
    }
  }

  /** 키워드 5개 — 모두 정상 (drift / locked / already-applied 없음). */
  function makeKeywords() {
    return [
      { id: "kw1", nccKeywordId: "ncc_1", bidAmt: 1000, useGroupBidAmt: false, userLock: false, status: "on", adgroupId: "ag1" },
      { id: "kw2", nccKeywordId: "ncc_2", bidAmt: 800, useGroupBidAmt: false, userLock: false, status: "on", adgroupId: "ag1" },
      { id: "kw3", nccKeywordId: "ncc_3", bidAmt: 600, useGroupBidAmt: false, userLock: false, status: "on", adgroupId: "ag1" },
      { id: "kw4", nccKeywordId: "ncc_4", bidAmt: 500, useGroupBidAmt: false, userLock: false, status: "on", adgroupId: "ag1" },
      { id: "kw5", nccKeywordId: "ncc_5", bidAmt: 400, useGroupBidAmt: false, userLock: false, status: "on", adgroupId: "ag1" },
    ]
  }

  beforeEach(() => {
    mockChangeBatchCreate.mockResolvedValue({ id: "batch_bundle" })
    mockBidSuggestionUpdateMany.mockResolvedValue({ count: 1 })
  })

  it("happy path — items=5 / all selected / drift 0 → applied=5, skipped=0", async () => {
    mockBidSuggestionFindFirst.mockResolvedValue(makeBundleSuggestion())
    mockKeywordFindMany.mockResolvedValue(makeKeywords())

    const r = await approveBundleSuggestion({
      advertiserId: ADV_ID,
      suggestionId: SUGGESTION_ID,
      selectedKeywordIds: ["kw1", "kw2", "kw3", "kw4", "kw5"],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.applied).toBe(5)
    expect(r.data.skippedDrift).toBe(0)
    expect(r.data.skippedAlreadyApplied).toBe(0)
    expect(r.data.skippedLocked).toBe(0)
    expect(r.data.batchId).toBe("batch_bundle")

    // ChangeBatch
    const batchArgs = mockChangeBatchCreate.mock.calls[0]?.[0]
    expect(batchArgs.data.action).toBe("bid_inbox.apply")
    expect(batchArgs.data.total).toBe(5)
    expect(batchArgs.data.summary.bundle).toBe(true)
    expect(batchArgs.data.summary.suggestionId).toBe(SUGGESTION_ID)

    // ChangeItem 5개
    const itemArgs = mockChangeItemCreateMany.mock.calls[0]?.[0]
    expect(itemArgs.data).toHaveLength(5)
    const seed = itemArgs.data[0]
    expect(seed.targetType).toBe("Keyword")
    expect(seed.status).toBe("pending")
    expect(seed.after.operation).toBe("UPDATE")
    expect(seed.after.fields).toBe("bidAmt,useGroupBidAmt")
    expect(seed.after.patch.bidAmt).toBe(1150)
    expect(seed.after.patch.useGroupBidAmt).toBe(false)
    expect(seed.idempotencyKey).toBe(`bundle:${SUGGESTION_ID}:keyword:kw1`)
    expect(seed.after.bundle).toBe(true)

    // BidSuggestion applied
    const updArgs = mockBidSuggestionUpdateMany.mock.calls[0]?.[0]
    expect(updArgs.data.status).toBe("applied")
    expect(updArgs.data.appliedBatchId).toBe("batch_bundle")

    // AuditLog
    const auditArgs = mockLogAudit.mock.calls[0]?.[0]
    expect(auditArgs.action).toBe("bid_inbox.bundle_apply")
    expect(auditArgs.targetId).toBe("batch_bundle")
    expect(auditArgs.after.applied).toBe(5)
  })

  it("partial select — items=5, selected=3 → applied=3", async () => {
    mockBidSuggestionFindFirst.mockResolvedValue(makeBundleSuggestion())
    mockKeywordFindMany.mockResolvedValue(makeKeywords())

    const r = await approveBundleSuggestion({
      advertiserId: ADV_ID,
      suggestionId: SUGGESTION_ID,
      selectedKeywordIds: ["kw1", "kw3", "kw5"],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.applied).toBe(3)
    expect(r.data.skippedDrift).toBe(0)
    expect(r.data.skippedAlreadyApplied).toBe(0)
    expect(r.data.skippedLocked).toBe(0)

    // findMany 호출 인자 — selected 3개만 조회
    const kwArgs = mockKeywordFindMany.mock.calls[0]?.[0]
    expect(kwArgs.where.id.in.sort()).toEqual(["kw1", "kw3", "kw5"])

    const itemArgs = mockChangeItemCreateMany.mock.calls[0]?.[0]
    expect(itemArgs.data).toHaveLength(3)
  })

  it("drift — currentBid !== beforeBid && !== afterBid → skippedDrift=1", async () => {
    mockBidSuggestionFindFirst.mockResolvedValue(makeBundleSuggestion())
    const kws = makeKeywords()
    // kw2 의 현재 입찰가가 묶음 생성 시점(800)/권고(920) 둘 다 아님
    kws[1].bidAmt = 850
    mockKeywordFindMany.mockResolvedValue(kws)

    const r = await approveBundleSuggestion({
      advertiserId: ADV_ID,
      suggestionId: SUGGESTION_ID,
      selectedKeywordIds: ["kw1", "kw2", "kw3", "kw4", "kw5"],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.applied).toBe(4)
    expect(r.data.skippedDrift).toBe(1)
    expect(r.data.skippedAlreadyApplied).toBe(0)
    expect(r.data.skippedLocked).toBe(0)

    const itemArgs = mockChangeItemCreateMany.mock.calls[0]?.[0]
    // kw2 가 ChangeItem 에 포함되지 않아야 함
    const targetIds = itemArgs.data.map((d: { targetId: string }) => d.targetId)
    expect(targetIds).not.toContain("ncc_2")
    expect(targetIds.sort()).toEqual(["ncc_1", "ncc_3", "ncc_4", "ncc_5"])
  })

  it("already applied — currentBid === afterBid → skippedAlreadyApplied=1", async () => {
    mockBidSuggestionFindFirst.mockResolvedValue(makeBundleSuggestion())
    const kws = makeKeywords()
    // kw3 의 현재 입찰가가 이미 권고값(690)
    kws[2].bidAmt = 690
    mockKeywordFindMany.mockResolvedValue(kws)

    const r = await approveBundleSuggestion({
      advertiserId: ADV_ID,
      suggestionId: SUGGESTION_ID,
      selectedKeywordIds: ["kw1", "kw2", "kw3", "kw4", "kw5"],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.applied).toBe(4)
    expect(r.data.skippedAlreadyApplied).toBe(1)
    expect(r.data.skippedDrift).toBe(0)
    expect(r.data.skippedLocked).toBe(0)
  })

  it("locked — userLock=true → skippedLocked=1", async () => {
    mockBidSuggestionFindFirst.mockResolvedValue(makeBundleSuggestion())
    const kws = makeKeywords()
    kws[0].userLock = true
    mockKeywordFindMany.mockResolvedValue(kws)

    const r = await approveBundleSuggestion({
      advertiserId: ADV_ID,
      suggestionId: SUGGESTION_ID,
      selectedKeywordIds: ["kw1", "kw2", "kw3", "kw4", "kw5"],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.applied).toBe(4)
    expect(r.data.skippedLocked).toBe(1)
    expect(r.data.skippedDrift).toBe(0)
    expect(r.data.skippedAlreadyApplied).toBe(0)
  })

  it("locked — status='deleted' → skippedLocked=1", async () => {
    mockBidSuggestionFindFirst.mockResolvedValue(makeBundleSuggestion())
    const kws = makeKeywords()
    kws[0].status = "deleted"
    mockKeywordFindMany.mockResolvedValue(kws)

    const r = await approveBundleSuggestion({
      advertiserId: ADV_ID,
      suggestionId: SUGGESTION_ID,
      selectedKeywordIds: ["kw1", "kw2", "kw3", "kw4", "kw5"],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.applied).toBe(4)
    expect(r.data.skippedLocked).toBe(1)
  })

  it("selectedKeywordIds 가 itemsJson 셋의 부분집합 아님 → error", async () => {
    mockBidSuggestionFindFirst.mockResolvedValue(makeBundleSuggestion())

    const r = await approveBundleSuggestion({
      advertiserId: ADV_ID,
      suggestionId: SUGGESTION_ID,
      selectedKeywordIds: ["kw1", "kw_not_in_set"],
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/묶음 셋에 포함되지 않/)
    expect(mockChangeBatchCreate).not.toHaveBeenCalled()
  })

  it("scope='keyword' 권고는 거부 (단건 흐름 전용)", async () => {
    mockBidSuggestionFindFirst.mockResolvedValue(
      makeBundleSuggestion({ scope: "keyword" }),
    )

    const r = await approveBundleSuggestion({
      advertiserId: ADV_ID,
      suggestionId: SUGGESTION_ID,
      selectedKeywordIds: ["kw1"],
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/scope='adgroup'/)
    expect(mockChangeBatchCreate).not.toHaveBeenCalled()
  })

  it("status !== 'pending' 권고는 거부", async () => {
    mockBidSuggestionFindFirst.mockResolvedValue(
      makeBundleSuggestion({ status: "applied" }),
    )

    const r = await approveBundleSuggestion({
      advertiserId: ADV_ID,
      suggestionId: SUGGESTION_ID,
      selectedKeywordIds: ["kw1"],
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/pending/)
    expect(mockChangeBatchCreate).not.toHaveBeenCalled()
  })

  it("BidSuggestion 미존재 → error", async () => {
    mockBidSuggestionFindFirst.mockResolvedValue(null)

    const r = await approveBundleSuggestion({
      advertiserId: ADV_ID,
      suggestionId: SUGGESTION_ID,
      selectedKeywordIds: ["kw1"],
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/찾을 수 없/)
    expect(mockChangeBatchCreate).not.toHaveBeenCalled()
  })

  it("viewer 차단", async () => {
    setRole("viewer")

    const r = await approveBundleSuggestion({
      advertiserId: ADV_ID,
      suggestionId: SUGGESTION_ID,
      selectedKeywordIds: ["kw1"],
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/권한 부족/)
    expect(mockBidSuggestionFindFirst).not.toHaveBeenCalled()
    expect(mockChangeBatchCreate).not.toHaveBeenCalled()
  })

  it("API 키 미입력 광고주 차단", async () => {
    mockGetCurrentAdvertiser.mockResolvedValue({
      advertiser: {
        id: ADV_ID,
        customerId: CUSTOMER_ID,
        name: "Adv",
        status: "active",
        hasKeys: false,
      },
      user: { id: USER_ID, role: "operator" },
    })

    const r = await approveBundleSuggestion({
      advertiserId: ADV_ID,
      suggestionId: SUGGESTION_ID,
      selectedKeywordIds: ["kw1"],
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/API 키/)
    expect(mockBidSuggestionFindFirst).not.toHaveBeenCalled()
  })

  it("Keyword 광고주 횡단 — findMany 결과 공집합 시 모두 skippedLocked", async () => {
    mockBidSuggestionFindFirst.mockResolvedValue(makeBundleSuggestion())
    // 다른 광고주 소속 — findMany (advertiserId 한정) 결과 빈 배열
    mockKeywordFindMany.mockResolvedValue([])

    const r = await approveBundleSuggestion({
      advertiserId: ADV_ID,
      suggestionId: SUGGESTION_ID,
      selectedKeywordIds: ["kw1", "kw2", "kw3", "kw4", "kw5"],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.applied).toBe(0)
    expect(r.data.skippedLocked).toBe(5)

    // applied=0 → ChangeItem 미적재 + ChangeBatch 즉시 done 마킹
    expect(mockChangeItemCreateMany).not.toHaveBeenCalled()
    expect(mockChangeBatchUpdate).toHaveBeenCalled()
    const batchUpd = mockChangeBatchUpdate.mock.calls[0]?.[0]
    expect(batchUpd.data.status).toBe("done")
  })

  it("만료된 권고 거부", async () => {
    mockBidSuggestionFindFirst.mockResolvedValue(
      makeBundleSuggestion({
        expiresAt: new Date(Date.now() - 60 * 1000),
      }),
    )

    const r = await approveBundleSuggestion({
      advertiserId: ADV_ID,
      suggestionId: SUGGESTION_ID,
      selectedKeywordIds: ["kw1"],
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/만료/)
    expect(mockChangeBatchCreate).not.toHaveBeenCalled()
  })
})
