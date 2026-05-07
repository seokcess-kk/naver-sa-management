/**
 * lib/batch/apply.ts — applySyncKeywordsAdgroup 분기 단위 테스트.
 *
 * 검증 범위:
 *   A. applyChange(item with targetType='AdGroup') → applySyncKeywordsAdgroup 라우팅
 *   B. listKeywords(customerId, { nccAdgroupId }) 호출 + 응답 키워드 upsert
 *   C. 응답 nccAdgroupId 가 다른 row → skip 카운트 (정상 케이스 X 가드)
 *   D. dbAdgroupId 미존재 → throw
 *   E. 광고주 일치 검증 실패 (campaign.advertiserId mismatch) → throw
 *   F. nccAdgroupId drift (item.targetId vs DB nccAdgroupId mismatch) → throw
 *   G. syncSummary 반환 shape (syncedKeywords / skipped)
 *
 * 외부 호출 0 — 모든 prisma / naver-sa 메서드 mock.
 */

import { describe, it, expect, beforeEach, vi } from "vitest"

// =============================================================================
// Mocks
// =============================================================================

const mockListKeywords = vi.fn()

vi.mock("@/lib/naver-sa/keywords", () => ({
  listKeywords: (...args: unknown[]) => mockListKeywords(...args),
  createKeywords: vi.fn(),
  updateKeywordsBulk: vi.fn(),
}))

// 자격증명 resolver side-effect 등록은 import 자체에 있음 — credentials.ts 를 빈 모듈로 stub.
vi.mock("@/lib/naver-sa/credentials", () => ({}))

const mockAdGroupFindUnique = vi.fn()
const mockKeywordUpsert = vi.fn()

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    adGroup: {
      findUnique: (...args: unknown[]) => mockAdGroupFindUnique(...args),
    },
    keyword: {
      upsert: (...args: unknown[]) => mockKeywordUpsert(...args),
      // 다른 호출 차단 — 본 테스트는 sync_keywords 분기만
      findFirst: vi.fn().mockRejectedValue(
        new Error("unexpected keyword.findFirst"),
      ),
      findUnique: vi.fn().mockRejectedValue(
        new Error("unexpected keyword.findUnique"),
      ),
      update: vi.fn().mockRejectedValue(new Error("unexpected keyword.update")),
    },
  },
}))

// =============================================================================
// 본체 import
// =============================================================================

import { applyChange } from "@/lib/batch/apply"

// =============================================================================
// 공통 setup
// =============================================================================

const NCC_ADGROUP = "ncc_a"
const DB_ADGROUP = "ag_db_1"
const CUSTOMER_ID = "c-1"
const ADV_ID = "adv_1"

type Item = Parameters<typeof applyChange>[0]

