/**
 * BidSuggestion reason LLM enrich (Phase F.4 — lazy on-demand).
 *
 * 책임:
 *   - 입찰 권고 1건의 정형 reason 을 자연어 2~3 문장으로 보강
 *   - 비용 안전: bid-suggest cron 자동 호출 X — Inbox UI 사용자 클릭 시에만
 *   - LLM 미설정 / 실패 시 callLlmWithFallback → defaultReason 그대로 반환 (호출자 무시 가능)
 *
 * 핵심 원칙 (사용자 검토 + SPEC v0.2.1):
 *   - LLM 은 분석·설명 전용. 모든 변경은 사용자 확정 거침 (Tool Use X).
 *   - 절대 수치 단정 금지 — system prompt 에 명시 ("1점 ≈ 14% 절감" 같은 가짜 인과 차단)
 *   - 운영자 검토 가능한 텍스트: 근거 + 위험 요소 명시
 *   - 모델: claude-haiku-4-5-20251001 (저비용)
 *   - 1회 호출 비용 추정: 입력 ~400 토큰 + 출력 ~200 토큰 → $0.001 ~ $0.005
 *
 * 호출자:
 *   - app/(dashboard)/[advertiserId]/bid-inbox/actions.ts → enrichSuggestionReason
 *   - 결과는 BidSuggestion.action JSON 에 llmEnrichedReason 으로 1회 저장 (재호출 방지)
 *
 * 비대상:
 *   - bid-suggest cron 자동 enrich (월 비용 폭증 방지 — 명시적 사용자 클릭만)
 *   - engineSource ≠ 'bid' (quality / targeting / budget — 후속 PR 의 별도 prompt 필요)
 *   - 다국어 (현재 한국어 고정)
 *
 * SPEC: SPEC v0.2.1 F-13 + plan(graceful-sparking-graham) Phase F.4
 */

import { callLlmWithFallback, type LlmModel } from "@/lib/llm/anthropic"
import type {
  DecisionMetrics,
  SuggestAction,
} from "@/lib/auto-bidding/marginal-score"

// =============================================================================
// 입출력 타입
// =============================================================================

export type EnrichBidReasonInput = {
  /** 원본 키워드 텍스트 — prompt 검색어 컨텍스트 */
  searchTerm: string
  /** 권고 액션 (currentBid / suggestedBid / deltaPct / direction) */
  suggestion: SuggestAction
  /** 결정 메트릭 (clicks7d / cost7d / currentRoas / currentCpa / keywordCpc / keywordCtr / avgRank7d / revenue7d) */
  metrics: DecisionMetrics
  /** 정형 reason — marginal-score.decideMarginalSuggestion 출력 텍스트 */
  defaultReason: string
}

export type EnrichBidReasonResult = {
  /** 보강된 자연어 텍스트 (LLM) 또는 defaultReason (폴백) */
  text: string
  /** LLM 사용 여부 — false 면 defaultReason 그대로 (UI 가 표시 분기 가능) */
  usedLlm: boolean
  /** 호출 비용 (USD). 폴백이면 0. */
  costUsd: number
}

// =============================================================================
// 모델·정책 상수
// =============================================================================

/** F.4 enrich 전용 — Haiku 4.5 고정 (저비용). */
const ENRICH_MODEL: LlmModel = "claude-haiku-4-5-20251001"

/** 출력 토큰 한도 — 2~3 문장 충분. */
const ENRICH_MAX_TOKENS = 300

/** 일관성 / 보수적 출력. */
const ENRICH_TEMPERATURE = 0.3

// =============================================================================
// Prompt 빌더
// =============================================================================

/**
 * system prompt — 운영자 친화 톤 + 가짜 수치 단정 차단.
 *
 * 의도:
 *   - "당신은 ~ 전문가입니다" 톤으로 신뢰성 부여
 *   - 분량 강제 (2~3 문장) — 운영자가 빨리 훑을 수 있도록
 *   - 수치 단정 금지 (예: "1점 ≈ 14% 절감") — 구체 수치는 입력 메트릭만 인용
 *   - 위험 요소 명시 강제
 */
export function buildSystemPrompt(): string {
  return [
    "당신은 네이버 검색광고 운영 전문가입니다.",
    "입찰 변경 권고의 이유를 한국어 2~3 문장으로 설명하세요.",
    "절대 수치 단정 금지 (예: '1점 ≈ 14% 절감' 같은 임의 인과 표현 X).",
    "운영자가 검토 후 적용할지 판단할 수 있게 근거 + 위험 요소를 함께 명시하세요.",
    "구체 수치는 사용자가 제공한 메트릭만 인용하고, 추정은 '~으로 보입니다' 등 완곡어로 표현.",
  ].join(" ")
}

