/**
 * bid-suggest cron — 광고주 1명 처리 (marginal / 묶음 흐름 + 엔진 조율).
 *
 * app/api/cron/bid-suggest/route.ts 분해 (순수 구조 리팩터) 로 추출.
 * processAdvertiser 는 광고주 단위 오케스트레이션:
 *   - BidAutomationConfig mode 게이트 + stat-daily stale 가드
 *   - budget 엔진 (processBudgetSuggestions)
 *   - marginal / 묶음 흐름 (decideMarginalSuggestion + bundleSuggestions) — 본 모듈 내부
 *   - 키워드 rank 엔진 (processRankSuggestions)
 *   - 광고그룹 rank 엔진 (processAdgroupRankSuggestions)
 * 로직 · 시그니처 불변.
 */

import { prisma } from "@/lib/db/prisma"
import { STAT_DAILY_DEVICE_FILTER } from "@/lib/stat-daily/device-filter"
import {
  bundleSuggestions,
  DEFAULT_MARGINAL_CONFIG,
  decideMarginalSuggestion,
  type AdvertiserBaselineInput,
  type AutomationTargets,
  type BundleInputDecision,
  type KeywordPerfInput,
  type MarginalDecision,
} from "@/lib/auto-bidding/marginal-score"
import type * as Prisma from "@/lib/generated/prisma/internal/prismaNamespace"

import { processBudgetSuggestions } from "./budget"
import { processRankSuggestions } from "./rank-keyword"
import { processAdgroupRankSuggestions } from "./rank-adgroup"
import {
  addDays,
  STATS_WINDOW_DAYS,
  SUGGESTION_TTL_DAYS,
  type AdvertiserStats,
} from "./shared"

const TOP_N = Number(process.env.BID_SUGGEST_TOP_N ?? "100")
/**
 * stat-daily stale 차단 임계 (Phase 7).
 *
 * StatDaily 적재가 본 임계 이상 정체된 광고주는 권고 생성 skip — 잘못된 데이터로 권고
 * 누적되는 사고 방지. 기준은 StatDaily.updatedAt 광고주별 max (recordSyncAt 미적재).
 *
 * 임계 30h 근거: stat-daily cron 은 KST 03:00 1회/일 + 광고주별 SA 보고서 빌드 폴링 ~5분.
 *   - 정상 운영 시 ageHours 가 24h 사이클로 변동 (KST 03:30 직전 ~24h, 직후 ~0).
 *   - 24h+α (폴링 지연/장애 여유 6h) = 30h 초과 = 전일자 적재 실패 1건만 검출.
 *   - 임계를 6h 등 짧게 두면 KST 02:00~03:30 슬롯에서 정상 광고주가 매일 stale 처리되는 운영 사고 발생.
 */
const STAT_STALENESS_HOURS = 30

