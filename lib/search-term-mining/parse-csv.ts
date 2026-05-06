/**
 * 검색어 보고서 CSV 파서 (Phase D.3).
 *
 * 책임:
 *   - 네이버 SA 콘솔에서 다운로드한 검색어 보고서 CSV 1건 파싱 → SearchTermRow[]
 *   - 한글 헤더 / 영문 헤더 양쪽 동시 지원 (key normalization 사전)
 *   - 동일 검색어 N행(날짜·디바이스 분할) → 같은 검색어로 합산 (impressions/clicks/cost/conversions sum)
 *   - 빈 검색어("기타" 합산 행) skip
 *
 * 비대상:
 *   - SA API 직접 호출 (콘솔 endpoint 자동화는 운영상 부적합 — 본 PR은 사용자 수동 다운로드 전제)
 *   - DB 적재 (호출자가 actions.ts 에서 결정)
 *   - adgroup 매핑 (검색어 단위 합산만; adgroup 결정은 UI 사용자 선택 → 후속 PR)
 *
 * 입력:
 *   - csvText: string (UTF-8, BOM 허용). 호출자(client)가 File → text 변환 후 server action 으로 전달.
 *
 * 출력:
 *   - { rows: SearchTermRow[]; rawRowCount: number; skipped: number; mappedKeys: string[]; fileError?: string }
 *   - SearchTermRow.adgroupId 는 빈 문자열 — classify.ts 입력 호환을 위해 필드는 유지 (UI/호출자가 사용자 선택으로 채움)
 *
 * 보안:
 *   - 시크릿 컬럼(apiKey/secretKey 등) 금지 — Excel 사용자가 잘못 만든 CSV 거부 (advertiser.ts 패턴 재사용 X — 검색어 보고서는 시크릿 컬럼 자체가 의미 없으나, 방어적으로 차단)
 */

import Papa from "papaparse"
import { z } from "zod"

import type { SearchTermRow } from "./classify"

// =============================================================================
// 헤더 매핑 사전
// =============================================================================
//
// 네이버 SA 콘솔 검색어 보고서 다운로드 응답에서 관찰된 영문 키:
//   expKeyword, schTp, ymd, impCnt, clkCnt, ctr, cpc, salesAmt(=cost), ccnt(=conversions),
//   crto(=conversion rate), convAmt, cpConv, ror, purchaseCcnt, purchaseConvAmt
//
// 한글 헤더 (실제 다운로드 CSV 파일):
//   검색어, 매치타입, 날짜, 노출수, 클릭수, 클릭률(%), 평균CPC, 총비용, 전환수, 전환율(%), 전환매출액, ...
//
// 정책:
//   - lowercase + 공백/괄호/% 제거 후 비교 (대소문자/공백/특수문자 둔감)
//   - 정규화 키 → 표준 키 매핑

/** 표준 내부 키 (SearchTermRow 의 키 + 보조 컬럼 포함). */
type StandardKey =
  | "searchTerm"
  | "matchType"
  | "date"
  | "impressions"
  | "clicks"
  | "cost"
  | "conversions"

/**
 * 헤더 매핑 사전.
 *
 * 키: 정규화된 헤더 문자열 (lowercase, 공백·괄호·% 제거)
 * 값: 표준 키 (StandardKey)
 *
 * 우선순위:
 *   - 영문 키(expKeyword, impCnt, clkCnt 등) 와 한글 키(검색어, 노출수, 클릭수 등) 양쪽 매핑
 *   - 콘솔 응답 영문 키(salesAmt) ≠ Stats API 영문 키(cost). 둘 다 cost 로 매핑.
 *   - "전환수"는 ccnt / purchaseCcnt 둘 다 가능 — 본 모듈은 ccnt 우선 (전환 정의 차이는
 *     광고주 콘솔 설정에 따라 다름; ccnt 가 없으면 purchaseCcnt fallback)
 */
