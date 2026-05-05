/**
 * 일일 운영 요약 (Phase F.5 / SPEC F-13.2).
 *
 * 책임:
 *   - 광고주의 어제(KST) 운영 데이터 집계 + LLM(Sonnet 4.6) 1단락 요약 생성
 *   - 출력 텍스트는 호출자가 AlertEvent / dispatch 로 발송
 *
 * 핵심 원칙 (사용자 검토 + SPEC v0.2.1):
 *   - 절대 수치 단정 금지 (사례·추정 표현)
 *   - 운영자 행동 권고 1~2개 포함 (자율 실행 X — 운영자 검토)
 *   - 폴백 패턴 — API 키 없거나 한도 초과 시 정형 텍스트 자동 사용
 */

import { prisma } from "@/lib/db/prisma"
import {
  callLlmWithFallback,
  assertMonthlyBudgetOk,
  type LlmModel,
} from "@/lib/llm/anthropic"

// =============================================================================
// 타입
// =============================================================================

export type DailySummaryStats = {
  /** 어제 KST 0시 ~ 24시 OptimizationRun 결과 카운트 (정책 등록 키워드 자동 비딩). */
  optimizationRuns: {
    success: number
    skippedUserLock: number
    skippedDeleted: number
    skippedGuardrail: number
    skippedKillSwitch: number
    skippedNoChange: number
    failed: number
  }
  /** 어제 신규 적재된 BidSuggestion 카운트 (engineSource 별). */
  suggestionsCreated: {
    bid: number
    quality: number
    targeting: number
    budget: number
  }
  /** 어제 사용자가 적용한 BidSuggestion 카운트 (status='applied'). */
  suggestionsApplied: number
  /** 어제 발송된 AlertEvent 카운트 (severity 별). */
  alertEvents: {
    info: number
    warn: number
    critical: number
  }
}

export type DailySummaryInput = {
  advertiserId: string
  advertiserName: string
  /** KST yyyy-mm-dd. */
  date: string
  stats: DailySummaryStats
}

export type DailySummaryResult = {
  /** 1~2 단락 자연어 요약. */
  text: string
  /** LLM 호출 성공 여부 (false = 폴백 정형 텍스트). */
  usedLlm: boolean
}

// =============================================================================
// 정형 폴백 텍스트
// =============================================================================

function buildPlainSummary(input: DailySummaryInput): string {
  const o = input.stats.optimizationRuns
  const s = input.stats.suggestionsCreated
  const a = input.stats.alertEvents
  const oTotal =
    o.success +
    o.skippedUserLock +
    o.skippedDeleted +
    o.skippedGuardrail +
    o.skippedKillSwitch +
    o.skippedNoChange +
    o.failed
  const sTotal = s.bid + s.quality + s.targeting + s.budget

  return [
    `${input.date} ${input.advertiserName} 운영 요약`,
    `자동 비딩 ${oTotal}건 — 성공 ${o.success} / Guardrail ${o.skippedGuardrail} / 실패 ${o.failed}`,
    `Inbox 권고 신규 ${sTotal}건 (입찰 ${s.bid} / 품질 ${s.quality} / 타게팅 ${s.targeting} / 예산 ${s.budget})`,
    `Inbox 적용 ${input.stats.suggestionsApplied}건`,
    `알림 — info ${a.info} / warn ${a.warn} / critical ${a.critical}`,
  ].join(". ")
}

// =============================================================================
// LLM prompt
// =============================================================================

const SYSTEM_PROMPT = [
  "당신은 네이버 검색광고 운영 매니저입니다.",
  "주어진 광고주의 어제 운영 결과를 한국어 1~2 단락으로 요약하세요.",
  "",
  "규칙:",
  "- 절대 수치 단정 금지 (예: '1점 = 14% 절감' X). 가능하면 사례·추정으로 표현.",
  "- 운영자가 다음 행동을 결정할 수 있게 핵심 신호 1~2개 + 권고 액션 1개 포함.",
  "- 자율 실행 / 자동 변경 약속 X — 모든 변경은 운영자가 검토 후 적용한다는 점 인지.",
  "- 출력은 한국어 자연어 단락. bullet / 마크다운 / 코드 블록 X.",
  "- 길이: 200~400자.",
].join("\n")

function buildUserPrompt(input: DailySummaryInput): string {
  const o = input.stats.optimizationRuns
  const s = input.stats.suggestionsCreated
  const a = input.stats.alertEvents
  return JSON.stringify(
    {
      광고주: input.advertiserName,
      날짜: input.date,
      자동비딩: {
        성공: o.success,
        가드레일차단: o.skippedGuardrail,
        킬스위치차단: o.skippedKillSwitch,
        userLock차단: o.skippedUserLock,
        deleted차단: o.skippedDeleted,
        변경없음: o.skippedNoChange,
        실패: o.failed,
      },
      Inbox권고신규: {
        입찰: s.bid,
        품질: s.quality,
        타게팅: s.targeting,
        예산: s.budget,
      },
      Inbox적용: input.stats.suggestionsApplied,
      알림: {
        info: a.info,
        warn: a.warn,
        critical: a.critical,
      },
    },
    null,
    2,
  )
}

// =============================================================================
// 핵심 함수
// =============================================================================

