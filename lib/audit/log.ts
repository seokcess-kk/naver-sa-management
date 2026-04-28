/**
 * AuditLog 기록 헬퍼
 *
 * 정책 (SPEC 5.4 / CLAUDE.md "핵심 안전장치 4"):
 *   - 모든 사용자 행동 / 자동 실행 기록
 *   - before / after JSON 보관
 *   - 시크릿 평문은 절대 저장 X — 자동 마스킹 처리
 *
 * 마스킹 대상 키 (대소문자 무관 partial match):
 *   apiKey, secretKey, password, token, accessKey, refreshToken
 *
 * 사용:
 *   await logAudit({
 *     userId,
 *     action: "advertiser.register",
 *     targetType: "Advertiser",
 *     targetId,
 *     before: null,
 *     after: { name, customerId },
 *   })
 */

import { prisma } from "@/lib/db/prisma"
import { mask } from "@/lib/crypto/secret"

const SECRET_KEY_PATTERNS = [
  /apikey/i,
  /secretkey/i,
  /password/i,
  /accesskey/i,
  /refreshtoken/i,
  /^token$/i,
]

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(key))
}

/**
 * before/after JSON 안에 시크릿 평문이 들어가면 자동 마스킹.
 * 깊이 제한: 6 (재귀 폭주 방지)
 */
function sanitize(value: unknown, depth = 0): unknown {
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

export type AuditLogInput = {
  userId: string | null
  action: string
  targetType: string
  targetId?: string | null
  before?: unknown
  after?: unknown
}

export async function logAudit(input: AuditLogInput): Promise<void> {
  const { userId, action, targetType, targetId = null, before, after } = input
  await prisma.auditLog.create({
    data: {
      userId: userId ?? null,
      action,
      targetType,
      targetId: targetId ?? null,
      before: before === undefined ? undefined : (sanitize(before) as never),
      after: after === undefined ? undefined : (sanitize(after) as never),
    },
  })
}
