/**
 * bid-suggest cron — 키워드 단위 5순위 미달 인상 권고 엔진 (Phase B.2 rank step).
 *
 * app/api/cron/bid-suggest/route.ts 분해 (순수 구조 리팩터) 로 추출.
 * BidSuggestion(scope='keyword', engineSource='bid') 적재. 로직 · 시그니처 불변.
 *
 * 진입 가정 (호출부):
 *   - BidAutomationConfig.mode != 'off' (이미 가드)
 *   - stat-daily stale 가드 통과
 *   - cfg.targetAvgRank 정규화는 decideRankSuggestion 내부 처리 (NULL → 5)
 *
 * 후보 추출:
 *   - 운영 중 (Campaign.status='on' AND AdGroup.status='on' AND Keyword.status='on')
 *   - useGroupBidAmt=false / userLock=false / bidAmt > 0 (명시 입찰만)
 *   - recentAvgRnk > targetAvgRank (목표 미달)
 *   - BiddingPolicy.enabled=true 키워드 제외 (auto-bidding cron 책임)
 *   - 광고주당 BID_RANK_PER_ADV_CAP 상한 — recentAvgRnk desc (가장 미달인 키워드 우선)
 *
 * 처리:
 *   - Estimate API (PC) 호출 — 30분 캐시 우선 (estimate-cached.ts)
 *   - decideRankSuggestion → suggest 면 BidSuggestion upsert (scope='keyword', engineSource='bid')
 *   - 같은 키워드의 marginal 흐름 권고가 있어도 update 으로 덮어쓰기 (rank 우선 정책)
 *   - Estimate throw 는 키워드 단위 흡수 → rankEstimateFailed++
 */

import { prisma } from "@/lib/db/prisma"
import { decideRankSuggestion } from "@/lib/auto-bidding/decide-rank"
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
 * rank 권고 단계 — 광고주당 후보 키워드 상한.
 *
 * 매시간 cron 1회 × Estimate 호출 1회/키워드 = 광고주당 시간당 최대 ~500건 (env override 가능).
 * 캐시 hit 률이 높아지면 (30분 TTL) 실효 SA 호출은 절반 이하.
 * 광고주 ~10명 가정 시 시간당 ~5,000건 / 30분 캐시 hit 후 ~2,500건 — 안전 범위.
 */
const BID_RANK_PER_ADV_CAP = Number(process.env.BID_RANK_PER_ADV_CAP ?? "500")

export type RankSuggestionStats = {
  candidatesScanned: number
  created: number
  updated: number
  holdNotReached: number
  cappedAtMaxCpc: number
  estimateFailed: number
  /**
   * stale 정리 — 이번 cron run 에서 effectiveRank > target 후보로 진입하지 않은
   * 키워드의 기존 `reasonCode='below_target_rank'` pending 권고를 dismiss 처리한 수.
   * 사유: 5위 도달 / 비활성화 / 그룹입찰 전환 / 정책 등록 / userLock / 캠페인 OFF 등.
   * marginal 권고 (다른 reasonCode) 는 action.reasonCode JSON path 매칭으로 보존.
   */
  staleDismissed: number
}

