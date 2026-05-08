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

const mockUpdateAdgroup = vi.fn()
vi.mock("@/lib/naver-sa/adgroups", () => ({
  updateAdgroup: (...args: unknown[]) => mockUpdateAdgroup(...args),
}))

// 자격증명 resolver side-effect 등록은 import 자체에 있음 — credentials.ts 를 빈 모듈로 stub.
vi.mock("@/lib/naver-sa/credentials", () => ({}))

const mockAdGroupFindUnique = vi.fn()
const mockAdGroupUpdate = vi.fn()
const mockKeywordUpsert = vi.fn()

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    adGroup: {
      findUnique: (...args: unknown[]) => mockAdGroupFindUnique(...args),
      update: (...args: unknown[]) => mockAdGroupUpdate(...args),
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
  mockAdGroupUpdate.mockResolvedValue({
    id: DB_ADGROUP,
    nccAdgroupId: NCC_ADGROUP,
    bidAmt: 750,
  })
  mockUpdateAdgroup.mockResolvedValue({
    nccAdgroupId: NCC_ADGROUP,
    bidAmt: 750,
  })
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

// =============================================================================
// applyAdgroupBidUpdate (Phase 2B 광고그룹 입찰가 적용) 테스트
// =============================================================================
//
// 검증 범위:
//   1. 정상 — updateAdgroup PUT + adGroup.update 호출 인자 검증
//   2. invalid bidAmt (음수/0/NaN/문자열) → throw
//   3. missing customerId → throw
//   4. missing nccAdgroupId → throw
//   5. 회귀 — operation 미지정 케이스는 여전히 sync_keywords 흐름 진입

describe("applyChange (targetType='AdGroup' + operation='UPDATE' + fields='bidAmt')", () => {
  const NEW_BID = 750
  const DB_AG_ID = "ag_db_2"

  function buildBidUpdateItem(overrides: Partial<Record<string, unknown>> = {}): Item {
    return {
      id: "item_bid",
      batchId: "batch_bid",
      targetType: "AdGroup",
      targetId: DB_AG_ID, // DB id (actions.ts 가 적재)
      before: {
        bidAmt: 500,
        nccAdgroupId: NCC_ADGROUP,
      },
      after: {
        operation: "UPDATE",
        fields: "bidAmt",
        customerId: CUSTOMER_ID,
        nccAdgroupId: NCC_ADGROUP,
        bidAmt: NEW_BID,
        suggestionId: "s_ag",
        suggestionReason: "광고그룹 평균 노출 7.2 → 목표 5",
      },
      status: "pending",
      error: null,
      idempotencyKey: "batch_bid:s_ag",
      attempt: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as Item
  }

  it("정상 — updateAdgroup PUT + adGroup.update DB 갱신", async () => {
    const item = buildBidUpdateItem()
    const result = await applyChange(item)

    // SA PUT
    expect(mockUpdateAdgroup).toHaveBeenCalledTimes(1)
    expect(mockUpdateAdgroup).toHaveBeenCalledWith(
      CUSTOMER_ID,
      NCC_ADGROUP,
      { bidAmt: NEW_BID },
      "bidAmt",
    )

    // DB update — id 기반 (DB id), data.bidAmt
    expect(mockAdGroupUpdate).toHaveBeenCalledTimes(1)
    expect(mockAdGroupUpdate).toHaveBeenCalledWith({
      where: { id: DB_AG_ID },
      data: { bidAmt: NEW_BID },
    })

    // sync_keywords 분기와 무관 — listKeywords / keyword upsert 미호출
    expect(mockListKeywords).not.toHaveBeenCalled()
    expect(mockKeywordUpsert).not.toHaveBeenCalled()

    // 빈 결과 (syncSummary / nccKeywordId 없음)
    expect(result).toEqual({})
  })

  it("invalid bidAmt — 음수 → throw", async () => {
    const item = buildBidUpdateItem({
      after: {
        operation: "UPDATE",
        fields: "bidAmt",
        customerId: CUSTOMER_ID,
        nccAdgroupId: NCC_ADGROUP,
        bidAmt: -100,
      },
    })
    await expect(applyChange(item)).rejects.toThrow(/invalid_after_payload: bidAmt/)
    expect(mockUpdateAdgroup).not.toHaveBeenCalled()
    expect(mockAdGroupUpdate).not.toHaveBeenCalled()
  })

  it("invalid bidAmt — 0 → throw", async () => {
    const item = buildBidUpdateItem({
      after: {
        operation: "UPDATE",
        fields: "bidAmt",
        customerId: CUSTOMER_ID,
        nccAdgroupId: NCC_ADGROUP,
        bidAmt: 0,
      },
    })
    await expect(applyChange(item)).rejects.toThrow(/invalid_after_payload: bidAmt/)
    expect(mockUpdateAdgroup).not.toHaveBeenCalled()
  })

  it("invalid bidAmt — NaN/문자열 → throw", async () => {
    const item = buildBidUpdateItem({
      after: {
        operation: "UPDATE",
        fields: "bidAmt",
        customerId: CUSTOMER_ID,
        nccAdgroupId: NCC_ADGROUP,
        bidAmt: "not_a_number",
      },
    })
    await expect(applyChange(item)).rejects.toThrow(/invalid_after_payload: bidAmt/)
    expect(mockUpdateAdgroup).not.toHaveBeenCalled()
  })

  it("missing customerId → throw", async () => {
    const item = buildBidUpdateItem({
      after: {
        operation: "UPDATE",
        fields: "bidAmt",
        // customerId 누락
        nccAdgroupId: NCC_ADGROUP,
        bidAmt: NEW_BID,
      },
    })
    await expect(applyChange(item)).rejects.toThrow(
      /invalid_after_payload: missing customerId/,
    )
    expect(mockUpdateAdgroup).not.toHaveBeenCalled()
    expect(mockAdGroupUpdate).not.toHaveBeenCalled()
  })

  it("missing nccAdgroupId → throw", async () => {
    const item = buildBidUpdateItem({
      after: {
        operation: "UPDATE",
        fields: "bidAmt",
        customerId: CUSTOMER_ID,
        // nccAdgroupId 누락
        bidAmt: NEW_BID,
      },
    })
    await expect(applyChange(item)).rejects.toThrow(
      /invalid_after_payload: missing nccAdgroupId/,
    )
    expect(mockUpdateAdgroup).not.toHaveBeenCalled()
    expect(mockAdGroupUpdate).not.toHaveBeenCalled()
  })

  it("회귀 — AdGroup 분기에 operation 부재 시 여전히 sync_keywords 진입", async () => {
    // operation 미지정 케이스 — sync_keywords 분기로 라우팅 확인
    mockListKeywords.mockResolvedValue([])
    const item = buildItem() // 기존 헬퍼 (after.operation 없음)
    await applyChange(item)

    // sync_keywords 가 호출됨 — listKeywords 호출
    expect(mockListKeywords).toHaveBeenCalledTimes(1)
    // bid update 함수는 호출되지 않음
    expect(mockUpdateAdgroup).not.toHaveBeenCalled()
    expect(mockAdGroupUpdate).not.toHaveBeenCalled()
  })
})
