/**
 * F-3.1 syncKeywords enqueue (ChangeBatch + ChangeItem) 단위 테스트.
 *
 * 검증 범위:
 *   A. 광고그룹 0개 → batchId=null, total=0, ChangeBatch 미생성
 *   B. 광고그룹 N개 → ChangeBatch (action='sync_keywords') + ChangeItem N건 createMany
 *   C. 캠페인 필터 적용 → adGroup.findMany where 에 campaign.id IN [...] 반영
 *   D. hasKeys=false → 즉시 차단
 *
 * 외부 호출 0:
 *   - vi.mock("@/lib/auth/access", ...)        — getCurrentAdvertiser stub
 *   - vi.mock("@/lib/db/prisma", ...)          — adGroup.findMany / changeBatch.create / changeItem.createMany stub
 *   - vi.mock("@/lib/audit/log", ...)          — logAudit no-op
 *   - vi.mock("@/lib/sync/last-sync-at", ...)  — recordSyncAt no-op
 *   - vi.mock("next/cache", ...)               — revalidatePath no-op
 *   - vi.mock("@/lib/naver-sa/keywords", ...)  — listKeywords (호출되면 안 됨 — enqueue 단계)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// =============================================================================
// Mocks (전역 — import 전에 hoist 됨)
// =============================================================================

const mockGetCurrentAdvertiser = vi.fn()

vi.mock("@/lib/auth/access", () => ({
  getCurrentAdvertiser: (...args: unknown[]) =>
    mockGetCurrentAdvertiser(...args),
  // 다른 named export 가 모듈 안에서 import 되더라도 안전하게 stub
  assertRole: vi.fn(),
}))

const mockAdGroupFindMany = vi.fn()
const mockChangeBatchCreate = vi.fn()
const mockChangeItemCreateMany = vi.fn()

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    adGroup: {
      findMany: (...args: unknown[]) => mockAdGroupFindMany(...args),
    },
    changeBatch: {
      create: (...args: unknown[]) => mockChangeBatchCreate(...args),
    },
    changeItem: {
      createMany: (...args: unknown[]) => mockChangeItemCreateMany(...args),
    },
    // 본 테스트에서 호출되지 않는 메서드들 — 안전하게 stub (호출되면 throw 로 가시화)
    keyword: {
      findFirst: vi.fn().mockRejectedValue(new Error("unexpected keyword.findFirst")),
      findUnique: vi.fn().mockRejectedValue(new Error("unexpected keyword.findUnique")),
      upsert: vi.fn().mockRejectedValue(new Error("unexpected keyword.upsert")),
      update: vi.fn().mockRejectedValue(new Error("unexpected keyword.update")),
      findMany: vi.fn().mockRejectedValue(new Error("unexpected keyword.findMany")),
    },
  },
}))

const mockLogAudit = vi.fn()
vi.mock("@/lib/audit/log", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}))

const mockRecordSyncAt = vi.fn()
vi.mock("@/lib/sync/last-sync-at", () => ({
  recordSyncAt: (...args: unknown[]) => mockRecordSyncAt(...args),
}))

const mockRevalidatePath = vi.fn()
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}))

// listKeywords 는 enqueue 단계에서 호출되면 안 됨 — 호출 시 throw.
const mockListKeywords = vi.fn().mockImplementation(() => {
  throw new Error("listKeywords MUST NOT be called from syncKeywords enqueue")
})
vi.mock("@/lib/naver-sa/keywords", () => ({
  listKeywords: (...args: unknown[]) => mockListKeywords(...args),
  createKeywords: vi.fn(),
  deleteKeyword: vi.fn(),
  updateKeywordsBulk: vi.fn(),
}))

// =============================================================================
// 본체 import — mock 등록 이후
// =============================================================================

import { syncKeywords } from "@/app/(dashboard)/[advertiserId]/keywords/actions"

// =============================================================================
// 공통 setup
// =============================================================================

const ADV_ID = "adv_1"
const CUSTOMER_ID = "c-1"
const USER_ID = "user_1"

beforeEach(() => {
  vi.clearAllMocks()

  // 기본 stub: 권한 OK + hasKeys
  mockGetCurrentAdvertiser.mockResolvedValue({
    advertiser: {
      id: ADV_ID,
      customerId: CUSTOMER_ID,
      name: "Adv",
      status: "active",
      hasKeys: true,
    },
    user: { id: USER_ID, role: "admin" },
  })

  mockChangeBatchCreate.mockImplementation(async ({ data }) => ({
    id: "batch_1",
    ...data,
  }))
  mockChangeItemCreateMany.mockImplementation(async ({ data }) => ({
    count: Array.isArray(data) ? data.length : 1,
  }))
  mockLogAudit.mockResolvedValue(undefined)
  mockRecordSyncAt.mockResolvedValue(undefined)
  mockRevalidatePath.mockReturnValue(undefined)
})

afterEach(() => {
  vi.resetAllMocks()
})

// =============================================================================
// Tests
// =============================================================================

describe("syncKeywords — enqueue 흐름 (광고그룹 0개)", () => {
  it("광고그룹 0개 → batchId=null + total=0 + ChangeBatch 미생성", async () => {
    mockAdGroupFindMany.mockResolvedValue([])

    const r = await syncKeywords(ADV_ID)

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.batchId).toBeNull()
    expect(r.total).toBe(0)
    expect(r.scope).toBe("all")

    // ChangeBatch / ChangeItem 미생성
    expect(mockChangeBatchCreate).not.toHaveBeenCalled()
    expect(mockChangeItemCreateMany).not.toHaveBeenCalled()

    // lastSyncAt 갱신 + revalidatePath 호출 (광고그룹 0개도 sync 시도 완료 표시)
    expect(mockRecordSyncAt).toHaveBeenCalledWith(ADV_ID, "keywords")
    expect(mockRevalidatePath).toHaveBeenCalledWith(`/${ADV_ID}/keywords`)

    // listKeywords 호출 X
    expect(mockListKeywords).not.toHaveBeenCalled()
  })
})

describe("syncKeywords — enqueue 흐름 (광고그룹 N개)", () => {
  it("광고그룹 3개 → ChangeBatch + ChangeItem 3건 생성 + 반환 batchId 일치", async () => {
    mockAdGroupFindMany.mockResolvedValue([
      { id: "ag_1", nccAdgroupId: "ncc_a" },
      { id: "ag_2", nccAdgroupId: "ncc_b" },
      { id: "ag_3", nccAdgroupId: "ncc_c" },
    ])

    const r = await syncKeywords(ADV_ID)

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.batchId).toBe("batch_1")
    expect(r.total).toBe(3)
    expect(r.scope).toBe("all")

    // ChangeBatch.create 검증
    expect(mockChangeBatchCreate).toHaveBeenCalledTimes(1)
    const batchArg = mockChangeBatchCreate.mock.calls[0][0] as {
      data: {
        action: string
        status: string
        total: number
        userId: string
        summary: Record<string, unknown>
      }
    }
    expect(batchArg.data.action).toBe("sync_keywords")
    expect(batchArg.data.status).toBe("pending")
    expect(batchArg.data.total).toBe(3)
    expect(batchArg.data.userId).toBe(USER_ID)
    expect(batchArg.data.summary).toMatchObject({
      advertiserId: ADV_ID,
      customerId: CUSTOMER_ID,
      scannedAdgroups: 0,
      syncedKeywords: 0,
      skipped: 0,
    })

    // ChangeItem.createMany 검증
    expect(mockChangeItemCreateMany).toHaveBeenCalledTimes(1)
    const itemsArg = mockChangeItemCreateMany.mock.calls[0][0] as {
      data: Array<{
        batchId: string
        targetType: string
        targetId: string
        after: Record<string, unknown>
        idempotencyKey: string
        status: string
      }>
    }
    expect(itemsArg.data).toHaveLength(3)
    for (const item of itemsArg.data) {
      expect(item.batchId).toBe("batch_1")
      expect(item.targetType).toBe("AdGroup")
      expect(item.status).toBe("pending")
      expect(item.after.customerId).toBe(CUSTOMER_ID)
      expect(item.after.advertiserId).toBe(ADV_ID)
      expect(item.idempotencyKey).toBe(`batch_1:${item.targetId}`)
    }
    expect(itemsArg.data.map((d) => d.targetId)).toEqual([
      "ncc_a",
      "ncc_b",
      "ncc_c",
    ])
    expect(itemsArg.data.map((d) => d.after.dbAdgroupId)).toEqual([
      "ag_1",
      "ag_2",
      "ag_3",
    ])

    // listKeywords 호출 X (Cron 위임)
    expect(mockListKeywords).not.toHaveBeenCalled()

    // revalidatePath 미호출 (실제 갱신은 finalize 시점)
    expect(mockRevalidatePath).not.toHaveBeenCalled()

    // AuditLog enqueue
    expect(mockLogAudit).toHaveBeenCalledTimes(1)
    const auditArg = mockLogAudit.mock.calls[0][0] as {
      action: string
      targetType: string
      targetId: string
    }
    expect(auditArg.action).toBe("keyword.sync.enqueue")
    expect(auditArg.targetType).toBe("ChangeBatch")
    expect(auditArg.targetId).toBe("batch_1")
  })
})

describe("syncKeywords — 캠페인 필터", () => {
  it("campaignIds 지정 → adGroup.findMany where 에 campaign.id IN [...] 반영", async () => {
    mockAdGroupFindMany.mockResolvedValue([
      { id: "ag_1", nccAdgroupId: "ncc_a" },
    ])

    const r = await syncKeywords(ADV_ID, { campaignIds: ["camp_1", "camp_2"] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.scope).toBe("campaigns")

    expect(mockAdGroupFindMany).toHaveBeenCalledTimes(1)
    const findManyArg = mockAdGroupFindMany.mock.calls[0][0] as {
      where: { campaign: { advertiserId: string; id?: { in: string[] } } }
    }
    expect(findManyArg.where.campaign.advertiserId).toBe(ADV_ID)
    expect(findManyArg.where.campaign.id).toEqual({
      in: ["camp_1", "camp_2"],
    })
  })

  it("campaignIds 미지정 → where 에 campaign.id 필터 없음", async () => {
    mockAdGroupFindMany.mockResolvedValue([])
    await syncKeywords(ADV_ID)

    const findManyArg = mockAdGroupFindMany.mock.calls[0][0] as {
      where: { campaign: Record<string, unknown> }
    }
    expect(findManyArg.where.campaign.id).toBeUndefined()
  })

  it("campaignIds=[] (빈 배열) → 'all' scope (필터 미적용)", async () => {
    mockAdGroupFindMany.mockResolvedValue([])
    const r = await syncKeywords(ADV_ID, { campaignIds: [] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.scope).toBe("all")

    const findManyArg = mockAdGroupFindMany.mock.calls[0][0] as {
      where: { campaign: Record<string, unknown> }
    }
    expect(findManyArg.where.campaign.id).toBeUndefined()
  })
})

describe("syncKeywords — hasKeys=false 차단", () => {
  it("hasKeys=false → ok:false + ChangeBatch 미생성", async () => {
    mockGetCurrentAdvertiser.mockResolvedValue({
      advertiser: {
        id: ADV_ID,
        customerId: CUSTOMER_ID,
        name: "Adv",
        status: "active",
        hasKeys: false,
      },
      user: { id: USER_ID, role: "admin" },
    })

    const r = await syncKeywords(ADV_ID)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("API")

    expect(mockAdGroupFindMany).not.toHaveBeenCalled()
    expect(mockChangeBatchCreate).not.toHaveBeenCalled()
    expect(mockChangeItemCreateMany).not.toHaveBeenCalled()
  })
})
