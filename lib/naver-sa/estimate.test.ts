/**
 * lib/naver-sa/estimate.ts 단위 테스트
 *
 * 검증 범위:
 *   A. estimateAveragePositionBid — happy / positions 기본값 / Zod 실패 / customerId·keyword 누락
 *   B. estimateExposureMinimumBid — happy / row 0 → throw / Zod 실패
 *   C. estimatePerformanceBulk    — happy / bids 빈 배열 → 호출 0회 / nullable / Zod 실패
 *   D. body shape 회귀 — POST body 의 device + items 가 기대대로 직렬화되는지
 *
 * 외부 호출 0:
 *   - naverSaClient.request: vi.mock 으로 in-memory stub
 *   - HTTP / 인증 / 토큰 버킷 영역은 client.test.ts 책임 — 본 테스트는 happy + Zod + 본 모듈 분기만.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// =============================================================================
// naverSaClient mock — 호출 인자 기록 + 시퀀스 응답
// =============================================================================

type ClientCall = {
  customerId: string
  method: string
  path: string
  body?: unknown
}
const clientCalls: ClientCall[] = []
let clientResponses: Array<unknown> = []
let clientCallIndex = 0

vi.mock("@/lib/naver-sa/client", () => ({
  naverSaClient: {
    request: vi.fn(
      async (args: {
        customerId: string
        method: string
        path: string
        body?: unknown
      }) => {
        clientCalls.push({
          customerId: args.customerId,
          method: args.method,
          path: args.path,
          body: args.body,
        })
        const r =
          clientResponses[Math.min(clientCallIndex, clientResponses.length - 1)]
        clientCallIndex++
        return r
      },
    ),
  },
}))

// 모듈은 mock 등록 후 import.
import {
  estimateAveragePositionBid,
  estimateExposureMinimumBid,
  estimatePerformanceBulk,
} from "@/lib/naver-sa/estimate"

// =============================================================================
// 공통 setup
// =============================================================================

beforeEach(() => {
  clientCalls.length = 0
  clientResponses = []
  clientCallIndex = 0
})

afterEach(() => {
  vi.clearAllMocks()
})

/** envelope 응답 만들기 — { data: rows }. */
function envelope<T>(rows: T[]): { data: T[] } {
  return { data: rows }
}

// =============================================================================
// A. estimateAveragePositionBid (F-10.1)
// =============================================================================