function buildItem(overrides: Partial<Record<string, unknown>> = {}): Item {
  return {
    id: "item_1",
    batchId: "batch_1",
    targetType: "AdGroup",
    targetId: NCC_ADGROUP,
    before: null,
    after: {
      customerId: CUSTOMER_ID,
      dbAdgroupId: DB_ADGROUP,
      advertiserId: ADV_ID,
    },
    status: "pending",
    error: null,
    idempotencyKey: `batch_1:${NCC_ADGROUP}`,
    attempt: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Item
}

beforeEach(() => {
  vi.clearAllMocks()

  mockAdGroupFindUnique.mockResolvedValue({
    id: DB_ADGROUP,
    nccAdgroupId: NCC_ADGROUP,
    campaign: { advertiserId: ADV_ID },
  })
  mockKeywordUpsert.mockImplementation(async ({ create }) => ({
    id: "kw_db_1",
    nccKeywordId: create.nccKeywordId,
  }))
})

// =============================================================================
// Tests
// =============================================================================

describe("applyChange (targetType='AdGroup') — sync_keywords 라우팅", () => {
  it("listKeywords 호출 + 키워드 upsert + syncSummary 반환", async () => {
    mockListKeywords.mockResolvedValue([
      {
        nccKeywordId: "kw_1",
        nccAdgroupId: NCC_ADGROUP,
        keyword: "신발",
        bidAmt: 500,
        useGroupBidAmt: false,
        userLock: false,
        matchType: "EXACT",
        recentAvgRnk: 3.2,
        inspectStatus: "APPROVED",
      },
      {
        nccKeywordId: "kw_2",
        nccAdgroupId: NCC_ADGROUP,
        keyword: "런닝화",
        bidAmt: 400,
        useGroupBidAmt: true,
        userLock: false,
        matchType: "PHRASE",
        inspectStatus: "UNDER_REVIEW",
      },
    ])

    const item = buildItem()
    const result = await applyChange(item)

    // listKeywords(customerId, { nccAdgroupId }) 정확 호출
    expect(mockListKeywords).toHaveBeenCalledTimes(1)
    expect(mockListKeywords).toHaveBeenCalledWith(CUSTOMER_ID, {
      nccAdgroupId: NCC_ADGROUP,
    })

    // upsert 2건 호출
    expect(mockKeywordUpsert).toHaveBeenCalledTimes(2)
    const firstCall = mockKeywordUpsert.mock.calls[0][0] as {
      where: { nccKeywordId: string }
      create: { adgroupId: string; nccKeywordId: string; matchType: string }
      update: Record<string, unknown>
    }
    expect(firstCall.where.nccKeywordId).toBe("kw_1")
    expect(firstCall.create.adgroupId).toBe(DB_ADGROUP)
    expect(firstCall.create.matchType).toBe("EXACT")

    // syncSummary 반환
    expect(result.syncSummary).toEqual({
      syncedKeywords: 2,
      skipped: 0,
    })
  })

  it("응답 nccAdgroupId 가 요청과 다르면 skip 카운트", async () => {
    mockListKeywords.mockResolvedValue([
      {
        nccKeywordId: "kw_1",
        nccAdgroupId: NCC_ADGROUP, // OK
        keyword: "ok-row",
        inspectStatus: "APPROVED",
      },
      {
        nccKeywordId: "kw_2",
        nccAdgroupId: "ncc_other", // mismatch → skip
        keyword: "skip-row",
        inspectStatus: "APPROVED",
      },
    ])

    const item = buildItem()
    const result = await applyChange(item)

    // upsert 는 1건만
    expect(mockKeywordUpsert).toHaveBeenCalledTimes(1)
    expect(result.syncSummary).toEqual({
      syncedKeywords: 1,
      skipped: 1,
    })
  })

  it("dbAdgroupId 미존재 → throw (시간차 deleted 가드)", async () => {
    mockAdGroupFindUnique.mockResolvedValue(null)

    await expect(applyChange(buildItem())).rejects.toThrow(/광고그룹 미존재/)
    expect(mockListKeywords).not.toHaveBeenCalled()
    expect(mockKeywordUpsert).not.toHaveBeenCalled()
  })

  it("광고주 일치 검증 실패 → throw (광고주 횡단 가드)", async () => {
    mockAdGroupFindUnique.mockResolvedValue({
      id: DB_ADGROUP,
      nccAdgroupId: NCC_ADGROUP,
      campaign: { advertiserId: "OTHER_ADV" },
    })

    await expect(applyChange(buildItem())).rejects.toThrow(/광고주 일치/)
    expect(mockListKeywords).not.toHaveBeenCalled()
  })

  it("nccAdgroupId drift (item.targetId vs DB) → throw", async () => {
    mockAdGroupFindUnique.mockResolvedValue({
      id: DB_ADGROUP,
      nccAdgroupId: "ncc_drifted",
      campaign: { advertiserId: ADV_ID },
    })

    await expect(applyChange(buildItem())).rejects.toThrow(/drift/)
    expect(mockListKeywords).not.toHaveBeenCalled()
  })

  it("after 누락(customerId) → throw", async () => {
    const item = buildItem({
      after: {
        // customerId 누락
        dbAdgroupId: DB_ADGROUP,
        advertiserId: ADV_ID,
      },
    })
    await expect(applyChange(item)).rejects.toThrow(/customerId/)
    expect(mockAdGroupFindUnique).not.toHaveBeenCalled()
  })

  it("targetId(nccAdgroupId) 누락 → throw", async () => {
    const item = buildItem({ targetId: null })
    await expect(applyChange(item)).rejects.toThrow(/targetId/)
  })

  it("listKeywords 빈 응답 → upsert 0건 + syncSummary {0,0}", async () => {
    mockListKeywords.mockResolvedValue([])

    const result = await applyChange(buildItem())
    expect(mockKeywordUpsert).not.toHaveBeenCalled()
    expect(result.syncSummary).toEqual({ syncedKeywords: 0, skipped: 0 })
  })
})
