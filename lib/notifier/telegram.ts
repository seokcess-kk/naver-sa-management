/**
 * Telegram 채널 — Bot API sendMessage 직접 호출.
 *
 * 정책 (CLAUDE.md "익숙한 스택 우선"):
 *   - 외부 SDK 미사용 — fetch 만 사용
 *   - TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID 둘 다 있을 때만 활성 (index.ts getChannels 가드)
 *   - HTML parse_mode — title/body 의 `<`, `>`, `&` escape 후 `<b>` 태그만 사용
 *   - severity 별 이모지 prefix (🔴 critical / 🟡 warn / ℹ️ info)
 *   - 4xx/5xx 또는 fetch throw 모두 error 메시지로 환원 (다른 채널 발송 차단 X — index.ts 책임)
 *
 * 시크릿 운영:
 *   - TELEGRAM_BOT_TOKEN 평문 로그 X — URL 에 들어가므로 에러 메시지에 URL 포함하지 않음
 *   - payload.meta 는 본문 미포함 (Telegram 메시지 길이 4096 한도 + meta 노출 위험 회피)
 *
 * 외부 의존:
 *   - https://api.telegram.org/bot<TOKEN>/sendMessage
 *   - 도큐먼트: https://core.telegram.org/bots/api#sendmessage
 */

import type {
  NotificationChannel,
  NotificationPayload,
  NotificationSendResult,
  NotificationSeverity,
} from "@/lib/notifier/types"

const SEVERITY_EMOJI: Record<NotificationSeverity, string> = {
  critical: "🔴",
  warn: "🟡",
  info: "ℹ️",
}

/** Telegram HTML parse_mode 가 의미를 부여하는 3 글자만 escape. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/**
 * Telegram 메시지 본문 포맷.
 *
 *   🔴 <b>제목</b>
 *   본문
 *
 *   <i>ruleType</i>
 */
export function formatTelegramMessage(payload: NotificationPayload): string {
  const emoji = SEVERITY_EMOJI[payload.severity]
  return [
    `${emoji} <b>${escapeHtml(payload.title)}</b>`,
    escapeHtml(payload.body),
    "",
    `<i>${escapeHtml(payload.ruleType)}</i>`,
  ].join("\n")
}

export const telegramChannel: NotificationChannel = {
  name: "telegram",
  async send(payload: NotificationPayload): Promise<NotificationSendResult> {
    const token = process.env.TELEGRAM_BOT_TOKEN
    const chatId = process.env.TELEGRAM_CHAT_ID
    if (!token) return { ok: false, error: "TELEGRAM_BOT_TOKEN not configured" }
    if (!chatId) return { ok: false, error: "TELEGRAM_CHAT_ID not configured" }

    const url = `https://api.telegram.org/bot${token}/sendMessage`
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: formatTelegramMessage(payload),
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        // res.text() 가 description 을 담은 JSON 인 경우 압축. URL 은 토큰 포함이라 노출 X.
        return { ok: false, error: `telegram ${res.status}: ${text.slice(0, 200)}` }
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },
}
