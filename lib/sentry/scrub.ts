/**
 * Sentry beforeSend / beforeBreadcrumb 스크러빙.
 *
 * 정책 (CLAUDE.md 안전장치 #4 — 시크릿 평문 노출 금지):
 *   - event.request.headers / cookies / data / query_string 마스킹
 *   - event.extra / event.contexts / event.tags / event.user 마스킹
 *   - breadcrumb.data / message 마스킹
 *   - exception.values[].value / event.message 안 시크릿 패턴 매치 시 마스킹
 *   - lib/audit/sanitize.ts 의 sanitize() 재사용 — 키 매칭 + 마스킹
 *
 * 미보호 영역 (의도된 한계):
 *   - exception.values[].stacktrace.frames[*].vars 안 보간 평문은 미보호
 *     (SDK 가 변수 값을 별도 영역에 옮길 경우 본 모듈 범위 밖)
 *   - event.message 본문은 sanitize 미적용. 다만 SECRET_VALUE_PATTERNS 매치 평문은 [REDACTED]
 *
 * Sentry SDK v10 타입은 @sentry/core 가 정의하고 @sentry/nextjs 가 re-export.
 * 직접 의존: @sentry/nextjs (transitive @sentry/core 도 동일 타입)
 */

import type { ErrorEvent, Breadcrumb, EventHint } from "@sentry/nextjs"
import { sanitize } from "@/lib/audit/sanitize"

/**
 * value 자체에 시크릿 패턴이 들어있는 경우(키 이름이 시크릿 단어가 아니어도) 마스킹.
 * - "Authorization: Bearer xxx" 같이 라인에 토큰 보간된 경우
 * - 32+ hex 문자열 (HMAC signature, MD5/SHA hex 등)
 *
 * Bearer 토큰: 빈공간 또는 quote 같은 종결자까지만 매칭 (alpha-num + dot/dash/underscore)
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._\-]{12,}/g, // Authorization: Bearer ...
  /[A-Fa-f0-9]{32,}/g, // 긴 hex (HMAC signature, MD5/SHA hex 등)
]

function scrubString(s: string): string {
  let out = s
  for (const re of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, "[REDACTED]")
  }
  return out
}

/**
 * Sentry beforeSend 훅.
 *
 * 반환 null 가능하지만 본 구현은 event 객체를 mutate 후 그대로 반환.
 * (null 반환은 이벤트 자체 전송 차단 — 본 정책은 마스킹만, 차단은 아님)
 */
export function scrubEvent(event: ErrorEvent, _hint?: EventHint): ErrorEvent | null {
  if (event.request) {
    if (event.request.headers) {
      // RequestEventData.headers: { [key: string]: string }
      event.request.headers = sanitize(event.request.headers) as { [key: string]: string }
    }
    if (event.request.cookies) {
      event.request.cookies = sanitize(event.request.cookies) as Record<string, string>
    }
    if (event.request.data !== undefined) {
      event.request.data = sanitize(event.request.data)
    }
    if (typeof event.request.query_string === "string") {
      event.request.query_string = scrubString(event.request.query_string)
    }
  }
  if (event.extra) {
    event.extra = sanitize(event.extra) as Record<string, unknown>
  }
  if (event.contexts) {
    // Contexts 는 Record<string, Context|undefined> 와 호환 — sanitize 결과를 그대로 캐스팅
    event.contexts = sanitize(event.contexts) as typeof event.contexts
  }
  if (event.tags) {
    event.tags = sanitize(event.tags) as typeof event.tags
  }
  if (event.user) {
    // sendDefaultPii=false 와 별개로 명시적 마스킹.
    // user[key]는 any 인덱스 시그니처라 sanitize 결과를 그대로 캐스팅
    event.user = sanitize(event.user) as typeof event.user
  }
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (typeof ex.value === "string") {
        ex.value = scrubString(ex.value)
      }
    }
  }
  if (typeof event.message === "string") {
    event.message = scrubString(event.message)
  }
  return event
}

/**
 * Sentry beforeBreadcrumb 훅.
 *
 * breadcrumb.data 의 시크릿 키 마스킹 + message 안 토큰 패턴 마스킹.
 */
export function scrubBreadcrumb(b: Breadcrumb, _hint?: { event?: unknown }): Breadcrumb | null {
  if (b.data) {
    b.data = sanitize(b.data) as typeof b.data
  }
  if (typeof b.message === "string") {
    b.message = scrubString(b.message)
  }
  return b
}
