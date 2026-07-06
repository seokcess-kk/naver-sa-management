/**
 * bid-suggest cron — 광고그룹 default bid 인상 권고 엔진 (Phase 2A).
 *
 * app/api/cron/bid-suggest/route.ts 분해 (순수 구조 리팩터) 로 추출.
 * BidSuggestion(scope='adgroup', action.kind='adgroup_default_bid_update') 적재.
 * 로직 · 시그니처 불변.
 *
 * 트리거:
 *   - 광고그룹 단위 평균 노출 순위 미달 (target 디폴트 5위) → AdGroup.bidAmt 인상 권고
 *   - 적용 단위: useGroupBidAmt=true 키워드 (그룹입찰가 사용)
 *
 * 후보 추출:
 *   - 운영 중 (Campaign.status='on' AND AdGroup.status='on')
 *   - AdGroup.bidAmt > 0
 *   - useGroupBidAmt=true / userLock=false / status='on' 키워드 1+ 보유
 *   - 그 키워드의 last non-null recentAvgRnk > target (1차 SQL 컷)
 *
 * effectiveRank 산출:
 *   - 광고그룹의 last non-null Keyword.recentAvgRnk 단순 평균 (일별 측정값 — 시간대별 순위 SA 미제공)
 *
 * effectiveRank > target 인 광고그룹만 enriched. desc 정렬 + cap.
 *
 * 대표 키워드 선정:
 *   - useGroupBidAmt=true 키워드 중 첫 키워드 (Estimate 호출 대상)
 *
 * 처리:
 *   - 대표 키워드로 PC Estimate (캐시 우선)
 *   - decideAdgroupRankSuggestion → suggest 면 BidSuggestion upsert
 *     (scope='adgroup', engineSource='bid', action.kind='adgroup_default_bid_update')
 *   - 같은 광고그룹의 같은 kind pending 행만 update (kind='keyword_bid_bundle' 묶음 권고는 별개)
 *   - Estimate throw 흡수 → adgroupRankEstimateFailed++
 *
 * stale 정리: 후보에서 빠진 광고그룹의 reasonCode='adgroup_below_target_rank' pending dismiss.
 */

import { prisma } from "@/lib/db/prisma"
import { decideAdgroupRankSuggestion } from "@/lib/auto-bidding/decide-rank"
import { getCachedAveragePositionBid } from "@/lib/auto-bidding/estimate-cached"
import type { AveragePositionBidRow } from "@/lib/naver-sa/estimate"
import type * as Prisma from "@/lib/generated/prisma/internal/prismaNamespace"

import {
  addDays,
  BID_RANK_DEVICE_SCOPE,
  safeError,
  SUGGESTION_TTL_DAYS,
} from "./shared"

/**
 * 광고그룹 단위 rank 권고 단계 — 광고주당 후보 광고그룹 상한 (Phase 2A).
 *
 * 키워드 단위와 별도 cap — 광고그룹은 키워드보다 카디널리티가 작으나 (수십 ~ 수백)
 * 메모리 가중평균 보정 / Estimate 호출 부담은 비슷. 기본 200 — 광고주당 시간당
 * 최대 200건 Estimate 호출. 캐시 hit 시 절반 이하.
 *
 * env 가드 — NaN / 음수 / 0 / 너무 큰 값 방어. 1~5000 범위 클램프 (W3 패턴).
 */
const BID_RANK_ADGROUP_PER_ADV_CAP = (() => {
  const raw = Number(process.env.BID_RANK_ADGROUP_PER_ADV_CAP ?? "200")
  if (!Number.isFinite(raw) || raw <= 0) return 200
  return Math.min(5000, Math.max(1, Math.floor(raw)))
})()

export type AdgroupRankStats = {
  candidatesScanned: number
  created: number
  updated: number
  holdNotReached: number
  cappedAtMaxCpc: number
  estimateFailed: number
  staleDismissed: number
}

