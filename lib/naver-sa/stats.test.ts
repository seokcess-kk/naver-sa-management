/**
 * lib/naver-sa/stats.ts 단위 테스트
 *
 * 검증 범위:
 *   A. getStatsChunked — chunk 분할 / 빈 ids / chunkSize / 결과 합치기 / env 오버라이드
 *   B. recentAvgRnk passthrough — 응답 row 에 null 도 통과
 *   C. breakdown row passthrough — hh24 / pcMblTp 키 통과
 *
 * 외부 호출 0 보장:
 *   - naverSaClient.request: vi.mock 으로 in-memory stub
 *   - cached: vi.mock 으로 fn 직호출 (캐시 우회)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// =============================================================================
// Redis cache mock — fn 직호출. 캐시 키 hash 분기는 본 테스트 범위 밖.
// =============================================================================

vi.mock("@/lib/cache/redis", () => ({
  getRedis: () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    del: vi.fn(async () => undefined),
  }),
  cached: vi.fn(
    async <T,>(_k: string, _ttl: number, fn: () => Promise<T>): Promise<T> => fn(),
  ),
}))

// =============================================================================
// naverSaClient mock — 호출 인자 기록 + 시퀀스 응답
// =============================================================================

type ClientCall = { customerId: string; method: string; path: string }
const clientCalls: ClientCall[] = []
let clientResponses: Array<unknown> = []
let clientCallIndex = 0

vi.mock("@/lib/naver-sa/client", () => ({
  naverSaClient: {
    request: vi.fn(async (args: { customerId: string; method: string; path: string }) => {
      clientCalls.push({
        customerId: args.customerId,
        method: args.method,
        path: args.path,
      })
      const r = clientResponses[Math.min(clientCallIndex, clientResponses.length - 1)]
      clientCallIndex++
      return r
    }),
  },
}))

// 모듈은 mock 등록 후 import.
import { getStats, getStatsChunked, StatsRowSchema } from "@/lib/naver-sa/stats"

// =============================================================================
// 공통 setup
// =============================================================================

beforeEach(() => {
  clientCalls.length = 0
  clientResponses = []
  clientCallIndex = 0
  delete process.env.NAVER_SA_STATS_CHUNK
})

afterEach(() => {
  vi.clearAllMocks()
})

/** 응답 envelope 만들기 — { data: rows }. */
function envelope(rows: Array<Record<string, unknown>>): { data: typeof rows } {
  return { data: rows }
}

/** ids 에 대응하는 row 응답 (각 id 마다 1 row). */
function rowsFor(ids: string[], extra: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  return ids.map((id) => ({ id, impCnt: 1, clkCnt: 1, ...extra }))
}

// =============================================================================
// A. getStatsChunked
// =============================================================================

