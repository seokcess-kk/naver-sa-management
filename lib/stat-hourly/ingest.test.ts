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

  // SA Stats API 응답 형식: row 1개당 합산 + breakdowns 시간별 분해 배열.
  // 라벨 "HH시~HH+1시" 는 HH 시간대를 의미. 시간대별 recentAvgRnk 는 SA 미제공.
  const makeRow = (
    id: string,
    rowRnk: number | null,
    hours: { hour: number; impCnt: number; clkCnt: number; salesAmt: number }[],
  ): StatsRow =>
    ({
      id,
      impCnt: hours.reduce((s, h) => s + h.impCnt, 0),
      clkCnt: hours.reduce((s, h) => s + h.clkCnt, 0),
      salesAmt: hours.reduce((s, h) => s + h.salesAmt, 0),
      recentAvgRnk: rowRnk,
      breakdowns: hours.map((h) => ({
        name: `${String(h.hour).padStart(2, "0")}시~${String(h.hour + 1).padStart(2, "0")}시`,
        impCnt: h.impCnt,
        clkCnt: h.clkCnt,
        salesAmt: h.salesAmt,
      })),
    }) as unknown as StatsRow

  it("happy — campaign/adgroup/keyword 3 level 호출 + 직전 시간(13) breakdown 추출 + Keyword 갱신", async () => {
    mockCampaignFindMany.mockResolvedValue([{ nccCampaignId: "C-1" }])
    mockAdGroupFindMany.mockResolvedValue([{ nccAdgroupId: "A-1" }])
    mockKeywordFindMany.mockResolvedValue([
      { nccKeywordId: "K-1" },
      { nccKeywordId: "K-2" },
    ])

    // 모든 호출 응답: hour 12/13/14 시간대 breakdown 3개 — 코드는 hour=13 만 추출
    mockGetStatsChunked.mockImplementation(
      async (
        _customerId: string,
        req: { ids: string[] },
      ): Promise<StatsRow[]> =>
        req.ids.map((id) =>
          makeRow(id, 2.5, [
            { hour: 12, impCnt: 5, clkCnt: 1, salesAmt: 100 },
            { hour: 13, impCnt: 50, clkCnt: 5, salesAmt: 1000 },
            { hour: 14, impCnt: 70, clkCnt: 7, salesAmt: 1500 },
          ]),
        ),
    )

    const r = await ingestAdvertiserStatHourly(baseArgs)

    // upsert: campaign 1 + adgroup 1 + keyword 2 = 4 row (hour=13 만)
    expect(r.rowsInserted).toBe(4)
    expect(r.rowsSkipped).toBe(0)
    // keyword 2건 모두 row level recentAvgRnk=2.5 → 2건 갱신
    expect(r.keywordsRanked).toBe(2)

    // 호출 인자 검증
    expect(mockGetStatsChunked).toHaveBeenCalledTimes(3)
    const calls = mockGetStatsChunked.mock.calls
    expect(calls[0][0]).toBe("cust-1")
    expect(calls[0][1]).toMatchObject({
      ids: ["C-1"],
      fields: ["impCnt", "clkCnt", "salesAmt", "recentAvgRnk"],
      breakdown: "hh24",
      timeRange: { since: "2026-04-29", until: "2026-04-29" },
    })
    expect(calls[1][1]).toMatchObject({ ids: ["A-1"] })
    expect(calls[2][1]).toMatchObject({ ids: ["K-1", "K-2"] })

    // Keyword.update 호출 — row level rnk 사용 (2.5)
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

  it("row level recentAvgRnk null / 0 → Keyword 갱신 큐 제외 (>0 정책)", async () => {
    mockCampaignFindMany.mockResolvedValue([])
    mockAdGroupFindMany.mockResolvedValue([])
    mockKeywordFindMany.mockResolvedValue([
      { nccKeywordId: "K-1" },
      { nccKeywordId: "K-2" },
      { nccKeywordId: "K-3" },
    ])

    mockGetStatsChunked.mockResolvedValue([
      makeRow("K-1", 2.5, [{ hour: 13, impCnt: 5, clkCnt: 1, salesAmt: 100 }]),
      makeRow("K-2", null, [{ hour: 13, impCnt: 0, clkCnt: 0, salesAmt: 0 }]),
      // 0 은 SA 가 데이터 부족 시 회신하는 placeholder — 갱신 안 함
      makeRow("K-3", 0, [{ hour: 13, impCnt: 0, clkCnt: 0, salesAmt: 0 }]),
    ])

    const r = await ingestAdvertiserStatHourly(baseArgs)
    // StatHourly upsert 는 3건 모두 (시간대별 매칭)
    expect(r.rowsInserted).toBe(3)
    // Keyword 갱신은 K-1 만 (rnk > 0)
    expect(r.keywordsRanked).toBe(1)
    expect(mockKeywordUpdate).toHaveBeenCalledTimes(1)
    expect(mockKeywordUpdate).toHaveBeenCalledWith({
      where: { nccKeywordId: "K-1" },
      data: { recentAvgRnk: 2.5 },
    })
  })

  it("breakdown 라벨 시간이 hour 와 다른 항목은 skip", async () => {
    mockCampaignFindMany.mockResolvedValue([])
    mockAdGroupFindMany.mockResolvedValue([])
    mockKeywordFindMany.mockResolvedValue([{ nccKeywordId: "K-1" }])

    mockGetStatsChunked.mockResolvedValue([
      makeRow("K-1", 2.5, [
        { hour: 11, impCnt: 5, clkCnt: 1, salesAmt: 100 },
        { hour: 14, impCnt: 9, clkCnt: 2, salesAmt: 200 },
      ]),
    ])

    const r = await ingestAdvertiserStatHourly(baseArgs)
    // hour=13 매칭 항목 없음 — upsert 0
    expect(r.rowsInserted).toBe(0)
    // 단 row level recentAvgRnk 갱신은 진행
    expect(r.keywordsRanked).toBe(1)
  })

  it("row.id 빈 (광고주 합산 row 등) → skip", async () => {
    mockCampaignFindMany.mockResolvedValue([])
    mockAdGroupFindMany.mockResolvedValue([])
    mockKeywordFindMany.mockResolvedValue([{ nccKeywordId: "K-1" }])

    mockGetStatsChunked.mockResolvedValue([
      makeRow("", null, [{ hour: 13, impCnt: 100, clkCnt: 10, salesAmt: 1000 }]),
      makeRow("K-1", 2.0, [{ hour: 13, impCnt: 5, clkCnt: 1, salesAmt: 100 }]),
    ])

    const r = await ingestAdvertiserStatHourly(baseArgs)
    expect(r.rowsInserted).toBe(1)
    // 빈 id row 는 breakdowns loop 진입 전에 skip — rowsSkipped 미증가
    expect(r.rowsSkipped).toBe(0)
  })

  it("breakdowns 누락 / 비배열 → 그 row 시간 적재 skip (Keyword 갱신은 row level 정책 그대로)", async () => {
    mockCampaignFindMany.mockResolvedValue([])
    mockAdGroupFindMany.mockResolvedValue([])
    mockKeywordFindMany.mockResolvedValue([{ nccKeywordId: "K-1" }])

    mockGetStatsChunked.mockResolvedValue([
      // breakdowns 키 자체 없음
      { id: "K-1", impCnt: 5, clkCnt: 1, salesAmt: 100, recentAvgRnk: 3.0 } as StatsRow,
    ])

    const r = await ingestAdvertiserStatHourly(baseArgs)
    expect(r.rowsInserted).toBe(0)
    expect(r.keywordsRanked).toBe(1)
  })

  it("Stats API 호출 실패 → throw 전파 (호출부가 광고주 격리)", async () => {
    mockCampaignFindMany.mockResolvedValue([])
    mockAdGroupFindMany.mockResolvedValue([])
    mockKeywordFindMany.mockResolvedValue([{ nccKeywordId: "K-1" }])

    mockGetStatsChunked.mockRejectedValue(new Error("SA boom"))

    await expect(ingestAdvertiserStatHourly(baseArgs)).rejects.toThrow("SA boom")
  })

  it("upsert chunk 100 — 250 keyword row 시간 매칭 → transaction 3번 (100+100+50)", async () => {
    mockCampaignFindMany.mockResolvedValue([])
    mockAdGroupFindMany.mockResolvedValue([])
    const keywords = Array.from({ length: 250 }, (_, i) => ({
      nccKeywordId: `K-${i}`,
    }))
    mockKeywordFindMany.mockResolvedValue(keywords)

    const rows: StatsRow[] = Array.from({ length: 250 }, (_, i) =>
      makeRow(`K-${i}`, 1.5, [
        { hour: 13, impCnt: 1, clkCnt: 0, salesAmt: 0 },
      ]),
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
