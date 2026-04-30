/**
 * 이상 징후 알림 평가기 (F-8.x — P1 4종)
 *
 * 본 모듈 스코프:
 *   - 4종 평가기를 각각 export. Cron 핸들러(app/api/cron/alerts/route.ts)가 rule.type 에 따라 분기 호출.
 *   - 각 평가기는 광고주 컨텍스트(EvalContext) + AlertRule (params) 받아 AlertCandidate[] 반환.
 *   - candidate 는 발송 후보일 뿐 — 실제 발송/적재/음소거는 Cron 책임.
 *   - 평가기 내부에서 fetch/HTTP 직접 호출 X. 항상 lib/naver-sa/* 통과.
 *   - SA 호출 실패는 candidate 생성으로 변환 (api_auth_error 평가기). 그 외 평가기는 throw 허용
 *     (Cron 이 console.error + 다음 rule 계속).
 *
 * candidate.muteKey:
 *   - 같은 키로 1시간 내 재발송 차단 (Cron 의 음소거 검사가 사용).
 *   - 동일 광고주 + 동일 객체 + 동일 임계 단위로 키를 분리.
 *
 * 시크릿 운영:
 *   - 자격증명은 lib/naver-sa/credentials.ts 가 처리. 본 모듈은 customerId 만 다룸.
 *   - candidate.body / meta 에 평문 키·시크릿 X.
 */

import { prisma } from "@/lib/db/prisma"
import { getStats } from "@/lib/naver-sa/stats"
import { getBizmoney } from "@/lib/naver-sa/billing"
import { NaverSaError } from "@/lib/naver-sa/errors"

// =============================================================================
// 공용 타입
// =============================================================================

/**
 * 평가기 입력 컨텍스트.
 *
 * Cron 핸들러가 rule.params.advertiserId → Advertiser 조회 후 채움.
 * - hasKeys=false 광고주는 Cron 단계에서 skip 되므로 본 모듈 진입 시 항상 true 가정.
 */
export type EvalContext = {
  advertiserId: string
  customerId: string
  hasKeys: boolean
}

/** 평가기 출력 — 발송 후보 1개. */
export type AlertCandidate = {
  ruleType: string
  severity: "info" | "warn" | "critical"
  title: string
  body: string
  meta: Record<string, unknown>
  /** 1시간 내 같은 키 재발송 차단 (Cron 음소거 검사가 사용). */
  muteKey: string
}

/** AlertRule 의 슬라이스 (params 타입은 평가기별로 다름). */
type RuleSlice<P> = {
  id: string
  type: string
  params: P
}

// =============================================================================
// 1. budget_burn — 캠페인 일 예산 소진 임계 (50/80/100%)
// =============================================================================

/** budget_burn rule.params shape. */
export type BudgetBurnParams = {
  /** 임계치 (%) 배열. 기본 [50, 80, 100]. 0 < x <= 1000 범위. */
  thresholds?: number[]
}

/**
 * 캠페인별 오늘 비용 / dailyBudget 비율을 임계 단계와 비교.
 *
 * - dailyBudget == null 캠페인은 제외 (예산 미설정 = 임계 의미 없음)
 * - status='deleted' 제외 (활성 / 일시중지(off)는 포함 — 일시중지여도 누적 비용은 발생할 수 있음)
 * - getStats(today, salesAmt) 광고주 한정. ids 미지정 시 전체 합산이라 ids 명시.
 * - 임계 단계: 매개변수 thresholds (기본 50/80/100). 한 캠페인이 복수 임계 통과해도
 *   현재 비율 대비 가장 높은 단계 1개만 candidate 발생 (스팸 방지).
 *
 * muteKey: `budget_burn:${nccCampaignId}:${threshold}` — 같은 캠페인 같은 단계는 1시간 내 1회.
 */
