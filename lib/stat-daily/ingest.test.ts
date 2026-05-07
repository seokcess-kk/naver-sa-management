/**
 * lib/stat-daily/ingest.ts 단위 테스트 (F-9.1)
 *
 * 검증 범위 (헬퍼 변환 로직 회귀 가드):
 *   A. previousDayKstAsUtc — KST 어제 0시 정확성
 *   B. pickLevel           — keyword > adgroup > campaign > null 우선순위
 *   C. toUpsertInput       — advertiserId 채움 / unique key / level 결정 / null skip
 *   D. ingestAdvertiserStatDaily — reports.* + prisma mock 으로 흐름 가드
 *
 * 외부 호출 0 보장:
 *   - vi.mock("@/lib/naver-sa/reports", ...) — 실 SA 호출 0
 *   - vi.mock("@/lib/db/prisma", ...)        — 실 DB 호출 0
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

// =============================================================================
// Mocks (전역 — import 전에 hoist 됨)
// =============================================================================

const mockCreateStatReport = vi.fn()
const mockWaitStatReportReady = vi.fn()
const mockDownloadStatReport = vi.fn()
const mockParseAdDetailTsv = vi.fn()
const mockDeleteStatReport = vi.fn()
const mockGetStatsChunked = vi.fn()

vi.mock("@/lib/naver-sa/reports", () => ({
  createStatReport: (...args: unknown[]) => mockCreateStatReport(...args),
  waitStatReportReady: (...args: unknown[]) => mockWaitStatReportReady(...args),
  downloadStatReport: (...args: unknown[]) => mockDownloadStatReport(...args),
  parseAdDetailTsv: (...args: unknown[]) => mockParseAdDetailTsv(...args),
  deleteStatReport: (...args: unknown[]) => mockDeleteStatReport(...args),
}))

vi.mock("@/lib/naver-sa/stats", () => ({
  getStatsChunked: (...args: unknown[]) => mockGetStatsChunked(...args),
}))

const mockUpsert = vi.fn()
const mockTransaction = vi.fn()
const mockCampaignFindMany = vi.fn()
const mockAdGroupFindMany = vi.fn()
const mockKeywordFindMany = vi.fn()

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
    },
    statDaily: {
      upsert: (...args: unknown[]) => mockUpsert(...args),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}))

// import 본체 — mock 등록 이후
import {
  ingestAdvertiserStatDaily,
  pickLevel,
  previousDayKstAsUtc,
  toUpsertInput,
} from "@/lib/stat-daily/ingest"
import type { AdDetailRow } from "@/lib/naver-sa/reports"

// =============================================================================
// 공통 helper
// =============================================================================

function row(partial: Partial<AdDetailRow>): AdDetailRow {
  return {
    date: "2026-04-28",
    customerId: "cust-1",
    device: "PC",
    impressions: 100,
    clicks: 10,
    cost: 1234.56,
    avgRnk: 1.5,
    ...partial,
  } as AdDetailRow
}

// =============================================================================
// A. previousDayKstAsUtc
// =============================================================================

describe("previousDayKstAsUtc", () => {
  it("now=2026-04-29 03:00 KST (=2026-04-28 18:00 UTC) → 어제 KST 0시 = 2026-04-27 15:00 UTC", () => {
    const now = new Date("2026-04-28T18:00:00.000Z") // 2026-04-29 03:00 KST
    const got = previousDayKstAsUtc(now)
    expect(got.toISOString()).toBe("2026-04-27T15:00:00.000Z")
  })

  it("now=2026-04-29 00:00 KST (=2026-04-28 15:00 UTC) → 어제 KST 0시 = 2026-04-27 15:00 UTC", () => {
    // 자정 직후 — 여전히 KST 어제(28일) 가 아니라 KST 오늘(29일)의 -1 = 28일
    // 즉 전일은 28일이 아니라... 잠깐: KST 자정 = 새 날 시작 → 어제는 28일.
    // 따라서 expect 도 28일이 아니라 28일 KST 0시 = 27일 15시 UTC.
    const now = new Date("2026-04-28T15:00:00.000Z")
    const got = previousDayKstAsUtc(now)
    expect(got.toISOString()).toBe("2026-04-27T15:00:00.000Z")
  })

  it("KST 자정 직전 (now=2026-04-29 23:59 KST = 2026-04-29 14:59 UTC) → 어제는 28일 KST = 2026-04-27 15:00 UTC", () => {
    const now = new Date("2026-04-29T14:59:00.000Z")
    const got = previousDayKstAsUtc(now)
    expect(got.toISOString()).toBe("2026-04-27T15:00:00.000Z")
  })

  it("월 경계 (now=2026-05-01 03:00 KST = 2026-04-30 18:00 UTC) → 어제 KST = 2026-04-30 0시 KST = 2026-04-29 15:00 UTC", () => {
    const now = new Date("2026-04-30T18:00:00.000Z")
    const got = previousDayKstAsUtc(now)
    expect(got.toISOString()).toBe("2026-04-29T15:00:00.000Z")
  })

  it("연 경계 (now=2026-01-01 03:00 KST = 2025-12-31 18:00 UTC) → 어제 KST 2025-12-31 = 2025-12-30 15:00 UTC", () => {
    const now = new Date("2025-12-31T18:00:00.000Z")
    const got = previousDayKstAsUtc(now)
    expect(got.toISOString()).toBe("2025-12-30T15:00:00.000Z")
  })

  it("default 인자 (now 미지정) — Date 객체 반환만 확인", () => {
    const got = previousDayKstAsUtc()
    expect(got).toBeInstanceOf(Date)
    expect(Number.isNaN(got.getTime())).toBe(false)
  })
})

// =============================================================================
// B. pickLevel
// =============================================================================

describe("pickLevel", () => {
  it("keywordId 우선 — keyword level / refId=keywordId", () => {
    const r = row({
      campaignId: "C-1",
      adgroupId: "A-1",
      keywordId: "K-1",
    })
    expect(pickLevel(r)).toEqual({ level: "keyword", refId: "K-1" })
  })

  it("adgroupId (keyword 없으면) — adgroup level / refId=adgroupId", () => {
    const r = row({ campaignId: "C-1", adgroupId: "A-1" })
    expect(pickLevel(r)).toEqual({ level: "adgroup", refId: "A-1" })
  })

  it("campaignId (keyword/adgroup 없으면) — campaign level / refId=campaignId", () => {
    const r = row({ campaignId: "C-1" })
    expect(pickLevel(r)).toEqual({ level: "campaign", refId: "C-1" })
  })

  it("ID 모두 빈 문자열 — null (advertiser 합산 row → skip)", () => {
    const r = row({ campaignId: "", adgroupId: "", keywordId: "" })
    expect(pickLevel(r)).toBeNull()
  })

  it("ID 모두 undefined — null", () => {
    const r = row({})
    expect(pickLevel(r)).toBeNull()
  })
})

// =============================================================================
// C. toUpsertInput
// =============================================================================

describe("toUpsertInput", () => {
  it("keyword level — advertiserId 채움 / unique key / device=PC / 모든 메트릭", () => {
    const r = row({
      date: "2026-04-28",
      keywordId: "K-1",
      adgroupId: "A-1",
      campaignId: "C-1",
      device: "MOBILE",
      impressions: 5,
      clicks: 1,
      cost: 99.99,
      avgRnk: 3.2,
    })
    const inp = toUpsertInput("adv-1", r)
    expect(inp).not.toBeNull()
    if (inp === null) return
    expect(inp.where).toEqual({
      date_level_refId_device: {
        date: new Date("2026-04-28T00:00:00.000Z"),
        level: "keyword",
        refId: "K-1",
        device: "MOBILE",
      },
    })
    expect(inp.create).toMatchObject({
      advertiserId: "adv-1",
      level: "keyword",
      refId: "K-1",
      device: "MOBILE",
      impressions: 5,
      clicks: 1,
      cost: 99.99,
      avgRnk: 3.2,
    })
    expect(inp.update).toMatchObject({
      impressions: 5,
      clicks: 1,
      cost: 99.99,
      avgRnk: 3.2,
    })
    // update 에 advertiserId 미포함 (refId owner 불변 가정)
    expect(inp.update).not.toHaveProperty("advertiserId")
  })

  it("avgRnk null/undefined — null 로 정규화", () => {
    const r = row({ keywordId: "K-1", avgRnk: null })
    const inp = toUpsertInput("adv-1", r)
    expect(inp).not.toBeNull()
    if (inp === null) return
    expect((inp.create as { avgRnk: unknown }).avgRnk).toBeNull()
    expect((inp.update as { avgRnk: unknown }).avgRnk).toBeNull()
  })

  it("ID 전부 비면 null (skip 신호)", () => {
    const r = row({})
    expect(toUpsertInput("adv-1", r)).toBeNull()
  })

  it("date 파싱 불가 → null", () => {
    const r = row({ keywordId: "K-1", date: "not-a-date" })
    expect(toUpsertInput("adv-1", r)).toBeNull()
  })

  it("level 우선순위 — adgroup 만 있으면 adgroup level", () => {
    const r = row({ adgroupId: "A-1" })
    const inp = toUpsertInput("adv-1", r)
    expect(inp).not.toBeNull()
    if (inp === null) return
    expect(inp.create).toMatchObject({ level: "adgroup", refId: "A-1" })
  })
})

// =============================================================================
// D. ingestAdvertiserStatDaily — reports.* + prisma mock
// =============================================================================

describe("ingestAdvertiserStatDaily", () => {
  beforeEach(() => {
    mockCreateStatReport.mockReset()
    mockWaitStatReportReady.mockReset()
    mockDownloadStatReport.mockReset()
    mockParseAdDetailTsv.mockReset()
    mockDeleteStatReport.mockReset()
    mockGetStatsChunked.mockReset()
    mockUpsert.mockReset()
    mockTransaction.mockReset()
    mockCampaignFindMany.mockReset()
    mockAdGroupFindMany.mockReset()
    mockKeywordFindMany.mockReset()

    // prisma.$transaction(promises[]) → Promise.all 흉내
    mockTransaction.mockImplementation(async (ops: unknown) => {
      if (Array.isArray(ops)) {
        // ops 는 prisma.statDaily.upsert 결과(promise) 배열
        return Promise.all(ops as Promise<unknown>[])
      }
      return ops
    })
    mockUpsert.mockImplementation(async () => ({}))
    mockCampaignFindMany.mockResolvedValue([])
    mockAdGroupFindMany.mockResolvedValue([])
    mockKeywordFindMany.mockResolvedValue([])
    mockGetStatsChunked.mockResolvedValue([])
  })

  it("happy — 보고서 생성→폴링→다운로드→파싱→upsert→정리 시퀀스 호출", async () => {
    mockCreateStatReport.mockResolvedValue({
      reportJobId: "job-1",
      status: "REGIST",
    })
    mockWaitStatReportReady.mockResolvedValue({
      reportJobId: "job-1",
      status: "BUILT",
      downloadUrl: "https://s3.example/report.tsv",
    })
    mockDownloadStatReport.mockResolvedValue("tsv-body")
    mockParseAdDetailTsv.mockResolvedValue([
      row({ keywordId: "K-1" }),
      row({ adgroupId: "A-1" }),
      row({ campaignId: "C-1", adgroupId: undefined, keywordId: undefined }),
      // skip — 모든 ID 빈
      row({}),
    ])

    const r = await ingestAdvertiserStatDaily({
      advertiserId: "adv-1",
      customerId: "cust-1",
      statDt: new Date("2026-04-27T15:00:00.000Z"),
    })

    expect(r.rowsInserted).toBe(3)
    expect(r.rowsSkipped).toBe(1)

    expect(mockCreateStatReport).toHaveBeenCalledWith("cust-1", {
      reportTp: "AD_DETAIL",
      statDt: new Date("2026-04-27T15:00:00.000Z"),
    })
    expect(mockWaitStatReportReady).toHaveBeenCalledWith("cust-1", "job-1")
    expect(mockDownloadStatReport).toHaveBeenCalledWith(
      "cust-1",
      "https://s3.example/report.tsv",
    )
    expect(mockParseAdDetailTsv).toHaveBeenCalledWith("tsv-body")
    expect(mockUpsert).toHaveBeenCalledTimes(3)
    expect(mockDeleteStatReport).toHaveBeenCalledWith("cust-1", "job-1")
  })

  it("createStatReport 실패 → throw 전파 + deleteStatReport 호출 X (jobId 없음)", async () => {
    mockCreateStatReport.mockRejectedValue(new Error("SA failed"))

    await expect(
      ingestAdvertiserStatDaily({
        advertiserId: "adv-1",
        customerId: "cust-1",
        statDt: new Date("2026-04-27T15:00:00.000Z"),
      }),
    ).rejects.toThrow("SA failed")

    expect(mockDeleteStatReport).not.toHaveBeenCalled()
  })

  it("waitStatReportReady 실패 → throw 전파 + deleteStatReport 호출 (jobId 보유)", async () => {
    mockCreateStatReport.mockResolvedValue({ reportJobId: "job-1", status: "REGIST" })
    mockWaitStatReportReady.mockRejectedValue(new Error("timeout"))

    await expect(
      ingestAdvertiserStatDaily({
        advertiserId: "adv-1",
        customerId: "cust-1",
        statDt: new Date("2026-04-27T15:00:00.000Z"),
      }),
    ).rejects.toThrow("timeout")

    expect(mockDeleteStatReport).toHaveBeenCalledWith("cust-1", "job-1")
  })

  it("deleteStatReport 자체 throw 도 전체 흐름 swallow (best-effort)", async () => {
    mockCreateStatReport.mockResolvedValue({ reportJobId: "job-1", status: "REGIST" })
    mockWaitStatReportReady.mockResolvedValue({
      reportJobId: "job-1",
      status: "BUILT",
      downloadUrl: "https://s3.example/report.tsv",
    })
    mockDownloadStatReport.mockResolvedValue("tsv")
    mockParseAdDetailTsv.mockResolvedValue([])
    mockDeleteStatReport.mockRejectedValue(new Error("cleanup boom"))

    // 주 흐름은 성공 — deleteStatReport throw 가 결과를 오염하지 않음
    await expect(
      ingestAdvertiserStatDaily({
        advertiserId: "adv-1",
        customerId: "cust-1",
        statDt: new Date("2026-04-27T15:00:00.000Z"),
      }),
    ).resolves.toEqual({ rowsInserted: 0, rowsSkipped: 0 })
  })

  it("upsert chunk 100 — 250행이면 transaction 3번 (100+100+50)", async () => {
    mockCreateStatReport.mockResolvedValue({ reportJobId: "job-1", status: "REGIST" })
    mockWaitStatReportReady.mockResolvedValue({
      reportJobId: "job-1",
      status: "BUILT",
      downloadUrl: "https://s3.example/report.tsv",
    })
    mockDownloadStatReport.mockResolvedValue("tsv")
    const rows: AdDetailRow[] = Array.from({ length: 250 }, (_, i) =>
      row({ keywordId: `K-${i}` }),
    )
    mockParseAdDetailTsv.mockResolvedValue(rows)

    const r = await ingestAdvertiserStatDaily({
      advertiserId: "adv-1",
      customerId: "cust-1",
      statDt: new Date("2026-04-27T15:00:00.000Z"),
    })

    expect(r.rowsInserted).toBe(250)
    expect(r.rowsSkipped).toBe(0)
    expect(mockTransaction).toHaveBeenCalledTimes(3)
  })

  // ===========================================================================
  // a) (date, level, refId, device) 단위 합산 collapse 회귀 가드
  // ===========================================================================
  // 같은 unique key 의 raw row 가 시간/권역으로 분해돼 다중 출현하는 케이스.
  // ingest 가 같은 key 에 대해 prisma.statDaily.upsert 를 1회만 호출해야 한다 (P2002 방지).
  // 가중평균 산식 (sum(avgRnk*imp) / sum(imp)) 도 정확해야 한다.
  it("같은 (date,level,refId,device) 3행 → upsert 1회 + avgRnk 가중평균", async () => {
    mockCreateStatReport.mockResolvedValue({ reportJobId: "job-1", status: "REGIST" })
    mockWaitStatReportReady.mockResolvedValue({
      reportJobId: "job-1",
      status: "BUILT",
      downloadUrl: "https://s3.example/report.tsv",
    })
    mockDownloadStatReport.mockResolvedValue("tsv")
    // 같은 keyword K-1 / device PC 를 시간/권역 분해된 3행으로 적재.
    //   imp=10 / avgRnk=2  → weight 10
    //   imp=20 / avgRnk=5  → weight 20
    //   imp=30 / avgRnk=4  → weight 30
    //   기대 가중평균 = (2*10 + 5*20 + 4*30) / (10+20+30) = 240 / 60 = 4.0
    mockParseAdDetailTsv.mockResolvedValue([
      row({ keywordId: "K-1", impressions: 10, clicks: 1, cost: 100, avgRnk: 2 }),
      row({ keywordId: "K-1", impressions: 20, clicks: 2, cost: 200, avgRnk: 5 }),
      row({ keywordId: "K-1", impressions: 30, clicks: 3, cost: 300, avgRnk: 4 }),
    ])

    const r = await ingestAdvertiserStatDaily({
      advertiserId: "adv-1",
      customerId: "cust-1",
      statDt: new Date("2026-04-27T15:00:00.000Z"),
    })

    expect(r.rowsInserted).toBe(1)
    expect(r.rowsSkipped).toBe(0)
    // upsert 가 1회만 호출 — collapse 후 unique key 중복 제거됨.
    expect(mockUpsert).toHaveBeenCalledTimes(1)
    const arg = mockUpsert.mock.calls[0][0] as {
      where: { date_level_refId_device: { device: string; refId: string } }
      create: { impressions: number; clicks: number; cost: number; avgRnk: number | null }
    }
    expect(arg.where.date_level_refId_device.device).toBe("PC")
    expect(arg.where.date_level_refId_device.refId).toBe("K-1")
    expect(arg.create.impressions).toBe(60)
    expect(arg.create.clicks).toBe(6)
    expect(arg.create.cost).toBe(600)
    expect(arg.create.avgRnk).toBeCloseTo(4.0, 5)
  })

  // ===========================================================================
  // b) imp=0 또는 avgRnk=null 행은 가중평균 weight 에서 제외
  // ===========================================================================
  // 입력 모두 imp=0 또는 avgRnk=null 이면 가중평균 분모=0 → avgRnk 결과 null.
  it("모든 행 imp=0 또는 avgRnk=null → avgRnk=null (전체 imp=0)", async () => {
    mockCreateStatReport.mockResolvedValue({ reportJobId: "job-1", status: "REGIST" })
    mockWaitStatReportReady.mockResolvedValue({
      reportJobId: "job-1",
      status: "BUILT",
      downloadUrl: "https://s3.example/report.tsv",
    })
    mockDownloadStatReport.mockResolvedValue("tsv")
    mockParseAdDetailTsv.mockResolvedValue([
      // imp=0 행 — weight 에서 제외 (avgRnk=2 이지만 imp=0 이라 미반영).
      row({ keywordId: "K-1", impressions: 0, clicks: 0, cost: 0, avgRnk: 2 }),
      // avgRnk=null 행 — 합산엔 imp 카운트, 가중평균 weight 엔 미반영.
      row({ keywordId: "K-1", impressions: 0, clicks: 0, cost: 0, avgRnk: null }),
    ])

    await ingestAdvertiserStatDaily({
      advertiserId: "adv-1",
      customerId: "cust-1",
      statDt: new Date("2026-04-27T15:00:00.000Z"),
    })

    expect(mockUpsert).toHaveBeenCalledTimes(1)
    const arg = mockUpsert.mock.calls[0][0] as {
      create: { impressions: number; avgRnk: number | null }
    }
    expect(arg.create.impressions).toBe(0)
    // 모든 weight=0 → avgRnk null
    expect(arg.create.avgRnk).toBeNull()
  })

  // ===========================================================================
  // c) Stats API 보강 적재 — device='ALL' 로 upsert 호출
  // ===========================================================================
  // ingest 의 두 경로 (AD_DETAIL collapse + Stats API 보강) 가 같은 (date, level, refId)
  // 에 대해 device 가 다른 행을 적재한다는 사실을 회귀 가드.
  // schema 주석 + lib/stat-daily/device-filter.ts 정책 일관성 검증.
  it("Stats API 보강 — keyword/adgroup/campaign 모두 device='ALL' 로 upsert", async () => {
    mockCreateStatReport.mockResolvedValue({ reportJobId: "job-1", status: "REGIST" })
    mockWaitStatReportReady.mockResolvedValue({
      reportJobId: "job-1",
      status: "BUILT",
      downloadUrl: "https://s3.example/report.tsv",
    })
    mockDownloadStatReport.mockResolvedValue("tsv")
    mockParseAdDetailTsv.mockResolvedValue([]) // AD_DETAIL 단계는 빈 행 — 보강만 검증
    // 활성 캠페인/광고그룹/키워드 각 1개 — 보강 적재 진입.
    mockCampaignFindMany.mockResolvedValue([{ nccCampaignId: "ncc_cmp_1" }])
    mockAdGroupFindMany.mockResolvedValue([{ nccAdgroupId: "ncc_ag_1" }])
    mockKeywordFindMany.mockResolvedValue([{ nccKeywordId: "ncc_kw_1" }])
    // getStatsChunked 가 level 별 1행씩 반환 (id = ncc*).
    mockGetStatsChunked.mockImplementation(
      async (_customerId: string, args: { ids: string[] }) => {
        return args.ids.map((id) => ({
          id,
          impCnt: 100,
          clkCnt: 5,
          salesAmt: 1000,
          recentAvgRnk: 1.5,
        }))
      },
    )

    const r = await ingestAdvertiserStatDaily({
      advertiserId: "adv-1",
      customerId: "cust-1",
      statDt: new Date("2026-04-27T15:00:00.000Z"),
    })

    // 3 level × 1 row = 3 upsert.
    expect(r.rowsInserted).toBe(3)
    expect(mockUpsert).toHaveBeenCalledTimes(3)
    // 모든 upsert 가 device='ALL' 로 호출됐는지 검증 — 정책 회귀 가드.
    for (const call of mockUpsert.mock.calls) {
      const arg = call[0] as {
        where: { date_level_refId_device: { device: string; level: string; refId: string } }
        create: { device: string; advertiserId: string }
      }
      expect(arg.where.date_level_refId_device.device).toBe("ALL")
      expect(arg.create.device).toBe("ALL")
      expect(arg.create.advertiserId).toBe("adv-1")
    }
    // level 분포 검증 — campaign/adgroup/keyword 1건씩.
    const levels = mockUpsert.mock.calls.map(
      (c) =>
        (c[0] as { where: { date_level_refId_device: { level: string } } }).where
          .date_level_refId_device.level,
    )
    expect(levels.sort()).toEqual(["adgroup", "campaign", "keyword"])
  })
})
