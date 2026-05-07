/**
 * 네이버 SA StatReport 모듈 (F-9.1 — 일별 적재 / AD_DETAIL 비동기 보고서)
 *
 * 엔드포인트 (네이버 SA — 비동기 보고서 패턴, 관찰 기반):
 *   POST   /stat-reports                → reportJobId 발급
 *   GET    /stat-reports/{reportJobId}  → 폴링 (REGIST → RUNNING → BUILT/DONE)
 *   GET    {downloadUrl}                → 외부 S3 TSV (HMAC 불필요)
 *   DELETE /stat-reports/{reportJobId}  → 보고서 정리 (best-effort)
 *
 * 권장 호출 시퀀스 (backend cron 일별 적재):
 *   1. createStatReport(customerId, { reportTp: "AD_DETAIL", statDt: yesterday })
 *   2. waitStatReportReady(customerId, reportJobId)
 *   3. downloadStatReport(customerId, downloadUrl)  ← HMAC + X-Customer 필요 (SA 자기 도메인)
 *   4. parseAdDetailTsv(tsv)
 *   5. (적재 완료 후) deleteStatReport(customerId, reportJobId)
 *
 * 캐시: StatReport 는 일 1회 적재 → 결과 캐시 불필요. client.ts cache 옵션 미사용.
 *
 * Rate Limit:
 *   - POST/GET/DELETE /stat-reports*  → client.ts 토큰 버킷 자동 통과
 *   - downloadUrl GET (자기 도메인)     → client.ts 경유 → 토큰 버킷 자동 통과
 *
 * HMAC 서명 / X-Customer / 재시도(429,1016)는 `lib/naver-sa/client.ts`만 수행.
 * 본 모듈에서 fetch 또는 직접 서명 금지.
 *
 * 시크릿 운영:
 *   - customerId 만 인자 — 평문 키/시크릿 직접 처리 X
 *   - 에러 메시지에 reportJobId / customerId 만 포함 (시크릿 X)
 *
 * 알려진 한계 (네이버 spec 미확정):
 *   - 응답 필드명/순서는 관찰 기반. passthrough 로 추가 필드 통과.
 *   - TSV 컬럼명은 헤더 라인 동적 매핑 (스펙 변경 견고성).
 *   - 운영 활성화 시 응답 1건 캡처 후 본 파일 Zod 갱신 권장.
 */

import { z } from "zod"

import { naverSaClient } from "@/lib/naver-sa/client"
import { NaverSaUnknownError, NaverSaValidationError } from "@/lib/naver-sa/errors"

// =============================================================================
// 타입 / Zod 스키마
// =============================================================================

/**
 * StatReport job status.
 *
 * - REGIST:  요청 등록만 됨
 * - RUNNING: 보고서 생성 중
 * - BUILT:   생성 완료 (downloadUrl 사용 가능)
 * - DONE:    다운로드까지 끝남 (downloadUrl 사용 가능 — 일부 응답에서 BUILT 대신 바로 DONE)
 * - FAILED:  생성 실패 (재시도 또는 보고)
 */
export const StatReportStatusSchema = z.enum(["REGIST", "RUNNING", "BUILT", "DONE", "FAILED"])
export type StatReportStatus = z.infer<typeof StatReportStatusSchema>

/**
 * 보고서 종류. 본 모듈에서 사용하는 건 AD_DETAIL (일별 광고 세부).
 * 다른 종류(AD / AD_CONVERSION 등)는 추후 필요 시 union 확장.
 */
export const StatReportTpSchema = z.enum([
  "AD",
  "AD_DETAIL",
  "AD_CONVERSION",
  "AD_CONVERSION_DETAIL",
])
export type StatReportTp = z.infer<typeof StatReportTpSchema>

/**
 * POST /stat-reports / GET /stat-reports/{id} 응답 공통 shape.
 *
 * 관찰 기반 — 필드 추가/이름 변경 대비 passthrough.
 * - reportJobId: API 가 number 로 줄 수 있어 union → string 정규화
 * - status: enum 외 값이 와도 zod 가 차단 (운영 활성화 시 spec 갱신 트리거)
 */
