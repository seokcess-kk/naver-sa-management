/**
 * 키워드 목록 페이지 (F-3.1) URL 파라미터 파싱 유틸.
 *
 * 서버 페이지네이션 도입 이후 page.tsx 가 클라이언트 in-memory 5천 행 모델 폐기 →
 * URL 파라미터(page / pageSize / q / status / sort) 기반 RSC 재조회로 전환.
 *
 * 파싱 정책:
 *   - 모든 파라미터에 대해 잘못된 / 누락된 값은 안전한 기본값으로 폴백 (throw 금지)
 *   - pageSize 는 화이트리스트(50/100/200/500) 외 값 → 100 폴백
 *   - sort 는 KeywordSort union 외 값 → "updatedAt:desc" 폴백
 *   - status 는 ("all" | "on" | "off" | "deleted") 외 값 → "all" 폴백
 *   - page 는 1-based, 1 미만 / NaN → 1 폴백
 *   - q 는 trim. 빈 문자열은 그대로 빈 문자열 (필터 비활성으로 처리)
 *
 * 호환:
 *   - lib/navigation/campaign-scope.ts 와 같은 검색 파라미터 객체 (Record<string, string|string[]|undefined>)
 *     를 받아 처리. campaign-scope 와 함께 사용해도 키 충돌 없음.
 */

type SearchParamValue = string | string[] | undefined

export type KeywordSearchParams = Record<string, SearchParamValue>

export type KeywordSort =
  | "updatedAt:desc"
  | "updatedAt:asc"
  | "keyword:asc"
  | "keyword:desc"
  | "bidAmt:desc"
  | "bidAmt:asc"
  | "recentAvgRnk:asc"
  | "recentAvgRnk:desc"

export type KeywordStatusFilter = "all" | "on" | "off" | "deleted"

export type KeywordPageParams = {
  /** 1-based, 최소 1 */
  page: number
  /** 50 | 100 | 200 | 500. 기본 100. */
  pageSize: number
  /** 검색어 (trim 적용 — 빈 문자열은 필터 비활성) */
  q: string
  /** 기본 "all" (전체) */
  status: KeywordStatusFilter
  /** 기본 "updatedAt:desc" */
  sort: KeywordSort
}

const PAGE_SIZE_WHITELIST = [50, 100, 200, 500] as const
const DEFAULT_PAGE_SIZE = 100

const SORT_WHITELIST: ReadonlySet<KeywordSort> = new Set([
  "updatedAt:desc",
  "updatedAt:asc",
  "keyword:asc",
  "keyword:desc",
  "bidAmt:desc",
  "bidAmt:asc",
  "recentAvgRnk:asc",
  "recentAvgRnk:desc",
])
const DEFAULT_SORT: KeywordSort = "updatedAt:desc"

const STATUS_WHITELIST: ReadonlySet<KeywordStatusFilter> = new Set([
  "all",
  "on",
  "off",
  "deleted",
])
const DEFAULT_STATUS: KeywordStatusFilter = "all"

/** searchParams 에서 단일 string 값 추출 (배열은 첫 번째). 없으면 undefined. */
function pickFirst(value: SearchParamValue): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

function parsePage(raw: SearchParamValue): number {
  const v = pickFirst(raw)
  if (!v) return 1
  const n = Number.parseInt(v, 10)
  if (!Number.isFinite(n) || n < 1) return 1
  return n
}

function parsePageSize(raw: SearchParamValue): number {
  const v = pickFirst(raw)
  if (!v) return DEFAULT_PAGE_SIZE
  const n = Number.parseInt(v, 10)
  if (!Number.isFinite(n)) return DEFAULT_PAGE_SIZE
  if (!(PAGE_SIZE_WHITELIST as readonly number[]).includes(n)) {
    return DEFAULT_PAGE_SIZE
  }
  return n
}

function parseQ(raw: SearchParamValue): string {
  const v = pickFirst(raw)
  if (!v) return ""
  return v.trim()
}

function parseStatus(raw: SearchParamValue): KeywordStatusFilter {
  const v = pickFirst(raw)
  if (!v) return DEFAULT_STATUS
  if (STATUS_WHITELIST.has(v as KeywordStatusFilter)) {
    return v as KeywordStatusFilter
  }
  return DEFAULT_STATUS
}

function parseSort(raw: SearchParamValue): KeywordSort {
  const v = pickFirst(raw)
  if (!v) return DEFAULT_SORT
  if (SORT_WHITELIST.has(v as KeywordSort)) return v as KeywordSort
  return DEFAULT_SORT
}

/**
 * URL 검색 파라미터에서 키워드 페이지 파라미터를 파싱.
 *
 * - 잘못된 값 / 누락 / 화이트리스트 외 값 → 안전한 기본값으로 폴백 (throw 안 함)
 * - 호출자는 반환값을 그대로 prisma where / orderBy / take / skip 에 매핑할 수 있음
 */
export function parseKeywordPageParams(
  searchParams: KeywordSearchParams | undefined,
): KeywordPageParams {
  return {
    page: parsePage(searchParams?.page),
    pageSize: parsePageSize(searchParams?.pageSize),
    q: parseQ(searchParams?.q),
    // URL key: `keywordStatus` (UI 표기와 일치 — generic `status` 는 다른 화면에서 충돌 가능)
    status: parseStatus(searchParams?.keywordStatus),
    sort: parseSort(searchParams?.sort),
  }
}

/**
 * 화이트리스트 상수 — UI 측 페이지 사이즈 셀렉터에서 동일 값 사용 권장.
 */
export const KEYWORD_PAGE_SIZES = PAGE_SIZE_WHITELIST
