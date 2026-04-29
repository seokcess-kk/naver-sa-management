/**
 * F-9.2 / F-9.4 — 시간별 적재 + 노출 순위 갱신 (Cron route 분리 헬퍼)
 *
 * 책임:
 *   - 광고주 1개 단위로 네이버 SA Stats API (breakdown=hh24) 호출 → StatHourly upsert
 *   - keyword level row 의 recentAvgRnk → Keyword.recentAvgRnk last non-null 갱신
 *   - 광고주별 실패 격리 (한 광고주 실패가 cron 전체 차단 X — 호출부 책임)
 *   - 시크릿 평문 누설 0 (lib/naver-sa/* 통과 + 본 모듈은 customerId 만 다룸)
 *
 * 비대상:
 *   - 사용자 인증 / RLS (Cron route 가 service_role + CRON_SECRET 보호)
 *   - ChangeBatch 적재 (조회·적재만 — SA 변경 X)
 *   - AuditLog 적재 (운영 메트릭은 cron 응답 + Sentry)
 *   - 시간×디바이스 분해 (P2 후속) — 본 PR 은 device='ALL' 단일
 *   - retention/cleanup (90일 보관 cron 별도 PR)
 *
 * 시간대 정책 (KST):
 *   - cron 매시간 5분에 실행 → "직전 1시간(KST)" 데이터 적재 ("1시간 후행")
 *     예: KST 14:05 cron → KST 13시(0..23 중 13) 시간대 행 적재
 *   - 본 PR 은 단순화: timeRange.since=until=KST 그날, breakdown=hh24 → 24개 row 응답
 *     중 row.hh24 === hour (직전 시간) 만 추출 적재 (다른 시간대 row 무시)
 *   - 매시간 unique upsert 라 같은 시간대 재방문해도 idempotent
 *
 * recentAvgRnk 갱신 정책 (F-9.4):
 *   - StatHourly: nullable Decimal 컬럼에 그대로 적재 (null 통과)
 *   - Keyword.recentAvgRnk: last non-null 우선 — null row 는 호출자(본 모듈)가 사전 필터
 *   - 다음 시간 cron 이 자연 재시도
 *
 * level 결정 (F-9.1 패턴 변형):
 *   - StatDaily 는 AD_DETAIL TSV 가 row 별 ID 컬럼을 모두 포함 → row.keywordId/adgroupId/campaignId
 *     우선순위로 pickLevel
 *   - StatHourly 는 Stats API ids 호출이라 row.id 필드만 옴. level 은 호출 컨텍스트(어느 ID 셋을
 *     ids 로 넘겼는가)로 이미 결정됨 → pickLevel 은 호출 컨텍스트(level) + row.id 정상 검증만
 *
 * 외부 호출:
 *   - lib/naver-sa/stats.ts (getStatsChunked) — chunk 100 직렬, 광고주별 토큰 버킷 분리
 *   - DB upsert chunk 100 / $transaction
 */

import {
  getStatsChunked,
  type StatsField,
  type StatsRow,
} from "@/lib/naver-sa/stats"
import { prisma } from "@/lib/db/prisma"
import type { Prisma, StatLevel, StatDevice } from "@/lib/generated/prisma/client"

// =============================================================================
// 시간대 헬퍼 — KST 기준 직전 시간(0..23) 추출
// =============================================================================

const KST_OFFSET_MS = 9 * 60 * 60 * 1000 // KST = UTC+9

