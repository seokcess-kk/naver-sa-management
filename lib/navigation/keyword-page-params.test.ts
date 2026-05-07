/**
 * parseKeywordPageParams 단위 테스트.
 *
 * 검증 범위:
 *   - 모든 파라미터가 비어 있을 때 기본값 반환
 *   - 화이트리스트 외 값 (sort / pageSize / status) → 안전한 기본값으로 폴백
 *   - 잘못된 page (NaN, 0, 음수, 문자열) → 1 폴백
 *   - q trim
 *   - 배열로 들어온 값은 첫 번째만 사용 (Next.js Router 의 string|string[]|undefined 호환)
 */

import { describe, expect, it } from "vitest"
import {
  parseKeywordPageParams,
  KEYWORD_PAGE_SIZES,
} from "./keyword-page-params"

describe("parseKeywordPageParams", () => {
  it("returns safe defaults when searchParams is empty", () => {
    expect(parseKeywordPageParams({})).toEqual({
      page: 1,
      pageSize: 100,
      q: "",
      status: "all",
      sort: "updatedAt:desc",
    })
  })

  it("returns safe defaults when searchParams is undefined", () => {
    expect(parseKeywordPageParams(undefined)).toEqual({
      page: 1,
      pageSize: 100,
      q: "",
      status: "all",
      sort: "updatedAt:desc",
    })
  })

  it("parses valid values straight through", () => {
    expect(
      parseKeywordPageParams({
        page: "3",
        pageSize: "200",
        q: "foo",
        keywordStatus: "on",
        sort: "bidAmt:desc",
      }),
    ).toEqual({
      page: 3,
      pageSize: 200,
      q: "foo",
      status: "on",
      sort: "bidAmt:desc",
    })
  })

  it("falls back to page=1 for invalid page values", () => {
    for (const bad of ["0", "-1", "abc", "", "NaN", " "]) {
      expect(parseKeywordPageParams({ page: bad }).page).toBe(1)
    }
  })

  it("accepts only whitelisted page sizes (50/100/200/500)", () => {
    for (const ok of KEYWORD_PAGE_SIZES) {
      expect(parseKeywordPageParams({ pageSize: String(ok) }).pageSize).toBe(ok)
    }
  })

  it("falls back to pageSize=100 for non-whitelist sizes", () => {
    for (const bad of ["1", "10", "150", "1000", "abc", "-50", "0"]) {
      expect(parseKeywordPageParams({ pageSize: bad }).pageSize).toBe(100)
    }
  })

  it("falls back to status='all' for unknown status", () => {
    expect(parseKeywordPageParams({ keywordStatus: "weird" }).status).toBe("all")
    expect(parseKeywordPageParams({ keywordStatus: "" }).status).toBe("all")
  })

  it("accepts all four valid status values", () => {
    for (const ok of ["all", "on", "off", "deleted"] as const) {
      expect(parseKeywordPageParams({ keywordStatus: ok }).status).toBe(ok)
    }
  })

  it("falls back to sort='updatedAt:desc' for unknown sort", () => {
    expect(parseKeywordPageParams({ sort: "foo:bar" }).sort).toBe(
      "updatedAt:desc",
    )
    expect(parseKeywordPageParams({ sort: "updatedAt" }).sort).toBe(
      "updatedAt:desc",
    )
    // SQL injection 시도성 값도 단순 폴백
    expect(parseKeywordPageParams({ sort: "id; DROP TABLE" }).sort).toBe(
      "updatedAt:desc",
    )
  })

  it("accepts all eight valid sort tokens", () => {
    const tokens = [
      "updatedAt:desc",
      "updatedAt:asc",
      "keyword:asc",
      "keyword:desc",
      "bidAmt:desc",
      "bidAmt:asc",
      "recentAvgRnk:asc",
      "recentAvgRnk:desc",
    ] as const
    for (const t of tokens) {
      expect(parseKeywordPageParams({ sort: t }).sort).toBe(t)
    }
  })

  it("trims q whitespace", () => {
    expect(parseKeywordPageParams({ q: "  foo  " }).q).toBe("foo")
    expect(parseKeywordPageParams({ q: "   " }).q).toBe("")
  })

  it("uses first array element when searchParam is string[]", () => {
    expect(
      parseKeywordPageParams({
        page: ["2", "9"],
        pageSize: ["500", "1"],
        q: ["bar", "baz"],
        keywordStatus: ["off", "on"],
        sort: ["keyword:asc", "bidAmt:desc"],
      }),
    ).toEqual({
      page: 2,
      pageSize: 500,
      q: "bar",
      status: "off",
      sort: "keyword:asc",
    })
  })

  it("does not throw on adversarial inputs", () => {
    expect(() =>
      parseKeywordPageParams({
        page: "Infinity",
        pageSize: "9999999",
        q: "  ",
        keywordStatus: "DROP",
        sort: "../../etc/passwd",
      }),
    ).not.toThrow()
  })
})
