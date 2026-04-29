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
 * reports.createStatReport 가 내부에서 toStatDtString(d) → UTC 자정으로 변환하므로,
 * 본 함수가 반환한 Date 의 UTC 자정 (= 어제 UTC 0시 = 어제 KST 9시) 이
 * 네이버 statDt 로 전송된다. 본 PR 디폴트는 KST 기준 어제 — 운영 환경에서
 * STAT_DAILY_TZ env 추가로 후속 조정 가능.
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

    // 3. TSV 다운로드 (외부 S3, HMAC 미적용)
    const tsv = await downloadStatReport(ready.downloadUrl)

    // 4. 행 단위 파싱 (행 단위 검증 실패는 reports.ts 내부에서 자동 skip)
    const rows = await parseAdDetailTsv(tsv)

    // 5. upsert — chunk 100 단위 $transaction 으로 묶음
    const inputs: Array<NonNullable<ReturnType<typeof toUpsertInput>>> = []
    for (const row of rows) {
      const inp = toUpsertInput(advertiserId, row)
      if (inp === null) {
        rowsSkipped++
        continue
      }
      inputs.push(inp)
    }

    const CHUNK = 100
    for (let i = 0; i < inputs.length; i += CHUNK) {
      const slice = inputs.slice(i, i + CHUNK)
      await prisma.$transaction(
        slice.map((inp) =>
          prisma.statDaily.upsert({
            where: inp.where,
            create: inp.create,
            update: inp.update,
          }),
        ),
      )
      rowsInserted += slice.length
    }

    return { rowsInserted, rowsSkipped }
  } finally {
    // 6. best-effort 정리 (실패해도 throw 안 함 — reports.deleteStatReport 가 흡수)
    if (reportJobId) {
      try {
        await deleteStatReport(customerId, reportJobId)
      } catch {
        // 안전망 — reports.deleteStatReport 자체가 throw 안 함이지만 한 번 더 흡수
      }
    }
  }
}
