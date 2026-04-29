/**
 * NotificationChannel 추상 타입 (F-8.x 알림 인프라)
 *
 * 정책 (CLAUDE.md "체질" / SPEC v0.2.1 알림):
 *   - 정식 채널은 P1 마무리 시점에 결정 — 본 PR 은 추상만 확정
 *   - 구현체 직접 호출 금지. dispatch() 통해 일괄 송신
 *   - payload 에 시크릿 평문 X (호출부 책임 — 본 모듈은 단순 전달)
 *
 * severity:
 *   - info:     단순 정보 (예: 잔액 상태 양호)
 *   - warn:     주의 필요 (예: 예산 80% 소진, 거절 키워드 발생)
 *   - critical: 즉시 조치 (예: 비즈머니 부족, API 인증 실패)
 *
 * meta:
 *   - 자유 JSON. dispatch 결과 / DB 적재용 부가 컨텍스트.
 *   - 시크릿 키 패턴 들어가면 lib/audit/log.ts sanitize 가 마스킹 (적재 시).
 */

export type NotificationSeverity = "info" | "warn" | "critical"

export type NotificationPayload = {
  /** AlertRule.type 와 동일 (budget_burn / bizmoney_low / api_auth_error / inspect_rejected). */
  ruleType: string
  severity: NotificationSeverity
  title: string
  body: string
  meta?: Record<string, unknown>
}

export type NotificationSendResult = {
  ok: boolean
  error?: string
}

export interface NotificationChannel {
  /** "log" / "email" / "slack" 등. dispatch 결과 식별자. */
  name: string
  send(payload: NotificationPayload): Promise<NotificationSendResult>
}
