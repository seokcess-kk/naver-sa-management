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
const mockBidSuggestionUpdateMany = vi.fn()

const mockKeywordFindMany = vi.fn()

const mockChangeBatchCreate = vi.fn()
const mockChangeBatchUpdate = vi.fn()

const mockChangeItemCreateMany = vi.fn()

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    bidSuggestion: {
      findMany: (...args: unknown[]) => mockBidSuggestionFindMany(...args),
      updateMany: (...args: unknown[]) =>
        mockBidSuggestionUpdateMany(...args),
    },
    keyword: {
      findMany: (...args: unknown[]) => mockKeywordFindMany(...args),
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

  it("invalid_keyword_state — 잠금/삭제/그룹입찰가 행은 사전 실패", async () => {
    mockBidSuggestionFindMany.mockResolvedValue([
      {
        id: "s_lock",
        keywordId: "kw_locked",
        action: { currentBid: 800, suggestedBid: 920, deltaPct: 15, direction: "up" },
        reason: "x",
        severity: "info",
      },
      {
        id: "s_del",
        keywordId: "kw_del",
        action: { currentBid: 700, suggestedBid: 805, deltaPct: 15, direction: "up" },
        reason: "x",
        severity: "info",
      },
      {
        id: "s_group",
        keywordId: "kw_group",
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
