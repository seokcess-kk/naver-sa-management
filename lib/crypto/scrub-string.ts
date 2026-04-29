/**
 * 문자열 안 시크릿 토큰 패턴 마스킹 (Edge Runtime 호환).
 *
 * 분리 이유:
 *   - `lib/sentry/scrub.ts` 의 동일 패턴이 cron route 의 errors[].message 마스킹에도 필요
 *   - sentry 모듈 import 의존성을 cron route 에 노출시키지 않기 위해 별도 모듈로 분리
 *   - 양쪽 (sentry/scrub, cron route, 기타 message 마스킹 사용처) 이 본 모듈을 import
 *
 * 정책 (CLAUDE.md "핵심 안전장치 4" — 시크릿 평문 노출 금지):
 *   - "Authorization: Bearer xxx" 같이 라인에 토큰 보간된 경우 마스킹
 *   - 32+ hex 문자열 (HMAC signature, MD5/SHA hex 등) 마스킹
 *   - 객체 대상이 아닌 문자열만 다룸 (객체는 lib/audit/sanitize.ts 사용)
 *
 * 미보호 영역 (의도된 한계):
 *   - 짧은 시크릿 (12 자 미만) — 일반 토큰 정책상 12 자 미만은 시크릿 자격 미달로 가정
 *   - non-hex Base64 시크릿 — 본 모듈은 패턴 기반이라 일반 단어와 구분 불가
 *   - 키 이름 매칭은 sanitize 로 보강 (예: { apiKey: "..." })
 */

/**
 * value 자체에 시크릿 패턴이 들어있는 경우 마스킹.
 * - "Authorization: Bearer xxx" 같이 라인에 토큰 보간된 경우
 * - 32+ hex 문자열 (HMAC signature, MD5/SHA hex 등)
 *
 * Bearer 토큰: 빈공간 또는 quote 같은 종결자까지만 매칭 (alpha-num + dot/dash/underscore)
 */
export const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._\-]{12,}/g, // Authorization: Bearer ...
  /[A-Fa-f0-9]{32,}/g, // 긴 hex (HMAC signature, MD5/SHA hex 등)
]

/**
 * 문자열 안 시크릿 패턴을 [REDACTED] 로 치환.
 *
 * @param s 원본 문자열
 * @returns 시크릿 패턴이 [REDACTED] 로 치환된 문자열
 */
export function scrubString(s: string): string {
  let out = s
  for (const re of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, "[REDACTED]")
  }
  return out
}
