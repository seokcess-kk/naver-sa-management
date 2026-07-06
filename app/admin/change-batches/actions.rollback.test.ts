/**
 * rollbackChangeBatch — saRecheck 기본값(정밀 재검증) 검증 (안전장치 #3).
 *
 * 핵심: opts.saRecheck 미지정 시 기본이 true(SA 재조회) 여야 한다.
 *   - 기본(미지정)      → detectDriftSA 경로 → listAdgroups(SA) 호출, prisma.adGroup.findMany 미호출
 *   - saRecheck:false   → detectDrift 경로   → prisma.adGroup.findMany(DB) 호출, listAdgroups 미호출
 *
 * 시나리오 단순화:
 *   - done AdGroup item 1건, before={} (비어있음 → no_before early skip) → SA update/롤백 적재 없이
 *     total=0 조기 종료. 단, drift 감지는 done items 전체에 대해 조기 종료 전에 실행되므로
 *     경로 선택(SA vs DB)만 깨끗하게 관측된다.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

const mockAssertRole = vi.fn()
const mockLogAudit = vi.fn()
const mockRevalidatePath = vi.fn()

const mockChangeBatchFindUnique = vi.fn()
const mockChangeBatchCreate = vi.fn()
const mockChangeBatchUpdate = vi.fn()
const mockAdvertiserFindUnique = vi.fn()
const mockAdGroupFindMany = vi.fn()

const mockListAdgroups = vi.fn()

vi.mock("@/lib/auth/access", () => ({
  assertRole: (...args: unknown[]) => mockAssertRole(...args),
}))

vi.mock("@/lib/audit/log", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}))

vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}))

// 자격증명 resolver side-effect import — 테스트에선 no-op
vi.mock("@/lib/naver-sa/credentials", () => ({}))

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    changeBatch: {
      findUnique: (...args: unknown[]) => mockChangeBatchFindUnique(...args),
      create: (...args: unknown[]) => mockChangeBatchCreate(...args),
      update: (...args: unknown[]) => mockChangeBatchUpdate(...args),
    },
    advertiser: {
      findUnique: (...args: unknown[]) => mockAdvertiserFindUnique(...args),
    },
    adGroup: {
      findMany: (...args: unknown[]) => mockAdGroupFindMany(...args),
    },
  },
}))

// naver-sa 모듈 — 롤백/재시도가 import 하는 런타임 함수만 스텁. AdGroup 경로만 관측하면 되므로
// 나머지는 호출되지 않는다(호출되면 테스트가 잘못된 것).
vi.mock("@/lib/naver-sa/keywords", () => ({
  updateKeywordsBulk: vi.fn(),
  listKeywords: vi.fn(),
}))
vi.mock("@/lib/naver-sa/adgroups", () => ({
  updateAdgroupsBulk: vi.fn(),
  listAdgroups: (...args: unknown[]) => mockListAdgroups(...args),
}))
vi.mock("@/lib/naver-sa/campaigns", () => ({
  updateCampaignsBulk: vi.fn(),
  listCampaigns: vi.fn(),
}))
vi.mock("@/lib/naver-sa/ads", () => ({
  updateAdsBulk: vi.fn(),
  listAds: vi.fn(),
}))
vi.mock("@/lib/naver-sa/ad-extensions", () => ({
  updateAdExtensionsBulk: vi.fn(),
  listAdExtensions: vi.fn(),
}))

import { rollbackChangeBatch } from "@/app/admin/change-batches/actions"

// done AdGroup item — before 비어있음(no_before) 이지만 drift 감지는 실행됨.
const DONE_ITEM = {
  id: "it_1",
  targetType: "AdGroup",
  targetId: "ag_1",
  before: {},
  after: { dailyBudget: 1000 },
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAssertRole.mockResolvedValue({ id: "user_1" })
  mockLogAudit.mockResolvedValue(undefined)
  mockChangeBatchFindUnique.mockResolvedValue({
    id: "batch_1",
    action: "adgroup.budget",
    summary: { advertiserId: "adv_1" },
    items: [DONE_ITEM],
  })
  mockAdvertiserFindUnique.mockResolvedValue({
    id: "adv_1",
    customerId: "cust_1",
    status: "active",
    apiKeyEnc: "enc_a",
    secretKeyEnc: "enc_b",
  })
  mockChangeBatchCreate.mockResolvedValue({ id: "rb_1" })
  mockChangeBatchUpdate.mockResolvedValue({})
  // 두 경로의 응답 (한쪽만 실제로 호출됨)
  mockListAdgroups.mockResolvedValue([
    { nccAdgroupId: "ag_1", dailyBudget: 1000, userLock: false },
  ])
  mockAdGroupFindMany.mockResolvedValue([
    { nccAdgroupId: "ag_1", bidAmt: null, dailyBudget: 1000, status: "on" },
  ])
})

describe("rollbackChangeBatch — saRecheck 기본값", () => {
  it("opts 미지정 → 기본 정밀(SA 재조회) 경로: listAdgroups 호출, DB findMany 미호출", async () => {
    const res = await rollbackChangeBatch("batch_1")
    expect(res.newBatchId).toBe("rb_1")
    // SA 재조회 경로가 선택됐다
    expect(mockListAdgroups).toHaveBeenCalledTimes(1)
    expect(mockListAdgroups).toHaveBeenCalledWith("cust_1")
    // 레거시 DB 비교 경로는 타지 않는다
    expect(mockAdGroupFindMany).not.toHaveBeenCalled()
  })

  it("saRecheck 미지정과 saRecheck:true 는 동일하게 SA 재조회", async () => {
    await rollbackChangeBatch("batch_1", { saRecheck: true })
    expect(mockListAdgroups).toHaveBeenCalledTimes(1)
    expect(mockAdGroupFindMany).not.toHaveBeenCalled()
  })

  it("saRecheck:false 명시 → 레거시 DB 비교 경로: adGroup.findMany 호출, listAdgroups 미호출", async () => {
    await rollbackChangeBatch("batch_1", { saRecheck: false })
    // DB 비교 경로가 선택됐다
    expect(mockAdGroupFindMany).toHaveBeenCalledTimes(1)
    // SA 재조회는 발생하지 않는다 (호출 0회 — 안전장치상 명시 opt-out)
    expect(mockListAdgroups).not.toHaveBeenCalled()
  })
})
