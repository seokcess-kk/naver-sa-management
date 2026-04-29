/**
 * 네이버 SA Stats 모듈 (F-7.1 / F-7.4 — 대시보드 KPI / 차트 / TOP 데이터 소스)
 *
 * 엔드포인트:
 *   GET /stats?ids=...&fields=[...]&datePreset=...
 *   GET /stats?ids=...&fields=[...]&timeRange={"since":"YYYY-MM-DD","until":"YYYY-MM-DD"}
 *
 * 쿼리 인코딩:
 *   - ids:       콤마 결합 후 encodeURIComponent (예: "cmp-1,cmp-2")
 *   - fields:    JSON 배열 → encodeURIComponent (예: ["impCnt","clkCnt"])
 *   - timeRange: JSON 객체 → encodeURIComponent (예: {"since":"2025-01-01","until":"2025-01-07"})
 *   - breakdown: 단순 문자열 (hh24 / pcMblTp)
 *   - datePreset 또는 timeRange 둘 중 하나만 사용 (둘 다 지정 시 timeRange 우선)
 *
 * 캐시 정책 (CLAUDE.md "데이터 소스 정책" — P1):
 *   - 오늘 데이터 (datePreset="today" 또는 timeRange.until >= 오늘): TTL 5분
 *   - 과거 데이터 (그 외): TTL 1시간
 *   - 키: stats:{customerId}:{kind}:{params-hash}
 *     kind = "today" | "past"
 *
 * 본 모듈은 stats 자체 캐시를 사용한다 (client.ts cache 옵션과 별도).
 * 이유: client.ts 캐시는 raw 응답(`{ data: [...] }`)을 캐시하지만,
 *       호출부는 변환된 StatsRow[] 만 필요 → 변환 후 캐시가 페이로드 측면에서 효율.
 *
 * 호출자 주의:
 *   - customerId 인자는 광고주 customerId (X-Customer 헤더). 누락 시 client.ts가 차단.
 *   - ids 미지정 시 광고주 전체 합산. ids 지정 시 ID 별 row 반환.
 *   - 응답 shape 은 sample 마다 다름 → StatsRowSchema는 passthrough.
 *   - 평균 노출 순위(recentAvgRnk) null 대응은 호출부 책임 (본 모듈은 stats API 한정).
 *   - 자체 적재 테이블 X — 본 모듈만 P1 데이터 소스 (StatHourly/StatDaily는 P2).
 *
 * HMAC 서명 / fetch / Rate Limit / 재시도는 `lib/naver-sa/client.ts`만 수행.
 * 본 모듈에서 fetch 또는 직접 서명 금지.
 */

import { createHash } from "node:crypto"

import { z } from "zod"

import { cached } from "@/lib/cache/redis"
import { naverSaClient } from "@/lib/naver-sa/client"
import { NaverSaValidationError } from "@/lib/naver-sa/errors"

// =============================================================================
// 타입 / 스키마
// =============================================================================

/**
 * Stats 응답 필드 (네이버 SA 공식 fields 파라미터 값).
 *
 * - impCnt:        노출 수
 * - clkCnt:        클릭 수
 * - salesAmt:      비용 (원). 명칭이 "sales"이지만 실제 의미는 광고주가 지불한 비용.
 * - crtoCnt:       전환 수 (P2 영역 — P1 KPI에서는 사용 안 함)
 * - ctr:           클릭률 (%)
 * - cpc:           평균 클릭당 비용 (원)
 * - ccnt:          추가 클릭 (옵션 — 일부 광고 유형 한정)
 * - recentAvgRnk:  최근 평균 노출 순위 (관찰 기반 — 데이터 부족 시 null 도래)
 *
 * 응답 row 에 정의 외 필드(예: hh24, pcMblTp)도 올 수 있어 passthrough.
 *
 * recentAvgRnk 처리 정책 (F-9.2 / F-9.4 — backend 책임):
 *   - StatHourly 적재: nullable Decimal 컬럼에 그대로 적재 (null 통과)
 *   - Keyword.recentAvgRnk 갱신: last non-null 우선 (이번 시간 null 이면 갱신 안 함)
 *   - 재시도 큐 X — 다음 시간 cron 이 자연 재시도
 *   - "15~30분 지연" SLA 가정 (CLAUDE.md "데이터 소스 정책")
 */
export type StatsField =
  | "impCnt"
  | "clkCnt"
  | "salesAmt"
  | "crtoCnt"
  | "ctr"
  | "cpc"
  | "ccnt"
  | "recentAvgRnk"