export async function evaluateBudgetBurn(
  ctx: EvalContext,
  rule: RuleSlice<BudgetBurnParams>,
): Promise<AlertCandidate[]> {
  // -- 임계 정규화 ----------------------------------------------------------
  const rawThresholds = rule.params?.thresholds ?? [50, 80, 100]
  const thresholds = rawThresholds
    .filter((t) => typeof t === "number" && Number.isFinite(t) && t > 0 && t <= 1000)
    .sort((a, b) => a - b)
  if (thresholds.length === 0) return []

  // -- 광고주 캠페인 (예산 설정된 것만) ------------------------------------
  const campaigns = await prisma.campaign.findMany({
    where: {
      advertiserId: ctx.advertiserId,
      status: { not: "deleted" },
      dailyBudget: { not: null },
    },
    select: {
      nccCampaignId: true,
      name: true,
      dailyBudget: true,
    },
  })
  if (campaigns.length === 0) return []

  // -- 오늘 비용 (캠페인별) -------------------------------------------------
  const ids = campaigns.map((c) => c.nccCampaignId)
  const rows = await getStats(ctx.customerId, {
    ids,
    fields: ["salesAmt"],
    datePreset: "today",
  })

  // id → salesAmt 맵
  const salesById = new Map<string, number>()
  for (const r of rows) {
    if (typeof r.id === "string") {
      salesById.set(r.id, typeof r.salesAmt === "number" ? r.salesAmt : 0)
    }
  }

  // -- 후보 생성 -----------------------------------------------------------
  const candidates: AlertCandidate[] = []
  for (const c of campaigns) {
    const budget = Number(c.dailyBudget ?? 0)
    if (budget <= 0) continue
    const cost = salesById.get(c.nccCampaignId) ?? 0
    if (cost <= 0) continue
    const pct = (cost / budget) * 100

    // pct 이하인 임계 중 가장 큰 것 1개만 (가장 높이 통과한 단계).
    let hit: number | null = null
    for (const t of thresholds) {
      if (pct >= t) hit = t
    }
    if (hit === null) continue

    const severity =
      hit >= 100 ? "critical" : hit >= 80 ? "warn" : "info"

    candidates.push({
      ruleType: "budget_burn",
      severity,
      title: `예산 ${hit}% 소진 — ${c.name}`,
      body: `${c.name} 캠페인이 오늘 일 예산의 ${pct.toFixed(1)}% (${cost.toLocaleString()} / ${budget.toLocaleString()}원)를 소진했습니다.`,
      meta: {
        advertiserId: ctx.advertiserId,
        customerId: ctx.customerId,
        nccCampaignId: c.nccCampaignId,
        campaignName: c.name,
        dailyBudget: budget,
        cost,
        pct: Number(pct.toFixed(2)),
        threshold: hit,
      },
      muteKey: `budget_burn:${c.nccCampaignId}:${hit}`,
    })
  }

  return candidates
}

// =============================================================================
// 2. bizmoney_low — 비즈머니 < N일치 일 예산 평균
// =============================================================================

/** bizmoney_low rule.params shape. */
export type BizmoneyLowParams = {
  /** 안전 잔고 일수. 기본 3일. 1..30. */
  days?: number
}

/**
 * 비즈머니 잔액이 활성 캠페인 일 예산 합 × N일 미만이면 알림.
 *
 * - status='active' 광고주에 한해 호출 (Cron 단계 보장)
 * - 활성 캠페인 = status='on' + dailyBudget != null. 광고그룹 일예산은 P1 비대상.
 * - 일예산 합이 0 이면 평가 의미 없음 → candidate 0
 * - 비즈머니 < days * dailyTotal 이면 critical
 *
 * muteKey: `bizmoney_low:${advertiserId}` — 광고주당 1시간 1회.
 */