describe("getStatsChunked", () => {
  it("ids 빈 배열 → 호출 0회, [] 반환", async () => {
    const rows = await getStatsChunked("c-1", {
      ids: [],
      fields: ["impCnt", "clkCnt"],
      datePreset: "today",
    })
    expect(rows).toEqual([])
    expect(clientCalls).toHaveLength(0)
  })

  it("ids=150, chunkSize=100 → 2회 호출 + 결과 합쳐짐", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `kw-${i}`)
    // chunk 1 (100개) + chunk 2 (50개) 순서대로 응답
    const chunk1 = rowsFor(ids.slice(0, 100))
    const chunk2 = rowsFor(ids.slice(100, 150))
    clientResponses = [envelope(chunk1), envelope(chunk2)]

    const rows = await getStatsChunked("c-1", {
      ids,
      fields: ["impCnt", "clkCnt"],
      datePreset: "today",
    })

    expect(clientCalls).toHaveLength(2)
    expect(rows).toHaveLength(150)
    // 순서 보존 — chunk1 → chunk2
    expect((rows[0] as { id: string }).id).toBe("kw-0")
    expect((rows[99] as { id: string }).id).toBe("kw-99")
    expect((rows[100] as { id: string }).id).toBe("kw-100")
    expect((rows[149] as { id: string }).id).toBe("kw-149")
  })

  it("chunkSize=500, ids=150 → 1회 호출", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `kw-${i}`)
    clientResponses = [envelope(rowsFor(ids))]

    const rows = await getStatsChunked(
      "c-1",
      { ids, fields: ["impCnt"], datePreset: "today" },
      { chunkSize: 500 },
    )

    expect(clientCalls).toHaveLength(1)
    expect(rows).toHaveLength(150)
  })

  it("opts.chunkSize 가 env 보다 우선", async () => {
    process.env.NAVER_SA_STATS_CHUNK = "10"
    const ids = Array.from({ length: 100 }, (_, i) => `kw-${i}`)
    // opts.chunkSize=50 → 2회 호출 (env=10 무시)
    clientResponses = [
      envelope(rowsFor(ids.slice(0, 50))),
      envelope(rowsFor(ids.slice(50, 100))),
    ]

    const rows = await getStatsChunked(
      "c-1",
      { ids, fields: ["impCnt"], datePreset: "today" },
      { chunkSize: 50 },
    )

    expect(clientCalls).toHaveLength(2)
    expect(rows).toHaveLength(100)
  })

  it("opts 미지정 시 env 값 적용", async () => {
    process.env.NAVER_SA_STATS_CHUNK = "30"
    const ids = Array.from({ length: 100 }, (_, i) => `kw-${i}`)
    // 30 / 30 / 30 / 10 = 4회 호출
    clientResponses = [
      envelope(rowsFor(ids.slice(0, 30))),
      envelope(rowsFor(ids.slice(30, 60))),
      envelope(rowsFor(ids.slice(60, 90))),
      envelope(rowsFor(ids.slice(90, 100))),
    ]

    const rows = await getStatsChunked("c-1", {
      ids,
      fields: ["impCnt"],
      datePreset: "today",
    })

    expect(clientCalls).toHaveLength(4)
    expect(rows).toHaveLength(100)
  })

  it("env / opts 모두 미지정 시 기본 100", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `kw-${i}`)
    clientResponses = [
      envelope(rowsFor(ids.slice(0, 100))),
      envelope(rowsFor(ids.slice(100, 200))),
      envelope(rowsFor(ids.slice(200, 250))),
    ]

    const rows = await getStatsChunked("c-1", {
      ids,
      fields: ["impCnt"],
      datePreset: "today",
    })

    expect(clientCalls).toHaveLength(3)
    expect(rows).toHaveLength(250)
  })

  it("env 가 잘못된 값(NaN) → 기본 100 으로 폴백", async () => {
    process.env.NAVER_SA_STATS_CHUNK = "abc"
    const ids = Array.from({ length: 150 }, (_, i) => `kw-${i}`)
    clientResponses = [
      envelope(rowsFor(ids.slice(0, 100))),
      envelope(rowsFor(ids.slice(100, 150))),
    ]

    const rows = await getStatsChunked("c-1", {
      ids,
      fields: ["impCnt"],
      datePreset: "today",
    })

    expect(clientCalls).toHaveLength(2)
    expect(rows).toHaveLength(150)
  })

  it("각 chunk 호출은 customerId / method / path 에 ids slice 반영", async () => {
    const ids = ["a", "b", "c", "d", "e"]
    clientResponses = [envelope(rowsFor(ids.slice(0, 2))), envelope(rowsFor(ids.slice(2, 4))), envelope(rowsFor(ids.slice(4, 5)))]

    await getStatsChunked(
      "cust-99",
      { ids, fields: ["impCnt"], datePreset: "today" },
      { chunkSize: 2 },
    )

    expect(clientCalls).toHaveLength(3)
    expect(clientCalls.every((c) => c.customerId === "cust-99")).toBe(true)
    expect(clientCalls.every((c) => c.method === "GET")).toBe(true)
    // ids 가 path 에 인코딩되어 들어감 (encodeURIComponent("a,b") = "a%2Cb")
    expect(clientCalls[0].path).toContain(encodeURIComponent("a,b"))
    expect(clientCalls[1].path).toContain(encodeURIComponent("c,d"))
    expect(clientCalls[2].path).toContain(encodeURIComponent("e"))
  })

  it("fields 비어있으면 즉시 throw (호출 0회)", async () => {
    await expect(
      getStatsChunked("c-1", {
        ids: ["a"],
        fields: [],
        datePreset: "today",
      }),
    ).rejects.toThrow(/fields/)
    expect(clientCalls).toHaveLength(0)
  })

  it("datePreset / timeRange 둘 다 미지정 → throw", async () => {
    await expect(
      getStatsChunked("c-1", {
        ids: ["a"],
        fields: ["impCnt"],
      } as Parameters<typeof getStatsChunked>[1]),
    ).rejects.toThrow(/datePreset or timeRange/)
    expect(clientCalls).toHaveLength(0)
  })

  it("customerId 누락 → throw", async () => {
    await expect(
      getStatsChunked("", {
        ids: ["a"],
        fields: ["impCnt"],
        datePreset: "today",
      }),
    ).rejects.toThrow(/customerId/)
    expect(clientCalls).toHaveLength(0)
  })
})