/**
 * 네이버 SA datePreset 화이트리스트.
 * timeRange 와 함께 지정 시 timeRange 가 우선 (본 모듈에서 timeRange 분기 시 datePreset 무시).
 */
export type StatsDatePreset = "today" | "yesterday" | "recent7d" | "recent30d"

/**
 * Stats 호출 요청.
 *
 * - ids:       캠페인/광고그룹/키워드 ID 배열 (옵션). 미지정 시 광고주 전체 합산 row 1개 반환.
 * - fields:    가져올 지표 (필수, 1개 이상)
 * - datePreset / timeRange: 둘 중 하나는 필수. 둘 다 지정 시 timeRange 우선.
 * - breakdown: hh24 (시간대) / pcMblTp (PC/모바일) — 응답에 분해 키가 추가됨.
 */
export type StatsRequest = {
  ids?: string[]
  fields: StatsField[]
  datePreset?: StatsDatePreset
  /** YYYY-MM-DD 형식. since <= until. */
  timeRange?: { since: string; until: string }
  breakdown?: "hh24" | "pcMblTp"
}

/**
 * 단일 Stats row.
 *
 * - id 는 ids 미지정 시 없음 (광고주 전체 합산 한 row).
 * - 모든 지표 필드는 optional — 요청 fields 에 포함된 항목만 채워짐.
 * - breakdown 응답은 hh24 / pcMblTp 같은 추가 키가 붙어옴 (passthrough 로 통과).
 *
 * breakdown 응답 추가 키 (호출자가 직접 row 에서 추출):
 *   - breakdown="hh24"    → row.hh24    (string "00".."23" 또는 number 0..23)
 *   - breakdown="pcMblTp" → row.pcMblTp ("PC" / "MOBILE")
 *   - 본 모듈은 추출 헬퍼 제공 X — backend 가 Number(row.hh24) 등으로 변환.
 *
 * Record<string, unknown> 합쳐 응답 변경/추가 필드도 그대로 노출.
 */
export type StatsRow = {
  id?: string
  impCnt?: number
  clkCnt?: number
  salesAmt?: number
  crtoCnt?: number
  ctr?: number
  cpc?: number
  ccnt?: number
  recentAvgRnk?: number | null
} & Record<string, unknown>

/**
 * 응답 row 스키마. passthrough 로 정의 외 필드 통과.
 *
 * 정의된 지표 필드는 모두 optional + nullable (네이버 응답에 null 도래 가능).
 * id 는 string | number 양쪽 → string 정규화 (캠페인/키워드 ID 일부가 number 로 올 수 있음).
 */
export const StatsRowSchema = z
  .object({
    id: z
      .union([z.string(), z.number()])
      .transform((v) => String(v))
      .optional(),
    impCnt: z.number().nullable().optional(),
    clkCnt: z.number().nullable().optional(),
    salesAmt: z.number().nullable().optional(),
    crtoCnt: z.number().nullable().optional(),
    ctr: z.number().nullable().optional(),
    cpc: z.number().nullable().optional(),
    ccnt: z.number().nullable().optional(),
    // recentAvgRnk: 관찰 기반 — 데이터 부족 시 null 도래. F-9.2 / F-9.4 호출부가 last non-null 우선 정책 적용.
    recentAvgRnk: z.number().nullable().optional(),
  })
  .passthrough()

/**
 * 네이버 SA Stats 응답 wrapper.
 *
 * 관찰된 shape: `{ data: StatsRow[] }`.
 * 호환성을 위해 응답이 배열 자체일 가능성도 함께 처리 (parseStatsResponse 참조).
 */
const StatsResponseEnvelopeSchema = z.object({
  data: z.array(StatsRowSchema),
})

// =============================================================================
// 내부 헬퍼
// =============================================================================

/**
 * 응답 → StatsRow[] 추출 + Zod 검증.
 *
 * 우선순위:
 *   1. `{ data: [...] }` envelope
 *   2. 배열 자체 (`[...]`)
 *
 * 두 형태 모두 실패 시 raw 보존 검증 에러.
 */
function parseStatsResponse(
  res: unknown,
  ctx: { path: string; customerId: string },
): StatsRow[] {
  // envelope 우선
  const envelope = StatsResponseEnvelopeSchema.safeParse(res)
  if (envelope.success) {
    return envelope.data.data as StatsRow[]
  }

  // 배열 fallback
  const bare = z.array(StatsRowSchema).safeParse(res)
  if (bare.success) {
    return bare.data as StatsRow[]
  }

  throw new NaverSaValidationError(`GET ${ctx.path}: stats zod validation failed`, {
    method: "GET",
    path: ctx.path,
    customerId: ctx.customerId,
    raw: res,
  })
}

