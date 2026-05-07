/**
 * 광고주 단위 KeywordPerformanceProfile baseline 계산 (Phase A.2)
 *
 * 책임:
 *   - 광고주의 최근 N일(기본 28) StatDaily 집계 → CTR / CVR / CPC 평균 산출
 *   - upsert 로 KeywordPerformanceProfile 1행 갱신 (advertiserId @unique)
 *
 * 사용처:
 *   - 일 1회 cron (`/api/cron/keyword-perf-profile`) 가 활성 광고주 전체 호출
 *   - Phase B 입찰 엔진(`bid-suggest`)이 baseline 을 신뢰도 / 임계 입력으로 활용
 *
 * 데이터 소스:
 *   - StatDaily level='campaign' 만 사용 (광고주 전체 합산 = 캠페인 합 = 광고그룹 합 = 키워드 합 동일).
 *     캠페인 level row 수가 가장 적어 효율적.
 *   - conversions / cost 는 P2 매출 조인 단계에서만 채워짐. 미적재 광고주는 avgCvr=null 정상.
 *
 * 비대상:
 *   - 키워드 단위 baseline (광고주 전체 평균만). 키워드별은 후속 PR 검토.
 *   - 디바이스(PC/MOBILE) 분리 baseline. 본 PR 은 단일 평균.
 *   - StatHourly 합산. 일 단위로 충분.
 */

import { prisma } from "@/lib/db/prisma"
import { Prisma } from "@/lib/generated/prisma/client"
import { STAT_DAILY_DEVICE_FILTER } from "@/lib/stat-daily/device-filter"

/** 기본 baseline 윈도 (일). */
export const DEFAULT_BASELINE_DAYS = 28

/** baseline 산출 결과. cron 호출자가 upsert 에 그대로 전달. */
export type BaselineResult = {
  advertiserId: string
  /** 데이터 있는 distinct 일수 (0 = 데이터 없음). */
  dataDays: number
  /** 클릭률 0..1 범위 (예: 0.0123 = 1.23%). 노출 0 → null. */
  avgCtr: Prisma.Decimal | null
  /** 전환율 0..1 범위. 클릭 0 → null. conversions 미적재 광고주는 0 으로 계산되지만, P1 단계에서는 null 유지. */
  avgCvr: Prisma.Decimal | null
  /** 평균 CPC (원). 클릭 0 → null. */
  avgCpc: Prisma.Decimal | null
  /** 산출 시각 (cron 진입 시점). */
  refreshedAt: Date
}

/**
 * 광고주 단위 baseline 산출 (DB read only).
 *
 * @param advertiserId — 광고주 id
 * @param opts.days   — 기본 28
 * @param opts.now    — 테스트용 시각 주입. 미지정 시 현재 시각.
 */
export async function calculateBaseline(
  advertiserId: string,
  opts: { days?: number; now?: Date } = {},
): Promise<BaselineResult> {
  const days = opts.days ?? DEFAULT_BASELINE_DAYS
  const now = opts.now ?? new Date()

  // since = now - days (UTC). StatDaily.date 는 KST 기준 Date 컬럼이지만 같은 timeline.
  const since = new Date(now)
  since.setUTCDate(since.getUTCDate() - days)

  // 합산 — level='campaign' 으로 광고주 전체 누적 (level 간 중복 합산 회피).
  // device 이중집계 방지 — 옵션 B (PC + MOBILE). 자세한 근거는
  // lib/stat-daily/device-filter.ts 참조.
  const agg = await prisma.statDaily.aggregate({
    where: {
      advertiserId,
      date: { gte: since },
      level: "campaign",
      ...STAT_DAILY_DEVICE_FILTER,
    },
    _sum: {
      impressions: true,
      clicks: true,
      cost: true,
      conversions: true,
    },
  })

  // 신뢰도 — 데이터 있는 distinct 일수 (0..days)
  // 같은 device 필터 적용해 dataDays 가 PC/MOBILE 적재 누락 일자를 정확히 반영.
  const distinctDates = await prisma.statDaily.findMany({
    where: {
      advertiserId,
      date: { gte: since },
      level: "campaign",
      ...STAT_DAILY_DEVICE_FILTER,
    },
    distinct: ["date"],
    select: { date: true },
  })

  const imps = agg._sum.impressions ?? 0
  const clicks = agg._sum.clicks ?? 0
  const cost = agg._sum.cost ?? new Prisma.Decimal(0)
  const convs = agg._sum.conversions ?? 0

  // 비율 계산 — Decimal 정밀도 보존
  const avgCtr =
    imps > 0 ? new Prisma.Decimal(clicks).div(imps) : null
  // conversions 미적재 광고주 — 0 / clicks 으로 계산되지만 의미상 "전환 없음 vs 미측정" 구분 불가.
  // P1 단계에서는 conversions=0 인 광고주의 avgCvr 도 0 으로 기록 (미측정 분기는 P2 매출 조인 시점).
  const avgCvr =
    clicks > 0 ? new Prisma.Decimal(convs).div(clicks) : null
  const avgCpc =
    clicks > 0
      ? new Prisma.Decimal(cost).div(clicks)
      : null

  return {
    advertiserId,
    dataDays: distinctDates.length,
    avgCtr,
    avgCvr,
    avgCpc,
    refreshedAt: now,
  }
}

/**
 * baseline 결과를 KeywordPerformanceProfile 에 upsert.
 *
 * 광고주 1:1 보장 (advertiserId @unique).
 */
export async function upsertBaseline(input: BaselineResult): Promise<void> {
  await prisma.keywordPerformanceProfile.upsert({
    where: { advertiserId: input.advertiserId },
    create: {
      advertiserId: input.advertiserId,
      dataDays: input.dataDays,
      avgCtr: input.avgCtr,
      avgCvr: input.avgCvr,
      avgCpc: input.avgCpc,
      refreshedAt: input.refreshedAt,
    },
    update: {
      dataDays: input.dataDays,
      avgCtr: input.avgCtr,
      avgCvr: input.avgCvr,
      avgCpc: input.avgCpc,
      refreshedAt: input.refreshedAt,
    },
  })
}
