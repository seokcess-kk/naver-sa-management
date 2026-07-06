/**
 * Vercel Cron 핸들러 — 입찰 권고 (Phase B.2)
 *
 * 목적:
 *   - 광고주별 비용 TOP N 키워드에 대해 한계효용 권고 → BidSuggestion(Inbox) 적재
 *   - 운영 중인 캠페인의 5순위 미달 키워드 인상 권고 (Estimate 기반) → BidSuggestion(Inbox) 적재
 *   - 자동 SA 변경 X — 운영자 승인 후 ChangeBatch 흐름으로 적용 (Phase B.3 UI)
 *
 * 매시간 실행. cron 등록 (vercel.json):
 *   { "path": "/api/cron/bid-suggest", "schedule": "20 * * * *" }
 *   - 분 20 — alerts(0) / batch(매분) / stat-hourly(5) / auto-bidding(10) / sync-all(15) 와 분리
 *   - Authorization: Bearer ${CRON_SECRET} 자동 부착
 *
 * 동작:
 *   1. CRON_SECRET 검증 (불일치 시 401)
 *   2. 활성 광고주 조회 (status='active' AND biddingKillSwitch=false AND
 *      BidAutomationConfig.mode != 'off')
 *   3. 광고주 직렬 처리 — processAdvertiser (lib/bid-suggest/marginal) 가 광고주별
 *      budget / marginal / rank / 광고그룹 rank 엔진을 조율
 *   4. JSON 응답 (광고주별 통계)
 *
 * 구조 (순수 리팩터로 분해 — 동작 불변):
 *   - lib/bid-suggest/shared.ts       공통 타입 · 헬퍼 · 상수
 *   - lib/bid-suggest/budget.ts       캠페인 예산 권고 엔진
 *   - lib/bid-suggest/rank-keyword.ts 키워드 단위 5순위 미달 인상 권고
 *   - lib/bid-suggest/rank-adgroup.ts 광고그룹 default bid 인상 권고 (Phase 2A)
 *   - lib/bid-suggest/marginal.ts     광고주 1명 처리 (marginal / 묶음 + 엔진 조율)
 *   - route.ts (본 파일)              GET 오케스트레이션 (인증 · 광고주 조회 · 루프 · 응답 집계 · 알림)
 *
 * 정책:
 *   - BidSuggestion 키워드별 active pending engineSource='bid' 1개만 (코드 강제)
 *   - expiresAt = +7d 기본
 *   - BiddingPolicy 등록 키워드도 후보에 포함 — 권고(Inbox)는 정책 유무와 무관
 *
 * Vercel maxDuration:
 *   - Pro 900s 한도 → 800. 광고주 N <= ~13 + TOP 100 키워드 직렬 가정.
 *
 * SPEC: SPEC v0.2.1 F-11.2 + plan(graceful-sparking-graham) Phase B.2
 */

import { NextRequest, NextResponse } from "next/server"

import { prisma } from "@/lib/db/prisma"
import { dispatch } from "@/lib/notifier"
import { shouldThrottle } from "@/lib/notifier/throttle"

import { processAdvertiser } from "@/lib/bid-suggest/marginal"
import {
  safeError,
  type CronError,
  type CronResponse,
} from "@/lib/bid-suggest/shared"

// 예산 순수 함수 · 타입 재노출 — 기존 import 경로 호환 (budget-decision.test.ts 등).
export {
  clampBudgetChange,
  decideBudgetSuggestion,
  roundBudget,
} from "@/lib/bid-suggest/budget"
export type { BudgetConfig, BudgetDecision } from "@/lib/bid-suggest/budget"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 800

// =============================================================================
// 핵심 진입점
// =============================================================================

