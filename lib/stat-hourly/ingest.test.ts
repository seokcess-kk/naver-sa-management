/**
 * lib/stat-hourly/ingest.ts 단위 테스트 (F-9.2 / F-9.4)
 *
 * 검증 범위 (헬퍼 변환 로직 회귀 가드):
 *   A. previousHourKstAsUtc — KST 직전 정시 정확성 (자정/월/연 경계)
 *   B. dateToStatDtString — KST 일자 문자열 변환
 *   C. pickLevel           — 호출 컨텍스트 level + row.id 정상 검증
 *   D. toUpsertInput       — device='ALL' / recentAvgRnk null·non-null / unique key
 *   E. updateKeywordRecentAvgRnk — 일괄 update + 실패(P2025) 흡수
 *   F. ingestAdvertiserStatHourly — Stats API + Prisma mock 으로 흐름 가드
 *
 * 외부 호출 0 보장:
 *   - vi.mock("@/lib/naver-sa/stats", ...) — 실 SA 호출 0
 *   - vi.mock("@/lib/db/prisma", ...)       — 실 DB 호출 0
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

// =============================================================================
// Mocks (전역 — import 전에 hoist 됨)
// =============================================================================

const mockGetStatsChunked = vi.fn()

vi.mock("@/lib/naver-sa/stats", () => ({
  getStatsChunked: (...args: unknown[]) => mockGetStatsChunked(...args),
}))

const mockCampaignFindMany = vi.fn()
const mockAdGroupFindMany = vi.fn()
const mockKeywordFindMany = vi.fn()
const mockKeywordUpdate = vi.fn()
const mockStatHourlyUpsert = vi.fn()
const mockTransaction = vi.fn()

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    campaign: {
      findMany: (...args: unknown[]) => mockCampaignFindMany(...args),
    },
    adGroup: {
      findMany: (...args: unknown[]) => mockAdGroupFindMany(...args),
    },
    keyword: {
      findMany: (...args: unknown[]) => mockKeywordFindMany(...args),
      update: (...args: unknown[]) => mockKeywordUpdate(...args),
    },
    statHourly: {
      upsert: (...args: unknown[]) => mockStatHourlyUpsert(...args),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}))

// import 본체 — mock 등록 이후
import {
  dateToStatDtString,
  ingestAdvertiserStatHourly,
  pickLevel,
  previousHourKstAsUtc,
  toUpsertInput,
  updateKeywordRecentAvgRnk,
} from "@/lib/stat-hourly/ingest"
import type { StatsRow } from "@/lib/naver-sa/stats"

// =============================================================================
// A. previousHourKstAsUtc
// =============================================================================

describe("previousHourKstAsUtc", () => {
  it("KST 14:35 (= UTC 05:35) → date=KST 그날 0시, hour=13 (직전 정시)", () => {
    const now = new Date("2026-04-29T05:35:00.000Z") // KST 2026-04-29 14:35
    const got = previousHourKstAsUtc(now)
    // KST 0시 = UTC 전일 15:00
    expect(got.date.toISOString()).toBe("2026-04-28T15:00:00.000Z")
    expect(got.hour).toBe(13)
  })

  it("KST 정시 직후 (14:00:30) → hour=13 (정시도 직전)", () => {
    const now = new Date("2026-04-29T05:00:30.000Z")
    const got = previousHourKstAsUtc(now)
    expect(got.date.toISOString()).toBe("2026-04-28T15:00:00.000Z")
    expect(got.hour).toBe(13)
  })

  it("KST 자정 직후 (00:30) → 전일 23시 (date 도 전일로 롤백)", () => {
    // KST 2026-04-29 00:30 = UTC 2026-04-28 15:30
    const now = new Date("2026-04-28T15:30:00.000Z")
    const got = previousHourKstAsUtc(now)
    // 직전 시간은 KST 2026-04-28 23시 → date = KST 2026-04-28 0시 = UTC 2026-04-27 15:00
    expect(got.date.toISOString()).toBe("2026-04-27T15:00:00.000Z")
    expect(got.hour).toBe(23)
  })

  it("KST 자정 (00:00) → 전일 23시", () => {
    const now = new Date("2026-04-28T15:00:00.000Z")
    const got = previousHourKstAsUtc(now)
    expect(got.date.toISOString()).toBe("2026-04-27T15:00:00.000Z")
    expect(got.hour).toBe(23)
  })

  it("KST 01:00 → KST 그날 0시", () => {
    // KST 2026-04-29 01:00 = UTC 2026-04-28 16:00
    const now = new Date("2026-04-28T16:00:00.000Z")
    const got = previousHourKstAsUtc(now)
    expect(got.date.toISOString()).toBe("2026-04-28T15:00:00.000Z") // KST 4-29 0시
    expect(got.hour).toBe(0)
  })

  it("월 경계 — KST 2026-05-01 00:30 → KST 2026-04-30 23시", () => {
    // KST 2026-05-01 00:30 = UTC 2026-04-30 15:30
    const now = new Date("2026-04-30T15:30:00.000Z")
    const got = previousHourKstAsUtc(now)
    expect(got.date.toISOString()).toBe("2026-04-29T15:00:00.000Z") // KST 4-30 0시
    expect(got.hour).toBe(23)
  })

  it("연 경계 — KST 2026-01-01 00:30 → KST 2025-12-31 23시", () => {
    // KST 2026-01-01 00:30 = UTC 2025-12-31 15:30
    const now = new Date("2025-12-31T15:30:00.000Z")
    const got = previousHourKstAsUtc(now)
    expect(got.date.toISOString()).toBe("2025-12-30T15:00:00.000Z") // KST 12-31 0시
    expect(got.hour).toBe(23)
  })

  it("default 인자 (now 미지정) — 정상 Date 반환", () => {
    const got = previousHourKstAsUtc()
    expect(got.date).toBeInstanceOf(Date)
    expect(Number.isNaN(got.date.getTime())).toBe(false)
    expect(got.hour).toBeGreaterThanOrEqual(0)
    expect(got.hour).toBeLessThanOrEqual(23)
  })
})

// =============================================================================
// B. dateToStatDtString
// =============================================================================

describe("dateToStatDtString", () => {
  it("KST 2026-04-28 0시 (= UTC 2026-04-27 15:00) → '2026-04-28'", () => {
    const date = new Date("2026-04-27T15:00:00.000Z")
    expect(dateToStatDtString(date)).toBe("2026-04-28")
  })

  it("KST 2026-01-01 0시 (= UTC 2025-12-31 15:00) → '2026-01-01'", () => {
    const date = new Date("2025-12-31T15:00:00.000Z")
    expect(dateToStatDtString(date)).toBe("2026-01-01")
  })

  it("월 경계 — KST 2026-05-01 0시 (= UTC 2026-04-30 15:00) → '2026-05-01'", () => {
    const date = new Date("2026-04-30T15:00:00.000Z")
    expect(dateToStatDtString(date)).toBe("2026-05-01")
  })
})

// =============================================================================
// C. pickLevel
// =============================================================================

describe("pickLevel", () => {
  it("row.id non-empty → { level, refId }", () => {
    expect(pickLevel("keyword", { id: "K-1" } as StatsRow)).toEqual({
      level: "keyword",
      refId: "K-1",
    })
    expect(pickLevel("adgroup", { id: "A-1" } as StatsRow)).toEqual({
      level: "adgroup",
      refId: "A-1",
    })
    expect(pickLevel("campaign", { id: "C-1" } as StatsRow)).toEqual({
      level: "campaign",
      refId: "C-1",
    })
  })

  it("row.id 빈 문자열 → null", () => {
    expect(pickLevel("keyword", { id: "" } as StatsRow)).toBeNull()
  })

  it("row.id undefined → null (광고주 합산 row)", () => {
    expect(pickLevel("keyword", {} as StatsRow)).toBeNull()
  })

  it("row.id 숫자형 (string 아님) → null (StatsRow 정규화 후엔 string 만)", () => {
    // StatsRowSchema 가 transform 으로 string 화 하지만, 본 함수는 typeof 가드
    expect(pickLevel("keyword", { id: 123 as unknown as string } as StatsRow)).toBeNull()
  })
})

// =============================================================================
// D. toUpsertInput
// =============================================================================

describe("toUpsertInput", () => {
  const baseDate = new Date("2026-04-28T15:00:00.000Z") // KST 4-29 0시
  const baseHour = 13

  it("keyword level / device='ALL' / 모든 메트릭 + recentAvgRnk", () => {
    const inp = toUpsertInput({
      advertiserId: "adv-1",
      date: baseDate,
      hour: baseHour,
      level: "keyword",
      row: {
        id: "K-1",
        impCnt: 100,
        clkCnt: 10,
        salesAmt: 1234.56,
        recentAvgRnk: 2.5,
        hh24: "13",
      } as StatsRow,
    })
    expect(inp).not.toBeNull()
    if (inp === null) return
    expect(inp.where).toEqual({
      date_hour_level_refId_device: {
        date: baseDate,
        hour: baseHour,
        level: "keyword",
        refId: "K-1",
        device: "ALL",
      },
    })
    expect(inp.create).toMatchObject({
      advertiserId: "adv-1",
      date: baseDate,
      hour: baseHour,
      level: "keyword",
      refId: "K-1",
      device: "ALL",
      impressions: 100,
      clicks: 10,
      cost: 1234.56,
      recentAvgRnk: 2.5,
    })
    expect(inp.update).toMatchObject({
      impressions: 100,
      clicks: 10,
      cost: 1234.56,
      recentAvgRnk: 2.5,
    })
    // update 에 advertiserId 미포함 (refId owner 불변 가정)
    expect(inp.update).not.toHaveProperty("advertiserId")
  })

  it("recentAvgRnk null → null 그대로 (Decimal? 컬럼)", () => {
    const inp = toUpsertInput({
      advertiserId: "adv-1",
      date: baseDate,
      hour: baseHour,
      level: "keyword",
      row: { id: "K-1", impCnt: 1, clkCnt: 0, salesAmt: 0, recentAvgRnk: null } as StatsRow,
    })
    expect(inp).not.toBeNull()
    if (inp === null) return
    expect((inp.create as { recentAvgRnk: unknown }).recentAvgRnk).toBeNull()
    expect((inp.update as { recentAvgRnk: unknown }).recentAvgRnk).toBeNull()
  })

  it("recentAvgRnk undefined → null", () => {
    const inp = toUpsertInput({
      advertiserId: "adv-1",
      date: baseDate,
      hour: baseHour,
      level: "keyword",
      row: { id: "K-1", impCnt: 1 } as StatsRow,
    })
    expect(inp).not.toBeNull()
    if (inp === null) return
    expect((inp.create as { recentAvgRnk: unknown }).recentAvgRnk).toBeNull()
  })

  it("impCnt/clkCnt/salesAmt 결측 → 0 으로 정규화", () => {
    const inp = toUpsertInput({
      advertiserId: "adv-1",
      date: baseDate,
      hour: baseHour,
      level: "campaign",
      row: { id: "C-1" } as StatsRow,
    })
    expect(inp).not.toBeNull()
    if (inp === null) return
    expect(inp.create).toMatchObject({ impressions: 0, clicks: 0, cost: 0 })
  })

  it("row.id 빈 → null (skip 신호)", () => {
    expect(
      toUpsertInput({
        advertiserId: "adv-1",
        date: baseDate,
        hour: baseHour,
        level: "keyword",
        row: { id: "" } as StatsRow,
      }),
    ).toBeNull()
  })
})

// =============================================================================
// E. updateKeywordRecentAvgRnk
// =============================================================================

describe("updateKeywordRecentAvgRnk", () => {
  beforeEach(() => {
    mockKeywordUpdate.mockReset()
  })

  it("빈 입력 → 0 / update 호출 0", async () => {
    const r = await updateKeywordRecentAvgRnk("adv-1", [])
    expect(r).toBe(0)
    expect(mockKeywordUpdate).not.toHaveBeenCalled()
  })

  it("3건 모두 성공 → 3 / nccKeywordId 기준 update", async () => {
    mockKeywordUpdate.mockResolvedValue({})
    const r = await updateKeywordRecentAvgRnk("adv-1", [
      { nccKeywordId: "K-1", rnk: 2.5 },
      { nccKeywordId: "K-2", rnk: 3.1 },
      { nccKeywordId: "K-3", rnk: 1.0 },
    ])
    expect(r).toBe(3)
    expect(mockKeywordUpdate).toHaveBeenCalledTimes(3)
    expect(mockKeywordUpdate).toHaveBeenCalledWith({
      where: { nccKeywordId: "K-1" },
      data: { recentAvgRnk: 2.5 },
    })
  })

  it("일부 실패(P2025 등) → settled 흡수 + 성공만 카운트", async () => {
    // 첫 번째 성공, 두 번째 실패, 세 번째 성공
    mockKeywordUpdate
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("Record to update not found"))
      .mockResolvedValueOnce({})
    const r = await updateKeywordRecentAvgRnk("adv-1", [
      { nccKeywordId: "K-1", rnk: 2.5 },
      { nccKeywordId: "K-NOPE", rnk: 9.9 },
      { nccKeywordId: "K-3", rnk: 1.0 },
    ])
    expect(r).toBe(2)
  })

  it("chunk 100 — 250건이면 update 250 호출", async () => {
    mockKeywordUpdate.mockResolvedValue({})
    const ranks = Array.from({ length: 250 }, (_, i) => ({
      nccKeywordId: `K-${i}`,
      rnk: i / 10,
    }))
    const r = await updateKeywordRecentAvgRnk("adv-1", ranks)
    expect(r).toBe(250)
    expect(mockKeywordUpdate).toHaveBeenCalledTimes(250)
  })
})

// =============================================================================
// F. ingestAdvertiserStatHourly — Stats API + Prisma mock
// =============================================================================

describe("ingestAdvertiserStatHourly", () => {
  beforeEach(() => {
    mockGetStatsChunked.mockReset()
    mockCampaignFindMany.mockReset()
    mockAdGroupFindMany.mockReset()
    mockKeywordFindMany.mockReset()
    mockKeywordUpdate.mockReset()
    mockStatHourlyUpsert.mockReset()
    mockTransaction.mockReset()

    // prisma.$transaction(promises[]) → Promise.all 흉내
    mockTransaction.mockImplementation(async (ops: unknown) => {
      if (Array.isArray(ops)) {
        return Promise.all(ops as Promise<unknown>[])
      }
      return ops
    })
    mockStatHourlyUpsert.mockImplementation(async () => ({}))
    mockKeywordUpdate.mockImplementation(async () => ({}))
  })

  const baseArgs = {
    advertiserId: "adv-1",
    customerId: "cust-1",
    date: new Date("2026-04-28T15:00:00.000Z"), // KST 4-29 0시
    hour: 13,
  }

  it("happy — campaign/adgroup/keyword 3 level 호출 + 직전 시간만 추출 + Keyword 갱신", async () => {
    mockCampaignFindMany.mockResolvedValue([{ nccCampaignId: "C-1" }])
    mockAdGroupFindMany.mockResolvedValue([{ nccAdgroupId: "A-1" }])
    mockKeywordFindMany.mockResolvedValue([
      { nccKeywordId: "K-1" },
      { nccKeywordId: "K-2" },
    ])

    // 각 level 호출 결과 (24개 시간대 row 중 hour=13 만 추출됨)
    mockGetStatsChunked.mockImplementation(
      async (
        _customerId: string,
        req: { ids: string[]; breakdown?: string },
      ): Promise<StatsRow[]> => {
        // 모든 호출에 대해 hh24=12 / hh24=13 / hh24=14 row 3개 반환
        // → ingest 는 hh24=13 만 추출
        const ids = req.ids
        const out: StatsRow[] = []
        for (const id of ids) {
          out.push(
            { id, hh24: "12", impCnt: 5, clkCnt: 1, salesAmt: 100, recentAvgRnk: 1.0 } as StatsRow,
            { id, hh24: "13", impCnt: 50, clkCnt: 5, salesAmt: 1000, recentAvgRnk: 2.5 } as StatsRow,
            { id, hh24: "14", impCnt: 70, clkCnt: 7, salesAmt: 1500, recentAvgRnk: 3.0 } as StatsRow,
          )
        }
        return out
      },
    )

    const r = await ingestAdvertiserStatHourly(baseArgs)

    // upsert: campaign 1 + adgroup 1 + keyword 2 = 4 row (hour=13 만)
    expect(r.rowsInserted).toBe(4)
    expect(r.rowsSkipped).toBe(0)
    // keyword 2건 모두 recentAvgRnk non-null → 2건 갱신
    expect(r.keywordsRanked).toBe(2)

    // 호출 인자 검증
    expect(mockGetStatsChunked).toHaveBeenCalledTimes(3)
    const calls = mockGetStatsChunked.mock.calls
    // campaign call
    expect(calls[0][0]).toBe("cust-1")
    expect(calls[0][1]).toMatchObject({
      ids: ["C-1"],
      fields: ["impCnt", "clkCnt", "salesAmt", "recentAvgRnk"],
      breakdown: "hh24",
      timeRange: { since: "2026-04-29", until: "2026-04-29" },
    })
    // adgroup call
    expect(calls[1][1]).toMatchObject({ ids: ["A-1"] })
    // keyword call
    expect(calls[2][1]).toMatchObject({ ids: ["K-1", "K-2"] })

    // Keyword.update 호출 (last non-null 정책 — null 제외)
    expect(mockKeywordUpdate).toHaveBeenCalledWith({
      where: { nccKeywordId: "K-1" },
      data: { recentAvgRnk: 2.5 },
    })
    expect(mockKeywordUpdate).toHaveBeenCalledWith({
      where: { nccKeywordId: "K-2" },
      data: { recentAvgRnk: 2.5 },
    })
  })

  it("ids 모두 빈 (활성 캠페인/광고그룹/키워드 0) → Stats 호출 0 / upsert 0 / Keyword 갱신 0", async () => {
    mockCampaignFindMany.mockResolvedValue([])
    mockAdGroupFindMany.mockResolvedValue([])
    mockKeywordFindMany.mockResolvedValue([])

    const r = await ingestAdvertiserStatHourly(baseArgs)
    expect(r.rowsInserted).toBe(0)
    expect(r.rowsSkipped).toBe(0)
    expect(r.keywordsRanked).toBe(0)
    expect(mockGetStatsChunked).not.toHaveBeenCalled()
    expect(mockTransaction).not.toHaveBeenCalled()
    expect(mockKeywordUpdate).not.toHaveBeenCalled()
  })

  it("recentAvgRnk null row → Keyword 갱신 큐에서 제외 (last non-null 정책)", async () => {
    mockCampaignFindMany.mockResolvedValue([])
    mockAdGroupFindMany.mockResolvedValue([])
    mockKeywordFindMany.mockResolvedValue([
      { nccKeywordId: "K-1" },
      { nccKeywordId: "K-2" },
    ])

    mockGetStatsChunked.mockResolvedValue([
      { id: "K-1", hh24: 13, impCnt: 5, clkCnt: 1, salesAmt: 100, recentAvgRnk: 2.5 },
      { id: "K-2", hh24: 13, impCnt: 0, clkCnt: 0, salesAmt: 0, recentAvgRnk: null },
    ] as StatsRow[])

    const r = await ingestAdvertiserStatHourly(baseArgs)
    // upsert 는 둘 다 적재 (StatHourly.recentAvgRnk null 통과)
    expect(r.rowsInserted).toBe(2)
    // Keyword 갱신은 K-1 만
    expect(r.keywordsRanked).toBe(1)
    expect(mockKeywordUpdate).toHaveBeenCalledTimes(1)
    expect(mockKeywordUpdate).toHaveBeenCalledWith({
      where: { nccKeywordId: "K-1" },
      data: { recentAvgRnk: 2.5 },
    })
  })

  it("hh24 number 응답도 처리 (string/number 양쪽 양식)", async () => {
    mockCampaignFindMany.mockResolvedValue([])
    mockAdGroupFindMany.mockResolvedValue([])
    mockKeywordFindMany.mockResolvedValue([{ nccKeywordId: "K-1" }])

    mockGetStatsChunked.mockResolvedValue([
      { id: "K-1", hh24: 13, impCnt: 5, clkCnt: 1, salesAmt: 100, recentAvgRnk: 2.5 },
      { id: "K-1", hh24: 14, impCnt: 9, clkCnt: 2, salesAmt: 200, recentAvgRnk: 3.0 },
    ] as StatsRow[])

    const r = await ingestAdvertiserStatHourly(baseArgs)
    expect(r.rowsInserted).toBe(1) // hh24=13 만
    expect(r.keywordsRanked).toBe(1)
  })

  it("row.id 빈 (광고주 합산 row 등) → skip", async () => {
    mockCampaignFindMany.mockResolvedValue([])
    mockAdGroupFindMany.mockResolvedValue([])
    mockKeywordFindMany.mockResolvedValue([{ nccKeywordId: "K-1" }])

    mockGetStatsChunked.mockResolvedValue([
      { id: "", hh24: "13", impCnt: 100, clkCnt: 10, salesAmt: 1000 },
      { id: "K-1", hh24: "13", impCnt: 5, clkCnt: 1, salesAmt: 100, recentAvgRnk: 2.0 },
    ] as StatsRow[])

    const r = await ingestAdvertiserStatHourly(baseArgs)
    expect(r.rowsInserted).toBe(1)
    expect(r.rowsSkipped).toBe(1)
  })

  it("Stats API 호출 실패 → throw 전파 (호출부가 광고주 격리)", async () => {
    mockCampaignFindMany.mockResolvedValue([])
    mockAdGroupFindMany.mockResolvedValue([])
    mockKeywordFindMany.mockResolvedValue([{ nccKeywordId: "K-1" }])

    mockGetStatsChunked.mockRejectedValue(new Error("SA boom"))

    await expect(ingestAdvertiserStatHourly(baseArgs)).rejects.toThrow("SA boom")
  })

  it("upsert chunk 100 — 250 keyword row 직전 시간 → transaction 3번 (100+100+50)", async () => {
    mockCampaignFindMany.mockResolvedValue([])
    mockAdGroupFindMany.mockResolvedValue([])
    const keywords = Array.from({ length: 250 }, (_, i) => ({
      nccKeywordId: `K-${i}`,
    }))
    mockKeywordFindMany.mockResolvedValue(keywords)

    const rows: StatsRow[] = Array.from(
      { length: 250 },
      (_, i) =>
        ({
          id: `K-${i}`,
          hh24: "13",
          impCnt: 1,
          clkCnt: 0,
          salesAmt: 0,
          recentAvgRnk: 1.5,
        }) as StatsRow,
    )
    mockGetStatsChunked.mockResolvedValue(rows)

    const r = await ingestAdvertiserStatHourly(baseArgs)
    expect(r.rowsInserted).toBe(250)
    expect(mockTransaction).toHaveBeenCalledTimes(3)
  })

  it("findMany where 조건 — status='on' 만", async () => {
    mockCampaignFindMany.mockResolvedValue([])
    mockAdGroupFindMany.mockResolvedValue([])
    mockKeywordFindMany.mockResolvedValue([])

    await ingestAdvertiserStatHourly(baseArgs)

    expect(mockCampaignFindMany).toHaveBeenCalledWith({
      where: { advertiserId: "adv-1", status: "on" },
      select: { nccCampaignId: true },
    })
    expect(mockAdGroupFindMany).toHaveBeenCalledWith({
      where: { campaign: { advertiserId: "adv-1" }, status: "on" },
      select: { nccAdgroupId: true },
    })
    expect(mockKeywordFindMany).toHaveBeenCalledWith({
      where: {
        adgroup: { campaign: { advertiserId: "adv-1" } },
        status: "on",
      },
      select: { nccKeywordId: true },
    })
  })
})
