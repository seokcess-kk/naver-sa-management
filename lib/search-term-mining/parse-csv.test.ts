/**
 * lib/search-term-mining/parse-csv.ts 단위 테스트 (Phase D.3).
 *
 * 검증 매트릭스:
 *   A. 영문 헤더 (콘솔 응답 영문 키) 매핑
 *   B. 한글 헤더 (콘솔 다운로드 CSV) 매핑
 *   C. 빈 expKeyword (= "기타" 합산 행) skip
 *   D. 동일 검색어 N행 → impressions/clicks/cost/conversions 합산
 *   E. conversions 모든 행 null → 결과 null 유지
 *   F. conversions 일부만 숫자 → 숫자 행만 합산
 *   G. 천 단위 콤마 / 통화기호 / 빈 셀 / "-" 파싱
 *   H. searchTerm 필수 누락 → fileError
 *   I. 빈 파일 → fileError
 *   J. BOM 자동 제거
 *   K. unmappedHeaders 진단 노출
 *   L. 헤더 케이싱·공백·괄호 둔감 매핑
 */

import { describe, expect, it } from "vitest"

import { parseSearchTermCsv } from "./parse-csv"

// =============================================================================
// A. 영문 헤더 매핑
// =============================================================================

describe("A. 영문 헤더 (expKeyword / impCnt / clkCnt / salesAmt / ccnt)", () => {
  it("최소 컬럼만 매핑되어 검색어 단위 행 생성", () => {
    const csv = [
      "expKeyword,impCnt,clkCnt,salesAmt,ccnt",
      "여성신발,1000,50,25000,2",
      "남성신발,500,10,8000,0",
    ].join("\n")

    const r = parseSearchTermCsv(csv)
    expect(r.fileError).toBeUndefined()
    expect(r.rows).toHaveLength(2)
    expect(r.mappedKeys).toEqual(
      expect.arrayContaining([
        "searchTerm",
        "impressions",
        "clicks",
        "cost",
        "conversions",
      ]),
    )
    const a = r.rows.find((x) => x.searchTerm === "여성신발")!
    expect(a.impressions).toBe(1000)
    expect(a.clicks).toBe(50)
    expect(a.cost).toBe(25000)
    expect(a.conversions).toBe(2)
  })
})

// =============================================================================
// B. 한글 헤더 매핑
// =============================================================================

describe("B. 한글 헤더 (검색어 / 노출수 / 클릭수 / 총비용 / 전환수)", () => {
  it("한글 다운로드 CSV — 매치타입/날짜/CTR 컬럼 함께 있어도 무시·인식", () => {
    const csv = [
      "검색어,매치타입,날짜,노출수,클릭수,클릭률(%),평균CPC,총비용,전환수",
      "운동화,확장검색,2026-04-30,2000,80,4.0,500,40000,3",
      "운동화,일치검색,2026-04-30,1000,40,4.0,600,24000,1",
    ].join("\n")

    const r = parseSearchTermCsv(csv)
    expect(r.fileError).toBeUndefined()
    expect(r.rows).toHaveLength(1) // aggregateBySearchTerm 기본 true
    const a = r.rows[0]
    expect(a.searchTerm).toBe("운동화")
    expect(a.impressions).toBe(3000)
    expect(a.clicks).toBe(120)
    expect(a.cost).toBe(64000)
    expect(a.conversions).toBe(4)
    expect(r.mappedKeys).toEqual(
      expect.arrayContaining([
        "searchTerm",
        "matchType",
        "date",
        "impressions",
        "clicks",
        "cost",
        "conversions",
      ]),
    )
  })
})

// =============================================================================
// C. 빈 검색어 skip
// =============================================================================

