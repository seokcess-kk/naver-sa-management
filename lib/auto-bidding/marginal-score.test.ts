/**
 * lib/auto-bidding/marginal-score.ts 단위 테스트 (Phase B.1)
 *
 * 검증 매트릭스:
 *   A. 신뢰도 분기 — clicks7d < minClicks / >= minClicks
 *   B. ROAS 분기 — high (up) / mid (hold) / low (down) / very low (warn)
 *   C. CPA 분기 — low cpa (up) / mid (hold) / high (down) / very high (warn)
 *   D. 평균 순위 분기 — 목표보다 낮은 순위(up) / 과상위+고CPC(down) / 가드레일 hold
 *   E. baseline fallback — cpc 이상 (down) / 정상 (hold) / 데이터 부족 (hold)
 *   F. clamp — bidLowerBound / bidUpperBound / no_change after clamp
 *   G. confidence — low / medium / high
 *   H. useGroupBidAmt 분기 — currentBid <= 0 → hold
 */

import { describe, expect, it } from "vitest"
import { Prisma } from "@/lib/generated/prisma/client"

import {
  decideMarginalSuggestion,
  DEFAULT_MARGINAL_CONFIG,
  type MarginalScoreInput,
} from "./marginal-score"

// 기본 입력 헬퍼 — 각 테스트가 필드 override
function input(over: Partial<MarginalScoreInput> = {}): MarginalScoreInput {
  return {
    keyword: {
      keywordId: "kw1",
      nccKeywordId: "nccKw1",
      currentBid: 1000,
      clicks7d: 100,
      impressions7d: 5000,
      cost7d: 100_000,
      conversions7d: 5,
      revenue7d: 500_000,
      avgRank7d: null,
      ...over.keyword,
    },
    baseline: {
      avgCtr: new Prisma.Decimal("0.02"),
      avgCvr: new Prisma.Decimal("0.05"),
      avgCpc: new Prisma.Decimal("1000"),
      ...over.baseline,
    },
    targets: {
      targetCpa: null,
      targetRoas: null,
      ...over.targets,
    },
    config: over.config,
  }
}

describe("decideMarginalSuggestion — A. 신뢰도", () => {
  it("clicks < minClicks (50) → hold low_confidence_data", () => {
    const r = decideMarginalSuggestion(input({ keyword: { clicks7d: 30 } as any }))
    expect(r.decision).toBe("hold")
    if (r.decision === "hold") expect(r.reason).toBe("low_confidence_data")
  })

  it("clicks 정확히 50 — 임계 통과 (low_confidence_data hold 아님)", () => {
    const r = decideMarginalSuggestion(
      input({
        keyword: { clicks7d: 50, cost7d: 50_000 } as any,
        targets: { targetCpa: 5000, targetRoas: null },
      }),
    )
    // 임계 통과만 검증 — 이후 분기는 다른 테스트가 담당
    if (r.decision === "hold") {
      expect(r.reason).not.toBe("low_confidence_data")
    }
  })

  it("currentBid <= 0 — useGroupBidAmt 키워드 hold", () => {
    const r = decideMarginalSuggestion(input({ keyword: { currentBid: 0 } as any }))
    expect(r.decision).toBe("hold")
    if (r.decision === "hold") expect(r.reason).toBe("use_group_bid_amt")
  })
})