// =============================================================================
// B. recentAvgRnk passthrough
// =============================================================================

describe("recentAvgRnk passthrough", () => {
  it("StatsRowSchema: number 통과", () => {
    const r = StatsRowSchema.parse({ id: "kw-1", recentAvgRnk: 3.4 })
    expect(r.recentAvgRnk).toBe(3.4)
  })

  it("StatsRowSchema: null 통과 (데이터 부족 시나리오)", () => {
    const r = StatsRowSchema.parse({ id: "kw-1", recentAvgRnk: null })
    expect(r.recentAvgRnk).toBeNull()
  })

  it("StatsRowSchema: 미존재 통과", () => {
    const r = StatsRowSchema.parse({ id: "kw-1" })
    expect(r.recentAvgRnk).toBeUndefined()
  })

  it("getStats 호출 시 recentAvgRnk 가 row 에 그대로 노출 (null 포함)", async () => {
    clientResponses = [
      envelope([
        { id: "kw-1", impCnt: 100, recentAvgRnk: 2.1 },
        { id: "kw-2", impCnt: 0, recentAvgRnk: null },
      ]),
    ]

    const rows = await getStats("c-1", {
      ids: ["kw-1", "kw-2"],
      fields: ["impCnt", "recentAvgRnk"],
      datePreset: "today",
    })

    expect(rows).toHaveLength(2)
    expect((rows[0] as { recentAvgRnk: number }).recentAvgRnk).toBe(2.1)
    expect((rows[1] as { recentAvgRnk: number | null }).recentAvgRnk).toBeNull()
  })
})

// =============================================================================
// C. breakdown row passthrough (hh24 / pcMblTp)
// =============================================================================

describe("breakdown row passthrough", () => {
  it("breakdown=hh24 → row.hh24 키 통과 (string)", async () => {
    clientResponses = [
      envelope([
        { id: "kw-1", hh24: "09", impCnt: 5 },
        { id: "kw-1", hh24: "10", impCnt: 7 },
      ]),
    ]

    const rows = await getStats("c-1", {
      ids: ["kw-1"],
      fields: ["impCnt"],
      datePreset: "today",
      breakdown: "hh24",
    })

    expect(rows).toHaveLength(2)
    expect(rows[0].hh24).toBe("09")
    expect(rows[1].hh24).toBe("10")
    // path 에 breakdown 포함
    expect(clientCalls[0].path).toContain("breakdown=hh24")
  })

  it("breakdown=hh24 → row.hh24 키 통과 (number)", async () => {
    clientResponses = [envelope([{ id: "kw-1", hh24: 9, impCnt: 5 }])]

    const rows = await getStats("c-1", {
      ids: ["kw-1"],
      fields: ["impCnt"],
      datePreset: "today",
      breakdown: "hh24",
    })

    expect(rows[0].hh24).toBe(9)
  })

  it("breakdown=pcMblTp → row.pcMblTp 키 통과", async () => {
    clientResponses = [
      envelope([
        { id: "kw-1", pcMblTp: "PC", impCnt: 100 },
        { id: "kw-1", pcMblTp: "MOBILE", impCnt: 200 },
      ]),
    ]

    const rows = await getStats("c-1", {
      ids: ["kw-1"],
      fields: ["impCnt"],
      datePreset: "today",
      breakdown: "pcMblTp",
    })

    expect(rows).toHaveLength(2)
    expect(rows[0].pcMblTp).toBe("PC")
    expect(rows[1].pcMblTp).toBe("MOBILE")
    expect(clientCalls[0].path).toContain("breakdown=pcMblTp")
  })
})
