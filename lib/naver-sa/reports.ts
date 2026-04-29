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
 *   3. downloadStatReport(downloadUrl)
 *   4. parseAdDetailTsv(tsv)
 *   5. (적재 완료 후) deleteStatReport(customerId, reportJobId)
 *
 * 캐시: StatReport 는 일 1회 적재 → 결과 캐시 불필요. client.ts cache 옵션 미사용.
 *
 * Rate Limit:
 *   - POST/GET/DELETE /stat-reports*  → client.ts 토큰 버킷 자동 통과
 *   - downloadUrl 외부 S3 fetch       → 토큰 버킷 외부 (광고주별 동시성은 backend가 직렬화 책임)
 *
 * HMAC 서명 / X-Customer / 재시도(429,1016)는 `lib/naver-sa/client.ts`만 수행.
 * 본 모듈에서 fetch 또는 직접 서명 금지 (단, downloadStatReport 만 외부 S3 raw GET).
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
 * downloadUrl 은 외부 S3 공인 URL — HMAC 헤더 없이 단순 GET.
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
 * Date → ISO 자정 UTC 문자열 (네이버 statDt 형식).
 * 예: 2026-04-29 → "2026-04-29T00:00:00.000Z"
 */
function toStatDtString(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  const day = String(d.getUTCDate()).padStart(2, "0")
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

/**
 * downloadStatReport 용 외부 fetch 재시도 (지수 백오프).
 *
 * 사유: client.ts는 NAVER_SA_BASE_URL 기준 호출 + HMAC 강제라
 * S3 공인 URL 다운로드는 별도 raw fetch 필요. 단, 재시도/timeout 만 갖춤.
 */
async function fetchWithRetry(url: string, maxAttempts = 3): Promise<Response> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { method: "GET", cache: "no-store" })
      if (res.ok) return res
      // 4xx 는 재시도 의미 없음 (S3 만료 등) — 즉시 throw
      if (res.status >= 400 && res.status < 500) {
        throw new NaverSaUnknownError(`download failed: HTTP ${res.status}`, {
          status: res.status,
          method: "GET",
        })
      }
      lastErr = new NaverSaUnknownError(`download failed: HTTP ${res.status}`, {
        status: res.status,
        method: "GET",
      })
    } catch (e) {
      if (e instanceof NaverSaUnknownError) {
        // 4xx 는 위에서 throw 했으므로 그대로 전파
        throw e
      }
      lastErr = e
    }
    await sleep(250 * Math.pow(2, attempt) + Math.floor(Math.random() * 100))
  }
  if (lastErr instanceof Error) {
    throw new NaverSaUnknownError(`download failed: ${lastErr.message}`, { method: "GET" })
  }
  throw new NaverSaUnknownError("download failed: unknown", { method: "GET" })
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
 * 외부 S3 downloadUrl 에서 TSV 본문 다운로드.
 *
 * - HMAC / X-Customer 헤더 X (S3 공인 URL — pre-signed)
 * - 5xx / 네트워크 오류는 3회 재시도 (지수 백오프)
 * - 4xx (URL 만료 등) 는 즉시 throw
 * - 응답 size 제한 미설정 (광고주 1일치 일반적으로 수 MB 이내)
 */
export async function downloadStatReport(downloadUrl: string): Promise<string> {
  if (!downloadUrl) {
    throw new NaverSaValidationError("downloadStatReport: downloadUrl is required")
  }
  const res = await fetchWithRetry(downloadUrl, 3)
  return res.text()
}

/**
 * AD_DETAIL TSV → AdDetailRow[] 파싱.
 *
 * 정책:
 *   - 첫 줄(헤더)로 컬럼 인덱스 동적 매핑 (HEADER_ALIASES). 알 수 없는 헤더는
 *     row[원본_헤더명] = 원본_값 형태로 passthrough 보존.
 *   - 빈 입력 → []
 *   - 행별 검증 실패 (필수 필드 누락 / 타입 변환 실패) → console.error + 해당 행 skip
 *     (전체 fail X — operational resilience).
 *   - 빈 셀 ("", "-", "null") → undefined.
 *
 * 견고성:
 *   - 컬럼 추가/이름 변경 → HEADER_ALIASES 갱신만으로 흡수
 *   - 컬럼 순서 변경 → 헤더 인덱스 재매핑으로 자동 흡수
 *   - device 미정 값 → normalizeDevice 가 null → 행 skip
 */
export async function parseAdDetailTsv(tsv: string): Promise<AdDetailRow[]> {
  if (!tsv || tsv.trim() === "") return []

  // CRLF / LF 모두 허용
  const lines = tsv.split(/\r?\n/).filter((l) => l.length > 0)
  if (lines.length === 0) return []

  // 헤더 추출
  const headerCells = lines[0].split("\t")
  const headerKeys: Array<{ raw: string; key: keyof AdDetailRow | null }> = headerCells.map(
    (h) => ({ raw: h, key: normalizeHeader(h) }),
  )

  const rows: AdDetailRow[] = []

  for (let lineIdx = 1; lineIdx < lines.length; lineIdx++) {
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
