"use server"

/**
 * F-7.1 KPI + F-7.4 TOP — Server Actions
 *
 * 책임 (SPEC 6.7 F-7.1 / F-7.4):
 *   1. getDashboardKpi   — 오늘/어제/7일/30일 4개 기간 × {imp, clk, salesAmt} 합계
 *   2. getTopCampaigns   — 캠페인 TOP/BOTTOM (지표/기간/limit 옵션)
 *   3. getTopKeywords    — 키워드 TOP/BOTTOM (지표/기간/limit 옵션)
 *
 * 운영 정책 (CLAUDE.md / backend-engineer.md):
 *   - 진입부 getCurrentAdvertiser(advertiserId) — 권한 / 광고주 횡단 차단
 *   - 모든 prisma 조회는 advertiserId 한정 (캠페인/키워드 집합 정의)
 *   - 외부 SA Stats 호출은 lib/naver-sa/stats.ts getStats() 만 통과 (fetch 직접 X)
 *   - 캐시는 stats.ts 가 자동 처리 (오늘 5분 / 과거 1시간) — 본 액션은 캐시 무지
 *   - hasKeys=false → 즉시 ok:false (외부 호출 차단)
 *   - 변경 X (조회만) → ChangeBatch / AuditLog 기록 안 함 (조회 노이즈 방지)
 *   - 시크릿 마스킹: Stats 응답에 키 없음 — OK
 *
 * 비대상:
 *   - F-7.2 트렌드 차트 (시계열) — 후속 PR
 *   - F-7.3 알림 피드 — F-8.x AlertEvent 모델 의존
 *
 * 데이터 소스 정책 (CLAUDE.md):
 *   - P1: Stats API 동기 호출 + Redis 캐시. 자체 적재 테이블 X.
 *   - 평균 노출 순위(recentAvgRnk) Stats 응답에 있을 때만 노출 (P1 읽기 전용).
 */

import { z } from "zod"

import { prisma } from "@/lib/db/prisma"
import { getCurrentAdvertiser } from "@/lib/auth/access"
import {
  getStats,
  type StatsField,
  type StatsRow,
} from "@/lib/naver-sa/stats"
import { NaverSaError } from "@/lib/naver-sa/errors"

// =============================================================================
// 공통 타입
// =============================================================================

/** F-7.1 KPI 4개 기간. */
export type KpiPeriod = "today" | "yesterday" | "recent7d" | "recent30d"

/**
 * 단일 기간 KPI 요약.
 *
 * - impCnt / clkCnt / salesAmt: 합계 (광고주 전체)
 * - ctr / cpc: 응답에 있으면 그대로, 없으면 합계로 계산
 * - recentAvgRnk: 응답 row 에 있을 때만 (없으면 null)
 *
 * salesAmt 의 의미는 "비용(원)" 임에 주의 (네이버 SA 명명 컨벤션 — stats.ts 주석 참조).
 */
export type KpiSummary = {
  impCnt: number
  clkCnt: number
  salesAmt: number
  ctr: number
  cpc: number
  recentAvgRnk?: number | null
}

export type DashboardKpi = Record<KpiPeriod, KpiSummary>

/** F-7.4 TOP 정렬용 지표. */
export type TopMetric = "impCnt" | "clkCnt" | "salesAmt" | "ctr" | "cpc"

const TOP_INPUT_LIMIT_DEFAULT = 5
const TOP_INPUT_LIMIT_MAX = 20
/** 키워드 매핑 안전 상한 (성능 / 메모리 보호). */
const TOP_KEYWORDS_DB_HARD_LIMIT = 1000

const topInputSchema = z.object({
  metric: z.enum(["impCnt", "clkCnt", "salesAmt", "ctr", "cpc"]),
  limit: z
    .number()
    .int()
    .min(1)
    .max(TOP_INPUT_LIMIT_MAX)
    .optional()
    .default(TOP_INPUT_LIMIT_DEFAULT),
  period: z.enum(["recent7d", "recent30d"]).optional().default("recent7d"),
  order: z.enum(["desc", "asc"]).optional().default("desc"),
})