export async function GET(req: NextRequest): Promise<NextResponse<CronResponse>> {
  const ts = new Date().toISOString()

  // -- 1. CRON_SECRET 검증 ---------------------------------------------------
  const cronSecret = process.env.CRON_SECRET
  const auth = req.headers.get("authorization") ?? ""
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      {
        ok: false,
        advertisersTotal: 0,
        advertisersOk: 0,
        advertisersSkipped: 0,
        advertisersStale: 0,
        keywordsScanned: 0,
        budgetCampaignsScanned: 0,
        suggestionsCreated: 0,
        suggestionsUpdated: 0,
        suggestionsDismissed: 0,
        bundlesCreated: 0,
        bundlesDismissed: 0,
        singlesCreated: 0,
        singlesUpdated: 0,
        singlesDismissed: 0,
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
        ts,
        errors: [],
        error: "unauthorized",
      },
      { status: 401 },
    )
  }

  // -- 2. 활성 광고주 (mode='off' 제외 — config 없으면 default inbox 처리) ---
  // biddingKillSwitch=true 광고주는 SQL 단계에서 사전 제외 (긴급 정지 오버라이드).
  // auto-bidding cron 과 동일 시맨틱 — 켜지면 rank/marginal/budget/targeting 모든 엔진의
  // 권고 생성이 중단된다 (폭주 방지). mode 게이트와 독립: mode=평상시 on/off, killSwitch=긴급 정지.
  const advertisers = await prisma.advertiser.findMany({
    where: { status: "active", biddingKillSwitch: false },
    select: {
      id: true,
      name: true,
      customerId: true,
      bidAutomationConfig: { select: { mode: true } },
    },
    orderBy: { id: "asc" },
  })
  // kill switch 로 사전 제외된 활성 광고주 수 — 운영 가시성 로그 (권고 0 보장).
  const killSwitchedCount = await prisma.advertiser.count({
    where: { status: "active", biddingKillSwitch: true },
  })
  if (killSwitchedCount > 0) {
    console.log(
      `[cron/bid-suggest] biddingKillSwitch 로 ${killSwitchedCount}개 광고주 권고 생성 스킵`,
    )
  }
  // config 없거나 mode='off' 광고주 사전 제외 — processAdvertiser 가 한 번 더 가드.
  const eligible = advertisers.filter(
    (a) =>
      a.bidAutomationConfig != null &&
      a.bidAutomationConfig.mode !== "off",
  )

  // 본 cron run 시작 시각 — 광고주별 신규 BidSuggestion 카운트 기준점.
  // processAdvertiser 가 createdAt >= cronStartedAt 인 행만 "이번 run 신규" 로 판정.
  const cronStartedAt = new Date()

  // -- 3. 광고주 직렬 처리 ---------------------------------------------------
  let advertisersOk = 0
  let advertisersSkipped = 0
  let advertisersStale = 0
  let keywordsScanned = 0
  let budgetCampaignsScanned = 0
  let suggestionsCreated = 0
  let suggestionsUpdated = 0
  let suggestionsDismissed = 0
  let bundlesCreated = 0
  let bundlesDismissed = 0
  let singlesCreated = 0
  let singlesUpdated = 0
  let singlesDismissed = 0
  let rankCandidatesScanned = 0
  let rankCreated = 0
  let rankUpdated = 0
  let rankHoldNotReached = 0
  let rankCappedAtMaxCpc = 0
  let rankEstimateFailed = 0
  let rankStaleDismissed = 0
  let adgroupRankCandidatesScanned = 0
  let adgroupRankCreated = 0
  let adgroupRankUpdated = 0
  let adgroupRankHoldNotReached = 0
  let adgroupRankCappedAtMaxCpc = 0
  let adgroupRankEstimateFailed = 0
  let adgroupRankStaleDismissed = 0
  const errors: CronError[] = []

  for (const adv of eligible) {
    try {
      const r = await processAdvertiser(adv.id, adv.customerId)
      keywordsScanned += r.scanned
      budgetCampaignsScanned += r.budgetScanned
      suggestionsCreated += r.created
      suggestionsUpdated += r.updated
      suggestionsDismissed += r.dismissed
      bundlesCreated += r.bundlesCreated
      bundlesDismissed += r.bundlesDismissed
      singlesCreated += r.singlesCreated
      singlesUpdated += r.singlesUpdated
      singlesDismissed += r.singlesDismissed
      rankCandidatesScanned += r.rankCandidatesScanned
      rankCreated += r.rankCreated
      rankUpdated += r.rankUpdated
      rankHoldNotReached += r.rankHoldNotReached
      rankCappedAtMaxCpc += r.rankCappedAtMaxCpc
      rankEstimateFailed += r.rankEstimateFailed
      rankStaleDismissed += r.rankStaleDismissed
      adgroupRankCandidatesScanned += r.adgroupRankCandidatesScanned
      adgroupRankCreated += r.adgroupRankCreated
      adgroupRankUpdated += r.adgroupRankUpdated
      adgroupRankHoldNotReached += r.adgroupRankHoldNotReached
      adgroupRankCappedAtMaxCpc += r.adgroupRankCappedAtMaxCpc
      adgroupRankEstimateFailed += r.adgroupRankEstimateFailed
      adgroupRankStaleDismissed += r.adgroupRankStaleDismissed
      if (r.stale) advertisersStale++
      else if (
        r.scanned > 0 ||
        r.budgetScanned > 0 ||
        r.rankCandidatesScanned > 0 ||
        r.adgroupRankCandidatesScanned > 0
      )
        advertisersOk++
      else advertisersSkipped++

      // -- bid_suggestion_new 알림 (Event 1) ---------------------------------
      // 본 cron run 에서 status='pending' 으로 신규 생성된 BidSuggestion 이 1+ 면
      // 광고주당 1회 dispatch. 광고주별 1 cron 1 dispatch (cron 매시간 = 광고주당
      // 시간당 최대 1회 — 자연 throttle).
      if (r.created > 0) {
        await maybeNotifyBidSuggestionNew({
          advertiserId: adv.id,
          advertiserName: adv.name,
          customerId: adv.customerId,
          cronStartedAt,
        })
      }
    } catch (e) {
      const message = safeError(e)
      errors.push({ advertiserId: adv.id, message })
      console.error(
        `[cron/bid-suggest] advertiser=${adv.id} failed: ${message}`,
      )
    }
  }

  return NextResponse.json({
    ok: true,
    advertisersTotal: eligible.length,
    advertisersOk,
    advertisersSkipped,
    advertisersStale,
    keywordsScanned,
    budgetCampaignsScanned,
    suggestionsCreated,
    suggestionsUpdated,
    suggestionsDismissed,
    bundlesCreated,
    bundlesDismissed,
    singlesCreated,
    singlesUpdated,
    singlesDismissed,
    rankCandidatesScanned,
    rankCreated,
    rankUpdated,
    rankHoldNotReached,
    rankCappedAtMaxCpc,
    rankEstimateFailed,
    rankStaleDismissed,
    adgroupRankCandidatesScanned,
    adgroupRankCreated,
    adgroupRankUpdated,
    adgroupRankHoldNotReached,
    adgroupRankCappedAtMaxCpc,
    adgroupRankEstimateFailed,
    adgroupRankStaleDismissed,
    ts,
    errors,
  })
}

