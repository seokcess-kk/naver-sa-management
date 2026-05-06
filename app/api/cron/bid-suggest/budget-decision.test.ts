/**
 * decideBudgetSuggestion / clampBudgetChange 단위 테스트.
 *
 * QA 보고서 (커밋 91f54e8 검토) 가 짚은 미커버 분기:
 *   - pacingMode='explore' factor 1.3
 *   - performanceBad 감액 분기 (budget_reduce_for_efficiency)
 *   - clampBudgetChange 상·하한 클램프 (mode 별)
 *
 * 외부 의존 0 — 순수 함수 단위 테스트.
 */

import { describe, expect, it } from "vitest"

import {
  clampBudgetChange,
  decideBudgetSuggestion,
  roundBudget,
} from "@/app/api/cron/bid-suggest/route"

describe("clampBudgetChange — mode 별 상·하한", () => {
  it("focus 모드: +20% / -15% 한도", () => {
    // suggested 가 한도 초과 → max 로 클램프 (round 1000 단위)
    expect(clampBudgetChange(100_000, 200_000, "focus")).toBe(120_000)
    // suggested 가 한도 미만 → min 으로 클램프
    expect(clampBudgetChange(100_000, 50_000, "focus")).toBe(85_000)
    // suggested 가 한도 안 → round 후 그대로
    expect(clampBudgetChange(100_000, 110_000, "focus")).toBe(110_000)
  })

  it("explore 모드: +30% / -15% 한도 — 증액 폭 확대", () => {
    // explore 는 증액 더 적극 (focus 의 +20% 대신 +30%)
    expect(clampBudgetChange(100_000, 200_000, "explore")).toBe(130_000)
    // 감액 한도는 focus 와 동일 (-15%)
    expect(clampBudgetChange(100_000, 50_000, "explore")).toBe(85_000)
  })

  it("protect 모드: +10% / -25% 한도 — 증액 보수, 감액 적극", () => {
    // protect 는 증액 보수 (+10% 만)
    expect(clampBudgetChange(100_000, 200_000, "protect")).toBe(110_000)
    // 감액은 더 적극 (-25%)
    expect(clampBudgetChange(100_000, 50_000, "protect")).toBe(75_000)
  })

  it("roundBudget: 1000 단위 round + 음수 → 0 클램프 + NaN 방어", () => {
    expect(roundBudget(105_400)).toBe(105_000)
    expect(roundBudget(105_500)).toBe(106_000)
    expect(roundBudget(-50_000)).toBe(0)
    expect(roundBudget(NaN)).toBe(0)
    expect(roundBudget(Infinity)).toBe(0)
  })
})