/** YYYY-MM-DD (UTC 기반 — 호출부와 합의된 timezone 정책 추가 시 변경 가능). */
function todayDateString(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * 요청이 "오늘 데이터를 포함하는가" 판정.
 *
 * - datePreset === "today" → true
 * - timeRange.until >= 오늘 (YYYY-MM-DD 사전식 비교) → true
 * - 그 외 (yesterday / recent7d / recent30d / 과거 timeRange) → false
 *
 * recent7d / recent30d 는 일반적으로 어제까지 기준이라 false 처리 (네이버 SA 관행).
 * 만약 오늘 포함 시멘틱이 필요하면 호출부가 timeRange 로 명시.
 */
function includesToday(req: StatsRequest): boolean {
  if (req.timeRange) {
    return req.timeRange.until >= todayDateString()
  }
  return req.datePreset === "today"
}

/** 캐시 키용 안정 해시 (16자 sha256 hex). */
function hashRequest(req: StatsRequest): string {
  // 키 안정화를 위해 fields/ids 정렬 후 직렬화.
  const stable = {
    ids: req.ids ? [...req.ids].sort() : undefined,
    fields: [...req.fields].sort(),
    datePreset: req.datePreset,
    timeRange: req.timeRange,
    breakdown: req.breakdown,
  }
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 16)
}

/**
 * Stats 쿼리 path 빌더.
 *
 * 네이버 SA 서명은 path 의 query string 을 제외한 부분(uri)만 사용 (client.ts 주석 참조).
 * 본 함수는 query string 까지 포함된 path 를 반환 → client 가 sign 시 자동으로 query 제거.
 */
function buildStatsPath(req: StatsRequest): string {
  const params: string[] = []

  if (req.ids && req.ids.length > 0) {
    params.push(`ids=${encodeURIComponent(req.ids.join(","))}`)
  }

  // fields 는 필수
  params.push(`fields=${encodeURIComponent(JSON.stringify(req.fields))}`)

  // timeRange 우선, 없으면 datePreset
  if (req.timeRange) {
    params.push(`timeRange=${encodeURIComponent(JSON.stringify(req.timeRange))}`)
  } else if (req.datePreset) {
    params.push(`datePreset=${encodeURIComponent(req.datePreset)}`)
  }

  if (req.breakdown) {
    params.push(`breakdown=${encodeURIComponent(req.breakdown)}`)
  }

  return `/stats?${params.join("&")}`
}

// =============================================================================
// public API
// =============================================================================

/**
 * Stats 조회 (P1 동기 호출 + Redis 캐시).
 *
 * 캐시:
 *   - 오늘 포함:   stats:{customerId}:today:{hash}  / TTL 300s (5분)
 *   - 과거만:      stats:{customerId}:past:{hash}   / TTL 3600s (1시간)
 *
 * 검증 실패(응답 shape 변경) 시 NaverSaValidationError 던짐 (raw 컨텍스트 첨부).
 *
 * @param customerId 광고주 customerId (X-Customer 헤더로 부착)
 * @param request    Stats 요청 (fields 필수, datePreset 또는 timeRange 중 하나)
 * @returns          StatsRow 배열 (ids 미지정 시 row 1개)
 *
 * 사용 예 (캠페인별 7일 KPI):
 *   const rows = await getStats(customerId, {
 *     ids: campaignIds,
 *     fields: ["impCnt", "clkCnt", "salesAmt", "ctr", "cpc"],
 *     datePreset: "recent7d",
 *   })
 *
 * 사용 예 (광고주 전체 오늘 합산):
 *   const [today] = await getStats(customerId, {
 *     fields: ["impCnt", "clkCnt", "salesAmt"],
 *     datePreset: "today",
 *   })
 *
 * 사용 예 (시간대 분해):
 *   const hourly = await getStats(customerId, {
 *     fields: ["impCnt", "clkCnt"],
 *     datePreset: "today",
 *     breakdown: "hh24",
 *   })
 */