/**
 * 현재 시각 기준 "KST 직전 정시" 의 (date, hour) 반환 — 1시간 후행 기록 정책.
 *
 * 예 (now = 2026-04-29 14:35 KST = 2026-04-29 05:35 UTC):
 *   → previousHourKstAsUtc(now) = { date: 2026-04-29 KST 0시 (= 2026-04-28 15:00 UTC), hour: 13 }
 *   - "직전 정시" = KST 13시 → cron 14:05 실행 시 KST 13시 데이터 기록
 *
 * 자정 직후 (now = 2026-04-29 00:30 KST = 2026-04-28 15:30 UTC):
 *   → previousHourKstAsUtc(now) = { date: 2026-04-28 KST 0시 (= 2026-04-27 15:00 UTC), hour: 23 }
 *   - 직전 시간은 "전날 KST 23시" → date 도 전일로 롤백
 *
 * 반환 date 는 "그 KST 일자 자정"의 절대 epoch — Prisma @db.Date 호환 (StatDaily 와 동일 패턴).
 * UTC 표시로는 "KST 0시 = 전일 UTC 15:00".
 *
 * @param now 테스트용 현재 시각 주입 (운영 호출부는 omit → new Date())
 */
export function previousHourKstAsUtc(now: Date = new Date()): {
  date: Date
  hour: number
} {
  // 1) now 의 "KST epoch" 환산 → epoch + 9h
  const kstShifted = new Date(now.getTime() + KST_OFFSET_MS)

  // 2) KST 시각 -1 시간 → 직전 정시
  const prevKst = new Date(kstShifted.getTime() - 60 * 60 * 1000)

  // 3) 직전 시각의 KST 일자 / 시 추출 (UTC API 사용 — kstShifted 가 이미 KST 기준)
  const kstY = prevKst.getUTCFullYear()
  const kstM = prevKst.getUTCMonth()
  const kstD = prevKst.getUTCDate()
  const hour = prevKst.getUTCHours() // 0..23 (KST 시각)

  // 4) date = KST 그날 0시 절대 epoch (UTC 로는 -9h)
  const kstDay0 = new Date(Date.UTC(kstY, kstM, kstD))
  const date = new Date(kstDay0.getTime() - KST_OFFSET_MS)

  return { date, hour }
}