export async function evaluateBizmoneyLow(
  ctx: EvalContext,
  rule: RuleSlice<BizmoneyLowParams>,
): Promise<AlertCandidate[]> {
  const rawDays = rule.params?.days
  const days =
    typeof rawDays === "number" && Number.isFinite(rawDays) && rawDays >= 1 && rawDays <= 30
      ? Math.floor(rawDays)
      : 3

  // -- 활성 캠페인 일예산 합 ------------------------------------------------
  const activeCampaigns = await prisma.campaign.findMany({
    where: {
      advertiserId: ctx.advertiserId,
      status: "on",
      dailyBudget: { not: null },
    },
    select: { dailyBudget: true },
  })
  let dailyTotal = 0
  for (const c of activeCampaigns) {
    dailyTotal += Number(c.dailyBudget ?? 0)
  }
  if (dailyTotal <= 0) return []

  // -- 비즈머니 조회 (실패 시 throw 허용 — Cron 이 catch 후 다음 rule 계속) ---
  const billing = await getBizmoney(ctx.customerId)
  const bizmoney = billing.bizmoney
  const threshold = days * dailyTotal
  if (bizmoney >= threshold) return []

  return [
    {
      ruleType: "bizmoney_low",
      severity: "critical",
      title: `비즈머니 부족 — ${days}일치 일예산 미만`,
      body: `비즈머니 잔액 ${bizmoney.toLocaleString()}원이 활성 캠페인 ${days}일치 일예산 합(${threshold.toLocaleString()}원) 미만입니다.`,
      meta: {
        advertiserId: ctx.advertiserId,
        customerId: ctx.customerId,
        bizmoney,
        dailyTotal,
        days,
        threshold,
        budgetLock: billing.budgetLock ?? null,
        refundLock: billing.refundLock ?? null,
      },
      muteKey: `bizmoney_low:${ctx.advertiserId}`,
    },
  ]
}

// =============================================================================
// 3. api_auth_error — SA 호출 인증 실패
// =============================================================================

/**
 * 본 PR 단순화: 마지막 호출 결과를 redis 에 누적 적재해야 의미 있는 "실패율" 도출 가능.
 * 따라서 본 평가기는 즉시 1회 getBizmoney 시도 → 401 / NaverSaAuthError catch 시 candidate 1개.
 *
 * 후속 PR (P1 마무리):
 *   - lib/naver-sa/client.ts 에 호출 결과(ok/fail) Redis 카운터 적재
 *   - 본 평가기는 카운터 임계(예: 5분 내 실패율 50%) 기반으로 변경
 *
 * muteKey: `api_auth:${advertiserId}` — 광고주당 1시간 1회.
 */
export async function evaluateApiAuthError(
  ctx: EvalContext,
): Promise<AlertCandidate[]> {
  try {
    await getBizmoney(ctx.customerId)
    return []
  } catch (e) {
    // NaverSaAuthError / NaverSaError / 기타 예외 모두 candidate 로 변환.
    // 메시지에 평문 키·시크릿 X (errors.ts 매핑 단계에서 이미 ctx 기반 메시지만 노출).
    const isNaver = e instanceof NaverSaError
    const status = isNaver ? e.context?.status : undefined
    const code = isNaver ? e.context?.code : undefined
    const reason = e instanceof Error ? e.message : String(e)

    // 인증/권한 실패만 critical, 그 외(네트워크/Validation)는 warn — 운영 노이즈 줄이기.
    const isAuth =
      status === 401 ||
      status === 403 ||
      (isNaver && (e.name === "NaverSaAuthError"))
    const severity: AlertCandidate["severity"] = isAuth ? "critical" : "warn"

    return [
      {
        ruleType: "api_auth_error",
        severity,
        title: isAuth ? "API 인증 실패" : "API 호출 실패",
        body: `광고주 ${ctx.advertiserId} (customerId=${ctx.customerId}) SA API 호출 실패: ${reason.slice(0, 200)}`,
        meta: {
          advertiserId: ctx.advertiserId,
          customerId: ctx.customerId,
          status: status ?? null,
          code: code ?? null,
          errorName: e instanceof Error ? e.name : "UnknownError",
        },
        muteKey: `api_auth:${ctx.advertiserId}`,
      },
    ]
  }
}

// =============================================================================
// 4. inspect_rejected — 새로 거절된 키워드/소재/확장소재
// =============================================================================

/** inspect_rejected rule.params shape. */
export type InspectRejectedParams = {
  /** 룩백 시간 (분). 기본 60. 5..1440. */
  withinMinutes?: number
  /** 한 번에 보고할 최대 후보 수. 기본 20. 1..200. */
  maxCandidates?: number
}

/**
 * 최근 N분 내 inspectStatus='rejected' 로 갱신된 키워드/소재/확장소재 검사.
 *
 * - 광고주 한정 join (keyword.adgroup.campaign / ad.adgroup.campaign / adExtension.adgroup.campaign)
 * - severity='warn' (즉시 매출 영향이라기보다 검수 회신 — operator 가 보고 처리)
 * - candidate 는 객체별 1개. muteKey 는 객체 nccId 기반 (같은 객체는 1시간 내 1회).
 * - maxCandidates 초과 시 그 이후는 잘라냄 (메시지 폭주 방지).
 *
 * muteKey: `inspect_rejected:${advertiserId}:${nccId}`
 */
