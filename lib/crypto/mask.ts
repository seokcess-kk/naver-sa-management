/**
 * 시크릿 평문 마스킹 유틸 (Edge Runtime 호환).
 *
 * `lib/crypto/secret.ts` 가 node:crypto 를 import 하므로, mask 함수만 따로 분리.
 * sanitize / scrub 처럼 Edge 또는 Browser 컨텍스트에서도 호출되는 경로는 본 모듈만 import.
 *
 * 정책 (CLAUDE.md "핵심 안전장치 4"):
 *  - 8자 미만은 전체 마스킹
 *  - 8자 이상은 앞4 + "****" + 뒤4
 *
 * 예: mask("ABCDEFGHIJKLMNOP") => "ABCD****MNOP"
 *     mask("short")           => "********"
 */
export function mask(plainText: string): string {
  if (typeof plainText !== "string") return "********"
  if (plainText.length < 8) return "********"
  return `${plainText.slice(0, 4)}****${plainText.slice(-4)}`
}
