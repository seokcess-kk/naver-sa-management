/**
 * F-11.2 / F-11.5 / F-11.6 — auto-bidding cron 통합 테스트.
 *
 * 외부 호출 0 — vi.mock 광범위:
 *   - @/lib/db/prisma (advertiser / biddingPolicy / optimizationRun)
 *   - @/lib/auto-bidding/estimate-cached (getCachedAveragePositionBid)
 *   - @/lib/auto-bidding/guardrail (checkAdvertiserGuardrail / checkKeywordGuardrail)
 *   - @/lib/naver-sa/keywords (updateKeyword)
 *   - @/lib/naver-sa/credentials (side-effect import)
 *
 * 시나리오:
 *   1. CRON_SECRET 미설정 / 헤더 불일치 → 401
 *   2. Kill Switch=true 광고주는 SQL 사전 제외 (where 절 검증)
 *   3. guardrailEnabled=false → 광고주 skip + OR 미적재
 *   4. 광고주 단위 한도 초과 → 광고주 skip + OR 미적재
 *   5. 정책별 happy path (Estimate hit → decide → updateKeyword → OR.success)
 *   6. decide skip (rank null) → OR.skipped_rank_unavailable
 *   7. SA updateKeyword throw → OR.failed + errors[] 추가
 *   8. userLock=true → OR.skipped_user_lock
 *   9. 키워드 한도 초과 → OR.skipped_guardrail
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// 자격증명 resolver side-effect 무력화 (테스트 환경에서 SA 모듈 import 막기)
vi.mock("@/lib/naver-sa/credentials", () => ({}))

// =============================================================================
// 광범위 mock
// =============================================================================

const mockAdvertiserFindMany = vi.fn()
const mockBiddingPolicyFindMany = vi.fn()
const mockORCreate = vi.fn()

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    advertiser: {
      findMany: (...args: unknown[]) => mockAdvertiserFindMany(...args),
    },
    biddingPolicy: {
      findMany: (...args: unknown[]) => mockBiddingPolicyFindMany(...args),
    },
    optimizationRun: {
      create: (...args: unknown[]) => mockORCreate(...args),
    },
  },
}))

const mockGetCached = vi.fn()
vi.mock("@/lib/auto-bidding/estimate-cached", () => ({
  getCachedAveragePositionBid: (...args: unknown[]) => mockGetCached(...args),
}))

const mockCheckAdvGuardrail = vi.fn()
const mockCheckKwGuardrail = vi.fn()
vi.mock("@/lib/auto-bidding/guardrail", () => ({
  checkAdvertiserGuardrail: (...args: unknown[]) => mockCheckAdvGuardrail(...args),
  checkKeywordGuardrail: (...args: unknown[]) => mockCheckKwGuardrail(...args),
}))

const mockUpdateKeyword = vi.fn()
vi.mock("@/lib/naver-sa/keywords", () => ({
  updateKeyword: (...args: unknown[]) => mockUpdateKeyword(...args),
}))

import { GET } from "@/app/api/cron/auto-bidding/route"

// =============================================================================
// 헬퍼
// =============================================================================

function makeReq(authHeader: string | null): {
  headers: { get: (name: string) => string | null }
} {
  return {
    headers: {
      get: (name: string) => (name === "authorization" ? authHeader : null),
    },
  }
}

const ADV = {
  id: "adv_1",
  customerId: "c-1",
  guardrailEnabled: true,
  guardrailMaxBidChangePct: 20,
  guardrailMaxChangesPerKeyword: 3,
  guardrailMaxChangesPerDay: 50,
}

const POLICY = {
  id: "p_1",
  advertiserId: "adv_1",
  keywordId: "kw_1",
  device: "PC" as const,
  targetRank: 1,
  maxBid: null,
  minBid: null,
  keyword: {
    id: "kw_1",
    nccKeywordId: "ncc_kw_1",
    keyword: "신발",
    bidAmt: 1000,
    // Prisma Decimal mock — toNumber()
    recentAvgRnk: { toNumber: () => 5.5 } as { toNumber(): number },
    userLock: false,
    status: "on" as const,
    adgroup: { campaign: { advertiserId: "adv_1" } },
  },
}

const ESTIMATE_ROWS = [
  { keyword: "신발", position: 1, bid: 1100 },
  { keyword: "신발", position: 2, bid: 900 },
  { keyword: "신발", position: 3, bid: 700 },
  { keyword: "신발", position: 4, bid: 500 },
  { keyword: "신발", position: 5, bid: 300 },
]

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = "test-secret"
  // 기본: Guardrail 통과
  mockCheckAdvGuardrail.mockResolvedValue({ ok: true, count: 0 })
  mockCheckKwGuardrail.mockResolvedValue({ ok: true, count: 0 })
  mockORCreate.mockResolvedValue({ id: "or_1" })
  mockUpdateKeyword.mockResolvedValue({ nccKeywordId: "ncc_kw_1" })
  mockGetCached.mockResolvedValue({ data: ESTIMATE_ROWS, cachedAll: true })
})

afterEach(() => {
  delete process.env.CRON_SECRET
})

// =============================================================================
// 1. CRON_SECRET 검증
// =============================================================================

describe("cron auto-bidding — CRON_SECRET 가드", () => {
  it("CRON_SECRET 미설정 → 401", async () => {
    delete process.env.CRON_SECRET
    const res = await GET(makeReq("Bearer x") as never)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe("unauthorized")
    expect(mockAdvertiserFindMany).not.toHaveBeenCalled()
  })

  it("Authorization 헤더 불일치 → 401", async () => {
    const res = await GET(makeReq("Bearer wrong") as never)
    expect(res.status).toBe(401)
    expect(mockAdvertiserFindMany).not.toHaveBeenCalled()
  })

  it("Authorization 헤더 null → 401", async () => {
    const res = await GET(makeReq(null) as never)
    expect(res.status).toBe(401)
  })

  it("Bearer 일치 → 진입 (광고주 0명이라도 200)", async () => {
    mockAdvertiserFindMany.mockResolvedValue([])
    const res = await GET(makeReq("Bearer test-secret") as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.advertisersTotal).toBe(0)
  })
})

// =============================================================================
// 2. SQL 광고주 조회 — Kill Switch / hasKeys / status 사전 제외
// =============================================================================

describe("cron auto-bidding — 광고주 조회 where 절", () => {
  it("Kill Switch=false / status=active / 키 등록 광고주만 조회", async () => {
    mockAdvertiserFindMany.mockResolvedValue([])
    await GET(makeReq("Bearer test-secret") as never)
    expect(mockAdvertiserFindMany).toHaveBeenCalledTimes(1)
    const arg = mockAdvertiserFindMany.mock.calls[0][0] as {
      where: {
        status: string
        apiKeyEnc: { not: null }
        secretKeyEnc: { not: null }
        biddingKillSwitch: boolean
      }
    }
    expect(arg.where.status).toBe("active")
    expect(arg.where.biddingKillSwitch).toBe(false)
    expect(arg.where.apiKeyEnc).toEqual({ not: null })
    expect(arg.where.secretKeyEnc).toEqual({ not: null })
  })
})

// =============================================================================
// 3. guardrailEnabled=false / 광고주 단위 한도 초과
// =============================================================================

describe("cron auto-bidding — 광고주 skip", () => {
  it("guardrailEnabled=false → OR 미적재 + advertisersSkipped++", async () => {
    mockAdvertiserFindMany.mockResolvedValue([
      { ...ADV, guardrailEnabled: false },
    ])
    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.advertisersSkipped).toBe(1)
    expect(body.advertisersOk).toBe(0)
    expect(mockORCreate).not.toHaveBeenCalled()
    expect(mockBiddingPolicyFindMany).not.toHaveBeenCalled()
    expect(mockCheckAdvGuardrail).not.toHaveBeenCalled()
  })

  it("checkAdvertiserGuardrail 초과 → OR 미적재 + 정책 진입 X", async () => {
    mockAdvertiserFindMany.mockResolvedValue([ADV])
    mockCheckAdvGuardrail.mockResolvedValue({ ok: false, count: 50 })
    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.advertisersSkipped).toBe(1)
    expect(mockBiddingPolicyFindMany).not.toHaveBeenCalled()
    expect(mockORCreate).not.toHaveBeenCalled()
  })
})

// =============================================================================
// 4. 정책별 happy path / skip / failed
// =============================================================================

describe("cron auto-bidding — 정책 처리", () => {
  it("happy path: Estimate hit → decide → updateKeyword → OR.success", async () => {
    mockAdvertiserFindMany.mockResolvedValue([ADV])
    mockBiddingPolicyFindMany.mockResolvedValue([POLICY])

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()

    expect(body.runsTotal).toBe(1)
    expect(body.runsSuccess).toBe(1)
    expect(body.runsSkipped).toBe(0)
    expect(body.runsFailed).toBe(0)

    expect(mockUpdateKeyword).toHaveBeenCalledTimes(1)
    expect(mockUpdateKeyword).toHaveBeenCalledWith(
      "c-1",
      "ncc_kw_1",
      { bidAmt: 1100, useGroupBidAmt: false }, // Estimate position 1 = 1100, in range
      "bidAmt,useGroupBidAmt",
    )
    expect(mockORCreate).toHaveBeenCalledTimes(1)
    const orArg = mockORCreate.mock.calls[0][0] as {
      data: { result: string; before: unknown; after: unknown }
    }
    expect(orArg.data.result).toBe("success")
  })

  it("decide skip (recentAvgRnk null) → OR.skipped_rank_unavailable + SA 호출 0", async () => {
    mockAdvertiserFindMany.mockResolvedValue([ADV])
    mockBiddingPolicyFindMany.mockResolvedValue([
      {
        ...POLICY,
        keyword: { ...POLICY.keyword, recentAvgRnk: null },
      },
    ])

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()

    expect(body.runsSuccess).toBe(0)
    expect(body.runsSkipped).toBe(1)
    expect(mockUpdateKeyword).not.toHaveBeenCalled()
    const orArg = mockORCreate.mock.calls[0][0] as { data: { result: string } }
    expect(orArg.data.result).toBe("skipped_rank_unavailable")
  })

  it("userLock=true → OR.skipped_user_lock + Estimate 미호출", async () => {
    mockAdvertiserFindMany.mockResolvedValue([ADV])
    mockBiddingPolicyFindMany.mockResolvedValue([
      { ...POLICY, keyword: { ...POLICY.keyword, userLock: true } },
    ])

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()

    expect(body.runsSkipped).toBe(1)
    expect(mockGetCached).not.toHaveBeenCalled()
    expect(mockUpdateKeyword).not.toHaveBeenCalled()
    const orArg = mockORCreate.mock.calls[0][0] as { data: { result: string } }
    expect(orArg.data.result).toBe("skipped_user_lock")
  })

  it("status='deleted' → OR.skipped_deleted", async () => {
    mockAdvertiserFindMany.mockResolvedValue([ADV])
    mockBiddingPolicyFindMany.mockResolvedValue([
      { ...POLICY, keyword: { ...POLICY.keyword, status: "deleted" } },
    ])

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()

    expect(body.runsSkipped).toBe(1)
    expect(mockGetCached).not.toHaveBeenCalled()
    const orArg = mockORCreate.mock.calls[0][0] as { data: { result: string } }
    expect(orArg.data.result).toBe("skipped_deleted")
  })

  it("키워드 단위 Guardrail 초과 → OR.skipped_guardrail", async () => {
    mockAdvertiserFindMany.mockResolvedValue([ADV])
    mockBiddingPolicyFindMany.mockResolvedValue([POLICY])
    mockCheckKwGuardrail.mockResolvedValue({ ok: false, count: 3 })

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()

    expect(body.runsSkipped).toBe(1)
    expect(mockGetCached).not.toHaveBeenCalled()
    const orArg = mockORCreate.mock.calls[0][0] as {
      data: { result: string; errorMessage?: string }
    }
    expect(orArg.data.result).toBe("skipped_guardrail")
    expect(orArg.data.errorMessage).toContain("keyword_limit:3/3")
  })

  it("SA updateKeyword throw → OR.failed + errors[] 추가", async () => {
    mockAdvertiserFindMany.mockResolvedValue([ADV])
    mockBiddingPolicyFindMany.mockResolvedValue([POLICY])
    mockUpdateKeyword.mockRejectedValue(new Error("SA 503 Service Unavailable"))

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()

    expect(body.runsFailed).toBe(1)
    expect(body.runsSuccess).toBe(0)
    expect(body.errors).toHaveLength(1)
    expect(body.errors[0].message).toContain("sa_update_failed")
    expect(body.errors[0].advertiserId).toBe("adv_1")
    expect(body.errors[0].policyId).toBe("p_1")
    const orArg = mockORCreate.mock.calls[0][0] as {
      data: { result: string; errorMessage: string }
    }
    expect(orArg.data.result).toBe("failed")
    expect(orArg.data.errorMessage).toContain("503")
  })

  it("Estimate throw → OR.failed (SA updateKeyword 미호출)", async () => {
    mockAdvertiserFindMany.mockResolvedValue([ADV])
    mockBiddingPolicyFindMany.mockResolvedValue([POLICY])
    mockGetCached.mockRejectedValue(new Error("Estimate timeout"))

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()

    expect(body.runsFailed).toBe(1)
    expect(mockUpdateKeyword).not.toHaveBeenCalled()
    const orArg = mockORCreate.mock.calls[0][0] as {
      data: { result: string }
    }
    expect(orArg.data.result).toBe("failed")
  })

  it("정책 여러 개 — 부분 실패가 다음 정책을 막지 않음", async () => {
    mockAdvertiserFindMany.mockResolvedValue([ADV])
    mockBiddingPolicyFindMany.mockResolvedValue([
      POLICY,
      { ...POLICY, id: "p_2", keywordId: "kw_2", keyword: { ...POLICY.keyword, id: "kw_2", nccKeywordId: "ncc_kw_2" } },
    ])
    // 1번째 SA 실패, 2번째 성공
    mockUpdateKeyword
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce({ nccKeywordId: "ncc_kw_2" })

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()

    expect(body.runsTotal).toBe(2)
    expect(body.runsFailed).toBe(1)
    expect(body.runsSuccess).toBe(1)
    expect(mockUpdateKeyword).toHaveBeenCalledTimes(2)
  })

  it("광고주 횡단 mismatch — campaign.advertiserId 불일치 → 정책 skip (방어선)", async () => {
    mockAdvertiserFindMany.mockResolvedValue([ADV])
    mockBiddingPolicyFindMany.mockResolvedValue([
      {
        ...POLICY,
        keyword: {
          ...POLICY.keyword,
          adgroup: { campaign: { advertiserId: "adv_OTHER" } },
        },
      },
    ])

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()

    expect(body.runsSkipped).toBe(1)
    expect(body.runsSuccess).toBe(0)
    expect(mockORCreate).not.toHaveBeenCalled()
    expect(mockUpdateKeyword).not.toHaveBeenCalled()
  })
})

// =============================================================================
// 시크릿 / 마스킹
// =============================================================================

describe("cron auto-bidding — 시크릿 마스킹", () => {
  it("errors[].message scrubString 통과 (Bearer 토큰 마스킹)", async () => {
    mockAdvertiserFindMany.mockResolvedValue([ADV])
    mockBiddingPolicyFindMany.mockResolvedValue([POLICY])
    mockUpdateKeyword.mockRejectedValue(
      new Error("auth failed: Bearer abcdef1234567890abcdef1234567890"),
    )

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()

    expect(body.errors[0].message).not.toContain(
      "abcdef1234567890abcdef1234567890",
    )
  })
})