describe("C. expKeyword 빈 문자열 ('기타' 합산 행) skip", () => {
  it("빈 검색어 행은 skipped 카운트", () => {
    const csv = [
      "expKeyword,impCnt,clkCnt,salesAmt,ccnt",
      "유효키워드,100,5,5000,0",
      ",2000,10,10000,0", // 빈 expKeyword (콘솔 '기타' 합산)
      "  ,500,2,2000,0", // 공백만
    ].join("\n")

    const r = parseSearchTermCsv(csv)
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].searchTerm).toBe("유효키워드")
    expect(r.skipped).toBe(2)
  })
})

// =============================================================================
// D. 동일 검색어 N행 합산
// =============================================================================

describe("D. 동일 검색어 N행 (날짜·매치타입 분할) 합산", () => {
  it("3일치 데이터 합산", () => {
    const csv = [
      "expKeyword,ymd,impCnt,clkCnt,salesAmt,ccnt",
      "키워드A,2026-04-28,100,5,2500,0",
      "키워드A,2026-04-29,200,10,5000,1",
      "키워드A,2026-04-30,300,15,7500,2",
      "키워드B,2026-04-28,50,2,1000,0",
    ].join("\n")

    const r = parseSearchTermCsv(csv)
    expect(r.rows).toHaveLength(2)
    const a = r.rows.find((x) => x.searchTerm === "키워드A")!
    expect(a.impressions).toBe(600)
    expect(a.clicks).toBe(30)
    expect(a.cost).toBe(15000)
    expect(a.conversions).toBe(3)
  })
})

// =============================================================================
// E. conversions 모두 null → null 유지
// =============================================================================

describe("E. conversions 모든 행이 누락(null) → 결과 null 유지", () => {
  it("conversions 컬럼 자체가 없으면 모든 행 null", () => {
    const csv = [
      "expKeyword,impCnt,clkCnt,salesAmt",
      "키워드,100,5,5000",
      "키워드,200,10,10000",
    ].join("\n")
    const r = parseSearchTermCsv(csv)
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].conversions).toBeNull()
  })

  it("conversions 컬럼은 있으나 모든 셀이 빈 문자열 → null", () => {
    const csv = [
      "expKeyword,impCnt,clkCnt,salesAmt,ccnt",
      "키워드,100,5,5000,",
      "키워드,200,10,10000,",
    ].join("\n")
    const r = parseSearchTermCsv(csv)
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].conversions).toBeNull()
  })
})

// =============================================================================
// F. conversions 일부만 숫자
// =============================================================================

describe("F. conversions 일부 숫자 + 일부 null → 숫자만 합산", () => {
  it("3행 중 2행만 숫자 → 합산값 = 그 2행 합", () => {
    const csv = [
      "expKeyword,impCnt,clkCnt,salesAmt,ccnt",
      "키워드,100,5,5000,2",
      "키워드,100,5,5000,",
      "키워드,100,5,5000,3",
    ].join("\n")
    const r = parseSearchTermCsv(csv)
    expect(r.rows[0].conversions).toBe(5)
  })
})

// =============================================================================
// G. 셀 파싱
// =============================================================================

describe("G. 셀 파싱 (콤마 / 통화기호 / 빈 셀 / '-')", () => {
  it("천 단위 콤마 + ₩ 기호 + 공백 제거", () => {
    const csv = [
      "expKeyword,impCnt,clkCnt,salesAmt",
      "키워드,\"1,234\",50,\"₩ 12,345\"",
    ].join("\n")
    const r = parseSearchTermCsv(csv)
    expect(r.rows[0].impressions).toBe(1234)
    expect(r.rows[0].cost).toBe(12345)
  })

  it("'-' / 'N/A' / 빈 셀 → 0 (impressions/clicks/cost) / null (conversions)", () => {
    const csv = [
      "expKeyword,impCnt,clkCnt,salesAmt,ccnt",
      "키워드,-,N/A,,-",
    ].join("\n")
    const r = parseSearchTermCsv(csv)
    expect(r.rows[0].impressions).toBe(0)
    expect(r.rows[0].clicks).toBe(0)
    expect(r.rows[0].cost).toBe(0)
    expect(r.rows[0].conversions).toBeNull()
  })
})

