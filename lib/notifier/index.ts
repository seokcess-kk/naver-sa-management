/**
 * NotificationChannel dispatcher (F-8.x).
 *
 * 정책:
 *   - 호출자는 항상 dispatch() 만 사용. 채널 구현체 직접 호출 금지
 *   - log 채널은 항상 활성화 (env 의존 없음 — 운영 가시성 보장)
 *   - email 채널은 RESEND_API_KEY 환경 변수가 있을 때만 시도 (없으면 추가하지 않음)
 *   - 한 채널 throw 가 다른 채널 발송을 막지 않게 Promise.all 내부에서 catch
 *   - "ok" 의 정의: 활성화된 채널 중 1개 이상 성공 (log 가 항상 성공하므로 사실상 always true 이지만,
 *     log 까지 throw 하면 false 가 됨 — 의도된 동작)
 *
 * 사용:
 *   import { dispatch } from "@/lib/notifier"
 *   await dispatch({ ruleType, severity, title, body, meta })
 *
 * 시크릿 운영:
 *   - payload.meta 에 시크릿 평문 X (호출부 책임)
 *   - dispatch.results 는 AlertEvent.payload 에 적재됨 — DB sanitize 통과 가정
 */

import { logChannel } from "@/lib/notifier/log"
import { emailChannel } from "@/lib/notifier/email"
import { slackChannel } from "@/lib/notifier/slack"
import type {
  NotificationChannel,
  NotificationPayload,
  NotificationSendResult,
} from "@/lib/notifier/types"

export type {
  NotificationChannel,
  NotificationPayload,
  NotificationSendResult,
} from "@/lib/notifier/types"

/**
 * 활성화된 채널 목록 결정.
 *
 * - log 채널: 항상 포함
 * - slack 채널: SLACK_WEBHOOK_URL 가 있을 때만
 * - email 채널: RESEND_API_KEY 가 있을 때만 (env 없으면 stub 채널 자체를 추가하지 않음 — dispatch 결과
 *   배열을 단순화).
 */
export function getChannels(): NotificationChannel[] {
  const channels: NotificationChannel[] = [logChannel]
  if (process.env.SLACK_WEBHOOK_URL) {
    channels.push(slackChannel)
  }
  if (process.env.RESEND_API_KEY) {
    channels.push(emailChannel)
  }
  return channels
}

export type DispatchResult = {
  /** 활성 채널 중 1개 이상 ok 면 true */
  ok: boolean
  results: Array<{ channel: string; ok: boolean; error?: string }>
}

/**
 * 활성 채널 전부에 알림 전송.
 *
 * Promise.all 로 병렬 호출하되, 각 채널의 throw 는 catch 하여 results 에 기록.
 * 한 채널 실패가 다른 채널 발송을 막지 않음.
 */
export async function dispatch(payload: NotificationPayload): Promise<DispatchResult> {
  const channels = getChannels()
  const results = await Promise.all(
    channels.map(async (c) => {
      try {
        const r: NotificationSendResult = await c.send(payload)
        return { channel: c.name, ok: r.ok, error: r.error }
      } catch (e) {
        return {
          channel: c.name,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        }
      }
    }),
  )
  const ok = results.some((r) => r.ok)
  return { ok, results }
}