/**
 * user prompt — 권고 액션 + 메트릭 + 정형 reason 병합.
 *
 * privacy:
 *   - 시크릿·고객 개인정보 주입 X (검색어 + 숫자만)
 *   - searchTerm 은 키워드 텍스트라 노출 OK (광고 입찰 대상이라 운영자 본인이 등록한 값)
 */
export function buildUserPrompt(input: EnrichBidReasonInput): string {
  const { searchTerm, suggestion, metrics, defaultReason } = input

  const lines: string[] = []
  lines.push("## 권고 대상")
  lines.push(`- 검색어: "${searchTerm}"`)

  lines.push("")
  lines.push("## 변경 권고")
  lines.push(`- 현재 입찰가: ${suggestion.currentBid.toLocaleString()}원`)
  lines.push(
    `- 권고 입찰가: ${suggestion.suggestedBid.toLocaleString()}원 (${
      suggestion.direction === "up" ? "인상" : "인하"
    } ${suggestion.deltaPct}%)`,
  )

  lines.push("")
  lines.push("## 7일 누적 메트릭")
  lines.push(`- 클릭: ${metrics.clicks7d.toLocaleString()}회`)
  lines.push(`- 비용: ${Math.round(metrics.cost7d).toLocaleString()}원`)
  if (metrics.revenue7d != null) {
    lines.push(`- 매출: ${Math.round(metrics.revenue7d).toLocaleString()}원`)
  }
  if (metrics.currentRoas != null) {
    lines.push(`- 현재 ROAS: ${metrics.currentRoas.toFixed(2)}배`)
  }
  if (metrics.currentCpa != null) {
    lines.push(`- 현재 CPA: ${Math.round(metrics.currentCpa).toLocaleString()}원`)
  }
  if (metrics.keywordCpc != null) {
    lines.push(
      `- 키워드 CPC: ${Math.round(metrics.keywordCpc).toLocaleString()}원`,
    )
  }
  if (metrics.keywordCtr != null) {
    lines.push(`- 키워드 CTR: ${metrics.keywordCtr.toFixed(2)}%`)
  }
  if (metrics.avgRank7d != null) {
    lines.push(`- 평균 노출 순위: ${metrics.avgRank7d.toFixed(1)}위`)
  }

  lines.push("")
  lines.push("## 시스템 산출 정형 사유")
  lines.push(defaultReason)

  lines.push("")
  lines.push(
    "위 정보 기반으로, 운영자가 적용 여부를 판단할 수 있도록 자연어 설명을 보강해주세요. 근거 + 위험 요소를 함께 2~3 문장으로 작성.",
  )

  return lines.join("\n")
}

// =============================================================================
// 핵심 함수
// =============================================================================

/**
 * BidSuggestion reason 을 LLM 으로 보강.
 *
 * 흐름:
 *   1. system / user prompt 빌드
 *   2. callLlmWithFallback 호출 (월 한도 + API 키 미설정 + 호출 실패 모두 폴백)
 *   3. 폴백 시 defaultReason 그대로 반환 (호출자가 toast 노출 등 분기 가능)
 *
 * 호출자 패턴:
 *   const r = await enrichBidReason({ searchTerm, suggestion, metrics, defaultReason })
 *   if (r.usedLlm) {
 *     // 새 텍스트 보존 + UI 표시
 *   } else {
 *     // 정형 reason 그대로 — 사용자에게 안내 (toast.warning("AI 설명 사용 불가"))
 *   }
 */
export async function enrichBidReason(
  input: EnrichBidReasonInput,
): Promise<EnrichBidReasonResult> {
  const system = buildSystemPrompt()
  const prompt = buildUserPrompt(input)

  const r = await callLlmWithFallback(
    {
      purpose: "bid_suggestion_reason",
      model: ENRICH_MODEL,
      system,
      prompt,
      maxTokens: ENRICH_MAX_TOKENS,
      temperature: ENRICH_TEMPERATURE,
    },
    () => input.defaultReason,
  )

  return {
    text: r.text,
    usedLlm: r.usedLlm,
    // callLlmWithFallback 은 비용 노출 X — 후속 PR 에서 noisy 노출 시 callLlm 직접 호출로 변경
    costUsd: 0,
  }
}

// =============================================================================
// 테스트 export (단위 테스트가 prompt 직접 검증)
// =============================================================================

export const __test__ = {
  buildSystemPrompt,
  buildUserPrompt,
  ENRICH_MODEL,
  ENRICH_MAX_TOKENS,
  ENRICH_TEMPERATURE,
}
