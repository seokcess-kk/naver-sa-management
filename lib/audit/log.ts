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
import { sanitize } from "@/lib/audit/sanitize"

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
