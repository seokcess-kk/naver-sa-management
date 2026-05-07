/**
 * 알림 throttle 헬퍼 — Redis 기반 1회/TTL 중복 방지.
 *
 * 사용처:
 *   - dispatch() 직전에 호출하여 동일 이벤트 중복 발송 차단
 *   - cron 1회 1광고주 1 dispatch 패턴 (bid_suggestion_new)
 *   - 광고주별 시간당 1회 dispatch 패턴 (api_auth_failed)
 *
 * 동작:
 *   - SET key "1" NX EX ttlSec
 *     · NX 옵션 — 키가 없을 때만 설정, 있으면 null 반환 (원자적)
 *   - 설정 성공 (반환 "OK"): throttle 미적용 → false 리턴 → 호출부 dispatch 진행
 *   - 설정 실패 (반환 null): 이미 키 존재 (TTL 안) → true 리턴 → 호출부 dispatch 생략
 *
 * 키 컨벤션:
 *   nsa:notify:{ruleType}:{advertiserId}      예: nsa:notify:api_auth:{customerId}
 *   nsa:notify:{ruleType}:{advertiserId}:{cronTs}  cron 1회 단위 묶음
 *
 * Redis 미설정·장애 안전:
 *   - Upstash 호출 throw 시 false 리턴 (안전한 default — dispatch 진행).
 *   - 알림 throttle 보다 알림 발송 자체가 우선. throttle 실패는 운영 가시성 저하 X.
 *
 * 시크릿:
 *   - key 에 시크릿 평문 X (호출부 책임 — customerId / advertiserId / ruleType 만 권장).
 */

import { getRedis } from "@/lib/cache/redis"

/**
 * Redis SET NX EX 로 1회/TTL 중복 방지.
 *
 * @param key Redis 키 (예: "nsa:notify:api_auth:1234567")
 * @param ttlSec 만료 (초) — 본 시간 동안 같은 키는 throttled
 * @returns true 면 이미 발송됨 (생략 권장), false 면 새 발송 가능
 */
export async function shouldThrottle(
  key: string,
  ttlSec: number,
): Promise<boolean> {
  if (ttlSec <= 0) return false
  try {
    const r = getRedis()
    // Upstash Redis SDK: set(key, value, { ex, nx })
    // nx=true → 없을 때만 set. 이미 있으면 null 반환.
    const result = await r.set(key, "1", { ex: ttlSec, nx: true })
    if (result === null || result === undefined) {
      // 이미 존재 — throttled
      return true
    }
    return false
  } catch (e) {
    // Redis 미설정·장애 — throttle 보다 알림 우선. 안전 fallback.
    console.warn(
      `[notifier/throttle] Redis throttle check failed for key=${key}:`,
      e instanceof Error ? e.message : String(e),
    )
    return false
  }
}