describe("estimateAveragePositionBid", () => {
  it("happy path: positions 기본 [1..5] 응답 5개 row 반환", async () => {
    clientResponses = [
      envelope([
        { keyword: "신발", position: 1, bid: 1500 },
        { keyword: "신발", position: 2, bid: 1100 },
        { keyword: "신발", position: 3, bid: 800 },
        { keyword: "신발", position: 4, bid: 600 },
        { keyword: "신발", position: 5, bid: 400 },
      ]),
    ]

    const rows = await estimateAveragePositionBid("c-1", {
      keyword: "신발",
      device: "PC",
    })

    expect(rows).toHaveLength(5)
    expect(rows[0]).toMatchObject({ position: 1, bid: 1500 })
    expect(rows[4]).toMatchObject({ position: 5, bid: 400 })

    // 호출 인자 검증
    expect(clientCalls).toHaveLength(1)
    expect(clientCalls[0].method).toBe("POST")
    expect(clientCalls[0].path).toBe("/estimate/average-position-bid/keyword")
    expect(clientCalls[0].customerId).toBe("c-1")
    expect(clientCalls[0].body).toEqual({
      device: "PC",
      items: [
        { keyword: "신발", position: 1 },
        { keyword: "신발", position: 2 },
        { keyword: "신발", position: 3 },
        { keyword: "신발", position: 4 },
        { keyword: "신발", position: 5 },
      ],
    })
  })

  it("positions 명시 → 그대로 body items 에 반영", async () => {
    clientResponses = [
      envelope([
        { keyword: "신발", position: 1, bid: 1500 },
        { keyword: "신발", position: 3, bid: 800 },
      ]),
    ]

    const rows = await estimateAveragePositionBid("c-1", {
      keyword: "신발",
      device: "MOBILE",
      positions: [1, 3],
    })

    expect(rows).toHaveLength(2)
    expect(clientCalls[0].body).toEqual({
      device: "MOBILE",
      items: [
        { keyword: "신발", position: 1 },
        { keyword: "신발", position: 3 },
      ],
    })
  })

  it("배열 fallback: envelope 없이 배열 그대로 응답해도 통과", async () => {
    clientResponses = [
      [
        { keyword: "신발", position: 1, bid: 1500 },
        { keyword: "신발", position: 2, bid: 1100 },
      ],
    ]

    const rows = await estimateAveragePositionBid("c-1", {
      keyword: "신발",
      device: "PC",
      positions: [1, 2],
    })

    expect(rows).toHaveLength(2)
  })

  it("Zod 실패 (응답 shape 어긋남) → throw", async () => {
    // bid 가 string 으로 옴 → 검증 실패
    clientResponses = [envelope([{ keyword: "신발", position: 1, bid: "abc" }])]

    await expect(
      estimateAveragePositionBid("c-1", {
        keyword: "신발",
        device: "PC",
        positions: [1],
      }),
    ).rejects.toThrow(/zod validation failed/i)
  })

  it("Zod 실패: position 누락 → throw", async () => {
    clientResponses = [envelope([{ keyword: "신발", bid: 1500 }])]

    await expect(
      estimateAveragePositionBid("c-1", {
        keyword: "신발",
        device: "PC",
        positions: [1],
      }),
    ).rejects.toThrow(/zod validation failed/i)
  })

  it("customerId 누락 → 호출 0회 + throw", async () => {
    await expect(
      estimateAveragePositionBid("", {
        keyword: "신발",
        device: "PC",
      }),
    ).rejects.toThrow(/customerId/)
    expect(clientCalls).toHaveLength(0)
  })

  it("keyword 빈값 → 호출 0회 + throw", async () => {
    await expect(
      estimateAveragePositionBid("c-1", {
        keyword: "",
        device: "PC",
      }),
    ).rejects.toThrow(/keyword/)

    await expect(
      estimateAveragePositionBid("c-1", {
        keyword: "   ",
        device: "PC",
      }),
    ).rejects.toThrow(/keyword/)

    expect(clientCalls).toHaveLength(0)
  })

  it("응답 passthrough: 정의 외 필드 통과", async () => {
    clientResponses = [
      envelope([
        {
          keyword: "신발",
          position: 1,
          bid: 1500,
          // 미정의 추가 필드 (네이버 spec 변경 대비)
          competition: "HIGH",
          extraField: 123,
        },
      ]),
    ]

    const rows = await estimateAveragePositionBid("c-1", {
      keyword: "신발",
      device: "PC",
      positions: [1],
    })

    expect(rows[0]).toMatchObject({ position: 1, bid: 1500 })
    expect((rows[0] as { competition?: string }).competition).toBe("HIGH")
    expect((rows[0] as { extraField?: number }).extraField).toBe(123)
  })
})

// =============================================================================
// B. estimateExposureMinimumBid (F-10.2)
// =============================================================================

