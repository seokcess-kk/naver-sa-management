/**
 * 광고주 일괄 등록 (F-1.2) — CSV 파싱·검증 모듈
 *
 * 정책:
 *   - 시크릿(apiKey / secretKey) 컬럼은 **CSV에 정의 X** (보안 핵심).
 *     CSV는 메타정보만 받고, 시크릿은 광고주 상세 화면에서 별도 입력.
 *   - PapaParse + Zod 4. 헤더 1행 필수, 컬럼 순서 무관, UTF-8 (BOM 허용).
 *   - 빈 행은 skip. 검증 실패 행은 ok:false 로 분리.
 *   - 같은 customerId N회 → "마지막 행만 적용" (앞선 행은 ok로 두되 duplicates 에 표시).
 *
 * 사용:
 *   const { rows, duplicates } = await parseAdvertiserCsv(file)
 *   const valid = rows.filter((r): r is Extract<ParsedAdvertiserRow, { ok: true }> => r.ok)
 *   const invalid = rows.filter((r): r is Extract<ParsedAdvertiserRow, { ok: false }> => !r.ok)
 */

import Papa from "papaparse"
import { z } from "zod"

// =============================================================================
// 타입
// =============================================================================

/**
 * registerAdvertisersBulk 의 입력 행 타입과 일치시킴.
 * (backend Server Action 시그니처 — actions.ts BulkAdvertiserInput)
 */
export type BulkAdvertiserInput = {
  name: string
  customerId: string
  bizNo?: string
  category?: string
  manager?: string
  memo?: string
  tags?: string[]
}

export type ParsedAdvertiserRow =
  | { ok: true; row: number; data: BulkAdvertiserInput }
  | { ok: false; row: number; raw: Record<string, string>; error: string }

export type CsvParseResult = {
  rows: ParsedAdvertiserRow[]
  /** 같은 customerId 가 CSV 안에서 N회 등장 → 마지막 행만 실제 등록 대상이 됨 */
  duplicates: Array<{ customerId: string; rowNumbers: number[] }>
  /** 헤더 누락 / 빈 파일 등 파일 수준 오류 */
  fileError?: string
}

// =============================================================================
// Zod schema (단건)
//   - backend Zod (actions.ts) 와 호환되는 범위에서 정의.
//   - apiKey / secretKey 는 정의 X (CSV 컬럼 미존재).
// =============================================================================

const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === undefined || v.length === 0 ? undefined : v))

export const advertiserCsvSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "표시명은 필수입니다")
    .max(100, "표시명은 최대 100자입니다"),
  customerId: z
    .string()
    .trim()
    .regex(/^\d+$/u, "customerId는 숫자만 입력 가능합니다")
    .min(4, "customerId는 최소 4자입니다")
    .max(20, "customerId는 최대 20자입니다"),
  bizNo: optionalTrimmed(20),
  category: optionalTrimmed(50),
  manager: optionalTrimmed(50),
  memo: z
    .string()
    .max(500, "메모는 최대 500자입니다")
    .optional()
    .or(z.literal("").transform(() => undefined))
    .transform((v) => {
      if (v === undefined) return undefined
      const trimmed = v.trim()
      return trimmed.length === 0 ? undefined : trimmed
    }),
  // CSV 의 tags 셀: "신규,VIP" 또는 "신규;VIP" → 배열
  tags: z
    .string()
    .max(200, "태그 셀은 최대 200자입니다")
    .optional()
    .transform((v) => {
      if (!v) return undefined
      const arr = v
        .split(/[,;]/u)
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
      return arr.length > 0 ? arr : undefined
    }),
})

export type AdvertiserCsvRow = z.infer<typeof advertiserCsvSchema>

// =============================================================================
// 알려진 컬럼 + 시크릿 컬럼 차단 목록
// =============================================================================

export const ADVERTISER_CSV_HEADERS = [
  "name",
  "customerId",
  "bizNo",
  "category",
  "manager",
  "memo",
  "tags",
] as const

/**
 * 보안: CSV에 절대 포함하면 안 되는 컬럼명 (case-insensitive 정규식).
 * 발견 시 파일 단위 거부. 의도: 사용자가 시크릿이 포함된 CSV를 만든 경우
 * 어떤 케이싱·구분자(`-`/`_`/공백) 변형이라도 즉시 경고.
 */
const FORBIDDEN_HEADER_PATTERNS: ReadonlyArray<RegExp> = [
  /^api[\s_-]?key$/i,
  /^secret([\s_-]?key)?$/i,
  /^password$/i,
  /^token$/i,
  /^access[\s_-]?key$/i,
]

// =============================================================================
// 파일 읽기 (UTF-8 BOM 자동 제거)
// =============================================================================

async function readFileAsUtf8(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const decoder = new TextDecoder("utf-8")
  let text = decoder.decode(buf)
  // BOM 제거
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1)
  }
  return text
}

// =============================================================================
// 메인 파서
// =============================================================================