/** YYYY-MM-DD (KST 기준 — date 인자의 KST 일자). */
export function dateToStatDtString(date: Date): string {
  // date 는 "KST 그날 0시"의 절대 epoch → UTC 로는 전일 15:00
  // KST 일자로 환원: epoch + 9h → UTC API 로 YYYY-MM-DD
  const kstShifted = new Date(date.getTime() + KST_OFFSET_MS)
  const y = kstShifted.getUTCFullYear()
  const m = String(kstShifted.getUTCMonth() + 1).padStart(2, "0")
  const d = String(kstShifted.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

// =============================================================================
// row → upsert 변환
// =============================================================================

/**
 * 호출 컨텍스트 기반 level 검증.
 *
 * StatDaily 의 pickLevel(row) 와 다르게, StatHourly 는 호출 컨텍스트(어느 ids 셋을 던졌는가)
 * 로 level 이 이미 결정됨. row.id 는 호출한 ids 셋의 element.
 *
 * - row.id 가 string non-empty → { level, refId: row.id } 반환
 * - row.id 누락 / 빈 → null (광고주 합산 row 등 — skip)
 */
export function pickLevel(
  level: StatLevel,
  row: StatsRow,
): { level: StatLevel; refId: string } | null {
  const id = typeof row.id === "string" ? row.id : ""
  if (id.length === 0) return null
  return { level, refId: id }
}

/**
 * StatsRow + 컨텍스트 → StatHourly upsert payload.
 *
 * device='ALL' 단일 (본 PR). impressions/clicks/cost 는 number → Int/Decimal.
 * recentAvgRnk: number → Decimal, null → null (Decimal? 컬럼).
 *
 * 반환 null = level 결정 불가 / row.id 누락 → 호출부 skip.
 */
export function toUpsertInput(args: {
  advertiserId: string
  date: Date
  hour: number
  level: StatLevel
  row: StatsRow
}): {
  where: Prisma.StatHourlyWhereUniqueInput
  create: Prisma.StatHourlyUncheckedCreateInput
  update: Prisma.StatHourlyUncheckedUpdateInput
} | null {
  const lvl = pickLevel(args.level, args.row)
  if (lvl === null) return null

  const device: StatDevice = "ALL"
  const impressions = numOr0(args.row.impCnt)
  const clicks = numOr0(args.row.clkCnt)
  const cost = numOr0(args.row.salesAmt)
  const recentAvgRnk =
    args.row.recentAvgRnk == null ? null : Number(args.row.recentAvgRnk)

  return {
    where: {
      // schema 의 @@unique([date, hour, level, refId, device]) 자동 생성 키
      date_hour_level_refId_device: {
        date: args.date,
        hour: args.hour,
        level: lvl.level,
        refId: lvl.refId,
        device,
      },
    },
    create: {
      advertiserId: args.advertiserId,
      date: args.date,
      hour: args.hour,
      level: lvl.level,
      refId: lvl.refId,
      device,
      impressions,
      clicks,
      cost,
      recentAvgRnk,
    },
    update: {
      // 매시간 재방문 시 최신 값으로 덮어쓰기 (idempotent)
      // advertiserId 는 update 에 포함하지 않음 (refId owner 불변 가정)
      impressions,
      clicks,
      cost,
      recentAvgRnk,
    },
  }
}

function numOr0(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v
  return 0
}

// =============================================================================
// Keyword.recentAvgRnk 일괄 갱신 (F-9.4)
// =============================================================================

/**
 * Keyword.recentAvgRnk 일괄 갱신 — last non-null 정책.
 *
 * - 입력은 호출자가 null 제외 후 전달 (rnk: number)
 * - nccKeywordId 기준 prisma.keyword.update 반복 (chunk 100 / $transaction)
 * - Keyword 행이 없으면 (P2 sync 미완) 자동 skip — update 실패는 catch 로 흡수
 *
 * 반환: 실제 update 성공 행 수 (skip 포함 안 함).
 */
export async function updateKeywordRecentAvgRnk(
  _advertiserId: string,
  ranks: { nccKeywordId: string; rnk: number }[],
): Promise<number> {
  if (ranks.length === 0) return 0

  let updated = 0
  const CHUNK = 100
  for (let i = 0; i < ranks.length; i += CHUNK) {
    const slice = ranks.slice(i, i + CHUNK)
    // 단건 update 가 P2025 (no row) 면 chunk 전체 트랜잭션이 rollback → 개별 try/catch
    // 로 분리 후 Promise.allSettled 로 흡수.
    const results = await Promise.allSettled(
      slice.map((r) =>
        prisma.keyword.update({
          where: { nccKeywordId: r.nccKeywordId },
          data: { recentAvgRnk: r.rnk },
        }),
      ),
    )
    for (const res of results) {
      if (res.status === "fulfilled") updated++
    }
  }
  return updated
}

// =============================================================================
// 광고주 1명 적재 (활성 ids 수집 → Stats 호출 → upsert → Keyword 갱신)
// =============================================================================

const STATS_FIELDS: StatsField[] = [
  "impCnt",
  "clkCnt",
  "salesAmt",
  "recentAvgRnk",
]

export type IngestAdvertiserHourlyArgs = {
  advertiserId: string
  customerId: string
  /** KST 그날 0시 절대 epoch (previousHourKstAsUtc 결과 date) */
  date: Date
  /** 0..23 (KST 시각) */
  hour: number
}

export type IngestAdvertiserHourlyResult = {
  rowsInserted: number
  rowsSkipped: number
  keywordsRanked: number
}

/**
 * 광고주 1명 단위 시간별 적재.
 *
 * 흐름:
 *   1. 활성 캠페인/광고그룹/키워드 nccId 수집 (status='on' 만)
 *   2. level 별 분리 호출 (Stats API getStatsChunked, breakdown=hh24, timeRange=같은 날짜)
 *   3. row.hh24 === hour 인 row 만 추출 → toUpsertInput → chunk 100 $transaction upsert
 *   4. keyword level row 중 recentAvgRnk non-null 만 모아 Keyword.recentAvgRnk 갱신
 *
 * 실패 정책:
 *   - 어느 단계든 throw → 호출부(cron route) 가 try/catch 로 다음 광고주 진행
 */
export async function ingestAdvertiserStatHourly(
  args: IngestAdvertiserHourlyArgs,
): Promise<IngestAdvertiserHourlyResult> {
  const { advertiserId, customerId, date, hour } = args

  // -- 1. 활성 ids 수집 -----------------------------------------------------
  // 캠페인: 광고주 직속 + status=on
  const campaigns = await prisma.campaign.findMany({
    where: { advertiserId, status: "on" },
    select: { nccCampaignId: true },
  })
  // 광고그룹: 광고주의 캠페인 하위 + status=on
  const adgroups = await prisma.adGroup.findMany({
    where: { campaign: { advertiserId }, status: "on" },
    select: { nccAdgroupId: true },
  })
  // 키워드: 광고주의 광고그룹 하위 + status=on
  const keywords = await prisma.keyword.findMany({
    where: { adgroup: { campaign: { advertiserId } }, status: "on" },
    select: { nccKeywordId: true },
  })

  const campaignIds = campaigns.map((c) => c.nccCampaignId)
  const adgroupIds = adgroups.map((a) => a.nccAdgroupId)
  const keywordIds = keywords.map((k) => k.nccKeywordId)

  // -- 2. Stats API 호출 (level 별 분리) ------------------------------------
  const statDtStr = dateToStatDtString(date)
  const baseTimeRange = { since: statDtStr, until: statDtStr }

  const fetchPlan: { level: StatLevel; ids: string[] }[] = [
    { level: "campaign", ids: campaignIds },
    { level: "adgroup", ids: adgroupIds },
    { level: "keyword", ids: keywordIds },
  ]

  let rowsInserted = 0
  let rowsSkipped = 0
  const keywordRanks: { nccKeywordId: string; rnk: number }[] = []

  for (const { level, ids } of fetchPlan) {
    if (ids.length === 0) continue

    const rows = await getStatsChunked(customerId, {
      ids,
      fields: STATS_FIELDS,
      timeRange: baseTimeRange,
      breakdown: "hh24",
    })

    // -- 3. 직전 시간 row 만 추출 --------------------------------------------
    const inputs: Array<NonNullable<ReturnType<typeof toUpsertInput>>> = []
    for (const row of rows) {
      // hh24: string "00".."23" 또는 number → Number 변환 후 비교
      const hh = Number((row as { hh24?: unknown }).hh24)
      if (!Number.isFinite(hh) || hh !== hour) {
        // 직전 시간 외 row 는 매시간 cron 의 다른 시간 적재가 책임
        continue
      }
      const inp = toUpsertInput({ advertiserId, date, hour, level, row })
      if (inp === null) {
        rowsSkipped++
        continue
      }
      inputs.push(inp)

      // keyword level + recentAvgRnk non-null → Keyword 갱신 큐
      if (level === "keyword") {
        const id = typeof row.id === "string" ? row.id : ""
        const rnk = row.recentAvgRnk
        if (id.length > 0 && rnk != null && Number.isFinite(Number(rnk))) {
          keywordRanks.push({ nccKeywordId: id, rnk: Number(rnk) })
        }
      }
    }

    // -- 4. upsert chunk 100 $transaction ------------------------------------
    const CHUNK = 100
    for (let i = 0; i < inputs.length; i += CHUNK) {
      const slice = inputs.slice(i, i + CHUNK)
      await prisma.$transaction(
        slice.map((inp) =>
          prisma.statHourly.upsert({
            where: inp.where,
            create: inp.create,
            update: inp.update,
          }),
        ),
      )
      rowsInserted += slice.length
    }
  }

  // -- 5. Keyword.recentAvgRnk 일괄 갱신 (F-9.4) -----------------------------
  const keywordsRanked = await updateKeywordRecentAvgRnk(advertiserId, keywordRanks)

  return { rowsInserted, rowsSkipped, keywordsRanked }
}