export async function processAdgroupRankSuggestions(args: {
  advertiserId: string
  customerId: string
  targetAvgRank: number | Prisma.Decimal | null
  maxCpc: number | null
}): Promise<AdgroupRankStats> {
  const {
    advertiserId,
    customerId,
    targetAvgRank,
    maxCpc,
  } = args
  const stats: AdgroupRankStats = {
    candidatesScanned: 0,
    created: 0,
    updated: 0,
    holdNotReached: 0,
    cappedAtMaxCpc: 0,
    estimateFailed: 0,
    staleDismissed: 0,
  }

  const target =
    targetAvgRank == null
      ? 5
      : typeof targetAvgRank === "number"
        ? targetAvgRank
        : Number(targetAvgRank)

  // -- 후보 추출 ------------------------------------------------------------
  // 1차 SQL 컷: 광고그룹 내 useGroupBidAmt=true 키워드의 last non-null recentAvgRnk > target.
  // 가중평균 미달 광고그룹 OR 후보 SQL 확장은 1차 PR 비대상 — 메모리 보정으로 effectiveRank 결정.
  const adgroups = await prisma.adGroup.findMany({
    where: {
      campaign: { is: { advertiserId, status: "on" } },
      status: "on",
      bidAmt: { not: null, gt: 0 },
      keywords: {
        some: {
          status: "on",
          useGroupBidAmt: true,
          userLock: false,
          recentAvgRnk: { not: null, gt: target },
        },
      },
    },
    select: {
      id: true,
      nccAdgroupId: true,
      name: true,
      bidAmt: true,
      keywords: {
        where: {
          status: "on",
          useGroupBidAmt: true,
          userLock: false,
        },
        select: {
          id: true,
          nccKeywordId: true,
          keyword: true,
          recentAvgRnk: true,
        },
      },
    },
    take: BID_RANK_ADGROUP_PER_ADV_CAP * 2,
  })

  // -- effectiveRank 산출 + 메모리 cap --------------------------------------
  type EnrichedAdgroup = {
    adgroup: (typeof adgroups)[number]
    effectiveRank: number
    /** 대표 키워드 (Estimate 호출 대상). useGroupBidAmt=true 키워드 중 첫 키워드. */
    representativeKeyword: (typeof adgroups)[number]["keywords"][number]
    /** useGroupBidAmt=true 키워드 수 (affectedCount). */
    affectedCount: number
  }
  const enriched: EnrichedAdgroup[] = []
  for (const ag of adgroups) {
    if (ag.keywords.length === 0) continue
    if (ag.bidAmt == null || ag.bidAmt <= 0) continue

    // -- effectiveRank — last non-null Keyword.recentAvgRnk 단순 평균 ---------
    // (시간대별 순위는 SA 미제공 — 과거 StatHourly 가중평균 경로는 영구 null 이라 제거됨.)
    const ranks = ag.keywords
      .map((k) => (k.recentAvgRnk == null ? null : Number(k.recentAvgRnk)))
      .filter((r): r is number => r != null && Number.isFinite(r) && r > 0)
    if (ranks.length === 0) continue
    const effectiveRank = ranks.reduce((s, r) => s + r, 0) / ranks.length
    if (!Number.isFinite(effectiveRank) || effectiveRank <= target) continue

    // 대표 키워드 = useGroupBidAmt=true 키워드 중 첫 키워드 (Estimate 호출 대상).
    const representative = ag.keywords[0]

    enriched.push({
      adgroup: ag,
      effectiveRank,
      representativeKeyword: representative,
      affectedCount: ag.keywords.length,
    })
  }
  enriched.sort((a, b) => b.effectiveRank - a.effectiveRank)
  const limited = enriched.slice(0, BID_RANK_ADGROUP_PER_ADV_CAP)

  const expiresAt = addDays(new Date(), SUGGESTION_TTL_DAYS)

  for (const cand of limited) {
    const { adgroup, effectiveRank, representativeKeyword, affectedCount } = cand
    stats.candidatesScanned++
    if (adgroup.bidAmt == null || adgroup.bidAmt <= 0) continue

    // -- Estimate 호출 (PC + MOBILE) — 대표 키워드로 ------------------------
    // PC throw → 광고그룹 1건 흡수. MOBILE 만 throw → PC 결과로 진행 (가용성 우선).
    let estimateRowsPc: AveragePositionBidRow[]
    try {
      const cached = await getCachedAveragePositionBid({
        advertiserId,
        customerId,
        keywordId: representativeKeyword.id,
        keywordText: representativeKeyword.keyword,
        device: "PC",
      })
      estimateRowsPc = cached.data
    } catch (e) {
      stats.estimateFailed++
      console.warn(
        `[cron/bid-suggest] adgroup rank estimate (PC) failed advertiser=${advertiserId} adgroup=${adgroup.id} keyword=${representativeKeyword.id}: ${safeError(e)}`,
      )
      continue
    }

    let estimateRowsMobile: AveragePositionBidRow[] | undefined
    if (BID_RANK_DEVICE_SCOPE === "BOTH") {
      try {
        const cached = await getCachedAveragePositionBid({
          advertiserId,
          customerId,
          keywordId: representativeKeyword.id,
          keywordText: representativeKeyword.keyword,
          device: "MOBILE",
        })
        estimateRowsMobile = cached.data
      } catch (e) {
        console.warn(
          `[cron/bid-suggest] adgroup rank estimate (MOBILE) failed advertiser=${advertiserId} adgroup=${adgroup.id} keyword=${representativeKeyword.id}: ${safeError(e)}`,
        )
      }
    }

    // -- 결정 -----------------------------------------------------------------
    // 가중평균 경로 제거 — rankWindowHours / rankSampleImpressions 은 항상 null.
    const decision = decideAdgroupRankSuggestion({
      adgroup: {
        adgroupId: adgroup.id,
        nccAdgroupId: adgroup.nccAdgroupId,
        currentBid: adgroup.bidAmt,
        recentAvgRnk: effectiveRank,
      },
      targetAvgRank,
      maxCpc,
      estimateRows: estimateRowsPc,
      estimateRowsMobile,
      rankWindowHours: null,
      rankSampleImpressions: null,
    })

    if (decision.decision === "hold") {
      if (decision.reason === "capped_at_max_cpc") {
        stats.cappedAtMaxCpc++
      } else {
        stats.holdNotReached++
      }
      continue
    }

    // -- reason suffix (affectedCount) --------------------------------------
    const reason = `${decision.reason} (광고그룹 ${affectedCount}개 키워드 / 최근 1시간 측정값 단순 평균)`

    // -- upsert (같은 광고그룹의 같은 kind pending 행만 1개 보장) -------------
    // 묶음 권고 (kind='keyword_bid_bundle') 와 광고그룹 default bid 권고 (kind='adgroup_default_bid_update')
    // 는 같은 scope='adgroup' 행이지만 kind 가 다름 → action.kind path 매칭으로 분리.
    const existing = await prisma.bidSuggestion.findFirst({
      where: {
        adgroupId: adgroup.id,
        engineSource: "bid",
        scope: "adgroup",
        status: "pending",
        action: {
          path: ["kind"],
          equals: "adgroup_default_bid_update",
        },
      },
      select: { id: true },
    })

    const data = {
      advertiserId,
      keywordId: null,
      adgroupId: adgroup.id,
      engineSource: "bid" as const,
      action: decision.action as unknown as Prisma.InputJsonValue,
      reason,
      severity: decision.severity,
      status: "pending" as const,
      scope: "adgroup" as const,
      affectedCount,
      targetName: adgroup.name,
      expiresAt,
    }

    if (existing) {
      await prisma.bidSuggestion.update({
        where: { id: existing.id },
        data: {
          action: data.action,
          reason: data.reason,
          severity: data.severity,
          targetName: data.targetName,
          affectedCount: data.affectedCount,
          expiresAt,
        },
      })
      stats.updated++
    } else {
      await prisma.bidSuggestion.create({ data })
      stats.created++
    }
  }

  // -- stale 정리 (W4) ------------------------------------------------------
  // 이번 cron run 에서 effectiveRank > target 후보로 진입한 광고그룹 (`enriched`) 만
  // handledAdgroupIds 로 보존. 그 외 광고그룹 (도달 / 비활성화 / bidAmt=0) 의 기존
  // adgroup_below_target_rank pending 권고는 stale → dismiss.
  //
  // action JSON path 매칭 (`reasonCode='adgroup_below_target_rank'`) 으로 묶음 권고
  // (`reasonCode` 다름) 보존.
  const handledAdgroupIds = enriched.map((e) => e.adgroup.id)
  const staleResult = await prisma.bidSuggestion.updateMany({
    where: {
      advertiserId,
      engineSource: "bid",
      scope: "adgroup",
      status: "pending",
      adgroupId: { notIn: handledAdgroupIds },
      action: {
        path: ["reasonCode"],
        equals: "adgroup_below_target_rank",
      },
    },
    data: { status: "dismissed" },
  })
  stats.staleDismissed = staleResult.count

  return stats
}
