/**
 * lib/llm/anthropic.ts 단위 테스트 (Phase F.3).
 *
 * 외부 호출 0:
 *   - Anthropic SDK mock — 실 API 호출 X
 *   - prisma mock — 실 DB 호출 X
 *
 * 검증 범위:
 *   - computeInputHash: 동일 입력 → 동일 hash, 다른 입력 → 다른 hash
 *   - computeCostUsd: 모델별 가격 정확성
 *   - callLlm: 캐시 검사 → SDK 호출 → LlmCallLog 적재 흐름
 *   - callLlmWithFallback: API 키 없음 → 폴백 텍스트
 *   - assertMonthlyBudgetOk: env 한도 초과 시 throw
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

// =============================================================================
// Mocks
// =============================================================================

const mockCreate = vi.fn()
vi.mock("@anthropic-ai/sdk", () => {
  // new Anthropic({ apiKey }) 호출 가능하도록 일반 function constructor.
  // arrow function 은 constructor 호출 불가 → 명시적 function.
  function MockAnthropic(this: { messages: { create: typeof mockCreate } }) {
    this.messages = { create: mockCreate }
  }
  return { default: MockAnthropic }
})

const mockFindFirst = vi.fn()
const mockCallLogCreate = vi.fn()
const mockAggregate = vi.fn()

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    llmCallLog: {
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
      create: (...args: unknown[]) => mockCallLogCreate(...args),
      aggregate: (...args: unknown[]) => mockAggregate(...args),
    },
  },
}))

// =============================================================================
// 진입
// =============================================================================

import {
  callLlm,
  callLlmWithFallback,
  getMonthlyCostUsd,
  assertMonthlyBudgetOk,
  __test__,
} from "./anthropic"

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  mockCreate.mockReset()
  mockFindFirst.mockReset()
  mockCallLogCreate.mockReset()
  mockAggregate.mockReset()
  process.env = { ...ORIGINAL_ENV }
  process.env.ANTHROPIC_API_KEY = "test-key"
  delete process.env.LLM_MONTHLY_BUDGET_USD
})

// =============================================================================
// computeInputHash
// =============================================================================

describe("computeInputHash", () => {
  it("동일 입력 → 동일 hash", () => {
    const a = __test__.computeInputHash({
      purpose: "bid_suggestion_reason",
      model: "claude-haiku-4-5-20251001",
      prompt: "test",
    })
    const b = __test__.computeInputHash({
      purpose: "bid_suggestion_reason",
      model: "claude-haiku-4-5-20251001",
      prompt: "test",
    })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/) // SHA-256 hex
  })

  it("prompt 변경 → 다른 hash", () => {
    const a = __test__.computeInputHash({
      purpose: "bid_suggestion_reason",
      model: "claude-haiku-4-5-20251001",
      prompt: "test",
    })
    const b = __test__.computeInputHash({
      purpose: "bid_suggestion_reason",
      model: "claude-haiku-4-5-20251001",
      prompt: "different",
    })
    expect(a).not.toBe(b)
  })

  it("model 변경 → 다른 hash", () => {
    const a = __test__.computeInputHash({
      purpose: "bid_suggestion_reason",
      model: "claude-haiku-4-5-20251001",
      prompt: "test",
    })
    const b = __test__.computeInputHash({
      purpose: "bid_suggestion_reason",
      model: "claude-sonnet-4-6",
      prompt: "test",
    })
    expect(a).not.toBe(b)
  })
})

// =============================================================================
// computeCostUsd
// =============================================================================

describe("computeCostUsd", () => {
  it("haiku — 1M input + 1M output", () => {
    const cost = __test__.computeCostUsd(
      "claude-haiku-4-5-20251001",
      1_000_000,
      1_000_000,
    )
    // input $1 + output $5 = $6
    expect(cost).toBe(6)
  })

  it("sonnet — 1M input + 1M output", () => {
    const cost = __test__.computeCostUsd("claude-sonnet-4-6", 1_000_000, 1_000_000)
    // input $3 + output $15 = $18
    expect(cost).toBe(18)
  })

  it("haiku — 100 input + 50 output 소수 정밀", () => {
    const cost = __test__.computeCostUsd("claude-haiku-4-5-20251001", 100, 50)
    // input 100/1M × $1 = $0.0001 + output 50/1M × $5 = $0.00025 = $0.00035
    expect(cost).toBe(0.00035)
  })

  it("0 토큰 → 0 USD", () => {
    expect(__test__.computeCostUsd("claude-haiku-4-5-20251001", 0, 0)).toBe(0)
  })
})

// =============================================================================
// callLlm
// =============================================================================

describe("callLlm", () => {
  it("정상 호출 — SDK 호출 + LlmCallLog 적재 + 결과 반환", async () => {
    mockFindFirst.mockResolvedValueOnce(null) // 캐시 miss
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "응답 텍스트" }],
      usage: { input_tokens: 100, output_tokens: 50 },
      stop_reason: "end_turn",
    })
    mockCallLogCreate.mockResolvedValueOnce({})

    const r = await callLlm({
      purpose: "bid_suggestion_reason",
      model: "claude-haiku-4-5-20251001",
      prompt: "테스트 prompt",
    })

    expect(r.text).toBe("응답 텍스트")
    expect(r.fromCache).toBe(false)
    expect(r.tokensIn).toBe(100)
    expect(r.tokensOut).toBe(50)
    // haiku 100in + 50out cost
    expect(r.costUsd).toBe(0.00035)
    expect(r.inputHash).toMatch(/^[0-9a-f]{64}$/)

    // SDK 호출 인자 검증
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        temperature: 0.3,
      }),
    )

    // LlmCallLog 적재 인자 검증
    expect(mockCallLogCreate).toHaveBeenCalledTimes(1)
    const logCall = mockCallLogCreate.mock.calls[0][0]
    expect(logCall.data.purpose).toBe("bid_suggestion_reason")
    expect(logCall.data.fromCache).toBe(false)
    expect(logCall.data.result).toBe("success")
  })

  it("캐시 hit — 그래도 새 SDK 호출 (text 본문 미저장)", async () => {
    mockFindFirst.mockResolvedValueOnce({ id: "prev1" }) // 캐시 hit
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "새 응답" }],
      usage: { input_tokens: 100, output_tokens: 50 },
      stop_reason: "end_turn",
    })
    mockCallLogCreate.mockResolvedValueOnce({})

    const r = await callLlm({
      purpose: "bid_suggestion_reason",
      model: "claude-haiku-4-5-20251001",
      prompt: "동일 prompt",
    })

    expect(r.fromCache).toBe(true) // 메타 캐시 hit
    expect(r.text).toBe("새 응답") // 그래도 새 호출이라 새 응답
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it("API 키 미설정 → throw", async () => {
    delete process.env.ANTHROPIC_API_KEY
    mockFindFirst.mockResolvedValueOnce(null)
    mockCallLogCreate.mockResolvedValueOnce({})

    await expect(
      callLlm({
        purpose: "bid_suggestion_reason",
        model: "claude-haiku-4-5-20251001",
        prompt: "test",
      }),
    ).rejects.toThrow(/LLM 호출 실패|ANTHROPIC_API_KEY/)
  })

  it("SDK 에러 → result='error' LlmCallLog 적재 + throw", async () => {
    mockFindFirst.mockResolvedValueOnce(null)
    mockCreate.mockRejectedValueOnce(new Error("rate_limit"))
    mockCallLogCreate.mockResolvedValueOnce({})

    await expect(
      callLlm({
        purpose: "bid_suggestion_reason",
        model: "claude-haiku-4-5-20251001",
        prompt: "test",
      }),
    ).rejects.toThrow(/LLM 호출 실패/)

    const logCall = mockCallLogCreate.mock.calls[0][0]
    expect(logCall.data.result).toBe("error")
    expect(logCall.data.errorMessage).toContain("rate_limit")
  })

  it("refusal stop_reason → result='blocked'", async () => {
    mockFindFirst.mockResolvedValueOnce(null)
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "" }],
      usage: { input_tokens: 100, output_tokens: 0 },
      stop_reason: "refusal",
    })
    mockCallLogCreate.mockResolvedValueOnce({})

    await expect(
      callLlm({
        purpose: "bid_suggestion_reason",
        model: "claude-haiku-4-5-20251001",
        prompt: "test",
      }),
    ).rejects.toThrow(/blocked|refusal/i)

    const logCall = mockCallLogCreate.mock.calls[0][0]
    expect(logCall.data.result).toBe("blocked")
  })
})

// =============================================================================
// callLlmWithFallback
// =============================================================================

describe("callLlmWithFallback", () => {
  it("정상 호출 → usedLlm=true + LLM 텍스트", async () => {
    mockFindFirst.mockResolvedValueOnce(null)
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "LLM 응답" }],
      usage: { input_tokens: 100, output_tokens: 50 },
      stop_reason: "end_turn",
    })
    mockCallLogCreate.mockResolvedValueOnce({})

    const r = await callLlmWithFallback(
      {
        purpose: "bid_suggestion_reason",
        model: "claude-haiku-4-5-20251001",
        prompt: "test",
      },
      () => "폴백 텍스트",
    )

    expect(r.usedLlm).toBe(true)
    expect(r.text).toBe("LLM 응답")
  })

  it("API 키 미설정 → usedLlm=false + 폴백 텍스트", async () => {
    delete process.env.ANTHROPIC_API_KEY
    mockFindFirst.mockResolvedValueOnce(null)
    mockCallLogCreate.mockResolvedValueOnce({})

    const r = await callLlmWithFallback(
      {
        purpose: "bid_suggestion_reason",
        model: "claude-haiku-4-5-20251001",
        prompt: "test",
      },
      () => "폴백 텍스트",
    )

    expect(r.usedLlm).toBe(false)
    expect(r.text).toBe("폴백 텍스트")
  })
})

// =============================================================================
// assertMonthlyBudgetOk
// =============================================================================

describe("assertMonthlyBudgetOk", () => {
  it("env 미설정 → 검사 통과 (throw X)", async () => {
    await expect(assertMonthlyBudgetOk()).resolves.toBeUndefined()
  })

  it("env 50 + 사용 30 → 통과", async () => {
    process.env.LLM_MONTHLY_BUDGET_USD = "50"
    mockAggregate.mockResolvedValueOnce({ _sum: { costUsd: 30 } })
    await expect(assertMonthlyBudgetOk()).resolves.toBeUndefined()
  })

  it("env 50 + 사용 50 → throw (== 한도 도달)", async () => {
    process.env.LLM_MONTHLY_BUDGET_USD = "50"
    mockAggregate.mockResolvedValueOnce({ _sum: { costUsd: 50 } })
    await expect(assertMonthlyBudgetOk()).rejects.toThrow(/한도 초과/)
  })

  it("env 50 + 사용 100 → throw", async () => {
    process.env.LLM_MONTHLY_BUDGET_USD = "50"
    mockAggregate.mockResolvedValueOnce({ _sum: { costUsd: 100 } })
    await expect(assertMonthlyBudgetOk()).rejects.toThrow(/한도 초과/)
  })

  it("env 잘못된 값 (0 / 음수 / NaN) → 검사 무시", async () => {
    for (const v of ["0", "-10", "abc"]) {
      process.env.LLM_MONTHLY_BUDGET_USD = v
      await expect(assertMonthlyBudgetOk()).resolves.toBeUndefined()
    }
  })
})

describe("getMonthlyCostUsd", () => {
  it("agg null → 0", async () => {
    mockAggregate.mockResolvedValueOnce({ _sum: { costUsd: null } })
    expect(await getMonthlyCostUsd()).toBe(0)
  })
  it("agg 12.34 → 12.34", async () => {
    mockAggregate.mockResolvedValueOnce({ _sum: { costUsd: 12.34 } })
    expect(await getMonthlyCostUsd()).toBe(12.34)
  })
})