describe("estimateExposureMinimumBid", () => {
  it("happy path: 단일 row 반환", async () => {
    clientResponses = [envelope([{ keyword: "신발", minBid: 70 }])]

    const r = await estimateExposureMinimumBid("c-1", {
      keyword: "신발",
      device: "MOBILE",
    })

    expect(r).toMatchObject({ keyword: "신발", minBid: 70 })

    // body shape
    expect(clientCalls).toHaveLength(1)
    expect(clientCalls[0].method).toBe("POST")
    expect(clientCalls[0].path).toBe("/estimate/exposure-minimum-bid/keyword")
    expect(clientCalls[0].body).toEqual({
      device: "MOBILE",
      items: [{ keyword: "신발" }],
    })
  })

  it("응답 row 0개 → throw (insufficient data)", async () => {
    clientResponses = [envelope([])]

    await expect(
      estimateExposureMinimumBid("c-1", {
        keyword: "신발",
        device: "PC",
      }),
    ).rejects.toThrow(/insufficient data|0 rows/i)
  })

  it("Zod 실패: minBid 누락 → throw", async () => {
    clientResponses = [envelope([{ keyword: "신발" }])]

    await expect(
      estimateExposureMinimumBid("c-1", {
        keyword: "신발",
        device: "PC",
      }),
    ).rejects.toThrow(/zod validation failed/i)
  })

  it("배열 fallback 동작", async () => {
    clientResponses = [[{ keyword: "신발", minBid: 70 }]]

    const r = await estimateExposureMinimumBid("c-1", {
      keyword: "신발",
      device: "PC",
    })

    expect(r.minBid).toBe(70)
  })

  it("customerId 누락 → 호출 0회 + throw", async () => {
    await expect(
      estimateExposureMinimumBid("", {
        keyword: "신발",
        device: "PC",
      }),
    ).rejects.toThrow(/customerId/)
    expect(clientCalls).toHaveLength(0)
  })

  it("keyword 누락 → 호출 0회 + throw", async () => {
    await expect(
      estimateExposureMinimumBid("c-1", {
        keyword: "",
        device: "PC",
      }),
    ).rejects.toThrow(/keyword/)
    expect(clientCalls).toHaveLength(0)
  })
})

// =============================================================================
// C. estimatePerformanceBulk (F-10.3)
// =============================================================================

describe("estimatePerformanceBulk", () => {
  it("happy path: bids N개 → row N개 반환", async () => {
    clientResponses = [
      envelope([
        {
          keyword: "신발",
          bid: 100,
          impressions: 50,
          clicks: 2,
          cost: 200,
          cpc: 100,
        },
        {
          keyword: "신발",
          bid: 500,
          impressions: 1234,
          clicks: 56,
          cost: 28000,
          cpc: 500,
        },
        {
          keyword: "신발",
          bid: 1000,
          impressions: 4500,
          clicks: 200,
          cost: 200000,
          cpc: 1000,
        },
      ]),
    ]

    const rows = await estimatePerformanceBulk("c-1", {
      keyword: "신발",
      device: "PC",
      bids: [100, 500, 1000],
    })

    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ bid: 100, impressions: 50, clicks: 2 })
    expect(rows[2]).toMatchObject({ bid: 1000, impressions: 4500 })

    // body shape 검증
    expect(clientCalls).toHaveLength(1)
    expect(clientCalls[0].method).toBe("POST")
    expect(clientCalls[0].path).toBe("/estimate/performance-bulk")
    expect(clientCalls[0].body).toEqual({
      device: "PC",
      items: [
        { keyword: "신발", bid: 100 },
        { keyword: "신발", bid: 500 },
        { keyword: "신발", bid: 1000 },
      ],
    })
  })

  it("bids 빈 배열 → 호출 0회 + [] 반환", async () => {
    const rows = await estimatePerformanceBulk("c-1", {
      keyword: "신발",
      device: "PC",
      bids: [],
    })

    expect(rows).toEqual([])
    expect(clientCalls).toHaveLength(0)
  })

  it("nullable 필드 통과: impressions/clicks/cost/cpc 가 null 도 OK", async () => {
    clientResponses = [
      envelope([
        {
          keyword: "신발",
          bid: 100,
          impressions: null,
          clicks: null,
          cost: null,
          cpc: null,
        },
        {
          keyword: "신발",
          bid: 200,
          // 일부 필드만 있음 — optional
          impressions: 50,
        },
      ]),
    ]

    const rows = await estimatePerformanceBulk("c-1", {
      keyword: "신발",
      device: "PC",
      bids: [100, 200],
    })

    expect(rows).toHaveLength(2)
    expect(rows[0].impressions).toBeNull()
    expect(rows[0].clicks).toBeNull()
    expect(rows[1].impressions).toBe(50)
    expect(rows[1].clicks).toBeUndefined()
  })

  it("Zod 실패: bid 가 string → throw", async () => {
    clientResponses = [envelope([{ keyword: "신발", bid: "abc" }])]

    await expect(
      estimatePerformanceBulk("c-1", {
        keyword: "신발",
        device: "PC",
        bids: [100],
      }),
    ).rejects.toThrow(/zod validation failed/i)
  })

  it("응답 row 0개 → [] 반환 (호출부 표시 정책 책임)", async () => {
    clientResponses = [envelope([])]

    const rows = await estimatePerformanceBulk("c-1", {
      keyword: "신발",
      device: "PC",
      bids: [100, 200],
    })

    expect(rows).toEqual([])
    expect(clientCalls).toHaveLength(1)
  })

  it("배열 fallback 동작", async () => {
    clientResponses = [
      [{ keyword: "신발", bid: 100, impressions: 50, clicks: 2, cost: 200, cpc: 100 }],
    ]

    const rows = await estimatePerformanceBulk("c-1", {
      keyword: "신발",
      device: "PC",
      bids: [100],
    })

    expect(rows).toHaveLength(1)
    expect(rows[0].bid).toBe(100)
  })

  it("customerId 누락 → 호출 0회 + throw", async () => {
    await expect(
      estimatePerformanceBulk("", {
        keyword: "신발",
        device: "PC",
        bids: [100],
      }),
    ).rejects.toThrow(/customerId/)
    expect(clientCalls).toHaveLength(0)
  })

  it("keyword 누락 → 호출 0회 + throw", async () => {
    await expect(
      estimatePerformanceBulk("c-1", {
        keyword: "",
        device: "PC",
        bids: [100],
      }),
    ).rejects.toThrow(/keyword/)
    expect(clientCalls).toHaveLength(0)
  })

  it("응답 passthrough: 정의 외 필드 통과", async () => {
    clientResponses = [
      envelope([
        {
          keyword: "신발",
          bid: 100,
          impressions: 50,
          rank: 3.2, // 미정의 추가 필드
        },
      ]),
    ]

    const rows = await estimatePerformanceBulk("c-1", {
      keyword: "신발",
      device: "PC",
      bids: [100],
    })

    expect((rows[0] as { rank?: number }).rank).toBe(3.2)
  })
})

