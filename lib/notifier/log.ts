/**
 * Log 채널 — 항상 동작하는 디폴트 채널.
 *
 * 정책:
 *   - env 의존 없음. 어떤 환경에서도 ok 반환
 *   - severity 별 console 메서드 분기 (info/warn/error)
 *   - payload.meta 는 두 번째 인자로 전달 (Sentry breadcrumb 호환 패턴)
 *   - 시크릿 평문은 절대 들어오면 안 됨 (호출부 책임 — types.ts 주석 참조)
 */

import type {
  NotificationChannel,
  NotificationPayload,
  NotificationSendResult,
} from "@/lib/notifier/types"

function logBy(severity: NotificationPayload["severity"], message: string, meta?: Record<string, unknown>): void {
  const args: [string] | [string, Record<string, unknown>] =
    meta && Object.keys(meta).length > 0 ? [message, meta] : [message]
  switch (severity) {
    case "critical":
      console.error(...args)
      return
    case "warn":
      console.warn(...args)
      return
    case "info":
    default:
      console.info(...args)
      return
  }
}

export const logChannel: NotificationChannel = {
  name: "log",
  async send(payload: NotificationPayload): Promise<NotificationSendResult> {
    const message = `[ALERT/${payload.severity}/${payload.ruleType}] ${payload.title} — ${payload.body}`
    logBy(payload.severity, message, payload.meta)
    return { ok: true }
  },
}
