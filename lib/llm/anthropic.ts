/**
 * Anthropic API 호출 인프라 (Phase F.3).
 *
 * 책임:
 *   - Anthropic SDK 싱글턴 + 비용·토큰 LlmCallLog 적재
 *   - 호출자(F.4 BidSuggestion enrich / F.5 일일 요약 등)가 callLlm() 만 사용
 *
 * 핵심 원칙 (사용자 검토 + SPEC v0.2.1):
 *   - LLM 은 분석·설명 전용. Tool Use / 자동 실행 X — 본 모듈은 단순 텍스트 in/out.
 *   - prompt / response 본문 미저장 — inputHash 만 (privacy: 시크릿·PII 누설 차단).
 *   - 모델별 토큰 가격 코드 상수 (env 오버라이드는 후속 PR).
 *   - text 본문 캐시 없음 (동일 입력도 매번 API 호출) — Upstash KV 캐시는 후속 PR.
 *   - API 키 미설정 시 throw — 호출자가 try/catch 후 폴백 (정형 텍스트 등).
 *
 * 비대상:
 *   - 스트리밍 응답 (본 시스템은 매시간 cron 일괄 — 스트리밍 불필요)
 *   - Tool Use / 함수 호출 (SPEC 비대상)
 *   - 멀티턴 대화 (단일 prompt → 단일 response)
 *
 * SPEC: SPEC v0.2.1 F-13 + plan(graceful-sparking-graham) Phase F.3
 */

import Anthropic from "@anthropic-ai/sdk"
import { createHash } from "node:crypto"

import { prisma } from "@/lib/db/prisma"
import { Prisma } from "@/lib/generated/prisma/client"

// =============================================================================
// 모델·가격 상수
// =============================================================================

/** 사용 가능 모델 — 호출부 type 안전. */
export type LlmModel =
  | "claude-haiku-4-5-20251001"
  | "claude-sonnet-4-6"

/** 토큰당 USD 가격 (Anthropic 공시 기준 — 변동 가능). */
const MODEL_PRICING: Record<
  LlmModel,
  { inputPerMTok: number; outputPerMTok: number }
> = {
  // Haiku 4.5: 빠르고 저렴 — BidSuggestion reason / 검수 분류 용도
  "claude-haiku-4-5-20251001": {
    inputPerMTok: 1.0,
    outputPerMTok: 5.0,
  },
  // Sonnet 4.6: 종합 분석 — 일일 요약(F-13.2) 용도
  "claude-sonnet-4-6": {
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
  },
}

// =============================================================================
// 타입
// =============================================================================

export type LlmPurpose =
  | "bid_suggestion_reason"
  | "daily_summary"

export type CallLlmInput = {
  purpose: LlmPurpose
  model: LlmModel
  /** 시스템 prompt (선택). */
  system?: string
  /** 사용자 prompt 본문. */
  prompt: string
  /** 최대 출력 토큰. 기본 500. */
  maxTokens?: number
  /** temperature. 기본 0.3 (분석·설명 일관성). */
  temperature?: number
}

export type CallLlmResult = {
  /** 응답 텍스트 (단일 turn). */
  text: string
  /**
   * 캐시 hit 여부. text 본문 캐시가 없어 항상 false — 필드는 CallLlmResult shape 유지용.
   * (기존 findRecentCallLog 메타 캐시 조회는 매 호출 무의미 DB 왕복이라 제거.)
   */
  fromCache: boolean
  /** 사용된 모델. */
  model: LlmModel
  /** 호출 비용 (USD). 캐시 hit 면 0. */
  costUsd: number
  /** 입력·출력 토큰 (캐시 hit 면 0). */
  tokensIn: number
  tokensOut: number
  /** 캐시 키 (디버깅·재호출). */
  inputHash: string
}

// =============================================================================
// 싱글턴 클라이언트
// =============================================================================

let _client: Anthropic | null = null

function getClient(): Anthropic {
  if (_client) return _client
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error(
      "LLM 호출 불가 — ANTHROPIC_API_KEY 미설정. 호출자가 정형 텍스트 폴백 처리.",
    )
  }
  _client = new Anthropic({ apiKey })
  return _client
}

// =============================================================================
// 입력 해시
// =============================================================================

/**
 * SHA-256(model + system + prompt + maxTokens + temperature) → 캐시 키.
 *
 * privacy: 본 hash 만 DB 적재. prompt 본문은 저장 X.
 */
function computeInputHash(input: CallLlmInput): string {
  const h = createHash("sha256")
  h.update(input.model)
  h.update("|")
  h.update(input.system ?? "")
  h.update("|")
  h.update(input.prompt)
  h.update("|")
  h.update(String(input.maxTokens ?? 500))
  h.update("|")
  h.update(String(input.temperature ?? 0.3))
  return h.digest("hex")
}

// =============================================================================
// 비용 산출
// =============================================================================

function computeCostUsd(
  model: LlmModel,
  tokensIn: number,
  tokensOut: number,
): number {
  const p = MODEL_PRICING[model]
  if (!p) return 0
  const inputCost = (tokensIn / 1_000_000) * p.inputPerMTok
  const outputCost = (tokensOut / 1_000_000) * p.outputPerMTok
  return Number((inputCost + outputCost).toFixed(6))
}