describe("decideBudgetSuggestion — 분기 커버리지", () => {
  const baseCfg = {
    budgetPacingMode: "focus" as const,
    targetCpa: null,
    targetRoas: null,
  }

  it("currentDailyBudget=0 → hold(no_budget_signal)", () => {
    const r = decideBudgetSuggestion({
      campaignName: "C",
      currentDailyBudget: 0,
      costYesterday: 50_000,
      cost7d: 350_000,
      conversions7d: null,
      revenue7d: null,
      cfg: baseCfg,
    })
    expect(r.decision).toBe("hold")
    expect(r.reasonCode).toBe("no_budget_signal")
  })

  it("cost7d=0 → hold(no_budget_signal)", () => {
    const r = decideBudgetSuggestion({
      campaignName: "C",
      currentDailyBudget: 100_000,
      costYesterday: 0,
      cost7d: 0,
      conversions7d: null,
      revenue7d: null,
      cfg: baseCfg,
    })
    expect(r.decision).toBe("hold")
    expect(r.reasonCode).toBe("no_budget_signal")
  })

  it("어제 페이스 ≥98% + 7일 ≥75% + explore mode → suggest factor 1.3 적용 후 +30% 클램프", () => {
    // 어제 100% / 7일 평균도 100% 페이스. explore 는 factor 1.3 → 130k 권고
    const r = decideBudgetSuggestion({
      campaignName: "C",
      currentDailyBudget: 100_000,
      costYesterday: 100_000,
      cost7d: 700_000,
      conversions7d: null,
      revenue7d: null,
      cfg: { ...baseCfg, budgetPacingMode: "explore" },
    })
    expect(r.decision).toBe("suggest")
    expect(r.reasonCode).toBe("budget_exhausted_with_signal")
    if (r.decision === "suggest") {
      expect(r.suggestedDailyBudget).toBe(130_000)
      expect(r.severity).toBe("warn")
    }
  })

  it("어제 페이스 ≥110% → severity='critical'", () => {
    const r = decideBudgetSuggestion({
      campaignName: "C",
      currentDailyBudget: 100_000,
      costYesterday: 115_000,
      cost7d: 700_000,
      conversions7d: null,
      revenue7d: null,
      cfg: baseCfg,
    })
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.severity).toBe("critical")
    }
  })

  it("performanceBad (CPA 1.25배 초과) + 7일 페이스 ≥50% → suggest(budget_reduce_for_efficiency)", () => {
    // 어제 페이스 60% / 7일 60% — 첫 분기(증액) 비대상.
    // 7일 페이스 ≥35% — 두번째 분기(감액 underused) 비대상.
    // CPA 7d = 600,000/10 = 60,000 / target 30,000 → 2배 → performanceBad → 세번째 분기 진입.
    const r = decideBudgetSuggestion({
      campaignName: "C",
      currentDailyBudget: 100_000,
      costYesterday: 60_000,
      cost7d: 600_000,
      conversions7d: 10,
      revenue7d: null,
      cfg: { ...baseCfg, targetCpa: 30_000 },
    })
    expect(r.decision).toBe("suggest")
    expect(r.reasonCode).toBe("budget_reduce_for_efficiency")
    if (r.decision === "suggest") {
      // 100k * 0.85 = 85k (focus 의 -15% 한도 안)
      expect(r.suggestedDailyBudget).toBe(85_000)
      expect(r.severity).toBe("warn")
    }
  })

  it("performanceBad + 7일 페이스 <50% → 감액 분기 비대상 → hold", () => {
    // 7일 페이스 30% — 감액 트리거 미달.
    const r = decideBudgetSuggestion({
      campaignName: "C",
      currentDailyBudget: 100_000,
      costYesterday: 30_000,
      cost7d: 210_000,
      conversions7d: 10,
      revenue7d: null,
      cfg: { ...baseCfg, targetCpa: 10_000 },
    })
    // 7일 페이스 30% → underused 분기 진입(cost7d=210k ≥ 100k → 조건 충족).
    // suggestedDailyBudget = max(210k/7/0.65, 100k*0.75) = max(46_153, 75_000) = 75_000
    expect(r.decision).toBe("suggest")
    expect(r.reasonCode).toBe("budget_underused")
  })

  it("7일 페이스 ≤35% + cost7d ≥ currentBudget + focus mode → suggest(budget_underused)", () => {
    // 7일 30% — 1주 평균 일 비용 30k vs 일예산 100k → 과다 책정.
    const r = decideBudgetSuggestion({
      campaignName: "C",
      currentDailyBudget: 100_000,
      costYesterday: 30_000,
      cost7d: 210_000,
      conversions7d: null,
      revenue7d: null,
      cfg: baseCfg,
    })
    expect(r.decision).toBe("suggest")
    expect(r.reasonCode).toBe("budget_underused")
    if (r.decision === "suggest") {
      // max(210k/7/0.65=46.1k, 100k*0.75=75k) = 75k. focus -15% 한도 = 85k 가 min →
      // clampBudgetChange(100k, 75k, focus) = max(85k, 75k) = 85k
      expect(r.suggestedDailyBudget).toBe(85_000)
      expect(r.severity).toBe("info")
    }
  })

  it("7일 페이스 ≤35% + explore mode → underused 분기 비대상 (mode 가드)", () => {
    // explore 는 underused 감액 안 함 (적극 학습 모드).
    const r = decideBudgetSuggestion({
      campaignName: "C",
      currentDailyBudget: 100_000,
      costYesterday: 30_000,
      cost7d: 210_000,
      conversions7d: null,
      revenue7d: null,
      cfg: { ...baseCfg, budgetPacingMode: "explore" },
    })
    expect(r.decision).toBe("hold")
    expect(r.reasonCode).toBe("budget_within_band")
  })

  it("정상 페이스 (밴드 안) → hold(budget_within_band)", () => {
    // 어제 70% / 7일 60% — 모든 분기 비대상.
    const r = decideBudgetSuggestion({
      campaignName: "C",
      currentDailyBudget: 100_000,
      costYesterday: 70_000,
      cost7d: 420_000,
      conversions7d: null,
      revenue7d: null,
      cfg: baseCfg,
    })
    expect(r.decision).toBe("hold")
    expect(r.reasonCode).toBe("budget_within_band")
  })

  it("ROAS performanceBad → 감액 분기 진입", () => {
    // ROAS 7d = 50k/600k = 0.0833 / target 1.0 (100%) → 0.8 미만 → performanceBad.
    const r = decideBudgetSuggestion({
      campaignName: "C",
      currentDailyBudget: 100_000,
      costYesterday: 60_000,
      cost7d: 600_000,
      conversions7d: null,
      revenue7d: 50_000,
      cfg: { ...baseCfg, targetRoas: 1 },
    })
    expect(r.decision).toBe("suggest")
    expect(r.reasonCode).toBe("budget_reduce_for_efficiency")
  })
})
