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
