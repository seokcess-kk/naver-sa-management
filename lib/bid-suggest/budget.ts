/**
 * bid-suggest cron — 캠페인 예산 페이싱/성과 권고 엔진.
 *
 * app/api/cron/bid-suggest/route.ts 분해 (순수 구조 리팩터) 로 추출.
 * BidSuggestion(engineSource='budget') 적재. 로직 · 시그니처 불변.
 */

import { prisma } from "@/lib/db/prisma"
import { STAT_DAILY_DEVICE_FILTER } from "@/lib/stat-daily/device-filter"
import type * as Prisma from "@/lib/generated/prisma/internal/prismaNamespace"

import { addDays, STATS_WINDOW_DAYS, SUGGESTION_TTL_DAYS } from "./shared"

export type BudgetSuggestionStats = {
  scanned: number
  created: number
  updated: number
  dismissed: number
}

export type BudgetConfig = {
  budgetPacingMode: "focus" | "explore" | "protect"
  targetCpa: number | null
  targetRoas: Prisma.Decimal | number | null
}

export type BudgetDecision =
  | {
      decision: "suggest"
      reasonCode: string
      suggestedDailyBudget: number
      severity: "info" | "warn" | "critical"
      reason: string
      meta: Record<string, number | string | null>
    }
  | {
      decision: "hold"
      reasonCode: string
    }

export function roundBudget(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.round(v / 1000) * 1000)
}

export function clampBudgetChange(
  currentBudget: number,
  suggestedBudget: number,
  mode: BudgetConfig["budgetPacingMode"],
): number {
  const maxIncreasePct = mode === "explore" ? 0.3 : mode === "protect" ? 0.1 : 0.2
  const maxDecreasePct = mode === "protect" ? 0.25 : 0.15
  const min = currentBudget * (1 - maxDecreasePct)
  const max = currentBudget * (1 + maxIncreasePct)
  return roundBudget(Math.min(max, Math.max(min, suggestedBudget)))
}

export function decideBudgetSuggestion(input: {
  campaignName: string
  currentDailyBudget: number
  costYesterday: number
  cost7d: number
  conversions7d: number | null
  revenue7d: number | null
  cfg: BudgetConfig
}): BudgetDecision {
  const {
    campaignName,
    currentDailyBudget,
    costYesterday,
    cost7d,
    conversions7d,
    revenue7d,
    cfg,
  } = input
  if (currentDailyBudget <= 0 || cost7d <= 0) {
    return { decision: "hold", reasonCode: "no_budget_signal" }
  }

  const yesterdayPacePct = (costYesterday / currentDailyBudget) * 100
  const sevenDayPacePct = (cost7d / (currentDailyBudget * 7)) * 100
  const cpa7d =
    conversions7d != null && conversions7d > 0 ? cost7d / conversions7d : null
  const roas7d =
    revenue7d != null && cost7d > 0 ? revenue7d / cost7d : null
  const targetRoas =
    cfg.targetRoas == null ? null : Number(cfg.targetRoas)

  const meetsCpa = cfg.targetCpa == null || (cpa7d != null && cpa7d <= cfg.targetCpa)
  const meetsRoas = targetRoas == null || (roas7d != null && roas7d >= targetRoas)
  const hasTarget = cfg.targetCpa != null || targetRoas != null
  const performanceOk = hasTarget ? meetsCpa || meetsRoas : true
  const performanceBad =
    (cfg.targetCpa != null && cpa7d != null && cpa7d > cfg.targetCpa * 1.25) ||
    (targetRoas != null && roas7d != null && roas7d < targetRoas * 0.8)

  const meta = {
    currentDailyBudget,
    costYesterday,
    cost7d,
    yesterdayPacePct: Number(yesterdayPacePct.toFixed(2)),
    sevenDayPacePct: Number(sevenDayPacePct.toFixed(2)),
    cpa7d: cpa7d == null ? null : Math.round(cpa7d),
    roas7d: roas7d == null ? null : Number(roas7d.toFixed(2)),
    budgetPacingMode: cfg.budgetPacingMode,
  }

  if (yesterdayPacePct >= 98 && sevenDayPacePct >= 75 && performanceOk) {
    const factor =
      cfg.budgetPacingMode === "explore"
        ? 1.3
        : cfg.budgetPacingMode === "protect"
          ? 1.1
          : 1.2
    const suggestedDailyBudget = clampBudgetChange(
      currentDailyBudget,
      currentDailyBudget * factor,
      cfg.budgetPacingMode,
    )
    return {
      decision: "suggest",
      reasonCode: "budget_exhausted_with_signal",
      suggestedDailyBudget,
      severity: yesterdayPacePct >= 110 ? "critical" : "warn",
      reason: `${campaignName} 캠페인이 어제 일예산의 ${yesterdayPacePct.toFixed(0)}%를 사용했고 7일 페이스도 ${sevenDayPacePct.toFixed(0)}%입니다. 성과 목표를 크게 벗어나지 않아 일예산을 ${suggestedDailyBudget.toLocaleString()}원으로 증액 권고합니다.`,
      meta,
    }
  }

  if (sevenDayPacePct <= 35 && cost7d >= currentDailyBudget && cfg.budgetPacingMode !== "explore") {
    const suggestedDailyBudget = clampBudgetChange(
      currentDailyBudget,
      Math.max(cost7d / 7 / 0.65, currentDailyBudget * 0.75),
      cfg.budgetPacingMode,
    )
    if (suggestedDailyBudget < currentDailyBudget) {
      return {
        decision: "suggest",
        reasonCode: "budget_underused",
        suggestedDailyBudget,
        severity: "info",
        reason: `${campaignName} 캠페인의 7일 예산 사용률이 ${sevenDayPacePct.toFixed(0)}%로 낮습니다. 예산을 ${suggestedDailyBudget.toLocaleString()}원으로 낮춰 다른 캠페인에 재배분하는 것을 권고합니다.`,
        meta,
      }
    }
  }

  if (performanceBad && sevenDayPacePct >= 50) {
    const suggestedDailyBudget = clampBudgetChange(
      currentDailyBudget,
      currentDailyBudget * 0.85,
      cfg.budgetPacingMode,
    )
    if (suggestedDailyBudget < currentDailyBudget) {
      return {
        decision: "suggest",
        reasonCode: "budget_reduce_for_efficiency",
        suggestedDailyBudget,
        severity: "warn",
        reason: `${campaignName} 캠페인의 최근 7일 효율이 목표 대비 낮습니다. 예산 소진은 이어지고 있어 일예산을 ${suggestedDailyBudget.toLocaleString()}원으로 감액 권고합니다.`,
        meta,
      }
    }
  }

  return { decision: "hold", reasonCode: "budget_within_band" }
}