export async function processAdvertiser(
  advertiserId: string,
  customerId: string,
): Promise<AdvertiserStats> {
  const stats: AdvertiserStats = {
    scanned: 0,
    budgetScanned: 0,
    created: 0,
    updated: 0,
    dismissed: 0,
    bundlesCreated: 0,
    bundlesDismissed: 0,
    singlesCreated: 0,
    singlesUpdated: 0,
    singlesDismissed: 0,
    stale: false,
    rankCandidatesScanned: 0,
    rankCreated: 0,
    rankUpdated: 0,
    rankHoldNotReached: 0,
    rankCappedAtMaxCpc: 0,
    rankEstimateFailed: 0,
    rankStaleDismissed: 0,
    adgroupRankCandidatesScanned: 0,
    adgroupRankCreated: 0,
    adgroupRankUpdated: 0,
    adgroupRankHoldNotReached: 0,
    adgroupRankCappedAtMaxCpc: 0,
    adgroupRankEstimateFailed: 0,
    adgroupRankStaleDismissed: 0,
  }

  // -- a. automation config 로드 (없거나 off 면 skip — 운영자 명시 활성화 필요) ---
  const cfg = await prisma.bidAutomationConfig.findUnique({
    where: { advertiserId },
  })
  if (!cfg || cfg.mode === "off") {
    return stats
  }

  // -- a-2. stat-daily stale 차단 (Phase 7) --------------------------------
  // 본 cron 은 StatDaily 7d groupBy 결과에 권고를 의존 — 적재가 정체된 광고주는
  // 잘못된 권고 생성 위험.
  //   1순위: Advertiser.lastSyncAt['stat_daily'] (stat-daily cron 적재 성공 시 갱신).
  //   2순위(fallback): StatDaily.updatedAt 광고주별 max — lastSyncAt 키 도입 전
  //     광고주 호환. 모든 광고주에 키가 채워지면 자연 소멸.
  // 신규 광고주 (어느 쪽도 없음) → skip 안 함. baseline 가드(KeywordPerformanceProfile
  // dataDays=0) 가 따로 처리.
  const adv = await prisma.advertiser.findUnique({
    where: { id: advertiserId },
    select: { lastSyncAt: true },
  })
  const lastSyncMap =
    adv?.lastSyncAt && typeof adv.lastSyncAt === "object" && !Array.isArray(adv.lastSyncAt)
      ? (adv.lastSyncAt as Record<string, string>)
      : {}
  const lastStatIso = lastSyncMap["stat_daily"]
  let lastStatTime: Date | null = lastStatIso ? new Date(lastStatIso) : null
  if (!lastStatTime) {
    const lastStat = await prisma.statDaily.findFirst({
      where: { advertiserId },
      select: { updatedAt: true },
      orderBy: { updatedAt: "desc" },
    })
    lastStatTime = lastStat?.updatedAt ?? null
  }
  if (lastStatTime) {
    const ageHours =
      (Date.now() - lastStatTime.getTime()) / (1000 * 60 * 60)
    if (ageHours > STAT_STALENESS_HOURS) {
      stats.stale = true
      return stats
    }
  }
  const targets: AutomationTargets = {
    targetCpc: cfg?.targetCpc ?? null,
    maxCpc: cfg?.maxCpc ?? null,
    minCtr: cfg?.minCtr ?? null,
    targetAvgRank: cfg?.targetAvgRank ?? null,
    targetCpa: cfg?.targetCpa ?? null,
    targetRoas: cfg?.targetRoas ?? null,
  }

  const budgetStats = await processBudgetSuggestions(advertiserId, {
    budgetPacingMode: cfg.budgetPacingMode,
    targetCpa: cfg.targetCpa ?? null,
    targetRoas: cfg.targetRoas ?? null,
  })
  stats.budgetScanned += budgetStats.scanned
  stats.created += budgetStats.created
  stats.updated += budgetStats.updated
  stats.dismissed += budgetStats.dismissed

  // -- c. baseline 로드 -----------------------------------------------------
  const kpp = await prisma.keywordPerformanceProfile.findUnique({
    where: { advertiserId },
  })
  if (!kpp || kpp.dataDays === 0) {
    return stats // baseline 없음 — bid 엔진만 다음 cron 까지 대기
  }
  const baseline: AdvertiserBaselineInput = {
    avgCtr: kpp.avgCtr,
    avgCvr: kpp.avgCvr,
    avgCpc: kpp.avgCpc,
  }
  const confidenceDays = Math.max(1, Math.min(kpp.dataDays, STATS_WINDOW_DAYS))
  const confidenceProgress =
    STATS_WINDOW_DAYS <= 1
      ? 1
      : (confidenceDays - 1) / (STATS_WINDOW_DAYS - 1)
  const confidenceConfig =
    confidenceDays < STATS_WINDOW_DAYS
      ? {
          minClicksForConfidence: Math.ceil(
            5 +
              (DEFAULT_MARGINAL_CONFIG.minClicksForConfidence - 5) *
                confidenceProgress,
          ),
          minImpressionsForConfidence: Math.ceil(
            100 +
              (DEFAULT_MARGINAL_CONFIG.minImpressionsForConfidence - 100) *
                confidenceProgress,
          ),
        }
      : undefined

  // -- e. TOP N — StatDaily level='keyword' 7일 cost 큰 순 -------------------
  const since = addDays(new Date(), -STATS_WINDOW_DAYS)
  const top = await prisma.statDaily.groupBy({
    by: ["refId"],
    where: {
      advertiserId,
      level: "keyword",
      date: { gte: since },
      // device 이중집계 방지 — 옵션 B (PC + MOBILE). 같은 (date, level, refId) 에
      // ALL 행이 공존하여 device 필터 누락 시 cost 가 ~2배로 부풀어 TOP N 권고 왜곡.
      ...STAT_DAILY_DEVICE_FILTER,
    },
    _sum: {
      impressions: true,
      clicks: true,
      cost: true,
      conversions: true,
      revenue: true,
    },
    _avg: { avgRnk: true },
    orderBy: { _sum: { cost: "desc" } },
    take: TOP_N,
  })

  if (top.length === 0) {
    // marginal 흐름 데이터 없음 — bid 엔진은 skip 하지만 rank 단계는 실행.
    // (rank 권고는 StatDaily TOP 의존 X — Keyword.recentAvgRnk 측정값 기반)
    const rankStatsOnly = await processRankSuggestions({
      advertiserId,
      customerId,
      targetAvgRank: cfg.targetAvgRank ?? null,
      maxCpc: cfg.maxCpc ?? null,
    })
    stats.rankCandidatesScanned += rankStatsOnly.candidatesScanned
    stats.rankCreated += rankStatsOnly.created
    stats.rankUpdated += rankStatsOnly.updated
    stats.rankHoldNotReached += rankStatsOnly.holdNotReached
    stats.rankCappedAtMaxCpc += rankStatsOnly.cappedAtMaxCpc
    stats.rankEstimateFailed += rankStatsOnly.estimateFailed
    stats.rankStaleDismissed += rankStatsOnly.staleDismissed
    stats.created += rankStatsOnly.created
    stats.updated += rankStatsOnly.updated

    // 광고그룹 단위 rank 권고 (Phase 2A) — top=0 분기에서도 실행
    const adgroupRankStatsOnly = await processAdgroupRankSuggestions({
      advertiserId,
      customerId,
      targetAvgRank: cfg.targetAvgRank ?? null,
      maxCpc: cfg.maxCpc ?? null,
    })
    stats.adgroupRankCandidatesScanned += adgroupRankStatsOnly.candidatesScanned
    stats.adgroupRankCreated += adgroupRankStatsOnly.created
    stats.adgroupRankUpdated += adgroupRankStatsOnly.updated
    stats.adgroupRankHoldNotReached += adgroupRankStatsOnly.holdNotReached
    stats.adgroupRankCappedAtMaxCpc += adgroupRankStatsOnly.cappedAtMaxCpc
    stats.adgroupRankEstimateFailed += adgroupRankStatsOnly.estimateFailed
    stats.adgroupRankStaleDismissed += adgroupRankStatsOnly.staleDismissed
    stats.created += adgroupRankStatsOnly.created
    stats.updated += adgroupRankStatsOnly.updated
    return stats
  }

  // -- f. Keyword 매핑 — adgroup name 까지 조인 (묶음 표시명 캐시) ----------
  const nccIds = top.map((t) => t.refId)
  const keywords = await prisma.keyword.findMany({
    where: {
      nccKeywordId: { in: nccIds },
      status: { not: "deleted" },
    },
    select: {
      id: true,
      nccKeywordId: true,
      bidAmt: true,
      useGroupBidAmt: true,
      userLock: true,
      adgroup: { select: { id: true, name: true } },
    },
  })
  const keywordMap = new Map(keywords.map((k) => [k.nccKeywordId, k]))

  // -- g. Pass 1 — 키워드별 결정 수집 ---------------------------------------
  const decisions: BundleInputDecision[] = []
  const heldKeywordIds: string[] = [] // hold + dismiss-eligible 키워드 (단건 정리용)

  for (const row of top) {
    stats.scanned++
    const k = keywordMap.get(row.refId)
    if (!k) continue
    if (k.userLock) continue
    if (k.useGroupBidAmt || k.bidAmt == null || k.bidAmt <= 0) continue

    const sum = row._sum
    const keywordPerf: KeywordPerfInput = {
      keywordId: k.id,
      nccKeywordId: k.nccKeywordId,
      currentBid: k.bidAmt,
      clicks7d: sum.clicks ?? 0,
      impressions7d: sum.impressions ?? 0,
      cost7d: sum.cost ? Number(sum.cost) : 0,
      conversions7d: sum.conversions ?? null,
      revenue7d: sum.revenue ? Number(sum.revenue) : null,
      avgRank7d: row._avg.avgRnk != null ? Number(row._avg.avgRnk) : null,
    }

    const decision: MarginalDecision = decideMarginalSuggestion({
      keyword: keywordPerf,
      baseline,
      targets,
      config: confidenceConfig,
    })

    if (decision.decision === "hold") {
      // hold 는 묶음 비대상 — 기존 단건 dismiss 흐름만 유지.
      if (decision.reason !== "low_confidence_data") {
        heldKeywordIds.push(k.id)
      }
      continue
    }

    decisions.push({
      decision,
      keywordId: k.id,
      adgroupId: k.adgroup.id,
      adgroupName: k.adgroup.name,
    })
  }

  // -- h. Pass 2 — 묶음 / 단건 분리 ------------------------------------------
  const { bundles, fallbackSingles } = bundleSuggestions(decisions)
  const expiresAt = addDays(new Date(), SUGGESTION_TTL_DAYS)

  // -- i. 기존 묶음 권고 supersede — 옵션 B (단순 / 변동 키워드 셋에 강건) ---
  // 같은 광고주의 status='pending' AND scope='adgroup' AND engineSource='bid' AND
  // action.kind='keyword_bid_bundle' 묶음을 dismiss 처리. 이번 cron 결과가 새로운 진실.
  // 묶음 키워드 셋이 변동돼도 안전.
  //
  // action.kind 필터 (Phase 2A) — 광고그룹 default bid 권고 (kind='adgroup_default_bid_update') 보호.
  // 같은 scope='adgroup' 행이지만 reasonCode 가 다른 행은 보존.
  const supersededBundles = await prisma.bidSuggestion.updateMany({
    where: {
      advertiserId,
      engineSource: "bid",
      scope: "adgroup",
      status: "pending",
      action: {
        path: ["kind"],
        equals: "keyword_bid_bundle",
      },
    },
    data: {
      status: "dismissed",
      reason: "superseded_by_new_bundle",
    },
  })
  stats.bundlesDismissed += supersededBundles.count
  stats.dismissed += supersededBundles.count

  // -- j. 묶음 신규 생성 -----------------------------------------------------
  for (const b of bundles) {
    const action = {
      kind: "keyword_bid_bundle",
      adgroupId: b.adgroupId,
      direction: b.direction,
      reasonCode: b.reasonCode,
      avgDeltaPct: b.avgDeltaPct,
      itemCount: b.items.length,
    } satisfies Prisma.InputJsonValue

    const reason =
      `${b.adgroupName} 광고그룹의 ${b.items.length}개 키워드 입찰가 ` +
      `${b.direction === "up" ? "인상" : "인하"} 권고 (평균 ±${b.avgDeltaPct.toFixed(1)}% / ${b.reasonCode})`

    await prisma.bidSuggestion.create({
      data: {
        advertiserId,
        keywordId: null,
        adgroupId: b.adgroupId,
        engineSource: "bid",
        action,
        reason,
        severity: b.maxSeverity,
        status: "pending",
        scope: "adgroup",
        affectedCount: b.items.length,
        targetName: b.adgroupName,
        itemsJson: b.items as unknown as Prisma.InputJsonValue,
        expiresAt,
      },
    })
    stats.bundlesCreated++
    stats.created++
  }

  // -- k. fallbackSingles 단건 BidSuggestion 적재 (기존 흐름 보존) ----------
  for (const fs of fallbackSingles) {
    if (fs.decision.decision !== "suggest") continue
    const existing = await prisma.bidSuggestion.findFirst({
      where: {
        keywordId: fs.keywordId,
        engineSource: "bid",
        scope: "keyword",
        status: "pending",
      },
      select: { id: true },
    })
    const data = {
      advertiserId,
      keywordId: fs.keywordId,
      adgroupId: fs.adgroupId,
      engineSource: "bid" as const,
      action: fs.decision.action as unknown as Prisma.InputJsonValue,
      reason: fs.decision.reason,
      severity: fs.decision.severity,
      status: "pending" as const,
      scope: "keyword" as const,
      affectedCount: 1,
      expiresAt,
    }
    if (existing) {
      await prisma.bidSuggestion.update({
        where: { id: existing.id },
        data: {
          action: data.action,
          reason: data.reason,
          severity: data.severity,
          expiresAt,
        },
      })
      stats.singlesUpdated++
      stats.updated++
    } else {
      await prisma.bidSuggestion.create({ data })
      stats.singlesCreated++
      stats.created++
    }
  }

  // -- l. hold 된 키워드의 기존 단건 pending dismiss --------------------------
  if (heldKeywordIds.length > 0) {
    const r = await prisma.bidSuggestion.updateMany({
      where: {
        keywordId: { in: heldKeywordIds },
        engineSource: "bid",
        scope: "keyword",
        status: "pending",
      },
      data: { status: "dismissed" },
    })
    stats.singlesDismissed += r.count
    stats.dismissed += r.count
  }

  // -- m. rank 권고 단계 — 5순위 미달 키워드 인상 권고 -----------------------
  // marginal/budget 흐름 후 별도 스캔. 같은 키워드의 marginal 권고가 있으면
  // rank 결과로 update 덮어쓰기 (사용자 의도: rank 우선).
  const rankStats = await processRankSuggestions({
    advertiserId,
    customerId,
    targetAvgRank: cfg.targetAvgRank ?? null,
    maxCpc: cfg.maxCpc ?? null,
  })
  stats.rankCandidatesScanned += rankStats.candidatesScanned
  stats.rankCreated += rankStats.created
  stats.rankUpdated += rankStats.updated
  stats.rankHoldNotReached += rankStats.holdNotReached
  stats.rankCappedAtMaxCpc += rankStats.cappedAtMaxCpc
  stats.rankEstimateFailed += rankStats.estimateFailed
  stats.rankStaleDismissed += rankStats.staleDismissed
  // 응답 호환 — 기존 created/updated 누적에도 합산.
  stats.created += rankStats.created
  stats.updated += rankStats.updated

  // -- n. 광고그룹 단위 rank 권고 (Phase 2A) ---------------------------------
  // useGroupBidAmt=true 키워드 보유 광고그룹의 평균 순위 미달 → AdGroup.bidAmt 인상 권고.
  // 키워드 단위 rank 권고와 별도 — 적용 단위가 다름 (그룹 default bid vs 키워드 bid).
  const adgroupRankStats = await processAdgroupRankSuggestions({
    advertiserId,
    customerId,
    targetAvgRank: cfg.targetAvgRank ?? null,
    maxCpc: cfg.maxCpc ?? null,
  })
  stats.adgroupRankCandidatesScanned += adgroupRankStats.candidatesScanned
  stats.adgroupRankCreated += adgroupRankStats.created
  stats.adgroupRankUpdated += adgroupRankStats.updated
  stats.adgroupRankHoldNotReached += adgroupRankStats.holdNotReached
  stats.adgroupRankCappedAtMaxCpc += adgroupRankStats.cappedAtMaxCpc
  stats.adgroupRankEstimateFailed += adgroupRankStats.estimateFailed
  stats.adgroupRankStaleDismissed += adgroupRankStats.staleDismissed
  stats.created += adgroupRankStats.created
  stats.updated += adgroupRankStats.updated

  return stats
}