export async function evaluateInspectRejected(
  ctx: EvalContext,
  rule: RuleSlice<InspectRejectedParams>,
): Promise<AlertCandidate[]> {
  const rawWithin = rule.params?.withinMinutes
  const withinMinutes =
    typeof rawWithin === "number" &&
    Number.isFinite(rawWithin) &&
    rawWithin >= 5 &&
    rawWithin <= 1440
      ? Math.floor(rawWithin)
      : 60
  const rawMax = rule.params?.maxCandidates
  const maxCandidates =
    typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax >= 1 && rawMax <= 200
      ? Math.floor(rawMax)
      : 20

  const since = new Date(Date.now() - withinMinutes * 60 * 1000)

  // 광고주 한정 조인은 광고주 → 캠페인 → 광고그룹 → 객체. nested where 로 처리.
  const advertiserScope = {
    adgroup: { campaign: { advertiserId: ctx.advertiserId } },
  } as const

  const [keywords, ads, extensions] = await Promise.all([
    prisma.keyword.findMany({
      where: {
        inspectStatus: "rejected",
        updatedAt: { gte: since },
        ...advertiserScope,
      },
      select: {
        nccKeywordId: true,
        keyword: true,
        adgroup: { select: { name: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: maxCandidates,
    }),
    prisma.ad.findMany({
      where: {
        inspectStatus: "rejected",
        updatedAt: { gte: since },
        ...advertiserScope,
      },
      select: {
        nccAdId: true,
        adType: true,
        inspectMemo: true,
        adgroup: { select: { name: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: maxCandidates,
    }),
    prisma.adExtension.findMany({
      where: {
        inspectStatus: "rejected",
        updatedAt: { gte: since },
        ownerType: "adgroup",
        adgroup: { campaign: { advertiserId: ctx.advertiserId } },
      },
      select: {
        nccExtId: true,
        type: true,
        inspectMemo: true,
        adgroup: { select: { name: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: maxCandidates,
    }),
  ])

  const candidates: AlertCandidate[] = []

  for (const k of keywords) {
    candidates.push({
      ruleType: "inspect_rejected",
      severity: "warn",
      title: `키워드 검수 거절 — ${k.keyword}`,
      body: `광고그룹 "${k.adgroup.name}" 의 키워드 "${k.keyword}" (${k.nccKeywordId})가 거절되었습니다.`,
      meta: {
        advertiserId: ctx.advertiserId,
        targetType: "Keyword",
        nccId: k.nccKeywordId,
        keyword: k.keyword,
        adgroupName: k.adgroup.name,
      },
      muteKey: `inspect_rejected:${ctx.advertiserId}:${k.nccKeywordId}`,
    })
  }

  for (const a of ads) {
    candidates.push({
      ruleType: "inspect_rejected",
      severity: "warn",
      title: `소재 검수 거절 — ${a.adType ?? "Ad"} ${a.nccAdId}`,
      body: `광고그룹 "${a.adgroup.name}" 의 소재 ${a.nccAdId}가 거절되었습니다.${a.inspectMemo ? ` 사유: ${a.inspectMemo}` : ""}`,
      meta: {
        advertiserId: ctx.advertiserId,
        targetType: "Ad",
        nccId: a.nccAdId,
        adType: a.adType ?? null,
        inspectMemo: a.inspectMemo ?? null,
        adgroupName: a.adgroup.name,
      },
      muteKey: `inspect_rejected:${ctx.advertiserId}:${a.nccAdId}`,
    })
  }

  for (const e of extensions) {
    candidates.push({
      ruleType: "inspect_rejected",
      severity: "warn",
      title: `확장소재 검수 거절 — ${e.type} ${e.nccExtId}`,
      body: `광고그룹 "${e.adgroup?.name ?? "(N/A)"}" 의 확장소재 ${e.nccExtId}가 거절되었습니다.${e.inspectMemo ? ` 사유: ${e.inspectMemo}` : ""}`,
      meta: {
        advertiserId: ctx.advertiserId,
        targetType: "AdExtension",
        nccId: e.nccExtId,
        extType: e.type,
        inspectMemo: e.inspectMemo ?? null,
        adgroupName: e.adgroup?.name ?? null,
      },
      muteKey: `inspect_rejected:${ctx.advertiserId}:${e.nccExtId}`,
    })
  }

  // 전체 후보 maxCandidates 한도 (3종 합산 후 컷).
  if (candidates.length > maxCandidates) {
    return candidates.slice(0, maxCandidates)
  }
  return candidates
}

// =============================================================================
// 5. cpc_surge — 7일 평균 CPC 대비 오늘 CPC 급등 (F-8.5)
// =============================================================================

/** cpc_surge rule.params shape. */
export type CpcSurgeParams = {
  /** 7일 평균 CPC 대비 상승률 임계 (%). 기본 50. 5..500. */
  thresholdPct?: number
  /** 표본 부족 컷오프 — 7일 합산 클릭 수 최소치. 기본 100. 10..10000. */
  minClicks?: number
}

/**
 * 캠페인별 7일 평균 CPC 와 오늘 CPC 비교 — 임계 이상 상승 시 candidate.
 *
 * - status='deleted' 제외. dailyBudget 무관 (CPC 는 비용/클릭 비율이라 예산과 별개)
 * - getStats 두 번: last7days 캐시 1h, today 캐시 5m. 같은 ids 라 SA 호출 단가 동일.
 * - 표본 부족: clk7 < minClicks 인 캠페인 skip. 오늘은 minClicks/7 의 floor (최소 1) 로 컷.
 * - cpc7 / cpcToday <= 0 이면 skip (NaN/Infinity 방어)
 * - severity: delta >= 2*thresholdPct 면 critical, 아니면 warn
 *
 * muteKey: `cpc_surge:${nccCampaignId}` — 임계 단계 분리 안 함. 단계 추가 시 muteKey 확장.
 */
export async function evaluateCpcSurge(
  ctx: EvalContext,
  rule: RuleSlice<CpcSurgeParams>,
): Promise<AlertCandidate[]> {
  // -- 파라미터 정규화 ------------------------------------------------------
  const rawThresholdPct = rule.params?.thresholdPct
  const thresholdPct =
    typeof rawThresholdPct === "number" &&
    Number.isFinite(rawThresholdPct) &&
    rawThresholdPct >= 5 &&
    rawThresholdPct <= 500
      ? rawThresholdPct
      : 50
  const rawMinClicks = rule.params?.minClicks
  const minClicks =
    typeof rawMinClicks === "number" &&
    Number.isFinite(rawMinClicks) &&
    rawMinClicks >= 10 &&
    rawMinClicks <= 10000
      ? Math.floor(rawMinClicks)
      : 100

  // -- 광고주 캠페인 (활성/일시중지 모두 포함) -----------------------------
  const campaigns = await prisma.campaign.findMany({
    where: {
      advertiserId: ctx.advertiserId,
      status: { not: "deleted" },
    },
    select: {
      nccCampaignId: true,
      name: true,
    },
  })
  if (campaigns.length === 0) return []

  const ids = campaigns.map((c) => c.nccCampaignId)

  // -- 7일 / 오늘 stats 조회 (캐시 분리됨) --------------------------------
  const [rows7, rowsToday] = await Promise.all([
    getStats(ctx.customerId, {
      ids,
      fields: ["clkCnt", "salesAmt"],
      datePreset: "last7days",
    }),
    getStats(ctx.customerId, {
      ids,
      fields: ["clkCnt", "salesAmt"],
      datePreset: "today",
    }),
  ])

  type Pair = { clk: number; sales: number }
  const by7 = new Map<string, Pair>()
  const byToday = new Map<string, Pair>()
  for (const r of rows7) {
    if (typeof r.id === "string") {
      by7.set(r.id, {
        clk: typeof r.clkCnt === "number" ? r.clkCnt : 0,
        sales: typeof r.salesAmt === "number" ? r.salesAmt : 0,
      })
    }
  }
  for (const r of rowsToday) {
    if (typeof r.id === "string") {
      byToday.set(r.id, {
        clk: typeof r.clkCnt === "number" ? r.clkCnt : 0,
        sales: typeof r.salesAmt === "number" ? r.salesAmt : 0,
      })
    }
  }

  // 오늘 표본 컷 (일평균 표본 floor — 너무 빡빡하면 1까지 완화)
  const todayMinClicks = Math.max(1, Math.floor(minClicks / 7))

  // -- 후보 생성 -----------------------------------------------------------
  const candidates: AlertCandidate[] = []
  for (const c of campaigns) {
    const r7 = by7.get(c.nccCampaignId)
    const rt = byToday.get(c.nccCampaignId)
    if (!r7 || !rt) continue
    if (r7.clk < minClicks) continue
    if (rt.clk < todayMinClicks) continue

    const cpc7 = r7.sales / r7.clk
    const cpcToday = rt.sales / rt.clk
    if (!Number.isFinite(cpc7) || !Number.isFinite(cpcToday)) continue
    if (cpc7 <= 0 || cpcToday <= 0) continue

    const delta = ((cpcToday - cpc7) / cpc7) * 100
    if (!Number.isFinite(delta)) continue
    if (delta < thresholdPct) continue

    const severity: AlertCandidate["severity"] =
      delta >= 2 * thresholdPct ? "critical" : "warn"

    candidates.push({
      ruleType: "cpc_surge",
      severity,
      title: `CPC 급등 — ${c.name} (+${delta.toFixed(1)}%)`,
      body: `7일 평균 CPC ${Math.round(cpc7).toLocaleString()}원 → 오늘 ${Math.round(cpcToday).toLocaleString()}원 (+${delta.toFixed(1)}%, 임계 ${thresholdPct}%)`,
      meta: {
        advertiserId: ctx.advertiserId,
        customerId: ctx.customerId,
        nccCampaignId: c.nccCampaignId,
        campaignName: c.name,
        cpc7: Number(cpc7.toFixed(2)),
        cpcToday: Number(cpcToday.toFixed(2)),
        deltaPct: Number(delta.toFixed(2)),
        thresholdPct,
        clkToday: rt.clk,
        clk7: r7.clk,
      },
      muteKey: `cpc_surge:${c.nccCampaignId}`,
    })
  }

  return candidates
}

// =============================================================================
// 6. impressions_drop — 7일 평균 시간당 노출 대비 오늘 시간당 노출 급감 (F-8.6)
// =============================================================================

/** impressions_drop rule.params shape. */
export type ImpressionsDropParams = {
  /** 7일 평균 시간당 노출 대비 감소율 임계 (%). 기본 50. 5..100. */
  thresholdPct?: number
  /** 표본 부족 컷오프 — 7일 합산 노출 최소치. 기본 1000. 100..1000000. */
  minImpressions?: number
}

/**
 * 캠페인별 7일 평균 시간당 노출 vs 오늘 현재 시간까지의 시간당 노출 비교.
 *
 * - 시간대 보정: 오늘은 진행 중이므로 "imp / 경과시간" 으로 시간당 평균을 산출.
 *   자정 직후(hour < 1) 는 표본 의미 없음 → 광고주 단위 skip.
 * - 7일 합산이 minImpressions 미만인 캠페인은 평가 제외.
 * - severity: drop >= 80% 면 critical, 아니면 warn
 *
 * muteKey: `impressions_drop:${nccCampaignId}`
 */
export async function evaluateImpressionsDrop(
  ctx: EvalContext,
  rule: RuleSlice<ImpressionsDropParams>,
): Promise<AlertCandidate[]> {
  // -- 파라미터 정규화 ------------------------------------------------------
  const rawThresholdPct = rule.params?.thresholdPct
  const thresholdPct =
    typeof rawThresholdPct === "number" &&
    Number.isFinite(rawThresholdPct) &&
    rawThresholdPct >= 5 &&
    rawThresholdPct <= 100
      ? rawThresholdPct
      : 50
  const rawMinImpressions = rule.params?.minImpressions
  const minImpressions =
    typeof rawMinImpressions === "number" &&
    Number.isFinite(rawMinImpressions) &&
    rawMinImpressions >= 100 &&
    rawMinImpressions <= 1_000_000
      ? Math.floor(rawMinImpressions)
      : 1000

  // -- 자정 직후 skip (표본 부족) ------------------------------------------
  const now = new Date()
  const hoursElapsed = now.getHours() + now.getMinutes() / 60
  if (hoursElapsed < 1) return []

  // -- 광고주 캠페인 ------------------------------------------------------
  const campaigns = await prisma.campaign.findMany({
    where: {
      advertiserId: ctx.advertiserId,
      status: { not: "deleted" },
    },
    select: {
      nccCampaignId: true,
      name: true,
    },
  })
  if (campaigns.length === 0) return []

  const ids = campaigns.map((c) => c.nccCampaignId)

  // -- 7일 / 오늘 노출 ----------------------------------------------------
  const [rows7, rowsToday] = await Promise.all([
    getStats(ctx.customerId, {
      ids,
      fields: ["impCnt"],
      datePreset: "last7days",
    }),
    getStats(ctx.customerId, {
      ids,
      fields: ["impCnt"],
      datePreset: "today",
    }),
  ])

  const imp7Map = new Map<string, number>()
  const impTodayMap = new Map<string, number>()
  for (const r of rows7) {
    if (typeof r.id === "string") {
      imp7Map.set(r.id, typeof r.impCnt === "number" ? r.impCnt : 0)
    }
  }
  for (const r of rowsToday) {
    if (typeof r.id === "string") {
      impTodayMap.set(r.id, typeof r.impCnt === "number" ? r.impCnt : 0)
    }
  }

  // -- 후보 생성 -----------------------------------------------------------
  const candidates: AlertCandidate[] = []
  for (const c of campaigns) {
    const imp7 = imp7Map.get(c.nccCampaignId) ?? 0
    if (imp7 < minImpressions) continue

    const impToday = impTodayMap.get(c.nccCampaignId) ?? 0
    const hourlyExpected = imp7 / 7 / 24
    if (!Number.isFinite(hourlyExpected) || hourlyExpected <= 0) continue
    const hourlyActual = impToday / hoursElapsed
    if (!Number.isFinite(hourlyActual)) continue

    const drop = ((hourlyExpected - hourlyActual) / hourlyExpected) * 100
    if (!Number.isFinite(drop)) continue
    if (drop < thresholdPct) continue

    const severity: AlertCandidate["severity"] =
      drop >= 80 ? "critical" : "warn"

    candidates.push({
      ruleType: "impressions_drop",
      severity,
      title: `노출 급감 — ${c.name} (-${drop.toFixed(1)}%)`,
      body: `7일 평균 시간당 노출 ${hourlyExpected.toFixed(0)} → 오늘 ${hourlyActual.toFixed(0)} (-${drop.toFixed(1)}%, 임계 ${thresholdPct}%)`,
      meta: {
        advertiserId: ctx.advertiserId,
        customerId: ctx.customerId,
        nccCampaignId: c.nccCampaignId,
        campaignName: c.name,
        hourlyExpected: Number(hourlyExpected.toFixed(2)),
        hourlyActual: Number(hourlyActual.toFixed(2)),
        dropPct: Number(drop.toFixed(2)),
        thresholdPct,
        hoursElapsed: Number(hoursElapsed.toFixed(2)),
      },
      muteKey: `impressions_drop:${c.nccCampaignId}`,
    })
  }

  return candidates
}

// =============================================================================
// 7. budget_pace — 시간대 예상 페이스 대비 초과 소진 (F-8.1+)
// =============================================================================

/** budget_pace rule.params shape. */
export type BudgetPaceParams = {
  /** 시간대 예상 페이스 대비 초과 소진률 임계 (%포인트). 기본 30. 5..100. */
  deviationPct?: number
  /** 평가 시작 시각 (0~23). 자정 직후 노이즈 방지. 기본 6. 1..23. */
  minHour?: number
}

/**
 * 캠페인별 "현재 시각의 예상 페이스" 대비 실제 소진률 비교.
 *
 * - F-8.1 (budget_burn) 은 절대 임계(50/80/100%) 검사. 본 평가기는 시간대 페이스 이상만 검사.
 *   같은 캠페인에서 두 알림이 동시 발생 가능 — muteKey 분리로 충돌 방지.
 * - 자정~minHour 시 사이는 표본 의미 작아 광고주 단위 skip.
 * - getStats(today, salesAmt) 호출은 budget_burn 과 동일 형태라 캐시 hit 됨 (분 단위 5m TTL).
 * - severity: excess >= 50%p 면 critical (페이스 ~2배), 아니면 warn
 *
 * muteKey: `budget_pace:${nccCampaignId}` — budget_burn 과 분리됨.
 */
export async function evaluateBudgetPace(
  ctx: EvalContext,
  rule: RuleSlice<BudgetPaceParams>,
): Promise<AlertCandidate[]> {
  // -- 파라미터 정규화 ------------------------------------------------------
  const rawDeviationPct = rule.params?.deviationPct
  const deviationPct =
    typeof rawDeviationPct === "number" &&
    Number.isFinite(rawDeviationPct) &&
    rawDeviationPct >= 5 &&
    rawDeviationPct <= 100
      ? rawDeviationPct
      : 30
  const rawMinHour = rule.params?.minHour
  const minHour =
    typeof rawMinHour === "number" &&
    Number.isFinite(rawMinHour) &&
    rawMinHour >= 1 &&
    rawMinHour <= 23
      ? Math.floor(rawMinHour)
      : 6

  // -- 시간대 컷 (광고주 단위 skip) ----------------------------------------
  const now = new Date()
  const hours = now.getHours()
  const hourFraction = hours + now.getMinutes() / 60
  if (hourFraction < minHour) return []

  // -- 예산 설정된 캠페인 --------------------------------------------------
  const campaigns = await prisma.campaign.findMany({
    where: {
      advertiserId: ctx.advertiserId,
      status: { not: "deleted" },
      dailyBudget: { not: null },
    },
    select: {
      nccCampaignId: true,
      name: true,
      dailyBudget: true,
    },
  })
  if (campaigns.length === 0) return []

  // -- 오늘 비용 (캠페인별, budget_burn 과 캐시 공유) -----------------------
  const ids = campaigns.map((c) => c.nccCampaignId)
  const rows = await getStats(ctx.customerId, {
    ids,
    fields: ["salesAmt"],
    datePreset: "today",
  })
  const salesById = new Map<string, number>()
  for (const r of rows) {
    if (typeof r.id === "string") {
      salesById.set(r.id, typeof r.salesAmt === "number" ? r.salesAmt : 0)
    }
  }

  // -- 후보 생성 -----------------------------------------------------------
  const expectedPct = (hourFraction / 24) * 100
  const candidates: AlertCandidate[] = []
  for (const c of campaigns) {
    const budget = Number(c.dailyBudget ?? 0)
    if (budget <= 0) continue
    const cost = salesById.get(c.nccCampaignId) ?? 0
    if (cost <= 0) continue

    const actualPct = (cost / budget) * 100
    if (!Number.isFinite(actualPct)) continue

    const excess = actualPct - expectedPct
    if (!Number.isFinite(excess)) continue
    if (excess < deviationPct) continue

    const severity: AlertCandidate["severity"] =
      excess >= 50 ? "critical" : "warn"

    candidates.push({
      ruleType: "budget_pace",
      severity,
      title: `예산 페이스 이상 — ${c.name} (예상 ${expectedPct.toFixed(0)}% vs 실제 ${actualPct.toFixed(0)}%)`,
      body: `${c.name} 캠페인이 ${hours}시 기준 예상 페이스 ${expectedPct.toFixed(1)}% 대비 ${actualPct.toFixed(1)}% 소진 (+${excess.toFixed(1)}%p, 임계 ${deviationPct}%p)`,
      meta: {
        advertiserId: ctx.advertiserId,
        customerId: ctx.customerId,
        nccCampaignId: c.nccCampaignId,
        campaignName: c.name,
        dailyBudget: budget,
        cost,
        expectedPct: Number(expectedPct.toFixed(2)),
        actualPct: Number(actualPct.toFixed(2)),
        excessPct: Number(excess.toFixed(2)),
        deviationPct,
        hourFraction: Number(hourFraction.toFixed(2)),
      },
      muteKey: `budget_pace:${c.nccCampaignId}`,
    })
  }

  return candidates
}