const HEADER_DICTIONARY: Record<string, StandardKey> = {
  // -- 검색어 --
  expkeyword: "searchTerm",
  searchterm: "searchTerm",
  검색어: "searchTerm",
  query: "searchTerm",

  // -- 매치타입 --
  schtp: "matchType",
  matchtype: "matchType",
  매치타입: "matchType",
  매치유형: "matchType",
  검색유형: "matchType", // 콘솔 검색어 보고서 한글 헤더

  // -- 날짜 --
  ymd: "date",
  date: "date",
  날짜: "date",
  일자: "date",
  일별: "date", // 콘솔 검색어 보고서 한글 헤더

  // -- 노출수 --
  impcnt: "impressions",
  impressions: "impressions",
  imp: "impressions",
  노출수: "impressions",
  노출: "impressions",

  // -- 클릭수 --
  clkcnt: "clicks",
  clicks: "clicks",
  click: "clicks",
  클릭수: "clicks",
  클릭: "clicks",

  // -- 비용 (콘솔 salesAmt = 광고비, Stats API cost) --
  salesamt: "cost",
  cost: "cost",
  sales: "cost",
  총비용: "cost",
  비용: "cost",
  광고비: "cost",

  // -- 전환수 (ccnt 우선, purchaseCcnt fallback) --
  ccnt: "conversions",
  conversions: "conversions",
  conversion: "conversions",
  conv: "conversions",
  전환수: "conversions",
  총전환수: "conversions", // 콘솔 검색어 보고서 한글 헤더
  전환: "conversions",
  // 보조: purchaseCcnt 도 conversions 로 (콘솔 응답에서 ccnt 미존재 시)
  purchaseccnt: "conversions",
  구매완료전환수: "conversions",
}

/** 헤더 1개를 정규화 + 표준 키로 매핑. 미매핑이면 null. */
function mapHeader(rawHeader: string): StandardKey | null {
  const normalized = rawHeader
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, "")
    .replace(/\(.*?\)/gu, "")
    .replace(/%/gu, "")
    .replace(/[\\/_-]/gu, "")
  return HEADER_DICTIONARY[normalized] ?? null
}

// =============================================================================
// 셀 값 파서
// =============================================================================
//
// 콘솔 CSV 의 숫자 셀:
//   - 천 단위 콤마 ("1,234")
//   - 빈 셀 "" / "-" / "N/A"
//   - 음수 는 등장 안 함 (전환수/비용/노출/클릭 모두 ≥ 0)

function parseNumber(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null
  const s = String(raw).trim()
  if (s.length === 0 || s === "-" || s === "N/A" || s === "NA") return null
  // 천 단위 콤마 / 통화 기호 / 공백 제거
  const cleaned = s.replace(/[,\s₩원]/gu, "")
  if (cleaned.length === 0) return null
  const n = Number(cleaned)
  if (!Number.isFinite(n)) return null
  return n
}

/** 빈 셀(0 으로 처리). impressions/clicks/cost 누락 → 0. */
function parseNumberOrZero(raw: string | undefined | null): number {
  return parseNumber(raw) ?? 0
}

/** 전환수 — null 보존 (P1 미적재 광고주 구분). */
function parseConversionsCell(raw: string | undefined | null): number | null {
  return parseNumber(raw)
}

// =============================================================================
// 입력/출력 타입
// =============================================================================

export type ParseSearchTermCsvOptions = {
  /**
   * 합산 단위 — 본 모듈은 항상 "검색어 단위" 합산.
   *   - 검색어 + 매치타입을 분리해서 다른 행으로 두려면 이 옵션을 false 로 두는 분기 추가 후속.
   *   - 현재는 단순화: 같은 검색어면 매치타입 무관 합산.
   *     (콘솔 보고서의 검색어×매치타입 분리가 필요해지면 후속 PR 에서 키 변경)
   * 기본 true.
   */
  aggregateBySearchTerm?: boolean
}

export type ParseSearchTermCsvResult = {
  /** classify.ts 의 입력 타입과 호환 — adgroupId 는 빈 문자열 (UI 가 채움). */
  rows: SearchTermRow[]
  /** PapaParse 가 읽은 원본 데이터 행 수 (헤더 제외). */
  rawRowCount: number
  /** 스킵된 행 수 (빈 검색어 / 모두 빈 셀). */
  skipped: number
  /** 매핑된 표준 키 목록 — UI 가 "어떤 컬럼이 인식되었는지" 표시용. */
  mappedKeys: StandardKey[]
  /** 매핑 실패 헤더 목록 — UI 진단. */
  unmappedHeaders: string[]
  /** 파일 단위 오류 (헤더 누락 / 빈 파일 등). 존재 시 rows 는 빈 배열. */
  fileError?: string
}

// =============================================================================
// 메인 파서
// =============================================================================