export async function processBudgetSuggestions(
  advertiserId: string,
  cfg: BudgetConfig,
): Promise<BudgetSuggestionStats> {
  const stats: BudgetSuggestionStats = {
    scanned: 0,
    created: 0,
    updated: 0,
    dismissed: 0,
  }

  const campaigns = await prisma.campaign.findMany({
    where: {
      advertiserId,
      status: { not: "deleted" },
      dailyBudget: { not: null },
    },
    select: {
      id: true,
      nccCampaignId: true,
      name: true,
      dailyBudget: true,
    },
  })
  if (campaigns.length === 0) return stats

  const since = addDays(new Date(), -STATS_WINDOW_DAYS)
  const yesterday = addDays(new Date(), -1)
  const yesterdayDate = new Date(Date.UTC(
    yesterday.getUTCFullYear(),
    yesterday.getUTCMonth(),
    yesterday.getUTCDate(),
  ))
  const cost7d = await prisma.statDaily.groupBy({
    by: ["refId"],
    where: {
      advertiserId,
      level: "campaign",
      refId: { in: campaigns.map((c) => c.nccCampaignId) },
      date: { gte: since },
      // device 이중집계 방지 — 옵션 B (PC + MOBILE). 자세한 근거는
      // lib/stat-daily/device-filter.ts 참조.
      ...STAT_DAILY_DEVICE_FILTER,
    },
    _sum: {
      cost: true,
      conversions: true,
      revenue: true,
    },
  })
  const costYesterday = await prisma.statDaily.groupBy({
    by: ["refId"],
    where: {
      advertiserId,
      level: "campaign",
      refId: { in: campaigns.map((c) => c.nccCampaignId) },
      date: yesterdayDate,
      ...STAT_DAILY_DEVICE_FILTER,
    },
    _sum: { cost: true },
  })

  const sevenDayById = new Map(cost7d.map((r) => [r.refId, r]))
  const yesterdayById = new Map(costYesterday.map((r) => [r.refId, r]))
  const expiresAt = addDays(new Date(), SUGGESTION_TTL_DAYS)

  for (const c of campaigns) {
    stats.scanned++
    const budget = Number(c.dailyBudget ?? 0)
    if (budget <= 0) continue
    const sevenDay = sevenDayById.get(c.nccCampaignId)
    const yesterdayRow = yesterdayById.get(c.nccCampaignId)
    const decision = decideBudgetSuggestion({
      campaignName: c.name,
      currentDailyBudget: budget,
      costYesterday: yesterdayRow?._sum.cost ? Number(yesterdayRow._sum.cost) : 0,
      cost7d: sevenDay?._sum.cost ? Number(sevenDay._sum.cost) : 0,
      conversions7d: sevenDay?._sum.conversions ?? null,
      revenue7d: sevenDay?._sum.revenue ? Number(sevenDay._sum.revenue) : null,
      cfg,
    })

    const existing = await prisma.bidSuggestion.findFirst({
      where: {
        advertiserId,
        engineSource: "budget",
        status: "pending",
        action: {
          path: ["campaignId"],
          equals: c.id,
        },
      },
      select: { id: true },
    })

    if (decision.decision === "suggest") {
      const action = {
        kind: "campaign_budget_update",
        campaignId: c.id,
        nccCampaignId: c.nccCampaignId,
        currentDailyBudget: budget,
        suggestedDailyBudget: decision.suggestedDailyBudget,
        reasonCode: decision.reasonCode,
        metrics: decision.meta,
        items: [
          {
            campaignId: c.id,
            nccCampaignId: c.nccCampaignId,
            currentDailyBudget: budget,
            suggestedDailyBudget: decision.suggestedDailyBudget,
            reasonCode: decision.reasonCode,
          },
        ],
      } satisfies Prisma.InputJsonValue

      const data = {
        advertiserId,
        keywordId: null,
        adgroupId: null,
        engineSource: "budget" as const,
        action,
        reason: decision.reason,
        severity: decision.severity,
        status: "pending" as const,
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
        stats.updated++
      } else {
        await prisma.bidSuggestion.create({ data })
        stats.created++
      }
    } else if (existing) {
      const r = await prisma.bidSuggestion.updateMany({
        where: { id: existing.id, status: "pending" },
        data: { status: "dismissed" },
      })
      stats.dismissed += r.count
    }
  }

  return stats
}