export async function processRankSuggestions(args: {
  advertiserId: string
  customerId: string
  targetAvgRank: number | Prisma.Decimal | null
  maxCpc: number | null
  policyKeywordIds: Set<string>
}): Promise<RankSuggestionStats> {
  const {
    advertiserId,
    customerId,
    targetAvgRank,
    maxCpc,
    policyKeywordIds,
  } = args
  const stats: RankSuggestionStats = {
    candidatesScanned: 0,
    created: 0,
    updated: 0,
    holdNotReached: 0,
    cappedAtMaxCpc: 0,
    estimateFailed: 0,
    staleDismissed: 0,
  }

  // -- 후보 추출 ------------------------------------------------------------
  // schema.prisma 기준 enum 값:
  //   KeywordStatus / AdGroupStatus / CampaignStatus = 'on' / 'off' / 'deleted'
  // BiddingPolicy 는 1:N (Keyword.biddingPolicies) — Set 차단 (호출부가 전달).
  // recentAvgRnk Decimal 비교: targetAvgRank Number 정규화 후 prisma.Decimal 비교 가능하도록
  // findMany 에서 raw Decimal 그대로 받고 decideRankSuggestion 호출 직전 Number 변환.
  const target =
    targetAvgRank == null
      ? 5
      : typeof targetAvgRank === "number"
        ? targetAvgRank
        : Number(targetAvgRank)

  // rank 후보는 Keyword.recentAvgRnk (일별 last non-null 측정값) 기준.
  // (시간대별 순위는 SA 미제공 — 과거 StatHourly 6h 가중평균 경로는 영구 null 이라 제거됨.)
  const candidates = await prisma.keyword.findMany({
    where: {
      adgroup: {
        is: {
          status: "on",
          campaign: { is: { status: "on" } },
        },
      },
      status: "on",
      useGroupBidAmt: false,
      userLock: false,
      bidAmt: { not: null, gt: 0 },
      recentAvgRnk: { not: null, gt: target },
    },
    select: {
      id: true,
      nccKeywordId: true,
      keyword: true,
      bidAmt: true,
      recentAvgRnk: true,
      adgroup: {
        select: {
          id: true,
          name: true,
          campaign: { select: { advertiserId: true } },
        },
      },
    },
    // recentAvgRnk desc (가장 미달인 키워드 우선) + 광고주당 cap.
    orderBy: { recentAvgRnk: "desc" },
    take: BID_RANK_PER_ADV_CAP,
  })

  // 광고주 횡단 차단 — Keyword 에는 advertiserId 없음. AdGroup -> Campaign.advertiserId 비교.
  // schema 상 adgroup.campaign 은 항상 존재하지만 일부 mock 구성 (campaign 필드 누락) 방어.
  const filtered = candidates.filter(
    (k) =>
      k.adgroup?.campaign?.advertiserId === advertiserId &&
      !policyKeywordIds.has(k.id),
  )

  // filtered.length === 0 이어도 마지막 stale dismiss (W4) 흐름까지 도달해야 함.
  // 모든 운영 중 키워드가 5위 도달했거나 비활성화된 경우 — 기존 below_target_rank pending 정리.

  // -- effectiveRank 산출 + 메모리 정렬·cap ----------------------------------
  // effectiveRank = Keyword.recentAvgRnk (일별 측정값). effectiveRank <= target 은 컷
  // (SQL 에서 > target 만 통과하지만 방어적으로 재확인).
  type EnrichedCandidate = {
    k: (typeof filtered)[number]
    effectiveRank: number
  }
  const enriched: EnrichedCandidate[] = []
  for (const k of filtered) {
    if (k.recentAvgRnk == null) continue
    const effectiveRank = Number(k.recentAvgRnk)
    if (!Number.isFinite(effectiveRank) || effectiveRank <= target) continue
    enriched.push({ k, effectiveRank })
  }
  enriched.sort((a, b) => b.effectiveRank - a.effectiveRank)
  const limited = enriched.slice(0, BID_RANK_PER_ADV_CAP)

  // limited.length === 0 도 stale dismiss 흐름까지 도달 (W4).
  const expiresAt = addDays(new Date(), SUGGESTION_TTL_DAYS)

  for (const cand of limited) {
    const { k, effectiveRank } = cand
    stats.candidatesScanned++
    if (k.bidAmt == null || k.bidAmt <= 0) continue

    // -- Estimate 호출 (PC + MOBILE) — 키워드 단위 try/catch ----------------
    // PC throw 시 키워드 1건 흡수 (기존 흐름). MOBILE 만 throw 시 PC 결과로 진행 (가용성 fallback).
    let estimateRowsPc: AveragePositionBidRow[]
    try {
      const cached = await getCachedAveragePositionBid({
        advertiserId,
        customerId,
        keywordId: k.id,
        keywordText: k.keyword,
        device: "PC",
      })
      estimateRowsPc = cached.data
    } catch (e) {
      stats.estimateFailed++
      console.warn(
        `[cron/bid-suggest] rank estimate (PC) failed advertiser=${advertiserId} keyword=${k.id}: ${safeError(e)}`,
      )
      continue
    }

    let estimateRowsMobile: AveragePositionBidRow[] | undefined
    if (BID_RANK_DEVICE_SCOPE === "BOTH") {
      try {
        const cached = await getCachedAveragePositionBid({
          advertiserId,
          customerId,
          keywordId: k.id,
          keywordText: k.keyword,
          device: "MOBILE",
        })
        estimateRowsMobile = cached.data
      } catch (e) {
        // MOBILE 호출만 실패 → PC 만으로 진행 (가용성 우선). 카운트는 PC와 통합 — 1차 PR.
        console.warn(
          `[cron/bid-suggest] rank estimate (MOBILE) failed advertiser=${advertiserId} keyword=${k.id}: ${safeError(e)}`,
        )
      }
    }

    // -- 결정 ----------------------------------------------------------------
    // effectiveRank(= Keyword.recentAvgRnk) 를 decideRankSuggestion 에 전달.
    // 시간대별 가중평균 경로 제거 — rankWindowHours / rankSampleImpressions 은 항상 null.
    const decision = decideRankSuggestion({
      keyword: {
        keywordId: k.id,
        nccKeywordId: k.nccKeywordId,
        currentBid: k.bidAmt,
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
      // capped_at_max_cpc 는 별도 카운트 — Phase 2 'unreachable' 표시 가능성.
      if (decision.reason === "capped_at_max_cpc") {
        stats.cappedAtMaxCpc++
      } else {
        stats.holdNotReached++
      }
      continue
    }

    // -- reason 본문 출처 suffix (텔레그램 / 감사 로그용) ---------------------
    const reason = `${decision.reason} (최근 평균 순위 측정값)`

    // -- 적재 (upsert: 같은 키워드 pending 1개 보장) ------------------------
    // marginal 권고 (engineSource='bid', scope='keyword', status='pending') 가 있으면
    // 같은 row 를 rank 결과로 덮어쓴다. 사용자 의도: rank 우선.
    const existing = await prisma.bidSuggestion.findFirst({
      where: {
        keywordId: k.id,
        engineSource: "bid",
        scope: "keyword",
        status: "pending",
      },
      select: { id: true },
    })

    const data = {
      advertiserId,
      keywordId: k.id,
      adgroupId: k.adgroup.id,
      engineSource: "bid" as const,
      action: decision.action as unknown as Prisma.InputJsonValue,
      reason,
      severity: decision.severity,
      status: "pending" as const,
      scope: "keyword" as const,
      affectedCount: 1,
      expiresAt,
    }

    if (existing) {
      await prisma.bidSuggestion.update({
        where: { id: existing.id },
        data: {
          adgroupId: data.adgroupId,
          action: data.action,
          reason: data.reason,
          severity: data.severity,
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
  // 이번 cron run 에서 effectiveRank > target 후보로 진입한 키워드 (`enriched`) 만
  // handledKeywordIds 로 보존 — cap 에 안 들어가 처리 안 된 키워드도 미달은 미달 → 보존.
  // 그 외 키워드 (도달 / 비활성화 / 그룹입찰 / 정책 등록 / userLock / 광고그룹·캠페인 OFF) 는
  // 후보 SQL 에서 빠져 enriched 에도 없음 → 기존 below_target_rank pending 권고는 stale.
  //
  // action JSON path 매칭 (`reasonCode='below_target_rank'`) 으로 marginal 권고 (다른
  // reasonCode 또는 reasonCode 부재) 는 영향 없음 — 광고주 격리 + scope='keyword' + status='pending'
  // 으로 광고주 횡단 / 묶음 / dismissed 이력 보호.
  const handledKeywordIds = enriched.map((e) => e.k.id)
  const staleResult = await prisma.bidSuggestion.updateMany({
    where: {
      advertiserId,
      engineSource: "bid",
      scope: "keyword",
      status: "pending",
      keywordId: { notIn: handledKeywordIds },
      action: {
        path: ["reasonCode"],
        equals: "below_target_rank",
      },
    },
    data: { status: "dismissed" },
  })
  stats.staleDismissed = staleResult.count

  return stats
}