// =============================================================================
// maybeNotifyBidSuggestionNew — 본 cron run 신규 BidSuggestion 알림 (Event 1)
// =============================================================================
//
// 동작:
//   - status='pending' AND createdAt >= cronStartedAt AND advertiserId 매치 행 조회
//   - count / groupCount(adgroupId distinct, null 제외) / sample 키워드 텍스트 추출
//   - count===0 이면 발송 생략 (호출부가 r.created>0 가드. 방어 코드)
//   - dispatch payload: 광고주명 / 카운트 / 묶음 그룹 수 / sampleKeywords (시크릿 X)
//   - throttle: 광고주별 50분 키 — 광고주당 시간당 최대 1회 (cron schedule 매시간 분 20)
//
// 시크릿 정책:
//   - title/body/meta 에 BOT_TOKEN / API key 평문 X
//   - sampleKeywords 는 키워드 텍스트만 (외부 검색어 — 시크릿 아님)
//
// 실패 격리:
//   - dispatch throw 는 호출부 try/catch 가 흡수 — cron 다른 광고주 진행 막지 않음.

async function maybeNotifyBidSuggestionNew(args: {
  advertiserId: string
  advertiserName: string
  customerId: string
  cronStartedAt: Date
}): Promise<void> {
  const { advertiserId, advertiserName, customerId, cronStartedAt } = args

  // 50분 throttle — cron schedule "20 * * * *" 매시간 1회. 50분이면 다음 cron 시점에 풀림.
  const throttled = await shouldThrottle(
    `nsa:notify:bid_suggestion_new:${advertiserId}`,
    50 * 60,
  )
  if (throttled) return

  const fresh = await prisma.bidSuggestion.findMany({
    where: {
      advertiserId,
      status: "pending",
      createdAt: { gte: cronStartedAt },
    },
    select: {
      adgroupId: true,
      keywordId: true,
      // targetName 은 묶음 권고의 광고그룹명 캐시 — sample 표시에 적합
      targetName: true,
      keyword: { select: { keyword: true } },
    },
    take: 200, // 묶음 + 단건 합산 — 알림 sample 추출용 캡 (전체 카운트는 r.created 기준)
  })

  if (fresh.length === 0) {
    // r.created>0 인데 조회 0 — 다른 cron 의 cleanup 으로 사라진 케이스. 발송 스킵.
    return
  }

  const count = fresh.length
  const groupSet = new Set<string>()
  for (const s of fresh) {
    if (s.adgroupId) groupSet.add(s.adgroupId)
  }
  const groupCount = groupSet.size

  const sampleKeywords: string[] = []
  for (const s of fresh) {
    const kw = s.keyword?.keyword ?? s.targetName
    if (kw && !sampleKeywords.includes(kw)) {
      sampleKeywords.push(kw)
      if (sampleKeywords.length >= 3) break
    }
  }

  console.info(
    `[cron/bid-suggest] notify bid_suggestion_new advertiser=${advertiserId} count=${count} groupCount=${groupCount}`,
  )

  await dispatch({
    ruleType: "bid_suggestion_new",
    severity: "info",
    title: `신규 권고 ${count}건 (광고주 ${advertiserName})`,
    body:
      `광고그룹 ${groupCount}개 / 전체 ${count}건. ` +
      `운영 Inbox 에서 확인 후 적용/거절`,
    meta: {
      advertiserId,
      customerId,
      count,
      groupCount,
      sampleKeywords,
    },
  })
}