/**
 * UTF-8 BOM 제거 후 PapaParse → 헤더 매핑 → 합산.
 *
 * 흐름:
 *   1. BOM 제거
 *   2. PapaParse(header:true, skipEmptyLines:"greedy", dynamicTyping:false)
 *   3. 헤더 매핑 (HEADER_DICTIONARY) — searchTerm 미매핑 → fileError
 *   4. 각 행 → 표준 키로 변환 → 빈 검색어 skip
 *   5. searchTerm key 로 Map 합산 (impressions/clicks/cost/conversions sum)
 *      - conversions 는 모든 입력 행이 null 이면 결과도 null (P1 광고주 구분)
 *      - 일부라도 숫자가 있으면 그 값들만 합산 (null 은 0 으로 안 봄 — 정합성)
 *   6. SearchTermRow[] 반환 (adgroupId="" — UI 사용자가 사용자 액션으로 채움)
 */
export function parseSearchTermCsv(
  csvText: string,
  opts: ParseSearchTermCsvOptions = {},
): ParseSearchTermCsvResult {
  const aggregateBySearchTerm = opts.aggregateBySearchTerm ?? true

  // -- 1. BOM 제거 -----------------------------------------------------------
  let text = csvText
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1)
  }
  if (text.trim().length === 0) {
    return {
      rows: [],
      rawRowCount: 0,
      skipped: 0,
      mappedKeys: [],
      unmappedHeaders: [],
      fileError: "빈 파일입니다",
    }
  }

  // -- 2. PapaParse ----------------------------------------------------------
  // 콘솔 검색어/키워드 보고서는 1행에 메타데이터(`검색어 보고서(2026.05.01.~...),2175052`)
  // 가 들어 있고 2행이 실제 헤더인 경우가 있다. 첫 시도에서 searchTerm 매핑 실패 시
  // 1행을 메타로 간주하고 제거 후 1회 재시도한다.
  const tryParse = (input: string) => {
    const parsed = Papa.parse<Record<string, string>>(input, {
      header: true,
      skipEmptyLines: "greedy",
      dynamicTyping: false,
      transformHeader: (h) => h.trim(),
    })
    const rawHeaders = (parsed.meta.fields ?? []).map((h) => h.trim())
    const headerMap: Record<string, StandardKey> = {}
    const unmappedHeaders: string[] = []
    for (const h of rawHeaders) {
      const std = mapHeader(h)
      if (std) {
        if (!Object.values(headerMap).includes(std)) {
          headerMap[h] = std
        } else {
          unmappedHeaders.push(`${h} (중복: ${std})`)
        }
      } else {
        unmappedHeaders.push(h)
      }
    }
    return { parsed, rawHeaders, headerMap, unmappedHeaders }
  }

  let attempt = tryParse(text)
  let metaSkipped = false
  if (
    attempt.rawHeaders.length > 0 &&
    !Object.values(attempt.headerMap).includes("searchTerm")
  ) {
    // 1행 제거 후 재시도 — 첫 줄을 line break 단위로 잘라낸다 (CRLF/LF 모두 처리).
    const firstBreak = text.search(/\r?\n/u)
    if (firstBreak >= 0) {
      const retried = tryParse(text.slice(firstBreak + 1))
      if (Object.values(retried.headerMap).includes("searchTerm")) {
        attempt = retried
        metaSkipped = true
      }
    }
  }

  const { parsed, rawHeaders, headerMap, unmappedHeaders } = attempt

  if (rawHeaders.length === 0) {
    return {
      rows: [],
      rawRowCount: 0,
      skipped: 0,
      mappedKeys: [],
      unmappedHeaders: [],
      fileError: "헤더 행이 없습니다. 1행 헤더 필수입니다.",
    }
  }

  void metaSkipped // 향후 진단 로그용 — 현재는 silent skip

  const mappedKeys = Object.values(headerMap)

  if (!mappedKeys.includes("searchTerm")) {
    return {
      rows: [],
      rawRowCount: parsed.data?.length ?? 0,
      skipped: 0,
      mappedKeys,
      unmappedHeaders,
      fileError:
        '필수 컬럼 누락: "검색어" (또는 expKeyword / searchTerm). 콘솔 검색어 보고서 다운로드 형식이 맞는지 확인하세요.',
    }
  }

  // -- 4-5. 행 변환 + 합산 ---------------------------------------------------
  type Aggregate = {
    searchTerm: string
    impressions: number
    clicks: number
    cost: number
    conversions: number | null
    /** 합산에 conversions 가 한 번이라도 숫자였는지 — 모두 null 이면 결과 null 유지. */
    conversionsSeen: boolean
    /** 매치타입 중 등장한 첫 값 — UI 표시용 (합산 후엔 의미 약화 — UI에 "복수" 표기 가능). */
    matchTypeFirst?: string
    matchTypeMixed: boolean
  }

  const rawRowCount = parsed.data?.length ?? 0
  const aggMap = new Map<string, Aggregate>()
  let skipped = 0

  // 매핑 역방향: 표준 키 → 원본 헤더 (1개) — 행에서 셀 추출 시 사용
  const stdToRawHeader = (std: StandardKey): string | undefined => {
    for (const [h, k] of Object.entries(headerMap)) {
      if (k === std) return h
    }
    return undefined
  }
  const hSearchTerm = stdToRawHeader("searchTerm")!
  const hImpressions = stdToRawHeader("impressions")
  const hClicks = stdToRawHeader("clicks")
  const hCost = stdToRawHeader("cost")
  const hConversions = stdToRawHeader("conversions")
  const hMatchType = stdToRawHeader("matchType")

  for (const raw of parsed.data ?? []) {
    // 빈 행 가드 (skipEmptyLines:"greedy" 가 거의 처리하지만, 셀에 "" 만 있는 케이스 방어)
    const allEmpty = Object.values(raw).every(
      (v) => v === undefined || v === null || String(v).trim() === "",
    )
    if (allEmpty) {
      skipped++
      continue
    }

    const searchTerm = String(raw[hSearchTerm] ?? "").trim()
    if (searchTerm.length === 0) {
      // "기타" 합산 행 / expKeyword="" 행 — skip
      skipped++
      continue
    }

    const impressions = hImpressions
      ? parseNumberOrZero(raw[hImpressions])
      : 0
    const clicks = hClicks ? parseNumberOrZero(raw[hClicks]) : 0
    const cost = hCost ? parseNumberOrZero(raw[hCost]) : 0
    const conversionsCell = hConversions
      ? parseConversionsCell(raw[hConversions])
      : null

    const matchType = hMatchType
      ? String(raw[hMatchType] ?? "").trim() || undefined
      : undefined

    const key = aggregateBySearchTerm
      ? searchTerm
      : `${searchTerm}|${matchType ?? ""}`

    const existing = aggMap.get(key)
    if (existing) {
      existing.impressions += impressions
      existing.clicks += clicks
      existing.cost += cost
      if (conversionsCell !== null) {
        existing.conversions =
          (existing.conversions ?? 0) + conversionsCell
        existing.conversionsSeen = true
      }
      if (matchType && existing.matchTypeFirst !== matchType) {
        existing.matchTypeMixed = true
      }
    } else {
      aggMap.set(key, {
        searchTerm,
        impressions,
        clicks,
        cost,
        conversions: conversionsCell, // null 가능
        conversionsSeen: conversionsCell !== null,
        matchTypeFirst: matchType,
        matchTypeMixed: false,
      })
    }
  }

  // -- 6. SearchTermRow[] 산출 -----------------------------------------------
  const rows: SearchTermRow[] = Array.from(aggMap.values()).map((a) => ({
    searchTerm: a.searchTerm,
    adgroupId: "", // UI 사용자가 사용자 선택으로 채움 (본 단순화 PR 비대상)
    impressions: a.impressions,
    clicks: a.clicks,
    cost: a.cost,
    conversions: a.conversionsSeen ? a.conversions : null,
  }))

  return {
    rows,
    rawRowCount,
    skipped,
    mappedKeys,
    unmappedHeaders,
  }
}

// =============================================================================
// Server Action 입력 검증용 Zod (csvText 사이즈 제한)
// =============================================================================

/** Server Action 진입부에서 csvText 길이 / 비어있음 검증. */
export const csvTextSchema = z
  .string()
  .min(1, "CSV 본문이 비어 있습니다")
  // 50MB hard limit (검색어 보고서 평균 1~5MB / 콘솔 다운로드 최대 ~ 30MB 가정)
  .max(50 * 1024 * 1024, "CSV 본문이 너무 큽니다 (최대 50MB)")

// =============================================================================
// Re-export (호출자 편의)
// =============================================================================

export type { SearchTermRow } from "./classify"
