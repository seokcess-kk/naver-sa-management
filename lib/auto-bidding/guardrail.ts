/**
 * F-11.5 — 자동 비딩 Guardrail (24h 변경 횟수 한도).
 *
 * 두 단위 검사 (둘 다 AND — 어느 쪽이든 초과면 차단):
 *   1. 키워드(=정책) 단위: `OptimizationRun(advertiserId, policyId, result='success', triggeredAt > now-24h)` 카운트
 *   2. 광고주 단위:        `OptimizationRun(advertiserId, result='success', triggeredAt > now-24h)` 카운트
 *
 * 'skipped_*' / 'failed' 는 변경이 발생하지 않았으므로 카운트에서 제외 (db_guardrail.md 규약).
 * 키워드 한도는 정책(policyId) 단위로 좁혀 — 같은 키워드 PC/MOBILE 정책은 별도 카운트.
 *
 * 본 모듈은 prisma 의존만. cron / Server Action 양측에서 재사용.
 *
 * SPEC: SPEC v0.2.1 F-11.5
 */

import { prisma } from "@/lib/db/prisma"

// =============================================================================
// 24h 윈도 헬퍼
// =============================================================================

const ONE_DAY_MS = 24 * 60 * 60 * 1000

function gtNow24h(): Date {
  return new Date(Date.now() - ONE_DAY_MS)
}

// =============================================================================
// 키워드(=정책) 단위 한도
// =============================================================================

export type CheckKeywordGuardrailArgs = {
  advertiserId: string
  policyId: string
  /** Advertiser.guardrailMaxChangesPerKeyword (1..20). */
  maxChangesPerKeyword: number
}

export type GuardrailResult = {
  /** count < limit 일 때 true. */
  ok: boolean
  /** 24h 내 success 카운트 (디버깅 / OptimizationRun.errorMessage 적재용). */
  count: number
}

/**
 * 키워드(=정책) 단위 24h 한도 검사.
 *
 * @returns ok=false 이면 호출부는 OptimizationRun.result='skipped_guardrail' 적재.
 */
export async function checkKeywordGuardrail(
  args: CheckKeywordGuardrailArgs,
): Promise<GuardrailResult> {
  const count = await prisma.optimizationRun.count({
    where: {
      advertiserId: args.advertiserId,
      policyId: args.policyId,
      result: "success",
      triggeredAt: { gt: gtNow24h() },
    },
  })
  return {
    ok: count < args.maxChangesPerKeyword,
    count,
  }
}

// =============================================================================
// 광고주 단위 한도
// =============================================================================

export type CheckAdvertiserGuardrailArgs = {
  advertiserId: string
  /** Advertiser.guardrailMaxChangesPerDay (1..1000). */
  maxChangesPerDay: number
}

/**
 * 광고주 단위 24h 한도 검사 (정책 진입 전 매크로 보호).
 */
export async function checkAdvertiserGuardrail(
  args: CheckAdvertiserGuardrailArgs,
): Promise<GuardrailResult> {
  const count = await prisma.optimizationRun.count({
    where: {
      advertiserId: args.advertiserId,
      result: "success",
      triggeredAt: { gt: gtNow24h() },
    },
  })
  return {
    ok: count < args.maxChangesPerDay,
    count,
  }
}