export type TopCampaignsInput = z.input<typeof topInputSchema>
export type TopKeywordsInput = z.input<typeof topInputSchema>

export type TopCampaignRow = {
  campaignId: string // 앱 DB Campaign.id
  nccCampaignId: string
  name: string
  impCnt: number
  clkCnt: number
  salesAmt: number
  ctr: number
  cpc: number
}

export type TopKeywordRow = {
  keywordId: string
  nccKeywordId: string
  keyword: string
  matchType: string | null
  adgroupName: string
  campaignName: string
  impCnt: number
  clkCnt: number
  salesAmt: number
  ctr: number
  cpc: number
}

// =============================================================================
// 내부 헬퍼
// =============================================================================

/** Stats fields 기본 셋 (KPI / TOP 공통). */
const DEFAULT_STATS_FIELDS: StatsField[] = [
  "impCnt",
  "clkCnt",
  "salesAmt",
  "ctr",
  "cpc",
]

/** undefined / null / NaN 안전 변환. */
function num(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0
  return v
}

/** Stats row 1개 → KpiSummary (ctr/cpc 누락 시 합계로 보정). */
function rowToSummary(row: StatsRow | undefined): KpiSummary {
  if (!row) {
    return { impCnt: 0, clkCnt: 0, salesAmt: 0, ctr: 0, cpc: 0 }
  }
  const impCnt = num(row.impCnt)
  const clkCnt = num(row.clkCnt)
  const salesAmt = num(row.salesAmt)

  const ctr =
    typeof row.ctr === "number" && Number.isFinite(row.ctr)
      ? row.ctr
      : impCnt > 0
        ? (clkCnt / impCnt) * 100
        : 0
  const cpc =
    typeof row.cpc === "number" && Number.isFinite(row.cpc)
      ? row.cpc
      : clkCnt > 0
        ? salesAmt / clkCnt
        : 0

  // recentAvgRnk 는 stats 응답에 있을 때만 (passthrough 통과 필드).
  const rnk = (row as Record<string, unknown>).recentAvgRnk
  const recentAvgRnk =
    typeof rnk === "number" && Number.isFinite(rnk) ? rnk : null

  return { impCnt, clkCnt, salesAmt, ctr, cpc, recentAvgRnk }
}

/**
 * 여러 row 합산 → KpiSummary.
 *
 * ids 미지정 호출이라도 응답이 배열로 다중 row 일 가능성 대비.
 * ctr / cpc 는 합산 후 재계산 (단순 평균은 부정확).
 */
function aggregateRows(rows: StatsRow[]): KpiSummary {
  if (rows.length === 0) {
    return { impCnt: 0, clkCnt: 0, salesAmt: 0, ctr: 0, cpc: 0 }
  }
  if (rows.length === 1) {
    return rowToSummary(rows[0])
  }

  let impCnt = 0
  let clkCnt = 0
  let salesAmt = 0
  let rnkSum = 0
  let rnkCount = 0

  for (const r of rows) {
    impCnt += num(r.impCnt)
    clkCnt += num(r.clkCnt)
    salesAmt += num(r.salesAmt)
    const rnk = (r as Record<string, unknown>).recentAvgRnk
    if (typeof rnk === "number" && Number.isFinite(rnk)) {
      rnkSum += rnk
      rnkCount++
    }
  }

  const ctr = impCnt > 0 ? (clkCnt / impCnt) * 100 : 0
  const cpc = clkCnt > 0 ? salesAmt / clkCnt : 0
  const recentAvgRnk = rnkCount > 0 ? rnkSum / rnkCount : null

  return { impCnt, clkCnt, salesAmt, ctr, cpc, recentAvgRnk }
}