describe("decideMarginalSuggestion — B. ROAS 분기", () => {
  it("ROAS 6.0x ≥ target 4.0x × 1.2(=4.8) → suggest up", () => {
    const r = decideMarginalSuggestion(
      input({
        keyword: { revenue7d: 600_000, cost7d: 100_000 } as any,
        // ROAS = 6.0
        targets: { targetCpa: null, targetRoas: new Prisma.Decimal("4.0") },
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.direction).toBe("up")
      expect(r.action.suggestedBid).toBe(1150) // 1000 × 1.15
      expect(r.severity).toBe("info")
    }
  })

  it("ROAS 2.5x < target 4.0x × 0.7(=2.8) AND ≥ 2.0(=4×0.5) → suggest down info", () => {
    const r = decideMarginalSuggestion(
      input({
        keyword: { revenue7d: 250_000, cost7d: 100_000 } as any, // ROAS 2.5
        targets: { targetCpa: null, targetRoas: new Prisma.Decimal("4.0") },
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.direction).toBe("down")
      expect(r.severity).toBe("info")
    }
  })

  it("ROAS 0.5x — target 4.0x × 0.5 = 2.0 미만이라 warn", () => {
    const r = decideMarginalSuggestion(
      input({
        keyword: { revenue7d: 50_000, cost7d: 100_000 } as any, // ROAS 0.5
        targets: { targetCpa: null, targetRoas: new Prisma.Decimal("4.0") },
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.direction).toBe("down")
      expect(r.severity).toBe("warn")
    }
  })

  it("ROAS 4.5x within band (0.7~1.2) → hold", () => {
    const r = decideMarginalSuggestion(
      input({
        keyword: { revenue7d: 450_000, cost7d: 100_000 } as any, // ROAS 4.5
        targets: { targetCpa: null, targetRoas: new Prisma.Decimal("4.0") },
      }),
    )
    expect(r.decision).toBe("hold")
    if (r.decision === "hold") expect(r.reason).toMatch(/^roas_within_band/)
  })
})

describe("decideMarginalSuggestion — C. CPA 분기", () => {
  it("CPA 3000 ≤ target 5000 × 0.8(=4000) → suggest up", () => {
    const r = decideMarginalSuggestion(
      input({
        keyword: { cost7d: 60_000, conversions7d: 20 } as any, // CPA 3000
        targets: { targetCpa: 5000, targetRoas: null },
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") expect(r.action.direction).toBe("up")
  })

  it("CPA 7000 > target 5000 × 1.3(=6500) → suggest down", () => {
    const r = decideMarginalSuggestion(
      input({
        keyword: { cost7d: 70_000, conversions7d: 10 } as any, // CPA 7000
        targets: { targetCpa: 5000, targetRoas: null },
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.direction).toBe("down")
      expect(r.severity).toBe("info")
    }
  })

  it("CPA 8000 > target 5000 × 1.5(=7500) → warn severity", () => {
    const r = decideMarginalSuggestion(
      input({
        keyword: { cost7d: 80_000, conversions7d: 10 } as any, // CPA 8000
        targets: { targetCpa: 5000, targetRoas: null },
      }),
    )
    if (r.decision === "suggest") expect(r.severity).toBe("warn")
  })

  it("CPA within band → hold", () => {
    const r = decideMarginalSuggestion(
      input({
        keyword: { cost7d: 50_000, conversions7d: 10 } as any, // CPA 5000 (target)
        targets: { targetCpa: 5000, targetRoas: null },
      }),
    )
    expect(r.decision).toBe("hold")
    if (r.decision === "hold") expect(r.reason).toMatch(/^cpa_within_band/)
  })
})

describe("decideMarginalSuggestion — D. 평균 순위 분기", () => {
  it("평균 순위가 목표보다 1위 이상 밀리고 CPC/CTR 가드레일 통과 → suggest up", () => {
    const r = decideMarginalSuggestion(
      input({
        keyword: {
          avgRank7d: 5.2,
          impressions7d: 5000,
          clicks7d: 100,
          cost7d: 90_000,
          conversions7d: null,
          revenue7d: null,
        } as any,
        targets: {
          targetCpa: null,
          targetRoas: null,
          targetAvgRank: new Prisma.Decimal("3.0"),
          targetCpc: 1000,
          maxCpc: 1500,
          minCtr: new Prisma.Decimal("1.0"),
        },
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.direction).toBe("up")
      expect(r.reason).toMatch(/평균 순위/)
      expect(r.metrics.avgRank7d).toBe(5.2)
    }
  })

  it("목표보다 충분히 상위인데 CPC가 목표보다 높으면 절감 후보로 suggest down", () => {
    const r = decideMarginalSuggestion(
      input({
        keyword: {
          avgRank7d: 1.4,
          clicks7d: 100,
          cost7d: 130_000,
          conversions7d: null,
          revenue7d: null,
        } as any,
        targets: {
          targetCpa: null,
          targetRoas: null,
          targetAvgRank: new Prisma.Decimal("3.0"),
          targetCpc: 1000,
        },
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") expect(r.action.direction).toBe("down")
  })

  it("순위 개선 필요해도 CTR 하한 미달이면 인상 대신 CTR 기준 down", () => {
    const r = decideMarginalSuggestion(
      input({
        keyword: {
          avgRank7d: 5.2,
          impressions7d: 10_000,
          clicks7d: 50,
          cost7d: 40_000,
          conversions7d: null,
          revenue7d: null,
        } as any,
        targets: {
          targetCpa: null,
          targetRoas: null,
          targetAvgRank: new Prisma.Decimal("3.0"),
          minCtr: new Prisma.Decimal("1.0"),
        },
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") expect(r.action.direction).toBe("down")
  })
})

describe("decideMarginalSuggestion — E. baseline fallback", () => {
  it("targets 없음 + 키워드 CPC > baseline × 1.5 → suggest down", () => {
    const r = decideMarginalSuggestion(
      input({
        keyword: { cost7d: 200_000, clicks7d: 100 } as any, // cpc 2000
        baseline: { avgCpc: new Prisma.Decimal("1000") } as any, // baseline 1000
        targets: { targetCpa: null, targetRoas: null },
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") expect(r.action.direction).toBe("down")
  })

  it("targets 없음 + cpc 정상 → hold no_target_cpc_normal", () => {
    const r = decideMarginalSuggestion(
      input({
        keyword: { cost7d: 100_000, clicks7d: 100 } as any, // cpc 1000 == baseline
        baseline: { avgCpc: new Prisma.Decimal("1000") } as any,
        targets: { targetCpa: null, targetRoas: null },
      }),
    )
    expect(r.decision).toBe("hold")
    if (r.decision === "hold") expect(r.reason).toBe("no_target_cpc_normal")
  })

  it("targets 없음 + baseline 없음 → hold insufficient_data", () => {
    const r = decideMarginalSuggestion(
      input({
        baseline: { avgCpc: null } as any,
        targets: { targetCpa: null, targetRoas: null },
      }),
    )
    expect(r.decision).toBe("hold")
    if (r.decision === "hold") expect(r.reason).toBe("insufficient_data_no_target")
  })
})

describe("decideMarginalSuggestion — F. clamp", () => {
  it("upper bound clamp — currentBid 95000 + up 15% = 109250 → 100000", () => {
    const r = decideMarginalSuggestion(
      input({
        keyword: { currentBid: 95_000, revenue7d: 600_000, cost7d: 100_000 } as any,
        targets: { targetCpa: null, targetRoas: new Prisma.Decimal("4.0") },
      }),
    )
    if (r.decision === "suggest") expect(r.action.suggestedBid).toBe(100_000)
  })

  it("upper bound 도달 + up direction에서 candidate=current → hold at_upper_bound", () => {
    const r = decideMarginalSuggestion(
      input({
        keyword: { currentBid: 100_000, revenue7d: 600_000, cost7d: 100_000 } as any,
        targets: { targetCpa: null, targetRoas: new Prisma.Decimal("4.0") },
      }),
    )
    expect(r.decision).toBe("hold")
    if (r.decision === "hold") expect(r.reason).toBe("at_upper_bound")
  })

  it("lower bound clamp — currentBid 80 + down 15% = 68 → 70", () => {
    const r = decideMarginalSuggestion(
      input({
        keyword: { currentBid: 80, revenue7d: 50_000, cost7d: 100_000 } as any,
        targets: { targetCpa: null, targetRoas: new Prisma.Decimal("4.0") },
      }),
    )
    if (r.decision === "suggest") expect(r.action.suggestedBid).toBe(70)
  })

  it("lower bound 도달 + down direction에서 candidate=current → hold at_lower_bound", () => {
    const r = decideMarginalSuggestion(
      input({
        keyword: { currentBid: 70, revenue7d: 50_000, cost7d: 100_000 } as any,
        targets: { targetCpa: null, targetRoas: new Prisma.Decimal("4.0") },
      }),
    )
    expect(r.decision).toBe("hold")
    if (r.decision === "hold") expect(r.reason).toBe("at_lower_bound")
  })
})

describe("decideMarginalSuggestion — G. confidence", () => {
  it("clicks 50 ~ 75 → low", () => {
    const r = decideMarginalSuggestion(
      input({
        keyword: { clicks7d: 60, revenue7d: 600_000, cost7d: 100_000 } as any,
        targets: { targetCpa: null, targetRoas: new Prisma.Decimal("4.0") },
      }),
    )
    if (r.decision === "suggest") expect(r.confidence).toBe("low")
  })

  it("clicks 100 → medium", () => {
    const r = decideMarginalSuggestion(
      input({
        keyword: { clicks7d: 100, revenue7d: 600_000, cost7d: 100_000 } as any,
        targets: { targetCpa: null, targetRoas: new Prisma.Decimal("4.0") },
      }),
    )
    if (r.decision === "suggest") expect(r.confidence).toBe("medium")
  })

  it("clicks ≥ 200 → high", () => {
    const r = decideMarginalSuggestion(
      input({
        keyword: { clicks7d: 250, revenue7d: 600_000, cost7d: 100_000 } as any,
        targets: { targetCpa: null, targetRoas: new Prisma.Decimal("4.0") },
      }),
    )
    if (r.decision === "suggest") expect(r.confidence).toBe("high")
  })
})

describe("decideMarginalSuggestion — H. config 기본값", () => {
  it("DEFAULT_MARGINAL_CONFIG 노출", () => {
    expect(DEFAULT_MARGINAL_CONFIG.minClicksForConfidence).toBe(50)
    expect(DEFAULT_MARGINAL_CONFIG.maxBidChangePct).toBe(15)
    expect(DEFAULT_MARGINAL_CONFIG.bidLowerBound).toBe(70)
    expect(DEFAULT_MARGINAL_CONFIG.bidUpperBound).toBe(100_000)
  })

  it("config 부분 override 가능", () => {
    const r = decideMarginalSuggestion(
      input({
        keyword: { clicks7d: 30, revenue7d: 600_000, cost7d: 100_000 } as any,
        targets: { targetCpa: null, targetRoas: new Prisma.Decimal("4.0") },
        config: { minClicksForConfidence: 20 },
      }),
    )
    expect(r.decision).toBe("suggest") // 30 ≥ 20 통과
  })
})
