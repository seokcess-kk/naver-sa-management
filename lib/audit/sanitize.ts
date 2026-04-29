/**
 * AuditLog / 외부 직렬화용 시크릿 마스킹 유틸
 *
 * 정책 (SPEC 5.4 / CLAUDE.md "핵심 안전장치 4"):
 *   - 시크릿 평문이 before/after JSON·로그·외부 호출에 흘러들어가지 않도록 자동 마스킹
 *   - 깊이 제한 6 (재귀 폭주 방지)
 *
 * 마스킹 대상 키 (대소문자 무관, partial match):
 *   - camelCase 연속: apiKey, secretKey, password, accessKey, refreshToken, token(정확)
 *   - snake/kebab 분리: api_key, secret_key, access_key, refresh_token (대소문자 무관)
 *   - 헤더/시스템 시크릿(정확 매치): authorization, bearer, cron_secret/cronSecret/CRON_SECRET
 *
 * `lib/audit/log.ts` 가 본 모듈을 import 하여 logAudit 안에서 sanitize 호출.
 * 별도 모듈로 분리한 이유: 테스트(prisma 의존 없음) + 외부 channel/notifier 등에서 재사용 가능.
 */

import { mask } from "@/lib/crypto/mask"

export const SECRET_KEY_PATTERNS: readonly RegExp[] = [
  // 기존 — camelCase 연속 매치 유지 (apiKey, secretKey, accessKey, refreshToken 등)
  /apikey/i,
  /secretkey/i,
  /password/i,
  /accesskey/i,
  /refreshtoken/i,
  /^token$/i,
  // 신규 — snake/kebab separator 허용 (api_key, API_KEY, api-key 등)
  /api[_-]key/i,
  /secret[_-]key/i,
  /access[_-]key/i,
  /refresh[_-]token/i,
  // 신규 — 헤더/시스템 시크릿 (정확 매치로 false positive 방지)
  /^authorization$/i,
  /^bearer$/i,
  /cron[_-]?secret/i,
]

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(key))
}

/**
 * before/after JSON 안에 시크릿 평문이 들어가면 자동 마스킹.
 * 깊이 제한: 6 (재귀 폭주 방지)
 */
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]"
  if (value === null || value === undefined) return value
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitize(v, depth + 1))
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(k) && typeof v === "string") {
        out[k] = mask(v)
      } else {
        out[k] = sanitize(v, depth + 1)
      }
    }
    return out
  }
  // function / symbol / bigint 등은 직렬화 안전을 위해 string 화
  return String(value)
}