// =============================================================================
// H. 검색어 컬럼 누락
// =============================================================================

describe("H. 필수 컬럼(searchTerm) 누락 → fileError", () => {
  it("expKeyword/검색어 둘 다 없으면 거부", () => {
    const csv = ["impCnt,clkCnt,salesAmt", "100,5,5000"].join("\n")
    const r = parseSearchTermCsv(csv)
    expect(r.fileError).toBeDefined()
    expect(r.fileError).toContain("검색어")
    expect(r.rows).toHaveLength(0)
  })
})

// =============================================================================
// I. 빈 파일
// =============================================================================

describe("I. 빈 파일 → fileError", () => {
  it("완전 빈 문자열", () => {
    const r = parseSearchTermCsv("")
    expect(r.fileError).toBe("빈 파일입니다")
  })
  it("공백만", () => {
    const r = parseSearchTermCsv("   \n  ")
    expect(r.fileError).toBe("빈 파일입니다")
  })
})

// =============================================================================
// J. BOM 제거
// =============================================================================

describe("J. UTF-8 BOM 자동 제거", () => {
  it("\\ufeff 가 첫 글자에 있어도 정상 파싱", () => {
    const csv =
      "\ufeff" + "expKeyword,impCnt,clkCnt,salesAmt,ccnt\n키워드,100,5,5000,0"
    const r = parseSearchTermCsv(csv)
    expect(r.fileError).toBeUndefined()
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].searchTerm).toBe("키워드")
  })
})

// =============================================================================
// K. unmappedHeaders 진단
// =============================================================================

describe("K. unmappedHeaders — UI 진단용", () => {
  it("매핑 안 된 헤더는 unmappedHeaders 에 그대로 보존", () => {
    const csv = [
      "expKeyword,impCnt,clkCnt,salesAmt,ccnt,임의컬럼,foo_bar",
      "키워드,100,5,5000,0,xx,yy",
    ].join("\n")
    const r = parseSearchTermCsv(csv)
    expect(r.unmappedHeaders).toEqual(
      expect.arrayContaining(["임의컬럼", "foo_bar"]),
    )
  })
})

// =============================================================================
// L. 헤더 케이싱/공백 둔감
// =============================================================================

describe("L. 헤더 케이싱·공백·괄호·% 둔감 매핑", () => {
  it("Imp Cnt / Clk Cnt / Sales Amt 같은 변형도 매핑", () => {
    const csv = [
      "expKeyword,Imp Cnt,Clk Cnt,Sales Amt,Ccnt",
      "키워드,100,5,5000,2",
    ].join("\n")
    const r = parseSearchTermCsv(csv)
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].impressions).toBe(100)
    expect(r.rows[0].clicks).toBe(5)
    expect(r.rows[0].cost).toBe(5000)
    expect(r.rows[0].conversions).toBe(2)
  })
  it("'클릭률(%)' 처럼 괄호 + % 가 있는 헤더는 정규화 후 매핑 시도 (date/match 매핑은 영향 없음)", () => {
    const csv = [
      "검색어,클릭률(%),노출수",
      "키워드,5.0,500",
    ].join("\n")
    const r = parseSearchTermCsv(csv)
    // 클릭률은 사전에 없으므로 unmapped — 노출수는 매핑되어야 함
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].impressions).toBe(500)
  })
})

// =============================================================================
// M. adgroupId 빈 문자열 (호환성)
// =============================================================================

describe("M. adgroupId — 본 모듈은 항상 빈 문자열 (UI 가 채움)", () => {
  it("classify.ts 입력 호환을 위해 필드 유지", () => {
    const csv = ["expKeyword,impCnt,clkCnt,salesAmt", "키워드,100,5,5000"].join(
      "\n",
    )
    const r = parseSearchTermCsv(csv)
    expect(r.rows[0].adgroupId).toBe("")
  })
})