// =============================================================================
// 핵심 함수
// =============================================================================

/**
 * Anthropic Messages API 호출.
 *
 * 흐름:
 *   1. inputHash 계산 (LlmCallLog 적재 키 — 본문 미저장 privacy)
 *   2. Anthropic SDK 호출 → text 추출 → 비용 산출
 *   3. LlmCallLog 적재 (fromCache=false)
 *   4. 결과 반환
 *
 * **text 본문 캐시 부재**: 동일 입력 재호출도 매번 새 API 호출 (텍스트는 결정론적이라
 * 거의 동일하나 비용 발생). text 캐시는 Upstash KV 도입 후 별도 PR.
 */
export async function callLlm(input: CallLlmInput): Promise<CallLlmResult> {
  const inputHash = computeInputHash(input)

  let text = ""
  let tokensIn = 0
  let tokensOut = 0
  let result: "success" | "error" | "blocked" = "success"
  let errorMessage: string | null = null

  try {
    const client = getClient()
    const message = await client.messages.create({
      model: input.model,
      max_tokens: input.maxTokens ?? 500,
      temperature: input.temperature ?? 0.3,
      system: input.system,
      messages: [{ role: "user", content: input.prompt }],
    })

    // 응답 — content 배열의 text 블록만 합산 (Tool Use 비대상)
    text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")

    tokensIn = message.usage.input_tokens
    tokensOut = message.usage.output_tokens

    if (message.stop_reason === "refusal") {
      result = "blocked"
      errorMessage = "Anthropic refused (safety policy)"
    }
  } catch (e) {
    result = "error"
    errorMessage = e instanceof Error ? e.message : String(e)
  }

  const costUsd = computeCostUsd(input.model, tokensIn, tokensOut)

  // LlmCallLog 적재 — fromCache=false (원본 호출).
  await prisma.llmCallLog.create({
    data: {
      purpose: input.purpose,
      model: input.model,
      inputHash,
      tokensIn,
      tokensOut,
      costUsd: new Prisma.Decimal(costUsd),
      fromCache: false,
      result,
      errorMessage: errorMessage?.slice(0, 500),
    },
  })

  if (result !== "success") {
    throw new Error(`LLM 호출 실패 (${result}): ${errorMessage ?? "unknown"}`)
  }

  return {
    text,
    fromCache: false,
    model: input.model,
    costUsd,
    tokensIn,
    tokensOut,
    inputHash,
  }
}

// =============================================================================
// 비용 가드 (월 한도 검사 — 호출 전)
// =============================================================================

/**
 * 이번 달 누적 비용 (USD) 조회.
 *
 * KST 기준 1일 0시부터 현재까지 LlmCallLog.costUsd 합산.
 */
export async function getMonthlyCostUsd(): Promise<number> {
  const now = new Date()
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  const monthStartKst = new Date(
    Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), 1),
  )
  // KST 1일 0시 → UTC 변환
  const monthStartUtc = new Date(monthStartKst.getTime() - 9 * 60 * 60 * 1000)

  const agg = await prisma.llmCallLog.aggregate({
    where: { createdAt: { gte: monthStartUtc } },
    _sum: { costUsd: true },
  })
  return agg._sum.costUsd ? Number(agg._sum.costUsd) : 0
}

/**
 * 월 한도 초과 시 throw — 호출자가 callLlm() 직전 검사.
 *
 * env LLM_MONTHLY_BUDGET_USD 미설정 시 무제한 (검사 통과).
 */
export async function assertMonthlyBudgetOk(): Promise<void> {
  const limit = process.env.LLM_MONTHLY_BUDGET_USD
  if (!limit) return
  const limitNum = Number(limit)
  if (!Number.isFinite(limitNum) || limitNum <= 0) return
  const used = await getMonthlyCostUsd()
  if (used >= limitNum) {
    throw new Error(
      `LLM 월 한도 초과 — 사용 ${used.toFixed(2)} USD / 한도 ${limitNum.toFixed(2)} USD`,
    )
  }
}

// =============================================================================
// 헬퍼 — 호출자 편의 (정형 폴백 패턴)
// =============================================================================

/**
 * callLlm 을 try/catch 로 감싸 LLM 미설정 / 실패 시 폴백 텍스트 반환.
 *
 * 호출자 패턴:
 *   const reason = await callLlmWithFallback(
 *     { purpose, model, prompt },
 *     () => "정형 텍스트 폴백",
 *   )
 */
export async function callLlmWithFallback(
  input: CallLlmInput,
  fallback: () => string,
): Promise<{ text: string; usedLlm: boolean }> {
  try {
    await assertMonthlyBudgetOk()
    const r = await callLlm(input)
    return { text: r.text, usedLlm: true }
  } catch (e) {
    console.warn(
      `[llm] 폴백 사용 — purpose=${input.purpose}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
    return { text: fallback(), usedLlm: false }
  }
}

// =============================================================================
// 테스트용 export
// =============================================================================

export const __test__ = {
  computeInputHash,
  computeCostUsd,
  MODEL_PRICING,
}