/**
 * Stats row 1개 → 정렬 가능한 메트릭 묶음 (TOP 표시용).
 *
 * 응답에 ctr/cpc 가 있으면 그대로, 없으면 합계로 보정 (KPI 와 동일 정책).
 */
function rowToMetrics(row: StatsRow): {
  impCnt: number
  clkCnt: number
  salesAmt: number
  ctr: number
  cpc: number
} {
  const impCnt = num(row.impCnt)
  const clkCnt = num(row.clkCnt)
  const salesAmt = num(row.salesAmt)
  const ctr =
    typeof row.ctr === "number" && Number.isFinite(row.ctr)
      ? row.ctr
      : impCnt > 0
        ? (clkCnt / impCnt) * 100
        : 0
  const cpc =
    typeof row.cpc === "number" && Number.isFinite(row.cpc)
      ? row.cpc
      : clkCnt > 0
        ? salesAmt / clkCnt
        : 0
  return { impCnt, clkCnt, salesAmt, ctr, cpc }
}

/**
 * 외부 호출 에러를 통일된 ok:false 메시지로 변환.
 *
 * NaverSaError 는 message 노출 (사용자 안내), 그 외는 일반 메시지.
 */
function errorMessage(e: unknown, prefix: string): string {
  if (e instanceof NaverSaError) return `${prefix}: ${e.message}`
  return `${prefix} 중 알 수 없는 오류`
}

// =============================================================================
// 1. getDashboardKpi (F-7.1)
// =============================================================================

export async function getDashboardKpi(
  advertiserId: string,
): Promise<{ ok: true; kpi: DashboardKpi } | { ok: false; error: string }> {
  const { advertiser } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    return { ok: false, error: "API 키/시크릿 미입력" }
  }

  const periods: KpiPeriod[] = ["today", "yesterday", "recent7d", "recent30d"]

  try {
    // 4개 기간 병렬 조회 — stats.ts 가 자체 캐시 (오늘 5분 / 과거 1시간) 처리.
    // ids 미지정 → 광고주 전체 합산 row (네이버 SA 응답은 보통 1 row, 다중 가능성 방어).
    const responses = await Promise.all(
      periods.map((p) =>
        getStats(advertiser.customerId, {
          fields: DEFAULT_STATS_FIELDS,
          datePreset: p,
        }),
      ),
    )

    const kpi: DashboardKpi = {
      today: aggregateRows(responses[0]),
      yesterday: aggregateRows(responses[1]),
      recent7d: aggregateRows(responses[2]),
      recent30d: aggregateRows(responses[3]),
    }
    return { ok: true, kpi }
  } catch (e) {
    console.error("[getDashboardKpi] failed:", e)
    return { ok: false, error: errorMessage(e, "KPI 조회 실패") }
  }
}

// =============================================================================
// 2. getTopCampaigns (F-7.4)
// =============================================================================

