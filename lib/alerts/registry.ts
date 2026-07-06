/**
 * 알림 종류 중앙 레지스트리 — tier(P1 코어 / P2 게이트) 단일 진실 원천.
 *
 * 배경 (알림 계층 압축):
 *   - CLAUDE.md 는 알림을 "P1 기본 알림"으로 규정했으나 실제 ~14종 룰타입이 존재.
 *   - 순위/최적화/요약 계열은 bid-inbox 권고·LLM 요약과 중복이거나 P2 성격.
 *   - 삭제 대신 게이팅: P2 종류는 env 플래그 뒤로 숨기고, 평가기 함수 자체는 보존.
 *
 * 사용:
 *   - cron (app/api/cron/alerts/route.ts): isAlertTypeEnabled() 로 P2 평가 skip
 *   - admin 생성 UI: alertTier() 로 P2 종류를 드롭다운에서 숨김 (p2Enabled prop 전달)
 *   - admin actions: createAlertRule 에서 P2 생성 차단 (플래그 off 시)
 *
 * 플래그 정책:
 *   - P2_ALERTS_ENABLED === "true" 일 때만 P2 활성. 미설정/기타 = false (기본 off).
 *   - false 여도 기존 P2 AlertRule row 는 DB 에 남음 (평가/발송만 skip — 되돌림 가능).
 *
 * 서버 전용 env:
 *   - isP2AlertsEnabled() 는 process.env 를 읽으므로 서버(RSC/Server Action/Route)에서만 호출.
 *   - 클라이언트 컴포넌트는 RSC 가 계산한 p2Enabled 를 prop 으로 받아 alertTier() 만 사용.
 */

export type AlertTier = "p1" | "p2"

/**
 * ruleType → tier 매핑 (단일 진실 원천).
 *
 * P1 코어 (계정 건강/운영 필수, 항상 노출):
 *   budget_burn / bizmoney_low / api_auth_error / inspect_rejected / cpc_surge / impressions_drop
 *
 * P2 게이트 (순위·최적화·요약 — bid-inbox·LLM 중복 또는 P2 성격, 기본 off):
 *   budget_pace / budget_pacing (예산 dedup — budget_burn 과 캠페인 중복 발송)
 *   rank_deviation / mobile_first_page / optimization_summary / suggestion_inbox /
 *   quality_stagnation / llm_daily_summary
 */
export const ALERT_TIER = {
  budget_burn: "p1",
  bizmoney_low: "p1",
  api_auth_error: "p1",
  inspect_rejected: "p1",
  cpc_surge: "p1",
  impressions_drop: "p1",
  budget_pace: "p2",
  rank_deviation: "p2",
  mobile_first_page: "p2",
  optimization_summary: "p2",
  suggestion_inbox: "p2",
  quality_stagnation: "p2",
  budget_pacing: "p2",
  llm_daily_summary: "p2",
} as const satisfies Record<string, AlertTier>

export type KnownAlertType = keyof typeof ALERT_TIER

/** ruleType 의 tier. 미등록 type 은 null (기존 동작 보존 — 게이트 통과). */
export function alertTier(type: string): AlertTier | null {
  return (ALERT_TIER as Record<string, AlertTier>)[type] ?? null
}

/** P2 알림 활성 여부. 서버 전용 (process.env). 미설정=false. */
export function isP2AlertsEnabled(): boolean {
  return process.env.P2_ALERTS_ENABLED === "true"
}

/**
 * 해당 ruleType 을 지금 평가/노출해도 되는지.
 *
 * - P1 (또는 미등록): 항상 true
 * - P2: p2Enabled 일 때만 true
 *
 * @param p2Enabled 클라이언트에서는 RSC 가 전달한 값을 넘길 것. 생략 시 서버 env 조회.
 */
export function isAlertTypeEnabled(
  type: string,
  p2Enabled: boolean = isP2AlertsEnabled(),
): boolean {
  return alertTier(type) === "p2" ? p2Enabled : true
}