/**
 * 일일 운영 요약 1단락 생성.
 *
 * 모델: Sonnet 4.6 (종합 분석 — 일일 1회만이라 비용 부담 적음)
 * 폴백: callLlmWithFallback — API 키 없거나 한도 초과 시 정형 텍스트
 */
export async function generateDailySummary(
  input: DailySummaryInput,
  opts: { model?: LlmModel } = {},
): Promise<DailySummaryResult> {
  const model = opts.model ?? "claude-sonnet-4-6"
  const fallback = () => buildPlainSummary(input)

  const r = await callLlmWithFallback(
    {
      purpose: "daily_summary",
      model,
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(input),
      maxTokens: 600,
      temperature: 0.4,
    },
    fallback,
  )

  return { text: r.text, usedLlm: r.usedLlm }
}

// =============================================================================
// 데이터 수집 — 어제(KST) 광고주 통계
// =============================================================================

/**
 * 어제(KST) 0시~24시 운영 데이터 집계.
 *
 * KST 어제 0시 = UTC 어제 -09:00. 즉 (now KST -1day) 의 UTC 변환.
 */
export async function collectDailyStats(
  advertiserId: string,
  now: Date = new Date(),
): Promise<DailySummaryStats & { yesterdayKst: string }> {
  // KST 오늘 0시 (UTC)
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  const kstTodayStartUtc = new Date(
    Date.UTC(
      kstNow.getUTCFullYear(),
      kstNow.getUTCMonth(),
      kstNow.getUTCDate(),
    ) - 9 * 60 * 60 * 1000,
  )
  // 어제 KST 0시 (UTC)
  const yesterdayStart = new Date(
    kstTodayStartUtc.getTime() - 24 * 60 * 60 * 1000,
  )
  const yesterdayEnd = kstTodayStartUtc

  // KST yyyy-mm-dd
  const kstYesterday = new Date(
    yesterdayStart.getTime() + 9 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10)

  // -- OptimizationRun 결과별 카운트 ---------------------------------------
  const optRows = await prisma.optimizationRun.groupBy({
    by: ["result"],
    where: {
      advertiserId,
      triggeredAt: { gte: yesterdayStart, lt: yesterdayEnd },
    },
    _count: { result: true },
  })
  const optCounts: DailySummaryStats["optimizationRuns"] = {
    success: 0,
    skippedUserLock: 0,
    skippedDeleted: 0,
    skippedGuardrail: 0,
    skippedKillSwitch: 0,
    skippedNoChange: 0,
    failed: 0,
  }
  for (const r of optRows) {
    const c = r._count.result
    switch (r.result) {
      case "success":
        optCounts.success += c
        break
      case "skipped_user_lock":
        optCounts.skippedUserLock += c
        break
      case "skipped_deleted":
        optCounts.skippedDeleted += c
        break
      case "skipped_guardrail":
        optCounts.skippedGuardrail += c
        break
      case "skipped_killswitch":
        optCounts.skippedKillSwitch += c
        break
      case "skipped_no_change":
        optCounts.skippedNoChange += c
        break
      case "failed":
        optCounts.failed += c
        break
    }
  }

  // -- BidSuggestion 신규 적재 (engineSource 별) ---------------------------
  const sugRows = await prisma.bidSuggestion.groupBy({
    by: ["engineSource"],
    where: {
      advertiserId,
      createdAt: { gte: yesterdayStart, lt: yesterdayEnd },
    },
    _count: { engineSource: true },
  })
  const sugCounts: DailySummaryStats["suggestionsCreated"] = {
    bid: 0,
    quality: 0,
    targeting: 0,
    budget: 0,
  }
  for (const r of sugRows) {
    const c = r._count.engineSource
    switch (r.engineSource) {
      case "bid":
        sugCounts.bid += c
        break
      case "quality":
        sugCounts.quality += c
        break
      case "targeting":
        sugCounts.targeting += c
        break
      case "budget":
        sugCounts.budget += c
        break
    }
  }

  // -- 어제 적용된 Suggestion 카운트 -----------------------------------------
  const appliedCount = await prisma.bidSuggestion.count({
    where: {
      advertiserId,
      status: "applied",
      // appliedBatchId 시점 = ChangeBatch.createdAt 근사 → updatedAt 사용
      updatedAt: { gte: yesterdayStart, lt: yesterdayEnd },
    },
  })

  // -- AlertEvent 발송 카운트 (severity payload 안에 있어 별도 raw) ---------
  // payload.severity 에서 추출 — severity 분류는 본 PR 단순화: 전체 카운트만
  const alertCount = await prisma.alertEvent.count({
    where: {
      createdAt: { gte: yesterdayStart, lt: yesterdayEnd },
      // payload 의 advertiserId 매칭은 JSON path query 필요 — 본 PR 은 광고주 무관 전체 카운트
      // (광고주 단위 분리는 후속 PR — payload.advertiserId 인덱스 추가 필요)
      status: "sent",
    },
  })

  return {
    optimizationRuns: optCounts,
    suggestionsCreated: sugCounts,
    suggestionsApplied: appliedCount,
    alertEvents: {
      // severity 분리는 후속 — 일단 전체를 info 로 표시
      info: alertCount,
      warn: 0,
      critical: 0,
    },
    yesterdayKst: kstYesterday,
  }
}

// =============================================================================
// 테스트용
// =============================================================================

export const __test__ = {
  buildPlainSummary,
  buildUserPrompt,
  SYSTEM_PROMPT,
}
