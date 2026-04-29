/**
 * Slack 알림 채널 (F-8.x 정식 채널 후속)
 *
 * 환경 변수:
 *   SLACK_WEBHOOK_URL — Slack Incoming Webhook URL (없으면 채널 비활성)
 *
 * 페이로드:
 *   - severity 별 색상 attachment
 *   - title / body / meta 일부 노출 (시크릿 평문 가정 X — 호출부 책임)
 *
 * 정책:
 *   - dispatch() 통해서만 호출. 구현체 직접 호출 금지
 *   - webhook 호출 실패 시 ok:false 반환 (다른 채널 발송 막지 않음)
 *   - 메시지 본문은 1회만 전송 (재시도 없음 — 이상 징후 알림은 빠른 손실보다 빠른 명확성)
 *
 * SPEC 6.8 알림 / 안전장치 시크릿 마스킹.
 */

import type {
  NotificationChannel,
  NotificationPayload,
  NotificationSendResult,
} from "@/lib/notifier/types"

const SEVERITY_COLOR = {
  info: "#3b82f6",
  warn: "#f59e0b",
  critical: "#ef4444",
} as const

function buildSlackBody(payload: NotificationPayload) {
  const color = SEVERITY_COLOR[payload.severity]
  const fields: Array<{ title: string; value: string; short: boolean }> = []

  if (payload.meta) {
    // meta 에서 단순 키-값 (string/number/boolean) 만 노출. 깊은 객체는 JSON 짧게.
    for (const [k, v] of Object.entries(payload.meta)) {
      if (
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean"
      ) {
        fields.push({ title: k, value: String(v), short: true })
      } else if (v !== null) {
        const json = JSON.stringify(v)
        fields.push({
          title: k,
          value: json.length > 200 ? json.slice(0, 200) + "…" : json,
          short: false,
        })
      }
    }
  }

  return {
    attachments: [
      {
        color,
        fallback: `[${payload.severity.toUpperCase()}] ${payload.title}`,
        title: payload.title,
        text: payload.body,
        fields,
        footer: `네이버 SA 어드민 · ${payload.ruleType}`,
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  }
}

export const slackChannel: NotificationChannel = {
  name: "slack",
  async send(payload: NotificationPayload): Promise<NotificationSendResult> {
    const url = process.env.SLACK_WEBHOOK_URL
    if (!url) {
      return { ok: false, error: "SLACK_WEBHOOK_URL not configured" }
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildSlackBody(payload)),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        return {
          ok: false,
          error: `Slack webhook ${res.status}: ${text.slice(0, 200)}`,
        }
      }
      return { ok: true }
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }
    }
  },
}
