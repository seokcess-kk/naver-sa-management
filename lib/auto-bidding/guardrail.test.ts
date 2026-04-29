/**
 * F-11.5 — Guardrail 24h count 검증 단위 테스트.
 *
 * 외부 호출 0:
 *   - vi.mock("@/lib/db/prisma", ...) — optimizationRun.count stub
 *
 * 검증:
 *   1. checkKeywordGuardrail count < limit → ok=true
 *   2. checkKeywordGuardrail count == limit → ok=false (boundary)
 *   3. checkKeywordGuardrail count > limit → ok=false
 *   4. checkAdvertiserGuardrail 동일 분기
 *   5. where 절 검증 (advertiserId / policyId / result='success' / triggeredAt > now-24h)
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// =============================================================================
// Mocks
// =============================================================================

const mockCount = vi.fn()
vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    optimizationRun: {
      count: (...args: unknown[]) => mockCount(...args),
    },
  },
}))

import {
  checkKeywordGuardrail,
  checkAdvertiserGuardrail,
} from "@/lib/auto-bidding/guardrail"

// =============================================================================
// 공통 setup
// =============================================================================

beforeEach(() => {
  vi.clearAllMocks()
})

// =============================================================================
// checkKeywordGuardrail
// =============================================================================

describe("checkKeywordGuardrail", () => {
  it("count < limit → ok=true", async () => {
    mockCount.mockResolvedValue(2)
    const r = await checkKeywordGuardrail({
      advertiserId: "adv_1",
      policyId: "p_1",
      maxChangesPerKeyword: 3,
    })
    expect(r.ok).toBe(true)
    expect(r.count).toBe(2)
  })

  it("count == limit → ok=false (boundary)", async () => {
    mockCount.mockResolvedValue(3)
    const r = await checkKeywordGuardrail({
      advertiserId: "adv_1",
      policyId: "p_1",
      maxChangesPerKeyword: 3,
    })
    expect(r.ok).toBe(false)
    expect(r.count).toBe(3)
  })

  it("count > limit → ok=false", async () => {
    mockCount.mockResolvedValue(10)
    const r = await checkKeywordGuardrail({
      advertiserId: "adv_1",
      policyId: "p_1",
      maxChangesPerKeyword: 3,
    })
    expect(r.ok).toBe(false)
    expect(r.count).toBe(10)
  })

  it("where 절: advertiserId + policyId + result='success' + triggeredAt > now-24h", async () => {
    mockCount.mockResolvedValue(0)
    const before = Date.now()
    await checkKeywordGuardrail({
      advertiserId: "adv_X",
      policyId: "p_X",
      maxChangesPerKeyword: 3,
    })
    const after = Date.now()

    expect(mockCount).toHaveBeenCalledTimes(1)
    const arg = mockCount.mock.calls[0][0] as {
      where: {
        advertiserId: string
        policyId: string
        result: string
        triggeredAt: { gt: Date }
      }
    }
    expect(arg.where.advertiserId).toBe("adv_X")
    expect(arg.where.policyId).toBe("p_X")
    expect(arg.where.result).toBe("success")
    const gt = arg.where.triggeredAt.gt.getTime()
    // 약 24h 전 +- 약간
    expect(gt).toBeGreaterThanOrEqual(before - 24 * 60 * 60 * 1000)
    expect(gt).toBeLessThanOrEqual(after - 24 * 60 * 60 * 1000)
  })
})

// =============================================================================
// checkAdvertiserGuardrail
// =============================================================================

describe("checkAdvertiserGuardrail", () => {
  it("count < limit → ok=true", async () => {
    mockCount.mockResolvedValue(40)
    const r = await checkAdvertiserGuardrail({
      advertiserId: "adv_1",
      maxChangesPerDay: 50,
    })
    expect(r.ok).toBe(true)
    expect(r.count).toBe(40)
  })

  it("count >= limit → ok=false", async () => {
    mockCount.mockResolvedValue(50)
    const r = await checkAdvertiserGuardrail({
      advertiserId: "adv_1",
      maxChangesPerDay: 50,
    })
    expect(r.ok).toBe(false)
    expect(r.count).toBe(50)
  })

  it("where 절: advertiserId + result='success' + triggeredAt > now-24h (policyId 절 없음)", async () => {
    mockCount.mockResolvedValue(0)
    await checkAdvertiserGuardrail({
      advertiserId: "adv_Y",
      maxChangesPerDay: 50,
    })

    expect(mockCount).toHaveBeenCalledTimes(1)
    const arg = mockCount.mock.calls[0][0] as {
      where: {
        advertiserId: string
        result: string
        triggeredAt: { gt: Date }
        policyId?: unknown
      }
    }
    expect(arg.where.advertiserId).toBe("adv_Y")
    expect(arg.where.result).toBe("success")
    expect(arg.where.policyId).toBeUndefined()
  })
})
