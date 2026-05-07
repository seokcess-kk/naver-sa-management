/**
 * lib/notifier/throttle.ts 단위 테스트.
 *
 * 외부 호출 0:
 *   - lib/cache/redis getRedis mock
 *
 * 검증 범위:
 *   - 첫 호출 (SET NX 성공 = "OK") → false 리턴 (throttle 미적용)
 *   - 재호출 (SET NX null) → true 리턴 (throttled)
 *   - ttlSec <= 0 → false 리턴 (Redis 호출 X)
 *   - Redis throw → false 리턴 (안전 fallback) + warn 로그
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// SET NX 의 store 동작 시뮬레이션 (set 호출에 nx 가 있으면 키 존재 시 null 리턴)
const redisStore = new Map<string, unknown>()
const setMock = vi.fn(
  async (
    k: string,
    v: unknown,
    opts?: { ex?: number; nx?: boolean },
  ): Promise<"OK" | null> => {
    if (opts?.nx && redisStore.has(k)) {
      return null
    }
    redisStore.set(k, v)
    return "OK"
  },
)

vi.mock("@/lib/cache/redis", () => ({
  getRedis: () => ({
    set: setMock,
  }),
}))

import { shouldThrottle } from "./throttle"

beforeEach(() => {
  redisStore.clear()
  setMock.mockClear()
})

afterEach(() => {
  redisStore.clear()
})

describe("shouldThrottle", () => {
  it("첫 호출은 false 리턴 (throttle 미적용 — 발송 진행)", async () => {
    const r = await shouldThrottle("nsa:notify:test:1", 3600)
    expect(r).toBe(false)
    expect(setMock).toHaveBeenCalledWith("nsa:notify:test:1", "1", {
      ex: 3600,
      nx: true,
    })
  })

  it("재호출 (이미 키 존재) → true 리턴 (throttled — 발송 생략)", async () => {
    redisStore.set("nsa:notify:test:1", "1")
    const r = await shouldThrottle("nsa:notify:test:1", 3600)
    expect(r).toBe(true)
  })

  it("ttlSec <= 0 → Redis 호출 없이 false (throttle 비활성)", async () => {
    const r = await shouldThrottle("nsa:notify:test:1", 0)
    expect(r).toBe(false)
    expect(setMock).not.toHaveBeenCalled()
  })

  it("Redis throw → false 리턴 (안전 fallback — 알림 발송 우선)", async () => {
    setMock.mockRejectedValueOnce(new Error("Redis down"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const r = await shouldThrottle("nsa:notify:test:1", 3600)
    expect(r).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
