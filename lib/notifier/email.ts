/**
 * Email 채널 — 개발 임시 (정식 채널 미정).
 *
 * 정책 (CLAUDE.md):
 *   - 정식 채널은 P1 마무리 시 결정. 본 모듈은 RESEND_API_KEY 가 있을 때만 활성화
 *   - 환경 변수:
 *       RESEND_API_KEY        — Resend SDK 토큰 (있으면 활성화)
 *       ALERT_EMAIL_TO        — 수신자 (콤마 구분 가능). 없으면 발송 skip
 *       ALERT_EMAIL_FROM      — 발신자 ("Alert <noreply@example.com>" 형식). 없으면 기본값
 *   - 본 PR 은 stub 수준 — Resend SDK 도입 시점에 실제 템플릿 작성
 *   - dispatch.results 에 stub 임을 명시하는 error 메시지 반환 (operational visibility)
 *
 * 시크릿 운영:
 *   - RESEND_API_KEY 평문 로그 X (Resend SDK 가 내부 핸들링)
 *   - payload.meta 에 customerId 등이 들어와도 마스킹 X (이메일 본문에는 표시되지 않음 가정)
 */

import type {
  NotificationChannel,
  NotificationPayload,
  NotificationSendResult,
} from "@/lib/notifier/types"

function isConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY) && Boolean(process.env.ALERT_EMAIL_TO)
}

export const emailChannel: NotificationChannel = {
  name: "email",
  async send(_payload: NotificationPayload): Promise<NotificationSendResult> {
    if (!process.env.RESEND_API_KEY) {
      return { ok: false, error: "RESEND_API_KEY not configured" }
    }
    if (!process.env.ALERT_EMAIL_TO) {
      return { ok: false, error: "ALERT_EMAIL_TO not configured" }
    }

    // TODO(P1 마무리): 정식 채널 결정 후 Resend 호출 활성화.
    //   import { Resend } from "resend"
    //   const resend = new Resend(process.env.RESEND_API_KEY)
    //   await resend.emails.send({ from, to, subject, html })
    //
    // 본 stub 은 isConfigured 통과해도 "not implemented" 반환.
    // 의도: dispatch.results 에 명시적으로 stub 임을 남기되, log 채널이 fallback 으로 ok 반환.
    void _payload
    return {
      ok: false,
      error: `email channel not implemented (stub${isConfigured() ? "; resend env present" : ""})`,
    }
  },
}
