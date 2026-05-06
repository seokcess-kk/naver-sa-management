/**
 * lib/llm/bid-reason.ts 단위 테스트 (Phase F.4).
 *
 * 외부 호출 0:
 *   - callLlmWithFallback mock — 실 LLM 호출 X
 *
 * 검증 범위:
 *   - buildSystemPrompt: 핵심 지시(수치 단정 금지 / 2~3 문장 / 한국어) 포함
 *   - buildUserPrompt: 검색어 + 권고 액션 + 메트릭 + defaultReason 모두 직렬화
 *     · null 메트릭 (revenue/roas/cpa) 누락 처리 검증
 *   - enrichBidReason:
 *     · LLM 성공 시 usedLlm=true + LLM 텍스트
 *     · 폴백 시 usedLlm=false + defaultReason 그대로
 *     · 모델 = haiku-4-5, maxTokens=300, temperature=0.3
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

import { Prisma } from "@/lib/generated/prisma/client"

// =============================================================================
// Mocks — callLlmWithFallback 만 mock (Anthropic SDK / prisma 미접근)
// =============================================================================

const mockCallLlmWithFallback = vi.fn()

vi.mock("@/lib/llm/anthropic", () => ({
  callLlmWithFallback: (...args: unknown[]) => mockCallLlmWithFallback(...args),
}))

// import 본체 — mock 등록 이후
import {
  enrichBidReason,
  buildSystemPrompt,
  buildUserPrompt,
  __test__,
} from "@/lib/llm/bid-reason"
import type { DecisionMetrics, SuggestAction } from "@/lib/auto-bidding/marginal-score"

beforeEach(() => {
  mockCallLlmWithFallback.mockReset()
})

// =============================================================================
// 공통 fixture
// =============================================================================

const SUGGEST_UP: SuggestAction = {
  currentBid: 1000,
  suggestedBid: 1150,
  deltaPct: 15,
  direction: "up",
}

const METRICS_FULL: DecisionMetrics = {
  clicks7d: 250,
  cost7d: 350_000,
  revenue7d: 1_500_000,
  currentRoas: 4.28,
  currentCpa: null,
  keywordCpc: 1400,
  keywordCtr: 2.5,
  avgRank7d: 3.2,
}

const METRICS_PARTIAL: DecisionMetrics = {
  clicks7d: 80,
  cost7d: 120_000,
  revenue7d: null,
  currentRoas: null,
  currentCpa: null,
  keywordCpc: 1500,
  keywordCtr: null,
  avgRank7d: null,
}

const DEFAULT_REASON = "ROAS 4.28x ≥ 목표 3.50x × 1.2 — 입찰 인상 여유"

// =============================================================================
// buildSystemPrompt
// =============================================================================

describe("buildSystemPrompt", () => {
  it("핵심 지시 포함 (전문가 톤 / 한국어 2~3 문장 / 수치 단정 금지 / 위험 요소 명시)", () => {
    const sys = buildSystemPrompt()
    expect(sys).toMatch(/네이버 검색광고/)
    expect(sys).toMatch(/한국어 2~3 문장/)
    expect(sys).toMatch(/절대 수치 단정 금지/)
    expect(sys).toMatch(/위험 요소/)
  })
})

// =============================================================================
// buildUserPrompt
// =============================================================================

describe("buildUserPrompt", () => {
  it("검색어 / 변경 권고 / 메트릭 / defaultReason 모두 직렬화", () => {
    const p = buildUserPrompt({
      searchTerm: "노트북 추천",
      suggestion: SUGGEST_UP,
      metrics: METRICS_FULL,
      defaultReason: DEFAULT_REASON,
    })

    // 검색어
    expect(p).toMatch(/"노트북 추천"/)

    // 권고
    expect(p).toMatch(/현재 입찰가: 1,000원/)
    expect(p).toMatch(/권고 입찰가: 1,150원/)
    expect(p).toMatch(/인상 15%/)

    // 메트릭
    expect(p).toMatch(/클릭: 250회/)
    expect(p).toMatch(/비용: 350,000원/)
    expect(p).toMatch(/매출: 1,500,000원/)
    expect(p).toMatch(/현재 ROAS: 4\.28배/)
    expect(p).toMatch(/키워드 CPC: 1,400원/)
    expect(p).toMatch(/키워드 CTR: 2\.50%/)
    expect(p).toMatch(/평균 노출 순위: 3\.2위/)

    // 정형 reason
    expect(p).toMatch(/시스템 산출 정형 사유/)
    expect(p).toMatch(DEFAULT_REASON)

    // 보강 요청 끝맺음
    expect(p).toMatch(/근거 \+ 위험 요소/)
  })

  it("null 메트릭 (revenue / roas / cpa) 라인 누락", () => {
    const p = buildUserPrompt({
      searchTerm: "테스트",
      suggestion: SUGGEST_UP,
      metrics: METRICS_PARTIAL,
      defaultReason: "x",
    })

    // 클릭 / 비용 / cpc 는 항상 표시
    expect(p).toMatch(/클릭: 80회/)
    expect(p).toMatch(/비용: 120,000원/)
    expect(p).toMatch(/키워드 CPC: 1,500원/)

    // null 항목은 라인 자체가 없어야 함
    expect(p).not.toMatch(/매출:/)
    expect(p).not.toMatch(/현재 ROAS:/)
    expect(p).not.toMatch(/현재 CPA:/)
  })

  it("direction='down' 시 '인하' 단어 사용", () => {
    const p = buildUserPrompt({
      searchTerm: "x",
      suggestion: { currentBid: 1000, suggestedBid: 850, deltaPct: 15, direction: "down" },
      metrics: METRICS_PARTIAL,
      defaultReason: "x",
    })
    expect(p).toMatch(/인하 15%/)
    expect(p).not.toMatch(/인상 15%/)
  })

  it("currentCpa 단독 노출 (ROAS null + CPA 값 있음)", () => {
    const p = buildUserPrompt({
      searchTerm: "x",
      suggestion: SUGGEST_UP,
      metrics: {
        clicks7d: 100,
        cost7d: 50_000,
        revenue7d: null,
        currentRoas: null,
        currentCpa: 12_345,
        keywordCpc: 500,
        keywordCtr: null,
        avgRank7d: null,
      },
      defaultReason: "x",
    })
    expect(p).toMatch(/현재 CPA: 12,345원/)
    expect(p).not.toMatch(/현재 ROAS:/)
  })
})

// =============================================================================
// enrichBidReason — happy + 폴백
// =============================================================================

describe("enrichBidReason", () => {
  it("LLM 성공 → usedLlm=true + LLM 텍스트", async () => {
    mockCallLlmWithFallback.mockResolvedValueOnce({
      text: "보강된 자연어 설명 (LLM)",
      usedLlm: true,
    })

    const r = await enrichBidReason({
      searchTerm: "노트북 추천",
      suggestion: SUGGEST_UP,
      metrics: METRICS_FULL,
      defaultReason: DEFAULT_REASON,
    })

    expect(r.usedLlm).toBe(true)
    expect(r.text).toBe("보강된 자연어 설명 (LLM)")
    expect(r.costUsd).toBe(0) // callLlmWithFallback 은 비용 미노출 — 본 PR 에서 0 고정

    // 호출 인자 검증
    expect(mockCallLlmWithFallback).toHaveBeenCalledTimes(1)
    const [callInput, fallback] = mockCallLlmWithFallback.mock.calls[0]
    expect(callInput.purpose).toBe("bid_suggestion_reason")
    expect(callInput.model).toBe("claude-haiku-4-5-20251001")
    expect(callInput.maxTokens).toBe(300)
    expect(callInput.temperature).toBe(0.3)
    expect(callInput.system).toMatch(/네이버 검색광고/)
    expect(callInput.prompt).toMatch(/노트북 추천/)
    expect(typeof fallback).toBe("function")
    expect(fallback()).toBe(DEFAULT_REASON)
  })

  it("폴백 (API 키 미설정 / 한도 초과 등) → usedLlm=false + defaultReason", async () => {
    mockCallLlmWithFallback.mockResolvedValueOnce({
      text: DEFAULT_REASON,
      usedLlm: false,
    })

    const r = await enrichBidReason({
      searchTerm: "x",
      suggestion: SUGGEST_UP,
      metrics: METRICS_PARTIAL,
      defaultReason: DEFAULT_REASON,
    })

    expect(r.usedLlm).toBe(false)
    expect(r.text).toBe(DEFAULT_REASON)
    expect(r.costUsd).toBe(0)
  })
})

// =============================================================================
// 상수 노출 검증 (회귀 차단)
// =============================================================================

describe("정책 상수", () => {
  it("ENRICH_MODEL = haiku-4-5", () => {
    expect(__test__.ENRICH_MODEL).toBe("claude-haiku-4-5-20251001")
  })
  it("ENRICH_MAX_TOKENS = 300 (2~3 문장 안전 한도)", () => {
    expect(__test__.ENRICH_MAX_TOKENS).toBe(300)
  })
  it("ENRICH_TEMPERATURE = 0.3 (보수적·일관성)", () => {
    expect(__test__.ENRICH_TEMPERATURE).toBe(0.3)
  })
})

// 본 모듈은 Decimal 미사용 — import 만 검증 (회귀 시 typecheck 실패)
describe("의존성 검증", () => {
  it("Prisma.Decimal import 가능 (간접: marginal-score 타입 의존)", () => {
    expect(typeof Prisma.Decimal).toBe("function")
  })
})