export async function getTopCampaigns(
  advertiserId: string,
  input: TopCampaignsInput,
): Promise<{ ok: true; rows: TopCampaignRow[] } | { ok: false; error: string }> {
  const { advertiser } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    return { ok: false, error: "API 키/시크릿 미입력" }
  }

  const parsed = topInputSchema.parse(input)

  // 광고주 한정 캠페인 (status='deleted' 제외 — TOP 표시는 활성/일시중지만).
  // SA Stats 자체는 deleted 도 응답할 수 있으나 화면 UX 상 제외.
  const dbCampaigns = await prisma.campaign.findMany({
    where: { advertiserId, status: { not: "deleted" } },
    select: { id: true, nccCampaignId: true, name: true },
  })

  if (dbCampaigns.length === 0) {
    return { ok: true, rows: [] }
  }

  const ids = dbCampaigns.map((c) => c.nccCampaignId)
  const meta = new Map(
    dbCampaigns.map((c) => [
      c.nccCampaignId,
      { campaignId: c.id, name: c.name },
    ]),
  )

  let rows: StatsRow[]
  try {
    rows = await getStats(advertiser.customerId, {
      ids,
      fields: DEFAULT_STATS_FIELDS,
      datePreset: parsed.period,
    })
  } catch (e) {
    console.error("[getTopCampaigns] stats failed:", e)
    return { ok: false, error: errorMessage(e, "TOP 조회 실패") }
  }

  // id 없는 row (광고주 전체 합산 형태) 는 스킵.
  const result: TopCampaignRow[] = []
  for (const r of rows) {
    if (!r.id) continue
    const m = meta.get(r.id)
    if (!m) continue // 광고주 횡단 또는 미동기화 캠페인 — 안전상 제외
    const metrics = rowToMetrics(r)
    result.push({
      campaignId: m.campaignId,
      nccCampaignId: r.id,
      name: m.name,
      ...metrics,
    })
  }

  // 정렬: order=desc → TOP, asc → BOTTOM. 동일 값은 입력 순서 유지(stable sort).
  // metric 값이 0 인 캠페인이 BOTTOM 상위에 몰릴 수 있음 — UI 측에서 필요시 필터링.
  result.sort((a, b) =>
    parsed.order === "desc"
      ? b[parsed.metric] - a[parsed.metric]
      : a[parsed.metric] - b[parsed.metric],
  )

  return { ok: true, rows: result.slice(0, parsed.limit) }
}

// =============================================================================
// 3. getTopKeywords (F-7.4)
// =============================================================================

export async function getTopKeywords(
  advertiserId: string,
  input: TopKeywordsInput,
): Promise<{ ok: true; rows: TopKeywordRow[] } | { ok: false; error: string }> {
  const { advertiser } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    return { ok: false, error: "API 키/시크릿 미입력" }
  }

  const parsed = topInputSchema.parse(input)

  // 광고주 한정 키워드. status='deleted' 제외 + 안전 상한 (TOP 표시 목적이라 1000 충분).
  // adgroup → campaign 조인으로 광고주 횡단 차단 (Keyword 자체엔 advertiserId 컬럼 없음).
  const dbKeywords = await prisma.keyword.findMany({
    where: {
      status: { not: "deleted" },
      adgroup: { campaign: { advertiserId } },
    },
    select: {
      id: true,
      nccKeywordId: true,
      keyword: true,
      matchType: true,
      adgroup: {
        select: {
          name: true,
          campaign: { select: { name: true } },
        },
      },
    },
    take: TOP_KEYWORDS_DB_HARD_LIMIT,
  })

  if (dbKeywords.length === 0) {
    return { ok: true, rows: [] }
  }

  const ids = dbKeywords.map((k) => k.nccKeywordId)
  const meta = new Map(
    dbKeywords.map((k) => [
      k.nccKeywordId,
      {
        keywordId: k.id,
        keyword: k.keyword,
        matchType: k.matchType,
        adgroupName: k.adgroup.name,
        campaignName: k.adgroup.campaign.name,
      },
    ]),
  )

  let rows: StatsRow[]
  try {
    rows = await getStats(advertiser.customerId, {
      ids,
      fields: DEFAULT_STATS_FIELDS,
      datePreset: parsed.period,
    })
  } catch (e) {
    console.error("[getTopKeywords] stats failed:", e)
    return { ok: false, error: errorMessage(e, "TOP 조회 실패") }
  }

  const result: TopKeywordRow[] = []
  for (const r of rows) {
    if (!r.id) continue
    const m = meta.get(r.id)
    if (!m) continue
    const metrics = rowToMetrics(r)
    result.push({
      keywordId: m.keywordId,
      nccKeywordId: r.id,
      keyword: m.keyword,
      matchType: m.matchType,
      adgroupName: m.adgroupName,
      campaignName: m.campaignName,
      ...metrics,
    })
  }

  result.sort((a, b) =>
    parsed.order === "desc"
      ? b[parsed.metric] - a[parsed.metric]
      : a[parsed.metric] - b[parsed.metric],
  )

  return { ok: true, rows: result.slice(0, parsed.limit) }
}
