"use server"

/**
 * F-D.3 검색어 보고서 CSV 업로드 — Server Actions.
 *
 * 책임:
 *   1. analyzeSearchTermCsv(advertiserId, csvText)
 *      - 권한 검증 + 광고주 화이트리스트
 *      - parseSearchTermCsv → 합산 → classifySearchTerms (KPP baseline 기반)
 *      - 결과만 반환 (DB 적재 X — 본 PR 단순화)
 *   2. saveSearchTermReport(advertiserId, weekStart, rows, classifications)
 *      - SearchTermReport 1행 적재 (rows JSON 에 분류 결과 포함)
 *      - (advertiserId, weekStart) UNIQUE — 동일 주차 재처리 시 upsert
 *
 * 운영 정책 (CLAUDE.md / 안전장치):
 *   - 자동 SA write 절대 X (검색어 신규 등록 / 제외키워드 등록은 본 PR 비대상 — 후속)
 *   - viewer 도 analyze 가능 (read 성격), saveSearchTermReport 는 operator+ 필수
 *   - AuditLog: search_term_report.save 만 (analyze 는 read-only 라 미기록)
 *
 * SPEC v0.2.1 F-D.3 + plan(graceful-sparking-graham) Phase D.3
 */

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { prisma } from "@/lib/db/prisma"
import { getCurrentAdvertiser } from "@/lib/auth/access"
import { logAudit } from "@/lib/audit/log"
import {
  parseSearchTermCsv,
  csvTextSchema,
  type ParseSearchTermCsvResult,
} from "@/lib/search-term-mining/parse-csv"
import {
  classifySearchTerms,
  type ClassificationResult,
  type AdvertiserBaselineForMining,
  type SearchTermRow,
} from "@/lib/search-term-mining/classify"

// =============================================================================
// 공통 타입
// =============================================================================

export type ActionResult<T = void> =
  | ({ ok: true } & (T extends void ? Record<never, never> : { data: T }))
  | { ok: false; error: string }

/** UI 가 받는 분석 결과. */
export type AnalyzeSearchTermCsvResult = {
  /** 합산된 검색어 행 수 (= 분류 입력 모집단). */
  searchTermCount: number
  /** 원본 CSV 행 수 (헤더 제외). */
  rawRowCount: number
  /** 빈 검색어 / 빈 셀 등으로 skip 된 원본 행 수. */
  skipped: number
  /** 매핑 성공한 표준 키 (UI 진단). */
  mappedKeys: string[]
  /** 매핑 실패 헤더 (UI 진단). */
  unmappedHeaders: string[]
  /** baseline 사용 가능 여부 — false 면 high_cpa_no_conversions 분기 비활성. */
  baselineAvailable: boolean
  /** 광고주 baseline (있을 때만). UI 표시용. */
  baseline: {
    avgCpc: number | null
    avgCtr: number | null
    avgCvr: number | null
    dataDays: number
  } | null
  /**
   * 분류 결과 (neutral 제외 — classifySearchTerms 가 내부에서 필터).
   * UI 가 new / exclude 탭으로 분할 표시.
   */
  classifications: ClassificationItem[]
  /** 합산된 SearchTermRow — saveSearchTermReport 호출 시 그대로 전달. */
  rows: SearchTermRow[]
}

/** UI 직렬화 친화 — Decimal 타입 없이 number / string 만. */
export type ClassificationItem = {
  searchTerm: string
  adgroupId: string
  classification: "new" | "exclude"
  reasonCode: ClassificationResult["reasonCode"]
  metrics: {
    impressions: number
    clicks: number
    cost: number
    conversions: number | null
    ctr: number | null
    cpc: number | null
    cpa: number | null
  }
}

// =============================================================================
// Zod
// =============================================================================

const advertiserIdSchema = z.string().trim().min(1).max(128)

// =============================================================================
// 1. analyzeSearchTermCsv
// =============================================================================

/**
 * CSV 파싱 + 합산 + 분류. DB 적재 없음.
 *
 * 흐름:
 *   1. advertiserId / csvText Zod 검증
 *   2. 권한 검증 (viewer 포함 read 가능)
 *   3. KPP baseline 조회 (없으면 baselineAvailable=false → classify 가 일부 분기 비활성)
 *   4. parseSearchTermCsv → 헤더 매핑 + 합산
 *   5. classifySearchTerms → new/exclude 분류 (neutral 제외)
 *   6. ClassificationItem[] + rows 반환
 *
 * 에러:
 *   - parseSearchTermCsv 의 fileError 는 ok:false 로 매핑
 *   - csv 길이 50MB 초과 → ok:false (csvTextSchema)
 */
