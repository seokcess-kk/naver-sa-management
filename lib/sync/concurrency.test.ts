/**
 * lib/sync/concurrency.ts 단위 테스트.
 *
 * 외부 의존 0 — 순수 함수.
 *
 * 검증:
 *   - getAdgroupChunkSize: env 우선, fallback 5, clamp [1, 20]
 *   - mapWithConcurrency: 결과 순서 유지 + 한도 초과 동시 실행 X + 0 length 처리
 *   - logSyncTiming: trigger 임계 (80%) 도달 시 ⚠ 출력
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  getAdgroupChunkSize,
  logSyncTiming,
  mapWithConcurrency,
  UPSERT_CONCURRENCY,
} from "./concurrency"

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV }
  delete process.env.SYNC_ADGROUP_CHUNK_SIZE
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("getAdgroupChunkSize", () => {
  it("env 미설정 → 기본 5", () => {
    expect(getAdgroupChunkSize()).toBe(5)
  })

  it("env=10 → 10", () => {
    process.env.SYNC_ADGROUP_CHUNK_SIZE = "10"
    expect(getAdgroupChunkSize()).toBe(10)
  })

  it("env=0 또는 음수 → 폴백 5", () => {
    process.env.SYNC_ADGROUP_CHUNK_SIZE = "0"
    expect(getAdgroupChunkSize()).toBe(5)
    process.env.SYNC_ADGROUP_CHUNK_SIZE = "-3"
    expect(getAdgroupChunkSize()).toBe(5)
  })

  it("env 비숫자 → 폴백 5", () => {
    process.env.SYNC_ADGROUP_CHUNK_SIZE = "abc"
    expect(getAdgroupChunkSize()).toBe(5)
  })

  it("env=100 → clamp 20", () => {
    process.env.SYNC_ADGROUP_CHUNK_SIZE = "100"
    expect(getAdgroupChunkSize()).toBe(20)
  })

  it("env=1 → clamp 1 (최소)", () => {
    process.env.SYNC_ADGROUP_CHUNK_SIZE = "1"
    expect(getAdgroupChunkSize()).toBe(1)
  })
})

describe("UPSERT_CONCURRENCY", () => {
  it("=10 (Supabase pool 안전선)", () => {
    expect(UPSERT_CONCURRENCY).toBe(10)
  })
})

describe("mapWithConcurrency", () => {
  it("빈 배열 → 빈 배열 반환, fn 미호출", async () => {
    const fn = vi.fn(async (n: number) => n * 2)
    const out = await mapWithConcurrency([], 5, fn)
    expect(out).toEqual([])
    expect(fn).not.toHaveBeenCalled()
  })

  it("결과 순서 = 입력 순서 (worker 가 cursor 기반 픽업해도 results[i] 으로 환원)", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    // 짝수는 살짝 더 오래 걸림 → 비결정적 완료 순서
    const out = await mapWithConcurrency(items, 3, async (n) => {
      await new Promise((r) => setTimeout(r, n % 2 === 0 ? 5 : 1))
      return n * 10
    })
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
  })

  it("동시 실행 한도 — 어느 시점에도 limit 초과 X", async () => {
    let inFlight = 0
    let peakInFlight = 0
    const items = Array.from({ length: 20 }, (_, i) => i)
    await mapWithConcurrency(items, 4, async () => {
      inFlight++
      peakInFlight = Math.max(peakInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
    })
    expect(peakInFlight).toBeLessThanOrEqual(4)
    expect(peakInFlight).toBeGreaterThanOrEqual(2) // 실제로 병렬 동작했음 확인
  })

  it("limit > items.length → safeLimit = items.length", async () => {
    const items = [1, 2, 3]
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency(items, 100, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
    })
    expect(peak).toBeLessThanOrEqual(3)
  })
})

describe("logSyncTiming", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
  })

  afterEach(() => {
    infoSpy.mockRestore()
  })

  it("정상 시간 → ⚠ 없음", () => {
    logSyncTiming({
      kind: "keywords",
      advertiserId: "adv-1",
      totalMs: 5_000,
      scannedAdgroups: 10,
      upserts: 100,
      maxDurationMs: 300_000,
    })
    expect(infoSpy).toHaveBeenCalledTimes(1)
    const msg = infoSpy.mock.calls[0][0] as string
    expect(msg).toContain("[sync.keywords]")
    expect(msg).toContain("totalMs=5000")
    expect(msg).not.toContain("⚠")
  })

  it("totalMs > maxDuration*0.8 → ⚠ 출력", () => {
    logSyncTiming({
      kind: "ads",
      advertiserId: "adv-2",
      totalMs: 250_000, // > 240_000 (80% of 300_000)
      scannedAdgroups: 200,
      upserts: 5000,
      maxDurationMs: 300_000,
    })
    const msg = infoSpy.mock.calls[0][0] as string
    expect(msg).toContain("⚠")
    expect(msg).toContain("83%") // 250000/300000 = 83.3%
  })

  it("maxDurationMs 미지정 → ⚠ 없음", () => {
    logSyncTiming({
      kind: "extensions",
      advertiserId: "adv-3",
      totalMs: 1_000_000, // 매우 큼
      scannedAdgroups: 1,
      upserts: 1,
    })
    const msg = infoSpy.mock.calls[0][0] as string
    expect(msg).not.toContain("⚠")
  })
})