// =============================================================================
// D. body shape 회귀
// =============================================================================

describe("body shape 회귀", () => {
  it("estimateAveragePositionBid: device + items[{keyword,position}]", async () => {
    clientResponses = [envelope([{ keyword: "k", position: 1, bid: 100 }])]

    await estimateAveragePositionBid("c-1", {
      keyword: "k",
      device: "PC",
      positions: [1],
    })

    const body = clientCalls[0].body as {
      device: string
      items: Array<{ keyword: string; position: number }>
    }
    expect(body.device).toBe("PC")
    expect(Array.isArray(body.items)).toBe(true)
    expect(body.items[0]).toEqual({ keyword: "k", position: 1 })
  })

  it("estimateExposureMinimumBid: device + items[{keyword}] 단일", async () => {
    clientResponses = [envelope([{ keyword: "k", minBid: 50 }])]

    await estimateExposureMinimumBid("c-1", {
      keyword: "k",
      device: "MOBILE",
    })

    const body = clientCalls[0].body as {
      device: string
      items: Array<{ keyword: string }>
    }
    expect(body.device).toBe("MOBILE")
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toEqual({ keyword: "k" })
  })

  it("estimatePerformanceBulk: device + items[{keyword,bid}] 멀티", async () => {
    clientResponses = [
      envelope([
        { keyword: "k", bid: 100 },
        { keyword: "k", bid: 200 },
      ]),
    ]

    await estimatePerformanceBulk("c-1", {
      keyword: "k",
      device: "PC",
      bids: [100, 200],
    })

    const body = clientCalls[0].body as {
      device: string
      items: Array<{ keyword: string; bid: number }>
    }
    expect(body.device).toBe("PC")
    expect(body.items).toHaveLength(2)
    expect(body.items[0]).toEqual({ keyword: "k", bid: 100 })
    expect(body.items[1]).toEqual({ keyword: "k", bid: 200 })
  })
})