export const StatReportJobSchema = z
  .object({
    reportJobId: z.union([z.string(), z.number()]).transform((v) => String(v)),
    status: StatReportStatusSchema,
    reportTp: z.string().optional(),
    statDt: z.string().optional(),
    registTm: z.string().optional(),
  })
  .passthrough()

export type StatReportJob = z.infer<typeof StatReportJobSchema>

/**
 * 다운로드 가능 상태(BUILT / DONE) 응답.
 *
 * downloadUrl 은 네이버 SA 자기 도메인 (예: api.searchad.naver.com/report-download).
 * → HMAC + X-Customer 헤더 필수 (raw fetch 시 400 Missing Header). client.ts 경유 호출.
 */
export const StatReportReadySchema = StatReportJobSchema.extend({
  downloadUrl: z.string().url(),
})
export type StatReportReady = z.infer<typeof StatReportReadySchema>

/**
 * AD_DETAIL TSV 행.
 *
 * TSV 헤더 인덱스로 동적 매핑 → 컬럼 추가/이름 변경에 견고.
 * passthrough 로 인식 못한 컬럼도 보존 (호출부 raw 적재 가능).
 *
 * - date:        YYYY-MM-DD (TSV 그대로 — UTC 기준 가정)
 * - device:      "PC" | "MOBILE" — TSV 값이 다른 형태(M/P 등)면 normalizeDevice 에서 실패 시 raw 보존
 * - impressions: 정수 0 이상
 * - clicks:      정수 0 이상
 * - cost:        실수 0 이상 (원화)
 * - avgRnk:      평균 노출 순위 (nullable — 노출 미달 행은 null)
 */
export const AdDetailRowSchema = z
  .object({
    date: z.string(),
    customerId: z.string(),
    campaignId: z.string().optional(),
    adgroupId: z.string().optional(),
    keywordId: z.string().optional(),
    adId: z.string().optional(),
    device: z.enum(["PC", "MOBILE"]),
    impressions: z.number().int().min(0),
    clicks: z.number().int().min(0),
    cost: z.number().min(0),
    avgRnk: z.number().nullable().optional(),
  })
  .passthrough()

export type AdDetailRow = z.infer<typeof AdDetailRowSchema>

// =============================================================================
// 내부 헬퍼
// =============================================================================

/**
 * Date → ISO 자정 UTC 문자열 (네이버 statDt 형식, KST 일자 기준).
 *
 * 입력 d 는 "KST 자정"의 절대 epoch 가정 (호출부 previousDayKstAsUtc 반환).
 * 예: d = 2026-05-05T15:00:00.000Z (= KST 2026-05-06 0시)
 *     → "2026-05-06T00:00:00.000Z"
 *
 * SA spec 은 KST 기준 일자를 받으므로 +9h 후 UTC year/month/day 추출.
 * 단순히 d.getUTCDate() 로 추출하면 KST 어제 자정 = UTC 그제 15:00 → "그제" 일자로 깎임 (회귀 차단).
 */
