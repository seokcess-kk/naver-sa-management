/**
 * F-9.1 — 일별 적재 로직 (Cron route 분리 헬퍼)
 *
 * 책임:
 *   - 광고주 1개 단위로 네이버 SA AD_DETAIL 보고서 생성→폴링→다운로드→파싱→upsert→정리
 *   - 광고주별 실패 격리 (한 광고주 실패가 cron 전체를 차단 X — 호출부 책임)
 *   - 시크릿 평문 누설 0 (lib/naver-sa/* 통과 + 본 모듈은 customerId 만 다룸)
 *
 * 비대상:
 *   - 사용자 인증 / RLS (Cron route 가 service_role + CRON_SECRET 보호)
 *   - ChangeBatch 적재 (조회·적재만 — SA 변경 X)
 *   - AuditLog 적재 (운영 메트릭은 cron 응답 + Sentry)
 *
 * 시크릿 운영:
 *   - 본 모듈은 advertiserId / customerId / Date 만 인자로 받음. 평문 키 직접 처리 X
 *   - reports.* 모듈이 client.ts(credentials.ts) 통해 자격증명 resolve → 본 모듈에서는 비가시
 *
 * 통합 테스트 비대상:
 *   - 본 PR 은 핵심 변환 로직(previousDayKstAsUtc / pickLevel / toUpsertInput) 단위 테스트만
 *   - SA / Prisma 통합은 mock 비용 대비 가치 낮음 — 운영 dry-run 으로 검증
 */

import {
  createStatReport,
  deleteStatReport,
  downloadStatReport,
  parseAdDetailTsv,
  waitStatReportReady,
  type AdDetailRow,
} from "@/lib/naver-sa/reports"
import {
  getStatsChunked,
  type StatsField,
  type StatsRow,
} from "@/lib/naver-sa/stats"
import { prisma } from "@/lib/db/prisma"
import type { Prisma, StatLevel, StatDevice } from "@/lib/generated/prisma/client"

// =============================================================================
// 시간대 헬퍼 — KST 기준 어제 0시 → Date 객체
// =============================================================================

const KST_OFFSET_MS = 9 * 60 * 60 * 1000 // KST = UTC+9

/**
 * 현재 시각 기준 KST 어제 0시(KST) 를 가리키는 Date 객체.
 *
 * 반환 Date 는 "어제 KST 자정"의 절대 순간(epoch).
 * UTC 표시로는 "어제 KST 0시 = 그제 UTC 15:00".
 *
 * 예 (now = 2026-04-29 03:00 KST = 2026-04-28 18:00 UTC):
 *   → 2026-04-28 00:00 KST = 2026-04-27 15:00 UTC
 *   → toISOString() = "2026-04-27T15:00:00.000Z"
 *
 * reports.createStatReport 가 내부에서 toStatDtString(d) 로 KST 일자(+9h)를 추출해
 * "YYYY-MM-DDT00:00:00.000Z" 형식으로 SA 에 전송한다. 따라서 본 함수의 반환 Date 가
 * KST 자정 epoch 인 한 SA 에는 "KST 어제 일자"가 정확히 전달된다.
 *
 * @param now 테스트용 현재 시각 주입 (운영 호출부는 omit → new Date())
 */
export function previousDayKstAsUtc(now: Date = new Date()): Date {
  // 1) now 의 KST 시각으로 이동 (UTC epoch + 9시간)
  const kstShifted = new Date(now.getTime() + KST_OFFSET_MS)
  // 2) KST 자정으로 truncate (UTC API 사용해서 시/분/초 0)
  const kstY = kstShifted.getUTCFullYear()
  const kstM = kstShifted.getUTCMonth()
  const kstD = kstShifted.getUTCDate()
  // 3) 어제로 -1일
  const yesterdayKst0 = new Date(Date.UTC(kstY, kstM, kstD - 1))
  // 4) 다시 UTC 로 환원: KST 자정 = UTC 전일 15:00 → -9시간
  return new Date(yesterdayKst0.getTime() - KST_OFFSET_MS)
}

