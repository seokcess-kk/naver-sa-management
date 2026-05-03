/**
 * 대시보드/소재/키워드/확장소재 공통 stats 표시 유틸 (F-7.x / F-3.x / F-4.x / F-5.x)
 *
 * 책임:
 *   - AdMetrics 타입 (5종 SA Stats 지표) — 모든 페이지가 동일 shape 사용
 *   - AdsPeriod 타입 + parsePeriod (URL searchParams.period 화이트리스트 파싱)
 *   - PERIOD_LABELS 한글 라벨 (UI select 표시)
 *   - formatInt / formatPct / formatWon 공통 포맷터
 *
 * 사용 패턴 (RSC + 클라이언트 테이블):
 *   1. RSC page.tsx 가 searchParams.period → parsePeriod 로 화이트리스트 적용
 *   2. RSC 가 getStatsChunked(customerId, { ids, fields, datePreset }) 호출
 *   3. 응답 row 를 ID 기반 Map 으로 매핑 → 각 행 metrics 채움 (없으면 0)
 *   4. 클라이언트 테이블이 AdMetrics 컬럼 5개 + 합계 footer 렌더
 *
 * stats 호출량 / 캐시:
 *   - getStatsChunked 가 ids 를 chunk 분할 + Redis 캐시 (오늘 5분 / 과거 1시간)
 *   - 광고주별 토큰 버킷 큐잉 → 분 단위 가능. 페이지 maxDuration=300 안전선.
 *   - 한계 도달 시 NAVER_SA_STATS_CHUNK env 상향 또는 ChangeBatch 패턴 이관 (SPEC 3.5).
 */

/**
 * SA Stats 5종 지표 (소재 / 키워드 / 확장소재 공통).
 *
 * - impCnt:   노출 수 (정수)
 * - clkCnt:   클릭 수 (정수)
 * - ctr:      클릭률 % (예: 0.32)
 * - cpc:      평균 CPC (원)
 * - salesAmt: 총 비용 (원)
 *
 * recentAvgRnk (평균 노출 순위) 는 키워드 단독 컬럼이라 본 타입에서 제외.
 */
export type AdMetrics = {
  impCnt: number
  clkCnt: number
  ctr: number
  cpc: number
  salesAmt: number
}

/** 빈 metrics — 매칭 없는 행 / 신규 소재 폴백. */
export const EMPTY_METRICS: AdMetrics = {
  impCnt: 0,
  clkCnt: 0,
  ctr: 0,
  cpc: 0,
  salesAmt: 0,
}

/**
 * 페이지 stats 기간 (네이버 SA datePreset 화이트리스트 일부).
 *
 * - today / yesterday / last7days / last30days
 * - 캐시 분기는 stats 모듈이 자체 처리 (오늘 포함 → 5분, 그 외 → 1시간)
 */
export type AdsPeriod = "today" | "yesterday" | "last7days" | "last30days"

/** UI select 표시용 한글 라벨. */
export const PERIOD_LABELS: Record<AdsPeriod, string> = {
  today: "오늘",
  yesterday: "어제",
  last7days: "지난 7일",
  last30days: "지난 30일",
}

/** 기본 기간 — RSC parsePeriod 폴백. SA 콘솔 관행과 일치. */
export const DEFAULT_PERIOD: AdsPeriod = "last7days"

const PERIOD_WHITELIST: ReadonlySet<AdsPeriod> = new Set([
  "today",
  "yesterday",
  "last7days",
  "last30days",
])

/**
 * URL searchParams.period 을 화이트리스트로 검증.
 *
 * 배열로 들어오면 첫 항목만 사용 (Next.js searchParams 는 string | string[] | undefined).
 */
export function parsePeriod(raw: string | string[] | undefined): AdsPeriod {
  const v = Array.isArray(raw) ? raw[0] : raw
  return v && PERIOD_WHITELIST.has(v as AdsPeriod) ? (v as AdsPeriod) : DEFAULT_PERIOD
}

// =============================================================================
// 포맷터 — 셀 / footer 합계 공통
// =============================================================================

const NUMBER_FMT = new Intl.NumberFormat("ko-KR")

export function formatInt(n: number): string {
  return NUMBER_FMT.format(Math.round(n))
}

export function formatPct(n: number): string {
  return `${n.toFixed(2)} %`
}

export function formatWon(n: number): string {
  return `${NUMBER_FMT.format(Math.round(n))}원`
}

// =============================================================================
// 합계 계산 — 필터 적용 후 row 합산 (ctr/cpc 는 가중평균)
// =============================================================================

/**
 * 행 metrics 합산 + 가중평균 ctr/cpc 계산 (SA 콘솔 footer 동등).
 *
 * - impCnt / clkCnt / salesAmt: 단순 합
 * - ctr: clkCnt / impCnt * 100 (가중평균)
 * - cpc: salesAmt / clkCnt (가중평균)
 *
 * 단순 평균(평균의 평균)은 표본 수 다른 행이 섞이면 왜곡되므로 본 정의 채택.
 */
export function sumMetrics(metricsList: readonly AdMetrics[]): AdMetrics {
  let impCnt = 0
  let clkCnt = 0
  let salesAmt = 0
  for (const m of metricsList) {
    impCnt += m.impCnt
    clkCnt += m.clkCnt
    salesAmt += m.salesAmt
  }
  const ctr = impCnt > 0 ? (clkCnt / impCnt) * 100 : 0
  const cpc = clkCnt > 0 ? salesAmt / clkCnt : 0
  return { impCnt, clkCnt, salesAmt, ctr, cpc }
}