export async function analyzeSearchTermCsv(
  advertiserId: string,
  csvText: string,
): Promise<ActionResult<AnalyzeSearchTermCsvResult>> {
  // -- 입력 검증 ------------------------------------------------------------
  try {
    advertiserIdSchema.parse(advertiserId)
    csvTextSchema.parse(csvText)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `잘못된 입력: ${msg}` }
  }

  // -- 권한 + 광고주 컨텍스트 -----------------------------------------------
  await getCurrentAdvertiser(advertiserId)

  // -- KPP baseline ---------------------------------------------------------
  const kpp = await prisma.keywordPerformanceProfile.findUnique({
    where: { advertiserId },
    select: {
      avgCtr: true,
      avgCvr: true,
      avgCpc: true,
      dataDays: true,
    },
  })

  const baseline: AdvertiserBaselineForMining = kpp
    ? {
        avgCtr: kpp.avgCtr,
        avgCvr: kpp.avgCvr,
        avgCpc: kpp.avgCpc,
      }
    : { avgCtr: null, avgCvr: null, avgCpc: null }

  // -- CSV 파싱 + 합산 -------------------------------------------------------
  let parsed: ParseSearchTermCsvResult
  try {
    parsed = parseSearchTermCsv(csvText)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `CSV 파싱 오류: ${msg}` }
  }

  if (parsed.fileError) {
    return { ok: false, error: parsed.fileError }
  }

  // -- 분류 ------------------------------------------------------------------
  const results = classifySearchTerms(parsed.rows, baseline)

  // neutral 은 이미 classifySearchTerms 에서 제외됨 — 잔여 보강 (타입 좁히기)
  const classifications: ClassificationItem[] = results
    .filter((r) => r.classification !== "neutral")
    .map((r) => ({
      searchTerm: r.searchTerm,
      adgroupId: r.adgroupId,
      classification: r.classification as "new" | "exclude",
      reasonCode: r.reasonCode,
      metrics: r.metrics,
    }))

  const baselineAvailable = kpp !== null && kpp.avgCpc !== null

  return {
    ok: true,
    data: {
      searchTermCount: parsed.rows.length,
      rawRowCount: parsed.rawRowCount,
      skipped: parsed.skipped,
      mappedKeys: parsed.mappedKeys,
      unmappedHeaders: parsed.unmappedHeaders,
      baselineAvailable,
      baseline: kpp
        ? {
            avgCpc: kpp.avgCpc !== null ? Number(kpp.avgCpc) : null,
            avgCtr: kpp.avgCtr !== null ? Number(kpp.avgCtr) : null,
            avgCvr: kpp.avgCvr !== null ? Number(kpp.avgCvr) : null,
            dataDays: kpp.dataDays,
          }
        : null,
      classifications,
      rows: parsed.rows,
    },
  }
}

// =============================================================================
// 2. saveSearchTermReport
// =============================================================================

const saveInputSchema = z.object({
  /**
   * KST 기준 주의 월요일 00:00 — UI 가 "yyyy-mm-dd" 로 전달 (Date 직렬화 회피).
   * Prisma 적재 시 new Date(weekStart + "T00:00:00.000Z") 로 UTC 자정.
   * (콘솔 보고서 다운로드 주차의 정확한 timezone 은 운영 정책으로 후속 PR 재정의)
   */
  weekStart: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u, "yyyy-mm-dd 형식이어야 합니다"),
  rows: z
    .array(
      z.object({
        searchTerm: z.string().min(1).max(500),
        adgroupId: z.string().max(128),
        impressions: z.number().int().min(0),
        clicks: z.number().int().min(0),
        cost: z.number().min(0),
        conversions: z.number().min(0).nullable(),
      }),
    )
    .max(100_000),
  classifications: z
    .array(
      z.object({
        searchTerm: z.string(),
        adgroupId: z.string(),
        classification: z.enum(["new", "exclude"]),
        reasonCode: z.string(),
        metrics: z.object({
          impressions: z.number(),
          clicks: z.number(),
          cost: z.number(),
          conversions: z.number().nullable(),
          ctr: z.number().nullable(),
          cpc: z.number().nullable(),
          cpa: z.number().nullable(),
        }),
      }),
    )
    .max(100_000),
})

