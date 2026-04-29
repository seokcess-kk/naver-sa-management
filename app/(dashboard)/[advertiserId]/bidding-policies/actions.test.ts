/**
 * F-11.1 BiddingPolicy CRUD Server Actions 단위 테스트
 *
 * 검증 범위:
 *   A. listBiddingPolicies         — 광고주 격리 / 정렬 / shape (ISO 변환)
 *   B. createBiddingPolicy         — viewer 차단 / 광고주 횡단 차단 / UNIQUE 충돌 /
 *                                    maxBid<minBid 거부 / 정상 happy path
 *   C. updateBiddingPolicy         — 광고주 격리 / partial / maxBid 검증 (기존값 + patch 합산)
 *   D. deleteBiddingPolicy         — 광고주 격리 / 멱등 (이미 삭제됨)
 *   E. listKeywordsWithoutPolicy   — device 별 필터 / 정렬
 *
 * 외부 호출 0:
 *   - vi.mock("@/lib/auth/access", ...)   — getCurrentAdvertiser stub
 *   - vi.mock("@/lib/db/prisma", ...)     — biddingPolicy / keyword 메서드 stub
 *   - vi.mock("@/lib/audit/log", ...)     — logAudit stub
 *   - vi.mock("next/cache", ...)          — revalidatePath stub
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// =============================================================================
// Mocks (전역 — import 전에 hoist 됨)
// =============================================================================

const mockGetCurrentAdvertiser = vi.fn()

vi.mock("@/lib/auth/access", () => ({
  getCurrentAdvertiser: (...args: unknown[]) =>
    mockGetCurrentAdvertiser(...args),
}))

const mockBiddingPolicyFindMany = vi.fn()
const mockBiddingPolicyFindFirst = vi.fn()
const mockBiddingPolicyFindUnique = vi.fn()
const mockBiddingPolicyCreate = vi.fn()
const mockBiddingPolicyUpdate = vi.fn()
const mockBiddingPolicyDelete = vi.fn()

const mockKeywordFindFirst = vi.fn()
const mockKeywordFindMany = vi.fn()

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    biddingPolicy: {
      findMany: (...args: unknown[]) => mockBiddingPolicyFindMany(...args),
      findFirst: (...args: unknown[]) => mockBiddingPolicyFindFirst(...args),
      findUnique: (...args: unknown[]) => mockBiddingPolicyFindUnique(...args),
      create: (...args: unknown[]) => mockBiddingPolicyCreate(...args),
      update: (...args: unknown[]) => mockBiddingPolicyUpdate(...args),
      delete: (...args: unknown[]) => mockBiddingPolicyDelete(...args),
    },
    keyword: {
      findFirst: (...args: unknown[]) => mockKeywordFindFirst(...args),
      findMany: (...args: unknown[]) => mockKeywordFindMany(...args),
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
  createBiddingPolicy,
  deleteBiddingPolicy,
  listBiddingPolicies,
  listKeywordsWithoutPolicy,
  updateBiddingPolicy,
} from "@/app/(dashboard)/[advertiserId]/bidding-policies/actions"

// =============================================================================
// 공통 setup
// =============================================================================

const ADV_ID = "adv_1"
const KEYWORD_ID = "kw_1"
const POLICY_ID = "pol_1"
const USER_ID = "u_op"

function setOperator(): void {
  mockGetCurrentAdvertiser.mockResolvedValue({
    advertiser: {
      id: ADV_ID,
      customerId: "1234",
      name: "Adv",
      status: "active",
      hasKeys: true,
    },
    user: { id: USER_ID, role: "operator" },
  })
}

function setViewer(): void {
  mockGetCurrentAdvertiser.mockResolvedValue({
    advertiser: {
      id: ADV_ID,
      customerId: "1234",
      name: "Adv",
      status: "active",
      hasKeys: true,
    },
    user: { id: "u_v", role: "viewer" },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  setOperator()
})

afterEach(() => {
  vi.clearAllMocks()
})

// =============================================================================
// A. listBiddingPolicies
// =============================================================================

describe("listBiddingPolicies", () => {
  it("광고주 격리 + ISO 변환 + shape (adgroup/campaign 포함)", async () => {
    const now = new Date("2026-04-29T00:00:00.000Z")
    mockBiddingPolicyFindMany.mockResolvedValue([
      {
        id: "p1",
        keywordId: "k1",
        device: "PC",
        targetRank: 1,
        maxBid: 5000,
        minBid: 100,
        enabled: true,
        createdAt: now,
        updatedAt: now,
        keyword: {
          keyword: "신발",
          nccKeywordId: "ncc-k1",
          adgroup: {
            name: "AG-1",
            campaign: { name: "C-1" },
          },
        },
      },
      {
        id: "p2",
        keywordId: "k2",
        device: "MOBILE",
        targetRank: 3,
        maxBid: null,
        minBid: null,
        enabled: false,
        createdAt: now,
        updatedAt: now,
        keyword: {
          keyword: "가방",
          nccKeywordId: "ncc-k2",
          adgroup: {
            name: "AG-2",
            campaign: { name: "C-2" },
          },
        },
      },
    ])

    const r = await listBiddingPolicies(ADV_ID)

    expect(mockGetCurrentAdvertiser).toHaveBeenCalledWith(ADV_ID)
    expect(mockBiddingPolicyFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { advertiserId: ADV_ID },
        orderBy: { createdAt: "desc" },
      }),
    )
    expect(r).toHaveLength(2)
    expect(r[0]).toEqual({
      id: "p1",
      keywordId: "k1",
      keyword: "신발",
      nccKeywordId: "ncc-k1",
      adgroupName: "AG-1",
      campaignName: "C-1",
      device: "PC",
      targetRank: 1,
      maxBid: 5000,
      minBid: 100,
      enabled: true,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    })
    expect(r[1].maxBid).toBeNull()
    expect(r[1].enabled).toBe(false)
    expect(r[1].adgroupName).toBe("AG-2")
    expect(r[1].campaignName).toBe("C-2")
  })

  it("권한 부족이면 throw (getCurrentAdvertiser 가 던짐)", async () => {
    mockGetCurrentAdvertiser.mockRejectedValueOnce(
      new Error("해당 광고주에 대한 접근 권한이 없습니다"),
    )
    await expect(listBiddingPolicies(ADV_ID)).rejects.toThrow(
      /접근 권한이 없습니다/,
    )
  })
})

// =============================================================================
// B. createBiddingPolicy
// =============================================================================

describe("createBiddingPolicy", () => {
  it("viewer 는 차단", async () => {
    setViewer()
    const r = await createBiddingPolicy({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
      targetRank: 1,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe("권한 부족")
    expect(mockBiddingPolicyCreate).not.toHaveBeenCalled()
  })

  it("광고주 횡단 차단 — 다른 광고주 키워드는 거부", async () => {
    mockKeywordFindFirst.mockResolvedValue(null) // 광고주 join 결과 0
    const r = await createBiddingPolicy({
      advertiserId: ADV_ID,
      keywordId: "kw_other",
      device: "PC",
      targetRank: 1,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/광고주의 키워드/u)
    expect(mockBiddingPolicyCreate).not.toHaveBeenCalled()
  })

  it("UNIQUE [keywordId, device] 충돌 시 안내", async () => {
    mockKeywordFindFirst.mockResolvedValue({
      id: KEYWORD_ID,
      keyword: "신발",
      nccKeywordId: "ncc-1",
    })
    mockBiddingPolicyFindUnique.mockResolvedValue({ id: "existing" })

    const r = await createBiddingPolicy({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
      targetRank: 1,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/이미 정책이 존재/u)
    expect(mockBiddingPolicyCreate).not.toHaveBeenCalled()
  })

  it("maxBid < minBid 거부 (Zod superRefine)", async () => {
    const r = await createBiddingPolicy({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
      targetRank: 1,
      maxBid: 100,
      minBid: 500,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/maxBid는 minBid 이상/u)
    expect(mockKeywordFindFirst).not.toHaveBeenCalled()
    expect(mockBiddingPolicyCreate).not.toHaveBeenCalled()
  })

  it("targetRank 범위 (1..10) 위반 거부", async () => {
    const r = await createBiddingPolicy({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
      targetRank: 11,
    })
    expect(r.ok).toBe(false)
    expect(mockBiddingPolicyCreate).not.toHaveBeenCalled()
  })

  it("happy path — create + AuditLog + revalidatePath", async () => {
    mockKeywordFindFirst.mockResolvedValue({
      id: KEYWORD_ID,
      keyword: "신발",
      nccKeywordId: "ncc-1",
    })
    mockBiddingPolicyFindUnique.mockResolvedValue(null)
    mockBiddingPolicyCreate.mockResolvedValue({ id: POLICY_ID })

    const r = await createBiddingPolicy({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
      targetRank: 1,
      maxBid: 5000,
      minBid: 100,
    })

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.id).toBe(POLICY_ID)
    expect(mockBiddingPolicyCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          advertiserId: ADV_ID,
          keywordId: KEYWORD_ID,
          device: "PC",
          targetRank: 1,
          maxBid: 5000,
          minBid: 100,
          enabled: true,
        }),
      }),
    )
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "bidding_policy.create",
        targetType: "BiddingPolicy",
        targetId: POLICY_ID,
        userId: USER_ID,
      }),
    )
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      `/${ADV_ID}/bidding-policies`,
    )
  })

  it("enabled 미지정 시 기본 true", async () => {
    mockKeywordFindFirst.mockResolvedValue({
      id: KEYWORD_ID,
      keyword: "신발",
      nccKeywordId: "ncc-1",
    })
    mockBiddingPolicyFindUnique.mockResolvedValue(null)
    mockBiddingPolicyCreate.mockResolvedValue({ id: POLICY_ID })

    await createBiddingPolicy({
      advertiserId: ADV_ID,
      keywordId: KEYWORD_ID,
      device: "MOBILE",
      targetRank: 5,
    })

    expect(mockBiddingPolicyCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ enabled: true }),
      }),
    )
  })
})

// =============================================================================
// C. updateBiddingPolicy
// =============================================================================

describe("updateBiddingPolicy", () => {
  it("viewer 차단", async () => {
    setViewer()
    const r = await updateBiddingPolicy({
      id: POLICY_ID,
      advertiserId: ADV_ID,
      targetRank: 2,
    })
    expect(r.ok).toBe(false)
    expect(mockBiddingPolicyUpdate).not.toHaveBeenCalled()
  })

  it("광고주 격리 — 다른 광고주의 정책 ID 는 못 찾음", async () => {
    mockBiddingPolicyFindFirst.mockResolvedValue(null)
    const r = await updateBiddingPolicy({
      id: "pol_other",
      advertiserId: ADV_ID,
      targetRank: 2,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/찾을 수 없습니다/u)
    expect(mockBiddingPolicyUpdate).not.toHaveBeenCalled()
  })

  it("partial update — patch 등장 필드만 변경 + before/after 동일 필드만", async () => {
    mockBiddingPolicyFindFirst.mockResolvedValue({
      id: POLICY_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
      targetRank: 5,
      maxBid: 1000,
      minBid: 100,
      enabled: true,
    })
    mockBiddingPolicyUpdate.mockResolvedValue({})

    const r = await updateBiddingPolicy({
      id: POLICY_ID,
      advertiserId: ADV_ID,
      targetRank: 3,
      enabled: false,
    })

    expect(r.ok).toBe(true)
    expect(mockBiddingPolicyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: POLICY_ID },
        data: { targetRank: 3, enabled: false },
      }),
    )

    const auditCall = mockLogAudit.mock.calls[0][0]
    expect(auditCall.action).toBe("bidding_policy.update")
    expect(auditCall.before).toEqual({ targetRank: 5, enabled: true })
    expect(auditCall.after).toEqual({ targetRank: 3, enabled: false })
  })

  it("입력 maxBid + 기존 minBid 결합 시 maxBid<minBid 거부", async () => {
    mockBiddingPolicyFindFirst.mockResolvedValue({
      id: POLICY_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
      targetRank: 5,
      maxBid: 5000,
      minBid: 1000, // 기존
      enabled: true,
    })

    // 입력은 maxBid만 — Zod superRefine 은 통과 (둘 다 number 일 때만 검사),
    // 호출부 사후 검증이 결합 maxBid=500 < minBid(기존)=1000 거부.
    const r = await updateBiddingPolicy({
      id: POLICY_ID,
      advertiserId: ADV_ID,
      maxBid: 500,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/maxBid는 minBid 이상/u)
    expect(mockBiddingPolicyUpdate).not.toHaveBeenCalled()
  })

  it("Zod 단계: 입력 maxBid<minBid 거부", async () => {
    const r = await updateBiddingPolicy({
      id: POLICY_ID,
      advertiserId: ADV_ID,
      maxBid: 100,
      minBid: 500,
    })
    expect(r.ok).toBe(false)
    expect(mockBiddingPolicyFindFirst).not.toHaveBeenCalled()
  })

  it("변경 사항 0 — 멱등 ok 반환 + DB update 미호출", async () => {
    mockBiddingPolicyFindFirst.mockResolvedValue({
      id: POLICY_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
      targetRank: 5,
      maxBid: 1000,
      minBid: 100,
      enabled: true,
    })

    const r = await updateBiddingPolicy({
      id: POLICY_ID,
      advertiserId: ADV_ID,
    })

    expect(r.ok).toBe(true)
    expect(mockBiddingPolicyUpdate).not.toHaveBeenCalled()
    expect(mockLogAudit).not.toHaveBeenCalled()
  })

  it("maxBid: null 명시 (제한 해제) 정상 적용", async () => {
    mockBiddingPolicyFindFirst.mockResolvedValue({
      id: POLICY_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
      targetRank: 5,
      maxBid: 5000,
      minBid: 100,
      enabled: true,
    })
    mockBiddingPolicyUpdate.mockResolvedValue({})

    const r = await updateBiddingPolicy({
      id: POLICY_ID,
      advertiserId: ADV_ID,
      maxBid: null,
    })

    expect(r.ok).toBe(true)
    expect(mockBiddingPolicyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { maxBid: null } }),
    )
  })
})

// =============================================================================
// D. deleteBiddingPolicy
// =============================================================================

describe("deleteBiddingPolicy", () => {
  it("viewer 차단", async () => {
    setViewer()
    const r = await deleteBiddingPolicy({ id: POLICY_ID, advertiserId: ADV_ID })
    expect(r.ok).toBe(false)
    expect(mockBiddingPolicyDelete).not.toHaveBeenCalled()
  })

  it("광고주 격리 — 다른 광고주 정책 ID 면 멱등 ok (이미 삭제 동급)", async () => {
    mockBiddingPolicyFindFirst.mockResolvedValue(null)
    const r = await deleteBiddingPolicy({
      id: "pol_other",
      advertiserId: ADV_ID,
    })
    expect(r.ok).toBe(true)
    expect(mockBiddingPolicyDelete).not.toHaveBeenCalled()
    expect(mockLogAudit).not.toHaveBeenCalled()
  })

  it("happy path — delete + AuditLog before 스냅샷 + revalidatePath", async () => {
    mockBiddingPolicyFindFirst.mockResolvedValue({
      id: POLICY_ID,
      keywordId: KEYWORD_ID,
      device: "PC",
      targetRank: 5,
      maxBid: 1000,
      minBid: 100,
      enabled: true,
    })
    mockBiddingPolicyDelete.mockResolvedValue({})

    const r = await deleteBiddingPolicy({
      id: POLICY_ID,
      advertiserId: ADV_ID,
    })

    expect(r.ok).toBe(true)
    expect(mockBiddingPolicyDelete).toHaveBeenCalledWith({
      where: { id: POLICY_ID },
    })

    const auditCall = mockLogAudit.mock.calls[0][0]
    expect(auditCall.action).toBe("bidding_policy.delete")
    expect(auditCall.targetId).toBe(POLICY_ID)
    expect(auditCall.before).toEqual({
      keywordId: KEYWORD_ID,
      device: "PC",
      targetRank: 5,
      maxBid: 1000,
      minBid: 100,
      enabled: true,
    })
    expect(auditCall.after).toBeNull()
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      `/${ADV_ID}/bidding-policies`,
    )
  })
})

// =============================================================================
// E. listKeywordsWithoutPolicy
// =============================================================================

describe("listKeywordsWithoutPolicy", () => {
  it("device 별 필터 + 가나다 정렬 + limit 500 + adgroupName 매핑", async () => {
    mockKeywordFindMany.mockResolvedValue([
      {
        id: "k1",
        keyword: "가방",
        nccKeywordId: "ncc-1",
        adgroup: { name: "AG-1" },
      },
      {
        id: "k2",
        keyword: "신발",
        nccKeywordId: "ncc-2",
        adgroup: { name: "AG-2" },
      },
    ])

    const r = await listKeywordsWithoutPolicy(ADV_ID, "PC")

    expect(mockKeywordFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          adgroup: { campaign: { advertiserId: ADV_ID } },
          biddingPolicies: { none: { device: "PC" } },
        }),
        orderBy: { keyword: "asc" },
        take: 500,
      }),
    )
    expect(r).toHaveLength(2)
    expect(r[0].keyword).toBe("가방")
    expect(r[0].adgroupName).toBe("AG-1")
    expect(r[1].adgroupName).toBe("AG-2")
  })

  it("MOBILE 일 때 biddingPolicies.none.device='MOBILE'", async () => {
    mockKeywordFindMany.mockResolvedValue([])
    await listKeywordsWithoutPolicy(ADV_ID, "MOBILE")

    expect(mockKeywordFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          biddingPolicies: { none: { device: "MOBILE" } },
        }),
      }),
    )
  })

  it("Zod 검증 실패 시 빈 배열 반환 (UI 셀렉터 friendly)", async () => {
    // 빈 advertiserId — Zod 거부
    const r = await listKeywordsWithoutPolicy(
      "",
      "PC" as "PC" | "MOBILE",
    )
    expect(r).toEqual([])
    expect(mockGetCurrentAdvertiser).not.toHaveBeenCalled()
    expect(mockKeywordFindMany).not.toHaveBeenCalled()
  })
})
