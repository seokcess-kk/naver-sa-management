/**
 * lib/naver-sa/reports.ts 헬퍼 단위 테스트.
 *
 * 회귀 가드:
 *   - toStatDtString: KST 자정 epoch → KST 일자 ISO 자정 변환.
 *     (회귀 1건: d.getUTCDate() 직접 사용 시 KST 어제가 UTC 그제로 깎이는 버그 — 2026-05-07 운영 inbox 0건 사고)
 */

import { describe, expect, it } from "vitest"

import { __test__, parseAdDetailTsv } from "@/lib/naver-sa/reports"

const { toStatDtString } = __test__

describe("toStatDtString", () => {
  it("KST 어제 자정 epoch (UTC -9h 표현) → KST 어제 일자 ISO", () => {
    // d = 2026-05-05T15:00:00.000Z = KST 2026-05-06 00:00
    const d = new Date("2026-05-05T15:00:00.000Z")
    expect(toStatDtString(d)).toBe("2026-05-06T00:00:00.000Z")
  })

  it("월 경계 — KST 5/1 0시 (= UTC 4/30 15:00) → 5/1", () => {
    const d = new Date("2026-04-30T15:00:00.000Z")
    expect(toStatDtString(d)).toBe("2026-05-01T00:00:00.000Z")
  })

  it("연 경계 — KST 1/1 0시 (= UTC 전년 12/31 15:00) → 1/1", () => {
    const d = new Date("2025-12-31T15:00:00.000Z")
    expect(toStatDtString(d)).toBe("2026-01-01T00:00:00.000Z")
  })

  it("KST 자정이 아니어도 KST 일자만 추출 — 동일 KST 일자의 다른 시각 동일 결과", () => {
    // d = 2026-05-06T03:00:00.000Z = KST 2026-05-06 12:00
    const d = new Date("2026-05-06T03:00:00.000Z")
    expect(toStatDtString(d)).toBe("2026-05-06T00:00:00.000Z")
  })
})

describe("parseAdDetailTsv — headerless fixed-position spec", () => {
  /**
   * 실측 sample (2026-05-06, customer 3494801) 기반 회귀 가드.
   * 16 컬럼: date / cust / camp / adg / kw / ad / bsn / media / period / mediaCode / device / imp / click / cost / avgRnk / conv
   * 1광고주 0건 사고 — 헤더 동적 매핑이 데이터 행 인식 못해 rows=0 → fixed-position 분기로 해결.
   */
  it("첫 셀이 8자리 숫자면 fixed-position 매핑 + YYYYMMDD → YYYY-MM-DD", async () => {
    const tsv = [
      "20260506\t3494801\tcmp-1\tgrp-1\tnkw-1\tnad-1\tbsn-1\t09\t01\t27758\tP\t100\t5\t1500\t2.5\t0",
      "20260506\t3494801\tcmp-1\tgrp-1\t-\tnad-1\tbsn-1\t09\t14\t27758\tM\t50\t1\t300\t3.0\t0",
    ].join("\n")
    const rows = await parseAdDetailTsv(tsv)
    expect(rows.length).toBe(2)
    expect(rows[0]).toMatchObject({
      date: "2026-05-06",
      customerId: "3494801",
      campaignId: "cmp-1",
      adgroupId: "grp-1",
      keywordId: "nkw-1",
      adId: "nad-1",
      device: "PC",
      impressions: 100,
      clicks: 5,
      cost: 1500,
      avgRnk: 2.5,
    })
    // keywordId="-" 인 행은 undefined 또는 미정 — pickLevel 에서 adgroup 으로 fallback.
    expect(rows[1].keywordId).toBeUndefined()
    expect(rows[1].device).toBe("MOBILE")
    expect(rows[1].avgRnk).toBe(3)
  })

  it("헤더 있는 TSV (회귀 안전망) — 첫 셀이 비-8자리 숫자면 헤더 매핑 분기", async () => {
    const tsv = [
      "Date\tCustomer ID\tCampaign ID\tAdgroup ID\tKeyword ID\tAd ID\tDevice\tImpressions\tClicks\tCost\tAverage Position",
      "2026-05-06\t3494801\tcmp-1\tgrp-1\tnkw-1\tnad-1\tPC\t100\t5\t1500\t2.5",
    ].join("\n")
    const rows = await parseAdDetailTsv(tsv)
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({
      date: "2026-05-06",
      device: "PC",
      impressions: 100,
      clicks: 5,
      cost: 1500,
      avgRnk: 2.5,
    })
  })
})