export async function parseAdvertiserCsv(
  file: File,
): Promise<CsvParseResult> {
  // 1) 파일 읽기 (BOM 제거)
  const text = await readFileAsUtf8(file)
  if (!text.trim()) {
    return { rows: [], duplicates: [], fileError: "빈 파일입니다" }
  }

  // 2) PapaParse — header:true, skipEmptyLines, dynamicTyping:false (모두 string)
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    dynamicTyping: false,
    transformHeader: (h) => h.trim(),
  })

  const headers = (parsed.meta.fields ?? []).map((h) => h.trim())
  if (headers.length === 0) {
    return {
      rows: [],
      duplicates: [],
      fileError: "헤더 행이 없습니다. 1행 헤더 필수입니다.",
    }
  }

  // 3) 시크릿 컬럼 차단 (보안 — case-insensitive 패턴)
  const forbiddenHit = headers.filter((h) =>
    FORBIDDEN_HEADER_PATTERNS.some((re) => re.test(h.trim())),
  )
  if (forbiddenHit.length > 0) {
    return {
      rows: [],
      duplicates: [],
      fileError: `보안: 시크릿 컬럼은 CSV에 포함할 수 없습니다 (${forbiddenHit.join(", ")}). 시크릿은 광고주 상세 화면에서 입력하세요.`,
    }
  }

  // 4) 필수 헤더 (name, customerId) 누락 확인
  const missingRequired = (["name", "customerId"] as const).filter(
    (h) => !headers.includes(h),
  )
  if (missingRequired.length > 0) {
    return {
      rows: [],
      duplicates: [],
      fileError: `필수 헤더 누락: ${missingRequired.join(", ")}`,
    }
  }

  // 5) 각 행 검증
  const out: ParsedAdvertiserRow[] = []
  const data = parsed.data ?? []

  data.forEach((raw, idx) => {
    // CSV row 번호: 헤더가 1행 → 데이터 첫 행은 2행
    const rowNumber = idx + 2

    // skipEmptyLines:"greedy" 가 모두 빈 셀 행은 걸러주지만,
    // PapaParse 가 ""만 들어있는 행을 남길 수 있어 한번 더 가드.
    const allEmpty = Object.values(raw).every(
      (v) => v === undefined || v === null || String(v).trim() === "",
    )
    if (allEmpty) return

    const result = advertiserCsvSchema.safeParse({
      name: raw.name ?? "",
      customerId: raw.customerId ?? "",
      bizNo: raw.bizNo ?? "",
      category: raw.category ?? "",
      manager: raw.manager ?? "",
      memo: raw.memo ?? "",
      tags: raw.tags ?? "",
    })

    if (!result.success) {
      const first = result.error.issues[0]
      const path = first?.path.join(".") ?? ""
      const msg = first?.message ?? "검증 실패"
      out.push({
        ok: false,
        row: rowNumber,
        raw,
        error: path ? `${path}: ${msg}` : msg,
      })
      return
    }

    const v = result.data
    const data: BulkAdvertiserInput = {
      name: v.name,
      customerId: v.customerId,
    }
    if (v.bizNo) data.bizNo = v.bizNo
    if (v.category) data.category = v.category
    if (v.manager) data.manager = v.manager
    if (v.memo) data.memo = v.memo
    if (v.tags && v.tags.length > 0) data.tags = v.tags

    out.push({ ok: true, row: rowNumber, data })
  })

  // 6) 중복 customerId 검출 (앞선 행은 ok 로 둠. 마지막만 실제 적용 — 호출측이 결정)
  const byId = new Map<string, number[]>()
  for (const r of out) {
    if (!r.ok) continue
    const id = r.data.customerId
    const arr = byId.get(id) ?? []
    arr.push(r.row)
    byId.set(id, arr)
  }
  const duplicates: CsvParseResult["duplicates"] = []
  for (const [customerId, rowNumbers] of byId) {
    if (rowNumbers.length > 1) {
      duplicates.push({ customerId, rowNumbers })
    }
  }

  return { rows: out, duplicates }
}

// =============================================================================
// 템플릿 다운로드용 헤더 문자열
// =============================================================================

/**
 * "CSV 템플릿 다운로드" 버튼이 사용하는 빈 CSV 본문.
 *   - UTF-8 BOM(\ufeff) 포함 → Excel 한글 깨짐 방지
 *   - 1행 헤더만 작성
 */
export const ADVERTISER_CSV_TEMPLATE =
  "\ufeff" + ADVERTISER_CSV_HEADERS.join(",") + "\n"

/**
 * 진단/테스트용: 정상 행만 추출 (마지막 customerId 만 남김).
 *   호출측 (UI) 가 미리보기에서 같은 로직을 사용해도 되고,
 *   확정 시 backend 에 보낼 행 추출 헬퍼로도 사용.
 */
export function extractFinalRows(
  parsed: CsvParseResult,
): BulkAdvertiserInput[] {
  // 마지막 등장만 채택. customerId → 행 객체 (마지막 win)
  const lastByCustomerId = new Map<string, BulkAdvertiserInput>()
  for (const r of parsed.rows) {
    if (!r.ok) continue
    lastByCustomerId.set(r.data.customerId, r.data)
  }
  return Array.from(lastByCustomerId.values())
}
