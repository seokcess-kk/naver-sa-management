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
 * - impCnt:   노출 수
 * - clkCnt:   클릭 수
 * - salesAmt: 비용 (원). 명칭이 "sales"이지만 실제 의미는 광고주가 지불한 비용.
 * - crtoCnt:  전환 수 (P2 영역 — P1 KPI에서는 사용 안 함)
 * - ctr:      클릭률 (%)
 * - cpc:      평균 클릭당 비용 (원)
 * - ccnt:     추가 클릭 (옵션 — 일부 광고 유형 한정)
 *
 * 응답 row 에 정의 외 필드(예: hh24, pcMblTp, recentAvgRnk)도 올 수 있어 passthrough.
 */
export type StatsField = "impCnt" | "clkCnt" | "salesAmt" | "crtoCnt" | "ctr" | "cpc" | "ccnt"

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