export type SaveSearchTermReportInput = z.infer<typeof saveInputSchema>

export type SaveSearchTermReportResult = {
  reportId: string
  weekStart: string
  rowCount: number
  classificationCount: number
  /** 동일 주차 기존 보고서 덮어쓰기 여부 (upsert update path). */
  upserted: boolean
}

/**
 * SearchTermReport 1행 적재 (advertiserId × weekStart UNIQUE — upsert).
 *
 *   - 권한: operator+ (저장은 mutation 성격)
 *   - rows JSON shape (passthrough):
 *       [{ searchTerm, adgroupId, impCnt, clkCnt, salesAmt, classification?, reasonCode? }]
 *     본 PR 은 단순화 — 합산 행 + 분류 결과 둘 다 동일 JSON 에 저장.
 *   - processed=false 로 적재 (후속 PR 의 ApprovalQueue 적재 cron 픽업 대상).
 *     ApprovalQueue 적재는 Phase D.4 — 본 PR 비대상.
 *
 * AuditLog:
 *   - action: search_term_report.save
 *   - after: { weekStart, rowCount, classificationCount, upserted }
 *
 * revalidatePath: /[advertiserId]/search-term-import
 */
export async function saveSearchTermReport(
  advertiserId: string,
  input: SaveSearchTermReportInput,
): Promise<ActionResult<SaveSearchTermReportResult>> {
  // -- 입력 검증 ------------------------------------------------------------
  let parsed: SaveSearchTermReportInput
  try {
    advertiserIdSchema.parse(advertiserId)
    parsed = saveInputSchema.parse(input)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `잘못된 입력: ${msg}` }
  }

  // -- 권한 ----------------------------------------------------------------
  const { user } = await getCurrentAdvertiser(advertiserId)
  if (user.role === "viewer") {
    return { ok: false, error: "권한 부족 (viewer)" }
  }

  // -- weekStart 정규화 ----------------------------------------------------
  // yyyy-mm-dd → UTC 자정 Date (Prisma @db.Date 컬럼은 timezone 무시 — 안전한 표현)
  const weekStartDate = new Date(`${parsed.weekStart}T00:00:00.000Z`)
  if (Number.isNaN(weekStartDate.getTime())) {
    return { ok: false, error: "weekStart 가 올바른 날짜가 아닙니다" }
  }

  // -- rows JSON shape (passthrough — 분류 결과를 행 옆에 붙임) -------------
  // 동일 검색어 1행 — analyze 가 합산 후 보낸 그대로 + classification map 머지
  const classBy = new Map(
    parsed.classifications.map((c) => [c.searchTerm, c]),
  )
  const merged = parsed.rows.map((r) => {
    const c = classBy.get(r.searchTerm)
    return {
      searchTerm: r.searchTerm,
      adgroupId: r.adgroupId,
      impCnt: r.impressions,
      clkCnt: r.clicks,
      salesAmt: r.cost,
      ccnt: r.conversions,
      classification: c?.classification ?? null,
      reasonCode: c?.reasonCode ?? null,
      metrics: c?.metrics ?? null,
    }
  })

  // -- upsert ---------------------------------------------------------------
  const existing = await prisma.searchTermReport.findUnique({
    where: {
      advertiserId_weekStart: {
        advertiserId,
        weekStart: weekStartDate,
      },
    },
    select: { id: true },
  })

  const report = await prisma.searchTermReport.upsert({
    where: {
      advertiserId_weekStart: {
        advertiserId,
        weekStart: weekStartDate,
      },
    },
    update: {
      rows: merged,
      processed: false,
    },
    create: {
      advertiserId,
      weekStart: weekStartDate,
      rows: merged,
      processed: false,
    },
    select: { id: true },
  })

  // -- AuditLog -------------------------------------------------------------
  await logAudit({
    userId: user.id,
    action: "search_term_report.save",
    targetType: "SearchTermReport",
    targetId: report.id,
    before: null,
    after: {
      advertiserId,
      weekStart: parsed.weekStart,
      rowCount: parsed.rows.length,
      classificationCount: parsed.classifications.length,
      upserted: existing !== null,
    },
  })

  revalidatePath(`/${advertiserId}/search-term-import`)

  return {
    ok: true,
    data: {
      reportId: report.id,
      weekStart: parsed.weekStart,
      rowCount: parsed.rows.length,
      classificationCount: parsed.classifications.length,
      upserted: existing !== null,
    },
  }
}