export async function getStats(
  customerId: string,
  request: StatsRequest,
): Promise<StatsRow[]> {
  if (!customerId) {
    throw new NaverSaValidationError("customerId is required for getStats")
  }
  if (!request.fields || request.fields.length === 0) {
    throw new NaverSaValidationError("getStats: fields must contain at least 1 entry")
  }
  if (!request.datePreset && !request.timeRange) {
    throw new NaverSaValidationError("getStats: datePreset or timeRange is required")
  }

  const path = buildStatsPath(request)
  const isToday = includesToday(request)
  const cacheKind = isToday ? "today" : "past"
  const ttl = isToday ? 300 : 3600
  const cacheKey = `stats:${customerId}:${cacheKind}:${hashRequest(request)}`

  return cached<StatsRow[]>(cacheKey, ttl, async () => {
    const res = await naverSaClient.request({
      customerId,
      method: "GET",
      path,
      // client.ts cache 옵션은 사용 안 함 (본 모듈에서 변환 후 캐시).
    })
    return parseStatsResponse(res, { path, customerId })
  })
}

/**
 * 다수 ids 를 chunk 분할하여 getStats 반복 호출 + 결과 병합.
 *
 * 배경 (F-9.2 시간별 cron / F-9.4 노출 순위 적재):
 *   네이버 SA Stats API 의 ids 인자에는 공식 한도가 비공개지만,
 *   관찰상 100~500 개 초과 시 400/414/실패 발생. 광고주당 키워드 5천 개를
 *   한 번에 호출 불가 → chunk 분할 직렬 호출 + 결과 row 평면 합치기.
 *
 * 동작:
 *   - ids.length === 0 → 즉시 [] (네트워크 호출 X)
 *   - chunkSize 기본 100 (보수적). NAVER_SA_STATS_CHUNK env 로 오버라이드 가능.
 *   - chunk 단위 직렬 호출 (광고주별 동시성 제어는 client.ts 토큰 버킷 책임)
 *   - 각 chunk 호출은 getStats 의 기존 캐시(`stats:{customerId}:{kind}:{hash}`) 활용 →
 *     chunk 별 ids 해시가 다르므로 캐시 키 분리 → today TTL 5분 동안 부분 hit/miss 가능
 *   - 각 chunk 의 Zod 검증 실패 시 NaverSaValidationError throw (호출자가 catch / batch 보고)
 *
 * 운영 권고:
 *   - chunk size 환경변수: NAVER_SA_STATS_CHUNK (예: "200" / "500")
 *   - 운영 초기에는 100 유지 → 안정 확인 후 상향
 *   - 시간별 cron 호출 빈도가 캐시 TTL 보다 짧으면 일부 chunk 재호출 (비용 추적 권장)
 *
 * @param customerId   광고주 customerId
 * @param baseRequest  ids 포함한 StatsRequest. ids 가 chunk 단위로 분리됨
 * @param opts.chunkSize  호출별 ids 최대 개수 (env 보다 우선)
 * @returns            모든 chunk 의 row 평면 합친 결과
 *
 * 사용 예 (시간별 키워드 적재):
 *   const rows = await getStatsChunked(customerId, {
 *     ids: keywordIds,            // 5,000 개
 *     fields: ["impCnt", "clkCnt", "salesAmt", "ctr", "cpc", "recentAvgRnk"],
 *     datePreset: "today",
 *     breakdown: "hh24",
 *   })
 *   // rows.length ≈ 5,000 × 24 (현재 시각까지 누적된 시간대만 채워짐)
 */
export async function getStatsChunked(
  customerId: string,
  baseRequest: Omit<StatsRequest, "ids"> & { ids: string[] },
  opts?: { chunkSize?: number },
): Promise<StatsRow[]> {
  if (!customerId) {
    throw new NaverSaValidationError("customerId is required for getStatsChunked")
  }
  if (!baseRequest.fields || baseRequest.fields.length === 0) {
    throw new NaverSaValidationError("getStatsChunked: fields must contain at least 1 entry")
  }
  if (!baseRequest.datePreset && !baseRequest.timeRange) {
    throw new NaverSaValidationError(
      "getStatsChunked: datePreset or timeRange is required",
    )
  }

  const ids = baseRequest.ids
  if (ids.length === 0) return []

  const explicit = opts?.chunkSize
  const envValue = Number(process.env.NAVER_SA_STATS_CHUNK ?? "100")
  const chunkSize =
    explicit && explicit > 0
      ? explicit
      : Number.isFinite(envValue) && envValue > 0
        ? envValue
        : 100

  const out: StatsRow[] = []
  for (let i = 0; i < ids.length; i += chunkSize) {
    const slice = ids.slice(i, i + chunkSize)
    const rows = await getStats(customerId, { ...baseRequest, ids: slice })
    // 평면 합치기 — 각 chunk 응답의 row 순서를 유지.
    for (const r of rows) out.push(r)
  }
  return out
}
