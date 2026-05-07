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
const mockORCount = vi.fn()
const mockTargetingRuleFindUnique = vi.fn()

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
      count: (...args: unknown[]) => mockORCount(...args),
    },
    targetingRule: {
      findUnique: (...args: unknown[]) => mockTargetingRuleFindUnique(...args),
    },
  },
}))

// notifier dispatch / throttle — 외부 호출 0
const mockDispatch = vi.fn().mockResolvedValue({ ok: true, results: [] })
vi.mock("@/lib/notifier", () => ({
  dispatch: (...args: unknown[]) => mockDispatch(...args),
}))
vi.mock("@/lib/notifier/throttle", () => ({
  shouldThrottle: vi.fn().mockResolvedValue(false),
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
  name: "광고주1",
  customerId: "c-1",
  guardrailEnabled: true,
  guardrailMaxBidChangePct: 20,
  guardrailMaxChangesPerKeyword: 3,
  guardrailMaxChangesPerDay: 50,
  biddingKillSwitch: false,
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
  // 기본: 본 cron run 신규 skipped_guardrail OR 0건 (알림 미호출 보장)
  mockORCount.mockResolvedValue(0)
  mockUpdateKeyword.mockResolvedValue({ nccKeywordId: "ncc_kw_1" })
  mockGetCached.mockResolvedValue({ data: ESTIMATE_ROWS, cachedAll: true })
  // F-11.4 — TargetingRule 기본 null (룰 없음 = weight 1.0 fallback). 기존 케이스 무회귀.
  mockTargetingRuleFindUnique.mockResolvedValue(null)
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
// F-11.4 — TargetingRule 통합
// =============================================================================

describe("cron auto-bidding — TargetingRule (F-11.4)", () => {
  it("TargetingRule null → weight 1.0 → 기존 동작 (Estimate 1100 그대로)", async () => {
    mockAdvertiserFindMany.mockResolvedValue([ADV])
    mockBiddingPolicyFindMany.mockResolvedValue([POLICY])
    mockTargetingRuleFindUnique.mockResolvedValue(null)

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.runsSuccess).toBe(1)

    // weight 1.0 → Estimate 1100 그대로 (currentBid 1000 ±20% 안)
    expect(mockUpdateKeyword).toHaveBeenCalledWith(
      "c-1",
      "ncc_kw_1",
      { bidAmt: 1100, useGroupBidAmt: false },
      "bidAmt,useGroupBidAmt",
    )
  })

  it("TargetingRule enabled=false → weight 1.0 → 기존 동작", async () => {
    mockAdvertiserFindMany.mockResolvedValue([ADV])
    mockBiddingPolicyFindMany.mockResolvedValue([POLICY])
    mockTargetingRuleFindUnique.mockResolvedValue({
      enabled: false,
      defaultWeight: { toNumber: () => 2.0 },
      hourWeights: { "wed-9": 2.0 }, // enabled=false 라 무시
      deviceWeights: { PC: 2.0 },
    })

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.runsSuccess).toBe(1)
    // weight 1.0 → Estimate 1100 (in [800, 1200])
    expect(mockUpdateKeyword).toHaveBeenCalledWith(
      "c-1",
      "ncc_kw_1",
      { bidAmt: 1100, useGroupBidAmt: false },
      "bidAmt,useGroupBidAmt",
    )
  })

  it("TargetingRule enabled=true + 강한 weight → guardrail upper 1200 강제 수렴", async () => {
    // 시점 의존성을 줄이기 위해 hourWeights 비워두고 defaultWeight 1.5 사용.
    // device PC 1.2 → 1.5 × 1.2 = 1.8 → Estimate 1100 × 1.8 = 1980 → guardrail upper 1200
    mockAdvertiserFindMany.mockResolvedValue([ADV])
    mockBiddingPolicyFindMany.mockResolvedValue([POLICY])
    mockTargetingRuleFindUnique.mockResolvedValue({
      enabled: true,
      defaultWeight: { toNumber: () => 1.5 },
      hourWeights: {},
      deviceWeights: { PC: 1.2 },
    })

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    expect(body.runsSuccess).toBe(1)
    // weight 1.8 → Estimate 1980 → guardrail upper 1200
    expect(mockUpdateKeyword).toHaveBeenCalledWith(
      "c-1",
      "ncc_kw_1",
      { bidAmt: 1200, useGroupBidAmt: false },
      "bidAmt,useGroupBidAmt",
    )
  })

  it("TargetingRule findUnique throw → errors[] + weight 1.0 fallback (cron 진행)", async () => {
    mockAdvertiserFindMany.mockResolvedValue([ADV])
    mockBiddingPolicyFindMany.mockResolvedValue([POLICY])
    mockTargetingRuleFindUnique.mockRejectedValue(new Error("DB connection lost"))

    const res = await GET(makeReq("Bearer test-secret") as never)
    const body = await res.json()
    // 에러 적재 + weight 1.0 으로 진행 → 정책 happy path (1100)
    expect(body.runsSuccess).toBe(1)
    expect(body.errors.some((e: { message: string }) =>
      e.message.includes("targeting_rule_load_failed"),
    )).toBe(true)
    expect(mockUpdateKeyword).toHaveBeenCalledWith(
      "c-1",
      "ncc_kw_1",
      { bidAmt: 1100, useGroupBidAmt: false },
      "bidAmt,useGroupBidAmt",
    )
  })

  it("findUnique 호출 인자 — { advertiserId } where + 4컬럼 select", async () => {
    mockAdvertiserFindMany.mockResolvedValue([ADV])
    mockBiddingPolicyFindMany.mockResolvedValue([])

    await GET(makeReq("Bearer test-secret") as never)

    expect(mockTargetingRuleFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { advertiserId: "adv_1" },
        select: expect.objectContaining({
          enabled: true,
          defaultWeight: true,
          hourWeights: true,
          deviceWeights: true,
        }),
      }),
    )
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

// =============================================================================
// Event 3 — guardrail_triggered 알림
// =============================================================================

describe("cron auto-bidding — guardrail_triggered dispatch", () => {
  it("광고주 단위 한도 초과 → dispatch 1회 (warn / dailyLimit 카운트 채움)", async () => {
    mockAdvertiserFindMany.mockResolvedValue([ADV])
    // 광고주 단위 한도 초과 — 정책 진입 X. dailyLimitOverride 와 함께 dispatch.
    mockCheckAdvGuardrail.mockResolvedValue({ ok: false, count: 99 })
    // (정책 진입 X — biddingPolicy.findMany / OR.count 호출 X)

    const res = await GET(makeReq("Bearer test-secret") as never)
    expect(res.status).toBe(200)

    expect(mockDispatch).toHaveBeenCalledTimes(1)
    const payload = mockDispatch.mock.calls[0][0]
    expect(payload.ruleType).toBe("guardrail_triggered")
    expect(payload.severity).toBe("warn")
    expect(payload.title).toContain("광고주1")
    expect(payload.title).toContain("99건")
    expect(payload.meta.advertiserId).toBe("adv_1")
    expect(payload.meta.customerId).toBe("c-1")
    expect(payload.meta.killSwitch).toBe(false)
    expect(payload.meta.breakdowns).toEqual({
      keywordLimit: 0,
      dailyLimit: 99,
    })
    // 정책 진입 X
    expect(mockBiddingPolicyFindMany).not.toHaveBeenCalled()
  })

  it("정책 루프 종료 후 keywordLimit 발동 → dispatch 1회 (breakdowns.keywordLimit)", async () => {
    mockAdvertiserFindMany.mockResolvedValue([ADV])
    // 정책 루프 안에서 keyword guardrail 1건 발동 — OR.count 가 1 리턴
    mockBiddingPolicyFindMany.mockResolvedValue([POLICY])
    mockCheckKwGuardrail.mockResolvedValue({ ok: false, count: 5 })
    mockORCount.mockResolvedValue(1)

    const res = await GET(makeReq("Bearer test-secret") as never)
    expect(res.status).toBe(200)

    expect(mockDispatch).toHaveBeenCalledTimes(1)
    const payload = mockDispatch.mock.calls[0][0]
    expect(payload.ruleType).toBe("guardrail_triggered")
    expect(payload.severity).toBe("warn")
    expect(payload.title).toContain("1건")
    expect(payload.meta.breakdowns).toEqual({
      keywordLimit: 1,
      dailyLimit: 0,
    })
  })

  it("발동 0건이면 dispatch 미호출 (정책 happy path)", async () => {
    mockAdvertiserFindMany.mockResolvedValue([ADV])
    mockBiddingPolicyFindMany.mockResolvedValue([POLICY])
    // OR.count = 0 → 발동 없음
    mockORCount.mockResolvedValue(0)

    const res = await GET(makeReq("Bearer test-secret") as never)
    expect(res.status).toBe(200)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it("payload meta 시크릿 평문 노출 X", async () => {
    mockAdvertiserFindMany.mockResolvedValue([ADV])
    mockCheckAdvGuardrail.mockResolvedValue({ ok: false, count: 1 })
    await GET(makeReq("Bearer test-secret") as never)
    expect(mockDispatch).toHaveBeenCalledTimes(1)
    const payload = mockDispatch.mock.calls[0][0]
    const all = JSON.stringify(payload)
    expect(all).not.toMatch(/Bearer\s+[A-Za-z0-9._\-]{12,}/u)
    expect(all).not.toMatch(/[A-Fa-f0-9]{32,}/u)
    expect(all).not.toContain("ENCRYPTION_KEY")
  })
})