function toStatDtString(d: Date): string {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000)
  const y = kst.getUTCFullYear()
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0")
  const day = String(kst.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${day}T00:00:00.000Z`
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

/**
 * TSV 헤더명 → 정규화 키.
 *
 * 네이버 SA TSV 헤더는 공식 문서/실측이 살짝씩 다름 (Date / 일자 / Stat Date 등).
 * 본 매핑은 관찰된 변형을 모두 흡수. 매칭 안 되는 헤더는 passthrough 로 그대로 두고
 * known-key 로만 row 객체 인덱싱.
 */
const HEADER_ALIASES: Record<string, keyof AdDetailRow> = {
  // date
  date: "date",
  "stat date": "date",
  "stat dt": "date",
  일자: "date",

  // customerId
  "customer id": "customerId",
  customerid: "customerId",
  광고주id: "customerId",

  // campaignId
  "campaign id": "campaignId",
  campaignid: "campaignId",
  캠페인id: "campaignId",

  // adgroupId
  "adgroup id": "adgroupId",
  "ad group id": "adgroupId",
  adgroupid: "adgroupId",
  광고그룹id: "adgroupId",

  // keywordId
  "keyword id": "keywordId",
  keywordid: "keywordId",
  키워드id: "keywordId",

  // adId
  "ad id": "adId",
  adid: "adId",
  소재id: "adId",

  // device
  device: "device",
  "pc/mobile": "device",
  pcmbltp: "device",
  디바이스: "device",

  // impressions
  impressions: "impressions",
  imp: "impressions",
  impcnt: "impressions",
  노출수: "impressions",

  // clicks
  clicks: "clicks",
  clk: "clicks",
  clkcnt: "clicks",
  클릭수: "clicks",

  // cost
  cost: "cost",
  salesamt: "cost",
  비용: "cost",

  // avgRnk
  "average position": "avgRnk",
  avgrnk: "avgRnk",
  "recent avg rank": "avgRnk",
  평균노출순위: "avgRnk",
}

function normalizeHeader(raw: string): keyof AdDetailRow | null {
  const k = raw.trim().toLowerCase()
  return HEADER_ALIASES[k] ?? null
}

/**
 * device 문자열 정규화. "PC" | "MOBILE" 외 값은 null (호출부 행 skip).
 */
function normalizeDevice(raw: string): "PC" | "MOBILE" | null {
  const v = raw.trim().toUpperCase()
  if (v === "PC" || v === "P") return "PC"
  if (v === "MOBILE" || v === "M" || v === "MBL") return "MOBILE"
  return null
}

/** 빈 셀("", "-", "null") → undefined */
function normalizeCell(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const v = raw.trim()
  if (v === "" || v === "-" || v.toLowerCase() === "null") return undefined
  return v
}

// =============================================================================
// public API
// =============================================================================

export type CreateStatReportArgs = {
  reportTp: StatReportTp
  /** 보고서 대상 일자 (UTC 자정으로 변환되어 전송) */
  statDt: Date
}

/**
 * 비동기 보고서 생성 요청.
 *
 * @param customerId 광고주 customerId (X-Customer)
 * @param args       reportTp + statDt
 * @returns          { reportJobId, status, ... } — 직후 폴링 시작
 *
 * 사용 예 (전일 AD_DETAIL):
 *   const yest = new Date(); yest.setUTCDate(yest.getUTCDate() - 1)
 *   const job = await createStatReport(customerId, { reportTp: "AD_DETAIL", statDt: yest })
 */
export async function createStatReport(
  customerId: string,
  args: CreateStatReportArgs,
): Promise<StatReportJob> {
  if (!customerId) {
    throw new NaverSaValidationError("createStatReport: customerId is required")
  }

  const body = {
    reportTp: args.reportTp,
    statDt: toStatDtString(args.statDt),
  }

  const res = await naverSaClient.request({
    customerId,
    method: "POST",
    path: "/stat-reports",
    body,
  })

  const parsed = StatReportJobSchema.safeParse(res)
  if (!parsed.success) {
    throw new NaverSaValidationError("createStatReport: zod validation failed", {
      method: "POST",
      path: "/stat-reports",
      customerId,
      raw: res,
    })
  }
  return parsed.data
}

/**
 * 보고서 상태 폴링 (단일 호출).
 *
 * waitStatReportReady 가 내부적으로 사용 — 호출부에서도 직접 폴링 가능.
 */
export async function getStatReport(
  customerId: string,
  reportJobId: string,
): Promise<StatReportJob> {
  if (!customerId) {
    throw new NaverSaValidationError("getStatReport: customerId is required")
  }
  if (!reportJobId) {
    throw new NaverSaValidationError("getStatReport: reportJobId is required")
  }

  const path = `/stat-reports/${encodeURIComponent(reportJobId)}`
  const res = await naverSaClient.request({
    customerId,
    method: "GET",
    path,
  })

  const parsed = StatReportJobSchema.safeParse(res)
  if (!parsed.success) {
    throw new NaverSaValidationError("getStatReport: zod validation failed", {
      method: "GET",
      path,
      customerId,
      raw: res,
    })
  }
  return parsed.data
}

export type WaitStatReportOpts = {
  /** 폴링 시도 한도 (기본 30) */
  maxAttempts?: number
  /** 폴링 간격 ms (기본 5000ms = 5초) */
  intervalMs?: number
  /** 전체 timeout ms (기본 300000ms = 5분 — 네이버 보고서 빌드 일반적으로 1~3분) */
  timeoutMs?: number
}

/**
 * 보고서가 다운로드 가능 상태(BUILT/DONE) 될 때까지 폴링.
 *
 * 종료 조건:
 *   - status === "BUILT" 또는 "DONE" + downloadUrl 유효 → 즉시 반환
 *   - status === "FAILED" → NaverSaUnknownError throw
 *   - maxAttempts 또는 timeoutMs 초과 → NaverSaUnknownError throw
 *
 * 운영 영향:
 *   - timeoutMs 5분 default. 네이버 빌드가 더 오래 걸리는 경우 backend cron 이
 *     timeout 캐치 → ChangeBatch.status='failed' 처리 + 다음 cron 재시도.
 *   - intervalMs 5초 → 평균 빌드 시간(~1~3분) 대비 토큰 버킷 부담 적음
 *     (광고주당 폴링 ~12~36회).
 */
export async function waitStatReportReady(
  customerId: string,
  reportJobId: string,
  opts: WaitStatReportOpts = {},
): Promise<StatReportReady> {
  const maxAttempts = opts.maxAttempts ?? 30
  const intervalMs = opts.intervalMs ?? 5000
  const timeoutMs = opts.timeoutMs ?? 300000

  const startedAt = Date.now()

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new NaverSaUnknownError("StatReport timeout", {
        method: "GET",
        path: `/stat-reports/${reportJobId}`,
        customerId,
      })
    }

    const job = await getStatReport(customerId, reportJobId)

    if (job.status === "FAILED") {
      throw new NaverSaUnknownError("StatReport failed", {
        method: "GET",
        path: `/stat-reports/${reportJobId}`,
        customerId,
        raw: job,
      })
    }

    if (job.status === "BUILT" || job.status === "DONE") {
      const ready = StatReportReadySchema.safeParse(job)
      if (ready.success) {
        return ready.data
      }
      // BUILT/DONE 인데 downloadUrl 누락 — 다음 폴링에서 채워질 수 있어 계속.
      // (관찰 케이스: 일부 응답이 BUILT 직후 downloadUrl 늦게 채워짐)
    }

    await sleep(intervalMs)
  }

  throw new NaverSaUnknownError("StatReport polling exhausted", {
    method: "GET",
    path: `/stat-reports/${reportJobId}`,
    customerId,
  })
}

/**
 * downloadUrl 에서 TSV 본문 다운로드.
 *
 * 네이버 SA 의 downloadUrl 은 자기 도메인 `/report-download?reportJobId=...` 를 반환하며
 * HMAC + X-Customer 헤더가 필수. client.ts 경유로 호출해 서명·토큰 버킷·재시도를 통과시킨다.
 *
 * - URL origin 이 NAVER_SA_BASE_URL 과 다르면 NaverSaValidationError (예상 외 응답 방어)
 * - 토큰 버킷 / 5xx 재시도 / 캐시 비대상 (TSV 일별 1회)
 */
export async function downloadStatReport(
  customerId: string,
  downloadUrl: string,
): Promise<string> {
  if (!customerId) {
    throw new NaverSaValidationError("downloadStatReport: customerId is required")
  }
  if (!downloadUrl) {
    throw new NaverSaValidationError("downloadStatReport: downloadUrl is required")
  }

  let parsed: URL
  try {
    parsed = new URL(downloadUrl)
  } catch {
    throw new NaverSaValidationError("downloadStatReport: invalid downloadUrl")
  }

  const expectedOrigin = new URL(
    process.env.NAVER_SA_BASE_URL || "https://api.searchad.naver.com",
  ).origin
  if (parsed.origin !== expectedOrigin) {
    // SA spec 변경 (S3 pre-signed 등 외부 origin 회귀)을 즉시 감지
    throw new NaverSaUnknownError(
      `downloadStatReport: unexpected origin ${parsed.origin} (expected ${expectedOrigin})`,
      { method: "GET" },
    )
  }

  const pathWithQuery = `${parsed.pathname}${parsed.search}`
  const res = await naverSaClient.request<unknown>({
    customerId,
    method: "GET",
    path: pathWithQuery,
  })

  // client.request 는 JSON 파싱 실패 시 text 로 fallback (TSV 본문은 string).
  if (typeof res !== "string") {
    throw new NaverSaUnknownError("downloadStatReport: expected text body", {
      method: "GET",
      path: pathWithQuery,
      customerId,
    })
  }
  return res
}

/**
 * AD_DETAIL TSV 컬럼 spec — 헤더 없는 fixed-position 16 컬럼 (실측 기반, 2026-05-06).
 *
 * idx | 의미              | 비고
 * ----+-------------------+---------------------------------------------------
 *  0  | date (YYYYMMDD)   | 8자리 → YYYY-MM-DD 변환 후 zod
 *  1  | customerId
 *  2  | campaignId
 *  3  | adgroupId
 *  4  | keywordId         | "-" → null (passthrough — pickLevel 에서 fallback)
 *  5  | adId
 *  6  | businessChannelId | P1 미사용 — passthrough(null) 하여 zod 통과
 *  7  | media             | passthrough
 *  8  | period?           | passthrough (시간/권역 등)
 *  9  | mediaCode         | passthrough
 * 10  | device (P/M)      | normalizeDevice
 * 11  | impressions
 * 12  | clicks
 * 13  | cost
 * 14  | avgRnk            | 노출 0 행은 SA 가 0~null 반환 — null 처리
 * 15  | conversions       | P2 — passthrough
 */
const POSITIONAL_COLUMNS: Array<keyof AdDetailRow | null> = [
  "date",
  "customerId",
  "campaignId",
  "adgroupId",
  "keywordId",
  "adId",
  null,
  null,
  null,
  null,
  "device",
  "impressions",
  "clicks",
  "cost",
  "avgRnk",
  null,
]

/**
 * AD_DETAIL TSV → AdDetailRow[] 파싱.
 *
 * SA spec: 헤더 없는 fixed-position 16 컬럼 (POSITIONAL_COLUMNS).
 *
 * 정책:
 *   - 첫 줄 첫 셀이 8자리 숫자(YYYYMMDD)면 헤더 없는 raw TSV 로 판정 → fixed-position 매핑.
 *   - 그렇지 않으면 헤더 동적 매핑 (HEADER_ALIASES) — SA spec 변경 회귀 안전망.
 *   - 빈 입력 → []
 *   - 행별 검증 실패 (필수 필드 누락 / 타입 변환 실패) → console.error + 해당 행 skip.
 *   - 빈 셀 ("", "-", "null") → undefined.
 *   - YYYYMMDD → YYYY-MM-DD 변환 (positional 분기 한정).
 *
 * 견고성:
 *   - 컬럼 추가/이름 변경 → HEADER_ALIASES 갱신만으로 흡수 (헤더 모드)
 *   - 컬럼 순서 변경 → POSITIONAL_COLUMNS 갱신 (positional 모드)
 *   - device 미정 값 → normalizeDevice 가 null → 행 skip
 */
export async function parseAdDetailTsv(tsv: string): Promise<AdDetailRow[]> {
  if (!tsv || tsv.trim() === "") return []

  // CRLF / LF 모두 허용
  const lines = tsv.split(/\r?\n/).filter((l) => l.length > 0)
  if (lines.length === 0) return []

  // 헤더 자동 감지 — 첫 셀이 8자리 숫자(YYYYMMDD)면 헤더 없는 fixed-position TSV
  const firstCell = (lines[0].split("\t")[0] ?? "").trim()
  const headerless = /^\d{8}$/.test(firstCell)

  let headerKeys: Array<{ raw: string; key: keyof AdDetailRow | null }>
  let dataStartIdx: number
  if (headerless) {
    headerKeys = POSITIONAL_COLUMNS.map((key, i) => ({ raw: `col_${i}`, key }))
    dataStartIdx = 0
  } else {
    headerKeys = lines[0].split("\t").map((h) => ({ raw: h, key: normalizeHeader(h) }))
    dataStartIdx = 1
  }

  const rows: AdDetailRow[] = []

  for (let lineIdx = dataStartIdx; lineIdx < lines.length; lineIdx++) {
    const cells = lines[lineIdx].split("\t")
    const obj: Record<string, unknown> = {}

    for (let i = 0; i < headerKeys.length; i++) {
      const { raw, key } = headerKeys[i]
      const cell = normalizeCell(cells[i])

      if (key === null) {
        // unknown 헤더 — passthrough 보존 (raw 헤더명 그대로)
        if (cell !== undefined) obj[raw] = cell
        continue
      }

      if (cell === undefined) {
        // 정의된 키지만 빈 값 — undefined (optional 또는 nullable 처리)
        if (key === "avgRnk") obj[key] = null
        continue
      }

      // 타입 변환
      switch (key) {
        case "device": {
          const dev = normalizeDevice(cell)
          if (dev === null) {
            // device 미정 → 이 행 자체 skip 마크
            obj.__skip = `device unknown: ${cell}`
          } else {
            obj.device = dev
          }
          break
        }
        case "impressions":
        case "clicks": {
          const n = Number(cell)
          if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
            obj.__skip = `${key} invalid: ${cell}`
          } else {
            obj[key] = n
          }
          break
        }
        case "cost": {
          const n = Number(cell)
          if (!Number.isFinite(n) || n < 0) {
            obj.__skip = `cost invalid: ${cell}`
          } else {
            obj.cost = n
          }
          break
        }
        case "avgRnk": {
          const n = Number(cell)
          obj.avgRnk = Number.isFinite(n) ? n : null
          break
        }
        default: {
          // 문자열 필드 (date / customerId / campaignId / adgroupId / keywordId / adId)
          obj[key] = cell
        }
      }
    }

    if ("__skip" in obj) {
      console.error(
        `parseAdDetailTsv: line ${lineIdx + 1} skipped — ${String(obj.__skip)}`,
      )
      continue
    }

    // YYYYMMDD → YYYY-MM-DD (positional spec — SA raw TSV는 dash 없는 8자리)
    if (typeof obj.date === "string" && /^\d{8}$/.test(obj.date)) {
      obj.date = `${obj.date.slice(0, 4)}-${obj.date.slice(4, 6)}-${obj.date.slice(6, 8)}`
    }

    const parsed = AdDetailRowSchema.safeParse(obj)
    if (!parsed.success) {
      console.error(
        `parseAdDetailTsv: line ${lineIdx + 1} zod failed — ${parsed.error.message}`,
      )
      continue
    }
    rows.push(parsed.data)
  }

  return rows
}

/**
 * 보고서 정리 (best-effort).
 *
 * - 호출 실패는 throw 안 하고 console.warn (이미 처리 완료된 데이터라 정리 실패는 비치명)
 * - 운영: 일별 cron 마지막 단계에서 호출
 */
export async function deleteStatReport(
  customerId: string,
  reportJobId: string,
): Promise<void> {
  if (!customerId || !reportJobId) {
    console.warn("deleteStatReport: missing customerId or reportJobId — skipped")
    return
  }
  const path = `/stat-reports/${encodeURIComponent(reportJobId)}`
  try {
    await naverSaClient.request({
      customerId,
      method: "DELETE",
      path,
    })
  } catch (e) {
    // 시크릿 노출 금지 — 메시지만 로깅
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`deleteStatReport: best-effort cleanup failed — ${msg}`)
  }
}

// =============================================================================
// 테스트 전용 internal export
// =============================================================================
// 운영 코드에서는 import 금지. 단위 테스트(reports.test.ts)에서 헬퍼 회귀 가드 용도.
export const __test__ = {
  toStatDtString,
  normalizeHeader,
  normalizeDevice,
  normalizeCell,
}
