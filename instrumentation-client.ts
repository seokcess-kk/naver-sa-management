/**
 * Next.js Instrumentation (browser / client entry point)
 *
 * Next.js 16 부터 `instrumentation-client.ts` 가 표준 (v9 시대의 sentry.client.config.ts 대체).
 *
 * 정책:
 *   - NEXT_PUBLIC_SENTRY_DSN 미설정 시 Sentry.init 호출 안 함 → 외부 호출 0
 *   - beforeSend / beforeBreadcrumb 에 스크러빙 헬퍼 부착 (서버와 동일 정책)
 *   - 라우터 transition 캡쳐는 SDK 가 자동 + 명시적 hook (`onRouterTransitionStart`) export
 *
 * import 자체는 항상 발생 (브라우저 번들에 들어감) — DSN 미설정 시 init 만 skip.
 * Sentry SDK 는 init 호출이 없으면 추가 외부 통신 X.
 */

import * as Sentry from "@sentry/nextjs"
import { scrubEvent, scrubBreadcrumb } from "@/lib/sentry/scrub"

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    sendDefaultPii: false,
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  })
}

/**
 * Next.js App Router transition 시작 hook.
 *
 * @sentry/nextjs v10 가 `captureRouterTransitionStart(href, navigationType)` 제공.
 * DSN 미설정 시 noop (Sentry 가 init 안 됐으므로 호출해도 외부 통신 X — 안전 차원에서 가드).
 */
export const onRouterTransitionStart = (href: string, navigationType: string): void => {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return
  Sentry.captureRouterTransitionStart(href, navigationType)
}
