/**
 * Next.js Instrumentation (server / edge entry point)
 *
 * 정책 (CLAUDE.md 안전장치 #4 — 시크릿 평문 노출 금지):
 *   - SENTRY_DSN 미설정 시 @sentry/nextjs import 자체 발생 X (lazy import)
 *   - 외부 호출 0 보장 (DSN 없으면 init 자체 호출 안 됨)
 *   - beforeSend / beforeBreadcrumb 에 lib/sentry/scrub 의 스크러빙 헬퍼 부착
 *
 * Next.js 16 표준 진입점:
 *   - `register()` — 서버/엣지 부트스트랩 시 1회 호출
 *   - `onRequestError(...)` — RSC / Server Action / Route Handler 에서 던진 에러 캡쳐
 *
 * 타입 주의: Next.js 의 `Instrumentation` namespace 는 `onRequestError`(소문자)만
 * 정의하므로 `Instrumentation.Register` 등의 타입은 사용하지 않음. 시그니처 명시.
 */

import type { InstrumentationOnRequestError } from "next/dist/server/instrumentation/types"

export const register = async (): Promise<void> => {
  // DSN 미설정 → Sentry 모듈 import 안 함. 외부 호출 0.
  if (!process.env.SENTRY_DSN) {
    return
  }

  // 공통 init 옵션 (Node / Edge 동일).
  const tracesSampleRate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1")

  if (process.env.NEXT_RUNTIME === "nodejs") {
    const Sentry = await import("@sentry/nextjs")
    const { scrubEvent, scrubBreadcrumb } = await import("@/lib/sentry/scrub")
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate,
      sendDefaultPii: false, // 사용자 IP / 쿠키 자동 수집 차단
      beforeSend: scrubEvent,
      beforeBreadcrumb: scrubBreadcrumb,
    })
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    const Sentry = await import("@sentry/nextjs")
    const { scrubEvent, scrubBreadcrumb } = await import("@/lib/sentry/scrub")
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate,
      sendDefaultPii: false,
      beforeSend: scrubEvent,
      beforeBreadcrumb: scrubBreadcrumb,
    })
  }
}

/**
 * RSC / Server Action / Route Handler 에서 던진 에러를 Sentry 로 캡쳐.
 * DSN 미설정 시 noop (import 자체 발생 X).
 */
export const onRequestError: InstrumentationOnRequestError = async (...args) => {
  if (!process.env.SENTRY_DSN) return
  const Sentry = await import("@sentry/nextjs")
  Sentry.captureRequestError(...args)
}
