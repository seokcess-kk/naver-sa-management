/**
 * lib/llm/daily-summary.ts 단위 테스트 (Phase F.5).
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

const mockCallLlmWithFallback = vi.fn()
const mockAssertBudget = vi.fn()

vi.mock("@/lib/llm/anthropic", () => ({
  callLlmWithFallback: (...args: unknown[]) => mockCallLlmWithFallback(...args),
  assertMonthlyBudgetOk: (...args: unknown[]) => mockAssertBudget(...args),
}))

const mockOptGroupBy = vi.fn()
const mockSugGroupBy = vi.fn()
const mockSugCount = vi.fn()
const mockAlertCount = vi.fn()

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    optimizationRun: {
      groupBy: (...args: unknown[]) => mockOptGroupBy(...args),
    },
    bidSuggestion: {
      groupBy: (...args: unknown[]) => mockSugGroupBy(...args),
      count: (...args: unknown[]) => mockSugCount(...args),
    },
    alertEvent: {
      count: (...args: unknown[]) => mockAlertCount(...args),
    },
  },
}))

import {
  generateDailySummary,
  collectDailyStats,
  __test__,
} from "./daily-summary"

beforeEach(() => {
  mockCallLlmWithFallback.mockReset()
  mockAssertBudget.mockReset()
  mockOptGroupBy.mockReset()
  mockSugGroupBy.mockReset()
  mockSugCount.mockReset()
  mockAlertCount.mockReset()
})

const baseInput = {
  advertiserId: "adv1",
  advertiserName: "렌트박스",
  date: "2026-05-04",
  stats: {
    optimizationRuns: {
      success: 50,
      skippedUserLock: 2,
      skippedDeleted: 0,
      skippedGuardrail: 5,
      skippedKillSwitch: 0,
      skippedNoChange: 10,
      failed: 1,
    },
    suggestionsCreated: { bid: 30, quality: 5, targeting: 1, budget: 0 },
    suggestionsApplied: 12,
    alertEvents: { info: 5, warn: 2, critical: 0 },
  },
}

describe("buildPlainSummary (폴백)", () => {
  it("핵심 필드 포함", () => {
    const text = __test__.buildPlainSummary(baseInput)
    expect(text).toContain("2026-05-04")
    expect(text).toContain("렌트박스")
    expect(text).toContain("자동 비딩")
    expect(text).toContain("Inbox 권고")
    expect(text).toContain("적용 12")
  })
})

describe("buildUserPrompt", () => {
  it("JSON 구조 + 핵심 필드", () => {
    const p = __test__.buildUserPrompt(baseInput)
    expect(p).toContain("렌트박스")
    expect(p).toContain("2026-05-04")
    expect(p).toContain("자동비딩")
    expect(p).toContain("Inbox권고신규")
  })
})

describe("SYSTEM_PROMPT 정책", () => {
  it("절대 수치 단정 금지 + 자율 실행 X 명시", () => {
    expect(__test__.SYSTEM_PROMPT).toContain("절대 수치 단정 금지")
    expect(__test__.SYSTEM_PROMPT).toContain("자율 실행")
  })
})

describe("generateDailySummary", () => {
  it("정상 호출 — LLM text 반환", async () => {
    mockCallLlmWithFallback.mockResolvedValueOnce({
      text: "어제 렌트박스 광고주는 ...",
      usedLlm: true,
    })
    const r = await generateDailySummary(baseInput)
    expect(r.usedLlm).toBe(true)
    expect(r.text).toContain("렌트박스")
    // model 기본값
    expect(mockCallLlmWithFallback).toHaveBeenCalled()
    const call = mockCallLlmWithFallback.mock.calls[0][0]
    expect(call.model).toBe("claude-sonnet-4-6")
    expect(call.purpose).toBe("daily_summary")
  })

  it("폴백 시 정형 텍스트 반환", async () => {
    mockCallLlmWithFallback.mockImplementationOnce(async (_input, fallback) => ({
      text: fallback(),
      usedLlm: false,
    }))
    const r = await generateDailySummary(baseInput)
    expect(r.usedLlm).toBe(false)
    expect(r.text).toContain("렌트박스")
    expect(r.text).toContain("자동 비딩")
  })

  it("model 옵션 override", async () => {
    mockCallLlmWithFallback.mockResolvedValueOnce({ text: "x", usedLlm: true })
    await generateDailySummary(baseInput, { model: "claude-haiku-4-5-20251001" })
    const call = mockCallLlmWithFallback.mock.calls[0][0]
    expect(call.model).toBe("claude-haiku-4-5-20251001")
  })
})

describe("collectDailyStats", () => {
  it("groupBy / count 호출 + KST 어제 산출", async () => {
    mockOptGroupBy.mockResolvedValueOnce([
      { result: "success", _count: { result: 50 } },
      { result: "failed", _count: { result: 1 } },
      { result: "skipped_guardrail", _count: { result: 5 } },
    ])
    mockSugGroupBy.mockResolvedValueOnce([
      { engineSource: "bid", _count: { engineSource: 30 } },
      { engineSource: "quality", _count: { engineSource: 5 } },
    ])
    mockSugCount.mockResolvedValueOnce(12)
    mockAlertCount.mockResolvedValueOnce(7)

    // 2026-05-05 KST 02:00 = UTC 2026-05-04 17:00
    const fixedNow = new Date("2026-05-04T17:00:00Z")
    const r = await collectDailyStats("adv1", fixedNow)

    expect(r.optimizationRuns.success).toBe(50)
    expect(r.optimizationRuns.failed).toBe(1)
    expect(r.optimizationRuns.skippedGuardrail).toBe(5)
    expect(r.suggestionsCreated.bid).toBe(30)
    expect(r.suggestionsCreated.quality).toBe(5)
    expect(r.suggestionsCreated.targeting).toBe(0)
    expect(r.suggestionsApplied).toBe(12)
    expect(r.alertEvents.info).toBe(7)
    // KST 어제 = 2026-05-04
    expect(r.yesterdayKst).toBe("2026-05-04")
  })

  it("groupBy / count 빈 결과 → 모두 0", async () => {
    mockOptGroupBy.mockResolvedValueOnce([])
    mockSugGroupBy.mockResolvedValueOnce([])
    mockSugCount.mockResolvedValueOnce(0)
    mockAlertCount.mockResolvedValueOnce(0)

    const r = await collectDailyStats("adv1", new Date("2026-05-04T17:00:00Z"))
    expect(r.optimizationRuns.success).toBe(0)
    expect(r.suggestionsCreated.bid).toBe(0)
    expect(r.suggestionsApplied).toBe(0)
    expect(r.alertEvents.info).toBe(0)
  })
})