/** Date 객체가 가리키는 KST 일자를 YYYY-MM-DD 로 변환. */
function dateToKstDateString(date: Date): string {
  const kst = new Date(date.getTime() + KST_OFFSET_MS)
  const y = kst.getUTCFullYear()
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0")
  const d = String(kst.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

// =============================================================================
// AdDetailRow → StatDaily upsert 입력 변환
// =============================================================================

/**
 * AdDetailRow 의 ID 우선순위로 level + refId 결정.
 *
 * 우선순위 (가장 세밀한 단위):
 *   keywordId > adgroupId > campaignId > (그 외 = null = skip)
 *
 * advertiser 단위 합산 row (모든 ID 빈) 는 적재 비대상 → null 반환.
 */
export function pickLevel(
  row: AdDetailRow,
): { level: StatLevel; refId: string } | null {
  if (row.keywordId && row.keywordId.length > 0) {
    return { level: "keyword", refId: row.keywordId }
  }
  if (row.adgroupId && row.adgroupId.length > 0) {
    return { level: "adgroup", refId: row.adgroupId }
  }
  if (row.campaignId && row.campaignId.length > 0) {
    return { level: "campaign", refId: row.campaignId }
  }
  return null
}

/**
 * AdDetailRow + advertiserId → StatDaily upsert payload (where / create / update).
 *
 * - date: row.date (YYYY-MM-DD) → UTC 자정 Date 변환 (Prisma @db.Date 호환)
 * - avgRnk: optional/null → undefined (Prisma upsert update 에서 "변경 안 함")
 *   * 단 create 에서는 null 도 허용 (Decimal? 컬럼)
 * - conversions / revenue: P2 매출 조인 시점에 채움 — 본 PR 미주입
 *
 * 반환 null = level 결정 불가 → 호출부 skip.
 */
export function toUpsertInput(
  advertiserId: string,
  row: AdDetailRow,
): {
  where: Prisma.StatDailyWhereUniqueInput
  create: Prisma.StatDailyUncheckedCreateInput
  update: Prisma.StatDailyUncheckedUpdateInput
} | null {
  const lvl = pickLevel(row)
  if (lvl === null) return null

  const date = new Date(`${row.date}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return null

  const device = row.device as StatDevice
  const avgRnk = row.avgRnk == null ? null : row.avgRnk

  return {
    where: {
      // schema 의 @@unique([date, level, refId, device]) 자동 생성 키
      date_level_refId_device: {
        date,
        level: lvl.level,
        refId: lvl.refId,
        device,
      },
    },
    create: {
      advertiserId,
      date,
      level: lvl.level,
      refId: lvl.refId,
      device,
      impressions: row.impressions,
      clicks: row.clicks,
      cost: row.cost,
      avgRnk,
    },
    update: {
      // 재실행 시 최신 값으로 덮어쓰기 (idempotent)
      // advertiserId 는 update 에 포함하지 않음 (refId 의 owner 는 불변 가정)
      impressions: row.impressions,
      clicks: row.clicks,
      cost: row.cost,
      avgRnk,
    },
  }
}

const STATS_FIELDS: StatsField[] = [
  "impCnt",
  "clkCnt",
  "salesAmt",
  "recentAvgRnk",
]

const UPSERT_CHUNK = 100
const UPSERT_TRANSACTION_TIMEOUT_MS = 30_000

function numOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

function statsRowToUpsertInput(args: {
  advertiserId: string
  date: Date
  level: StatLevel
  row: StatsRow
}): {
  where: Prisma.StatDailyWhereUniqueInput
  create: Prisma.StatDailyUncheckedCreateInput
  update: Prisma.StatDailyUncheckedUpdateInput
} | null {
  const refId = typeof args.row.id === "string" ? args.row.id : ""
  if (refId.length === 0) return null

  const device: StatDevice = "ALL"
  const impressions = numOr0(args.row.impCnt)
  const clicks = numOr0(args.row.clkCnt)
  const cost = numOr0(args.row.salesAmt)
  const conversions = numOr0(args.row.crtoCnt)
  const avgRnk =
    typeof args.row.recentAvgRnk === "number" && args.row.recentAvgRnk > 0
      ? args.row.recentAvgRnk
      : null

  return {
    where: {
      date_level_refId_device: {
        date: args.date,
        level: args.level,
        refId,
        device,
      },
    },
    create: {
      advertiserId: args.advertiserId,
      date: args.date,
      level: args.level,
      refId,
      device,
      impressions,
      clicks,
      cost,
      avgRnk,
      conversions,
    },
    update: {
      impressions,
      clicks,
      cost,
      avgRnk,
      conversions,
    },
  }
}

// =============================================================================
// 광고주 1명 적재 (보고서 생성→폴링→다운로드→파싱→upsert→정리)
// =============================================================================

export type IngestAdvertiserArgs = {
  advertiserId: string
  customerId: string
  /** 적재 대상 일자 — reports.createStatReport 에 그대로 전달 */
  statDt: Date
}

export type IngestAdvertiserResult = {
  rowsInserted: number
  rowsSkipped: number
}

/**
 * 광고주 1명 단위 일별 적재.
 *
 * 흐름:
 *   1. createStatReport(AD_DETAIL, statDt)
 *   2. waitStatReportReady (5분 timeout 기본)
 *   3. downloadStatReport(downloadUrl)
 *   4. parseAdDetailTsv(tsv)
 *   5. row 별 toUpsertInput → prisma.statDaily.upsert (chunk 100 / $transaction)
 *   6. (finally) deleteStatReport(reportJobId) — best-effort
 *
 * 실패 정책:
 *   - 1~5 단계에서 throw → finally 에서 deleteStatReport 실행 후 호출부에 throw 전파
 *   - 호출부(cron route) 가 try/catch 로 감싸 다음 광고주 진행
 *
 * upsert 단건 vs batch:
 *   - 광고주당 평균 행수 ~1,000~5,000 가정 (DB schema doc 참조)
 *   - 단건 upsert 반복은 트랜잭션 비용 큼 → chunk 100 단위 $transaction 으로 묶음
 *   - createMany skipDuplicates 는 update 가 안 됨 (재실행 시 최신 덮어쓰기 필요)
 */
export async function ingestAdvertiserStatDaily(
  args: IngestAdvertiserArgs,
): Promise<IngestAdvertiserResult> {
  const { advertiserId, customerId, statDt } = args

  let reportJobId: string | null = null
  let rowsInserted = 0
  let rowsSkipped = 0

  try {
    // 1. 보고서 생성 요청
    const job = await createStatReport(customerId, {
      reportTp: "AD_DETAIL",
      statDt,
    })
    reportJobId = job.reportJobId

    // 2. BUILT/DONE 까지 폴링
    const ready = await waitStatReportReady(customerId, reportJobId)

    // 3. TSV 다운로드 (SA 자기 도메인 /report-download — HMAC + X-Customer 필수)
    const tsv = await downloadStatReport(customerId, ready.downloadUrl)

    // 4. 행 단위 파싱 (행 단위 검증 실패는 reports.ts 내부에서 자동 skip)
    const rows = await parseAdDetailTsv(tsv)

    // 5. (date, level, refId, device) 단위 합산 collapse — TSV 가 시간/권역으로 분해된
    //    raw row 다중 출현 (실측: 같은 adgroup·device 가 시간별로 6~24행). chunk transaction
    //    내 같은 unique 키 두 번 upsert 시 P2002 충돌 → 적재 전 합산 필수.
    //
    //    합산 정책:
    //      - impressions / clicks / cost: SUM
    //      - avgRnk: 노출 가중 평균 (sum(avgRnk*imp) / sum(imp)). imp=0 또는 null 행은 제외.
    //                노출 0 광고그룹은 avgRnk=null 적재.
    type Agg = {
      date: Date
      level: StatLevel
      refId: string
      device: StatDevice
      impressions: number
      clicks: number
      cost: number
      avgRnkWeightedSum: number
      avgRnkWeight: number
    }
    const aggMap = new Map<string, Agg>()

    for (const row of rows) {
      const inp = toUpsertInput(advertiserId, row)
      if (inp === null) {
        rowsSkipped++
        continue
      }
      const w = inp.where.date_level_refId_device
      if (!w) {
        rowsSkipped++
        continue
      }
      const wDate = w.date instanceof Date ? w.date : new Date(w.date)
      const k = `${wDate.toISOString()}|${w.level}|${w.refId}|${w.device}`
      const c = inp.create
      const imp = (c.impressions as number) ?? 0
      const clk = (c.clicks as number) ?? 0
      const cst =
        typeof c.cost === "number" ? c.cost : Number(c.cost ?? 0)
      const rnk =
        c.avgRnk == null
          ? null
          : typeof c.avgRnk === "number"
            ? c.avgRnk
            : Number(c.avgRnk)

      const prev = aggMap.get(k)
      if (prev) {
        prev.impressions += imp
        prev.clicks += clk
        prev.cost += cst
        if (rnk != null && imp > 0) {
          prev.avgRnkWeightedSum += rnk * imp
          prev.avgRnkWeight += imp
        }
      } else {
        aggMap.set(k, {
          date: wDate,
          level: w.level as StatLevel,
          refId: w.refId as string,
          device: w.device as StatDevice,
          impressions: imp,
          clicks: clk,
          cost: cst,
          avgRnkWeightedSum: rnk != null && imp > 0 ? rnk * imp : 0,
          avgRnkWeight: rnk != null && imp > 0 ? imp : 0,
        })
      }
    }

    const inputs = Array.from(aggMap.values()).map((a) => {
      const avgRnk = a.avgRnkWeight > 0 ? a.avgRnkWeightedSum / a.avgRnkWeight : null
      return {
        where: {
          date_level_refId_device: {
            date: a.date,
            level: a.level,
            refId: a.refId,
            device: a.device,
          },
        },
        create: {
          advertiserId,
          date: a.date,
          level: a.level,
          refId: a.refId,
          device: a.device,
          impressions: a.impressions,
          clicks: a.clicks,
          cost: a.cost,
          avgRnk,
        } satisfies Prisma.StatDailyUncheckedCreateInput,
        update: {
          impressions: a.impressions,
          clicks: a.clicks,
          cost: a.cost,
          avgRnk,
        } satisfies Prisma.StatDailyUncheckedUpdateInput,
      }
    })

    for (let i = 0; i < inputs.length; i += UPSERT_CHUNK) {
      const slice = inputs.slice(i, i + UPSERT_CHUNK)
      await prisma.$transaction(
        slice.map((inp) =>
          prisma.statDaily.upsert({
            where: inp.where,
            create: inp.create,
            update: inp.update,
          }),
        ),
        { timeout: UPSERT_TRANSACTION_TIMEOUT_MS },
      )
      rowsInserted += slice.length
    }

    // 6. AD_DETAIL StatReport 는 keywordId 가 비어 소재/adgroup 단위로 내려오는
    //    케이스가 있다. 입찰 inbox 는 keyword-level 7일 성과가 필요하므로 Stats API
    //    ids 호출로 campaign/adgroup/keyword 일별 행을 보강 적재한다.
    const campaigns = await prisma.campaign.findMany({
      where: { advertiserId, status: "on" },
      select: { nccCampaignId: true },
    })
    const adgroups = await prisma.adGroup.findMany({
      where: { campaign: { advertiserId }, status: "on" },
      select: { nccAdgroupId: true },
    })
    const keywords = await prisma.keyword.findMany({
      where: { adgroup: { campaign: { advertiserId } }, status: "on" },
      select: { nccKeywordId: true },
    })

    const statDtStr = dateToKstDateString(statDt)
    const statDate = new Date(`${statDtStr}T00:00:00.000Z`)
    const fetchPlan: { level: StatLevel; ids: string[] }[] = [
      { level: "campaign", ids: campaigns.map((c) => c.nccCampaignId) },
      { level: "adgroup", ids: adgroups.map((a) => a.nccAdgroupId) },
      { level: "keyword", ids: keywords.map((k) => k.nccKeywordId) },
    ]

    for (const { level, ids } of fetchPlan) {
      if (ids.length === 0) continue
      const statsRows = await getStatsChunked(customerId, {
        ids,
        fields: STATS_FIELDS,
        timeRange: { since: statDtStr, until: statDtStr },
      })
      const statsInputs: Array<NonNullable<ReturnType<typeof statsRowToUpsertInput>>> = []
      for (const row of statsRows) {
        const inp = statsRowToUpsertInput({
          advertiserId,
          date: statDate,
          level,
          row,
        })
        if (inp === null) {
          rowsSkipped++
        } else {
          statsInputs.push(inp)
        }
      }

      for (let i = 0; i < statsInputs.length; i += UPSERT_CHUNK) {
        const slice = statsInputs.slice(i, i + UPSERT_CHUNK)
        await prisma.$transaction(
          slice.map((inp) =>
            prisma.statDaily.upsert({
              where: inp.where,
              create: inp.create,
              update: inp.update,
            }),
          ),
          { timeout: UPSERT_TRANSACTION_TIMEOUT_MS },
        )
        rowsInserted += slice.length
      }
    }

    return { rowsInserted, rowsSkipped }
  } finally {
    // 7. best-effort 정리 (실패해도 throw 안 함 — reports.deleteStatReport 가 흡수)
    if (reportJobId) {
      try {
        await deleteStatReport(customerId, reportJobId)
      } catch {
        // 안전망 — reports.deleteStatReport 자체가 throw 안 함이지만 한 번 더 흡수
      }
    }
  }
}
