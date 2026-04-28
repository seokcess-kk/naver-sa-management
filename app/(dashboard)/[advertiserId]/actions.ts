"use server"

/**
 * F-1.5 — 연결 상태 점검 (Server Action)
 *
 * `/billing/bizmoney` 호출로 광고주 SA API 헬스체크 + 비즈머니 잔액 조회.
 * 자기 자신 endpoint이므로 권한 무관 (마스터 권한 필요 없음).
 *
 * 운영 정책:
 *   - getCurrentAdvertiser 권한 + 광고주 객체
 *   - hasKeys=false → 즉시 차단
 *   - SA API 호출 → BizmoneyResponse 반환 또는 에러
 *   - AuditLog 미기록 (조회만 — 외부 변경 X. 사용자 화면이 자주 새로고침되면 노이즈)
 *   - 캐시: client.ts 자체에서 GET 캐시 X (헬스체크는 항상 최신 응답 필요)
 *
 * SPEC 6.1 F-1.5 / 안전장치 시크릿 마스킹.
 */

import { getCurrentAdvertiser } from "@/lib/auth/access"
import { getBizmoney } from "@/lib/naver-sa/billing"
import { NaverSaError } from "@/lib/naver-sa/errors"

export type CheckConnectionResult =
  | {
      ok: true
      bizmoney: number
      budgetLock: boolean
      refundLock: boolean
      checkedAt: string // ISO
    }
  | { ok: false; error: string }

/**
 * 광고주 연결 상태 + 비즈머니 잔액 점검.
 *
 * @param advertiserId 앱 DB Advertiser.id
 */
export async function checkConnection(
  advertiserId: string,
): Promise<CheckConnectionResult> {
  const { advertiser } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    return { ok: false, error: "API 키/시크릿 미입력" }
  }

  try {
    const res = await getBizmoney(advertiser.customerId)
    return {
      ok: true,
      bizmoney: res.bizmoney,
      budgetLock: res.budgetLock ?? false,
      refundLock: res.refundLock ?? false,
      checkedAt: new Date().toISOString(),
    }
  } catch (e) {
    if (e instanceof NaverSaError) {
      return { ok: false, error: `SA 호출 실패: ${e.message}` }
    }
    console.error("[checkConnection] unexpected error:", e)
    return { ok: false, error: "연결 점검 중 알 수 없는 오류" }
  }
}
