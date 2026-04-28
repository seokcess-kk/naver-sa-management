/**
 * Upstash Redis 클라이언트 + 캐시 헬퍼
 *
 * 사용처:
 * - 네이버 SA API 응답 캐시 (lib/naver-sa/client.ts)
 * - Rate Limit 토큰 버킷 (lib/naver-sa/client.ts)
 * - 기타 단순 KV
 *
 * 키 컨벤션:
 *   nsa:{kind}:{customerId}:{params-hash}     ← Naver SA 캐시
 *   nsa:rl:{customerId}                       ← Rate Limit 토큰 버킷 상태
 *
 * 환경 변수 (Vercel + .env.local):
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 */

import { Redis } from "@upstash/redis"

let _client: Redis | null = null

/**
 * 싱글톤 Redis 클라이언트.
 * env 부재 시 호출 시점에만 명확한 에러. import만으로는 throw하지 않음.
 */
export function getRedis(): Redis {
  if (_client) return _client
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    throw new Error(
      "Upstash Redis env not configured (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)",
    )
  }
  _client = new Redis({ url, token })
  return _client
}

/** 편의 export — 모듈 import 시점이 아닌 사용 시점 lazy 평가 */
export const redis: Redis = new Proxy({} as Redis, {
  get(_target, prop, receiver) {
    const real = getRedis()
    const value = Reflect.get(real, prop, receiver)
    return typeof value === "function" ? value.bind(real) : value
  },
})

/**
 * 캐시-or-실행 헬퍼.
 *
 * - 키에 값이 있으면 그대로 반환 (Upstash는 JSON 자동 직렬화/역직렬화 지원)
 * - 없으면 fn 실행 → 결과 set EX ttl → 반환
 *
 * @param key    Redis 키 (`nsa:{kind}:{customerId}:{hash}` 등)
 * @param ttlSec 만료(초)
 * @param fn     캐시 미스 시 실제 데이터 fetch 함수
 */
export async function cached<T>(
  key: string,
  ttlSec: number,
  fn: () => Promise<T>,
): Promise<T> {
  const r = getRedis()
  const hit = await r.get<T>(key)
  if (hit !== null && hit !== undefined) {
    return hit
  }
  const value = await fn()
  // ttl <= 0 이면 set 하지 않음 (캐시 비활성)
  if (ttlSec > 0) {
    await r.set(key, value, { ex: ttlSec })
  }
  return value
}

/**
 * 캐시 무효화 (단일 키).
 */
export async function invalidate(key: string): Promise<void> {
  const r = getRedis()
  await r.del(key)
}
