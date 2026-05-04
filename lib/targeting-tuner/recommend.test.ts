/**
 * lib/targeting-tuner/recommend.ts 단위 테스트 (Phase E.3).
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "@/lib/generated/prisma/client"

const mockGroupBy = vi.fn()
vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    statHourly: {
      groupBy: (...args: unknown[]) => mockGroupBy(...args),
    },
  },
}))

import {
  bucketOf,
  recommendTargetingWeights,
  DEFAULT_TARGETING_TUNER_CONFIG,
} from "./recommend"

beforeEach(() => mockGroupBy.mockReset())

describe("bucketOf", () => {
  it("월요일(1) 10시 → weekday_morning", () => {
    expect(bucketOf(1, 10)).toBe("weekday_morning")
  })
  it("금요일(5) 14시 → weekday_afternoon", () => {
    expect(bucketOf(5, 14)).toBe("weekday_afternoon")
  })
  it("수요일(3) 20시 → evening (전체 18~23)", () => {
    expect(bucketOf(3, 20)).toBe("evening")
  })
  it("토요일(6) 20시 → evening", () => {
    expect(bucketOf(6, 20)).toBe("evening")
  })
  it("일요일(0) 12시 → off_peak (주말 낮)", () => {
    expect(bucketOf(0, 12)).toBe("off_peak")
  })
  it("월요일(1) 6시 → off_peak (새벽)", () => {
    expect(bucketOf(1, 6)).toBe("off_peak")
  })
  it("월요일(1) 8시 → off_peak (오전 9시 미만)", () => {
    expect(bucketOf(1, 8)).toBe("off_peak")
  })
  it("월요일(1) 9시 → weekday_morning (boundary inclusive)", () => {
    expect(bucketOf(1, 9)).toBe("weekday_morning")
  })
  it("월요일(1) 18시 → evening (boundary)", () => {
    expect(bucketOf(1, 18)).toBe("evening")
  })
})

describe("recommendTargetingWeights", () => {
  function statRow(opts: {
    date: string
    hour: number
    imps: number
    clicks: number
    cost?: number
  }) {
    return {
      date: new Date(opts.date),
      hour: opts.hour,
      _sum: {
        impressions: opts.imps,
        clicks: opts.clicks,
        cost: new Prisma.Decimal(opts.cost ?? 0),
      },
    }
  }

  it("표본 부족 — minSamples=14 미만이면 hasSignal=false / weight=1.0", async () => {
    // 14 슬롯 미만의 weekday_morning 데이터만
    const rows = [
      statRow({ date: "2026-04-13", hour: 10, imps: 1000, clicks: 50 }),
      statRow({ date: "2026-04-14", hour: 10, imps: 1000, clicks: 50 }),
    ]
    mockGroupBy.mockResolvedValueOnce(rows)

    const r = await recommendTargetingWeights("adv1")
    expect(r.buckets.weekday_morning.hasSignal).toBe(false)
    expect(r.buckets.weekday_morning.recommendedWeight).toBe(1.0)
  })

  it("baseline 없음 (전체 imp 0) → 모든 버킷 weight 1.0", async () => {
    mockGroupBy.mockResolvedValueOnce([])
    const r = await recommendTargetingWeights("adv1")
    expect(r.baseline.ctr).toBeNull()
    for (const k of ["weekday_morning", "weekday_afternoon", "evening", "off_peak"] as const) {
      expect(r.buckets[k].hasSignal).toBe(false)
      expect(r.buckets[k].recommendedWeight).toBe(1.0)
    }
  })

  it("CTR 우월 묶음 → weight > 1.0 (clamp 1.5 상한)", async () => {
    // 14 slots 가득 채워서 hasSignal=true 만들고 CTR 비교
    // weekday_morning: 14 slots, 매 슬롯 imps 1000, clicks 50 = CTR 5%
    // 다른 묶음: 14 slots 씩, imps 1000, clicks 10 = CTR 1%
    // baseline = (14×50 + 14×10×3) / (14×1000×4) = 1120 / 56000 = 2%
    // weekday_morning ratio = 5/2 = 2.5 → clamp 1.5
    const rows: ReturnType<typeof statRow>[] = []
    // weekday_morning: 14일 월요일 10시
    for (let i = 0; i < 14; i++) {
      // 2026-04-13 = 월요일
      const d = new Date("2026-04-13")
      d.setUTCDate(d.getUTCDate() + i * 7) // 매 월요일
      rows.push(
        statRow({
          date: d.toISOString().slice(0, 10),
          hour: 10,
          imps: 1000,
          clicks: 50,
        }),
      )
    }
    // weekday_afternoon: 14 슬롯
    for (let i = 0; i < 14; i++) {
      const d = new Date("2026-04-13")
      d.setUTCDate(d.getUTCDate() + i * 7)
      rows.push(
        statRow({
          date: d.toISOString().slice(0, 10),
          hour: 14,
          imps: 1000,
          clicks: 10,
        }),
      )
    }
    // evening: 14 슬롯
    for (let i = 0; i < 14; i++) {
      const d = new Date("2026-04-13")
      d.setUTCDate(d.getUTCDate() + i * 7)
      rows.push(
        statRow({
          date: d.toISOString().slice(0, 10),
          hour: 20,
          imps: 1000,
          clicks: 10,
        }),
      )
    }
    // off_peak: 14 슬롯 (수요일 새벽)
    for (let i = 0; i < 14; i++) {
      const d = new Date("2026-04-15")
      d.setUTCDate(d.getUTCDate() + i * 7)
      rows.push(
        statRow({
          date: d.toISOString().slice(0, 10),
          hour: 5,
          imps: 1000,
          clicks: 10,
        }),
      )
    }
    mockGroupBy.mockResolvedValueOnce(rows)

    const r = await recommendTargetingWeights("adv1")
    expect(r.buckets.weekday_morning.hasSignal).toBe(true)
    expect(r.buckets.weekday_morning.recommendedWeight).toBe(1.5) // clamp ceil
    expect(r.buckets.evening.hasSignal).toBe(true)
    // evening CTR 1% < baseline 2% → ratio 0.5 → weight 0.5 (clamp floor)
    expect(r.buckets.evening.recommendedWeight).toBe(0.5)
  })

  it("DEFAULT_TARGETING_TUNER_CONFIG 노출", () => {
    expect(DEFAULT_TARGETING_TUNER_CONFIG.windowDays).toBe(28)
    expect(DEFAULT_TARGETING_TUNER_CONFIG.minSamples).toBe(14)
    expect(DEFAULT_TARGETING_TUNER_CONFIG.weightFloor).toBe(0.5)
    expect(DEFAULT_TARGETING_TUNER_CONFIG.weightCeil).toBe(1.5)
  })

  it("groupBy 호출 시 level='campaign' AND device='ALL'", async () => {
    mockGroupBy.mockResolvedValueOnce([])
    await recommendTargetingWeights("adv1")
    const where = mockGroupBy.mock.calls[0][0].where
    expect(where.level).toBe("campaign")
    expect(where.device).toBe("ALL")
    expect(where.advertiserId).toBe("adv1")
  })
})
