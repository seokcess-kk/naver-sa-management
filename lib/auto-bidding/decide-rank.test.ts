/**
 * lib/auto-bidding/decide-rank.ts 단위 테스트 (Phase B.2)
 *
 * 검증 매트릭스:
 *   A. 가드 — currentBid <= 0 → hold "use_group_bid_amt"
 *   B. 이미 달성 — recentAvgRnk <= target → hold "already_at_or_above_target"
 *   C. Estimate 행 누락 / 무효 bid
 *   D. Estimate <= currentBid → hold "estimate_below_current"
 *   E. 정상 인상 (clean case)
 *   F. maxCpc 클램프 — cappedByMaxCpc=true / severity=warn
 *   G. capped_at_max_cpc — 클램프로 인해 currentBid 와 동일
 *   H. targetAvgRank=NULL → defaultTargetRank=5
 *   I. targetAvgRank=Prisma.Decimal 입력 정상 동작
 *   J. bidLowerBound 클램프
 */

import { describe, expect, it } from "vitest"
import { Prisma } from "@/lib/generated/prisma/client"

import type { AveragePositionBidRow } from "@/lib/naver-sa/estimate"

import {
  decideAdgroupRankSuggestion,
  decideRankSuggestion,
  DEFAULT_RANK_CONFIG,
  type AdgroupRankDecisionInput,
  type RankDecisionInput,
} from "./decide-rank"

/** position 1..5 행을 bids 배열로 합성 (idx0 → position 1). */
function makeRows(bids: number[]): AveragePositionBidRow[] {
  return bids.map((bid, i) => ({
    keyword: "테스트키워드",
    position: i + 1,
    bid,
  }))
}

/** 기본 입력 헬퍼 — 각 테스트가 필드 override. */
function input(over: Partial<RankDecisionInput> = {}): RankDecisionInput {
  return {
    keyword: {
      keywordId: "kw1",
      nccKeywordId: "nccKw1",
      currentBid: 1000,
      recentAvgRnk: 7.5,
      ...over.keyword,
    },
    targetAvgRank: over.targetAvgRank !== undefined ? over.targetAvgRank : 5,
    maxCpc: over.maxCpc !== undefined ? over.maxCpc : null,
    // position 1=2500, 2=2000, 3=1600, 4=1400, 5=1200
    estimateRows: over.estimateRows ?? makeRows([2500, 2000, 1600, 1400, 1200]),
    config: over.config,
  }
}

describe("decideRankSuggestion — A. 그룹입찰가 가드", () => {
  it("currentBid=0 → hold use_group_bid_amt", () => {
    const r = decideRankSuggestion(
      input({ keyword: { currentBid: 0 } as any }),
    )
    expect(r.decision).toBe("hold")
    if (r.decision === "hold") expect(r.reason).toBe("use_group_bid_amt")
  })

  it("currentBid=-1 → hold use_group_bid_amt", () => {
    const r = decideRankSuggestion(
      input({ keyword: { currentBid: -1 } as any }),
    )
    expect(r.decision).toBe("hold")
    if (r.decision === "hold") expect(r.reason).toBe("use_group_bid_amt")
  })
})

describe("decideRankSuggestion — B. 이미 목표 달성", () => {
  it("recentAvgRnk=4 < target=5 → hold already_at_or_above_target", () => {
    const r = decideRankSuggestion(
      input({ keyword: { recentAvgRnk: 4 } as any, targetAvgRank: 5 }),
    )
    expect(r.decision).toBe("hold")
    if (r.decision === "hold")
      expect(r.reason).toBe("already_at_or_above_target")
  })

  it("recentAvgRnk=5 == target=5 → hold (경계값, '미달'은 strict greater-than)", () => {
    const r = decideRankSuggestion(
      input({ keyword: { recentAvgRnk: 5 } as any, targetAvgRank: 5 }),
    )
    expect(r.decision).toBe("hold")
    if (r.decision === "hold")
      expect(r.reason).toBe("already_at_or_above_target")
  })

  it("recentAvgRnk=5.01 > target=5 → 진입 (이 테스트는 다른 hold 가능, hold 사유만 체크)", () => {
    const r = decideRankSuggestion(
      input({ keyword: { recentAvgRnk: 5.01 } as any, targetAvgRank: 5 }),
    )
    if (r.decision === "hold") {
      expect(r.reason).not.toBe("already_at_or_above_target")
    }
  })
})

describe("decideRankSuggestion — C. Estimate 행 누락 / 무효", () => {
  it("estimateRows=[] → hold estimate_position_not_found", () => {
    const r = decideRankSuggestion(input({ estimateRows: [] }))
    expect(r.decision).toBe("hold")
    if (r.decision === "hold")
      expect(r.reason).toBe("estimate_position_not_found")
  })

  it("position=5 행 누락 (1~4만) → hold estimate_position_not_found", () => {
    const r = decideRankSuggestion(
      input({ estimateRows: makeRows([2500, 2000, 1600, 1400]) }),
    )
    expect(r.decision).toBe("hold")
    if (r.decision === "hold")
      expect(r.reason).toBe("estimate_position_not_found")
  })

  it("position=5 bid=0 → hold estimate_invalid_bid", () => {
    const r = decideRankSuggestion(
      input({ estimateRows: makeRows([2500, 2000, 1600, 1400, 0]) }),
    )
    expect(r.decision).toBe("hold")
    if (r.decision === "hold") expect(r.reason).toBe("estimate_invalid_bid")
  })

  it("position=5 bid=-100 → hold estimate_invalid_bid", () => {
    const r = decideRankSuggestion(
      input({ estimateRows: makeRows([2500, 2000, 1600, 1400, -100]) }),
    )
    expect(r.decision).toBe("hold")
    if (r.decision === "hold") expect(r.reason).toBe("estimate_invalid_bid")
  })
})

describe("decideRankSuggestion — D. Estimate <= currentBid", () => {
  it("estimatedBid 1200 <= currentBid 1500 → hold estimate_below_current", () => {
    const r = decideRankSuggestion(
      input({
        keyword: { currentBid: 1500, recentAvgRnk: 7.5 } as any,
        // position=5 bid=1200 < 1500
      }),
    )
    expect(r.decision).toBe("hold")
    if (r.decision === "hold") expect(r.reason).toBe("estimate_below_current")
  })

  it("estimatedBid 1200 == currentBid 1200 → hold estimate_below_current (경계)", () => {
    const r = decideRankSuggestion(
      input({ keyword: { currentBid: 1200, recentAvgRnk: 7.5 } as any }),
    )
    expect(r.decision).toBe("hold")
    if (r.decision === "hold") expect(r.reason).toBe("estimate_below_current")
  })
})

describe("decideRankSuggestion — E. 정상 인상 (clean case)", () => {
  it("currentBid 1000 + estimate 1200 + maxCpc null → suggest up info, +20%", () => {
    const r = decideRankSuggestion(
      input({
        keyword: { currentBid: 1000, recentAvgRnk: 7.5 } as any,
        targetAvgRank: 5,
        maxCpc: null,
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.kind).toBe("keyword_bid_update")
      expect(r.action.reasonCode).toBe("below_target_rank")
      expect(r.action.direction).toBe("up")
      expect(r.action.currentBid).toBe(1000)
      expect(r.action.suggestedBid).toBe(1200)
      expect(r.action.deltaPct).toBe(20)
      expect(r.action.cappedByMaxCpc).toBe(false)
      expect(r.action.targetAvgRank).toBe(5)
      expect(r.action.currentAvgRank).toBe(7.5)
      expect(r.severity).toBe("info")
      expect(r.reason).toMatch(/평균 순위 7\.5위 > 목표 5위/)
      expect(r.reason).toMatch(/\+20% 인상 권고/)
    }
  })

  it("maxCpc 충분히 큰 경우 — cappedByMaxCpc=false, info", () => {
    const r = decideRankSuggestion(
      input({
        keyword: { currentBid: 1000, recentAvgRnk: 7.5 } as any,
        maxCpc: 5000,
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.cappedByMaxCpc).toBe(false)
      expect(r.action.suggestedBid).toBe(1200)
      expect(r.severity).toBe("info")
    }
  })
})

describe("decideRankSuggestion — F. maxCpc 클램프 (warn)", () => {
  it("estimate 1200 > maxCpc 1100 → suggestedBid=1100, capped warn, +10%", () => {
    const r = decideRankSuggestion(
      input({
        keyword: { currentBid: 1000, recentAvgRnk: 7.5 } as any,
        maxCpc: 1100,
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.suggestedBid).toBe(1100)
      expect(r.action.cappedByMaxCpc).toBe(true)
      expect(r.severity).toBe("warn")
      expect(r.action.deltaPct).toBe(10)
      expect(r.reason).toMatch(/maxCpc/)
      expect(r.reason).toMatch(/절단/)
    }
  })

  it("maxCpc 동등 (estimate=maxCpc) → not capped (estimate > maxCpc 만 capped)", () => {
    const r = decideRankSuggestion(
      input({
        keyword: { currentBid: 1000, recentAvgRnk: 7.5 } as any,
        maxCpc: 1200,
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.suggestedBid).toBe(1200)
      expect(r.action.cappedByMaxCpc).toBe(false)
      expect(r.severity).toBe("info")
    }
  })
})

describe("decideRankSuggestion — G. capped_at_max_cpc (클램프 후 currentBid와 동일)", () => {
  it("currentBid 1100 + estimate 1200 + maxCpc 1100 → 클램프 1100 == currentBid → hold", () => {
    const r = decideRankSuggestion(
      input({
        keyword: { currentBid: 1100, recentAvgRnk: 7.5 } as any,
        maxCpc: 1100,
      }),
    )
    expect(r.decision).toBe("hold")
    if (r.decision === "hold") expect(r.reason).toBe("capped_at_max_cpc")
  })

  it("maxCpc < currentBid (이상 케이스) → 클램프 후 hold", () => {
    // currentBid 1500 + estimate 1200 — D 분기에서 hold estimate_below_current
    // 가 먼저 잡힘. capped_at_max_cpc 분기 진입은 estimate > currentBid 인 상황에서만.
    // currentBid 1100 + estimate 1200 + maxCpc 1000 → 클램프 1000 < currentBid → hold capped.
    const r = decideRankSuggestion(
      input({
        keyword: { currentBid: 1100, recentAvgRnk: 7.5 } as any,
        maxCpc: 1000,
      }),
    )
    expect(r.decision).toBe("hold")
    if (r.decision === "hold") expect(r.reason).toBe("capped_at_max_cpc")
  })
})

describe("decideRankSuggestion — H. targetAvgRank=NULL → defaultTargetRank=5", () => {
  it("targetAvgRank=null + recentAvgRnk=7.5 → 디폴트 5위 적용 → suggest", () => {
    const r = decideRankSuggestion(
      input({
        keyword: { currentBid: 1000, recentAvgRnk: 7.5 } as any,
        targetAvgRank: null,
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.targetAvgRank).toBe(5)
      // position=5 (ceil(5)) 행 = bid 1200
      expect(r.action.suggestedBid).toBe(1200)
    }
  })

  it("targetAvgRank=null + recentAvgRnk=4 → 디폴트 5위 적용 → 이미 달성 hold", () => {
    const r = decideRankSuggestion(
      input({
        keyword: { recentAvgRnk: 4 } as any,
        targetAvgRank: null,
      }),
    )
    expect(r.decision).toBe("hold")
    if (r.decision === "hold")
      expect(r.reason).toBe("already_at_or_above_target")
  })

  it("config defaultTargetRank=3 override + targetAvgRank=null → 3위 기준 적용", () => {
    const r = decideRankSuggestion(
      input({
        keyword: { currentBid: 1000, recentAvgRnk: 4 } as any, // 4 > 3
        targetAvgRank: null,
        config: { defaultTargetRank: 3 },
        // position=3 행 = bid 1600
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.targetAvgRank).toBe(3)
      expect(r.action.suggestedBid).toBe(1600)
    }
  })
})

describe("decideRankSuggestion — I. Prisma.Decimal 입력", () => {
  it("targetAvgRank=Decimal('5') 정상 동작 (Number 변환)", () => {
    const r = decideRankSuggestion(
      input({
        keyword: { currentBid: 1000, recentAvgRnk: 7.5 } as any,
        targetAvgRank: new Prisma.Decimal("5"),
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.targetAvgRank).toBe(5)
      expect(r.action.suggestedBid).toBe(1200)
    }
  })

  it("targetAvgRank=Decimal('3.5') → ceil(3.5)=4 위 행 사용", () => {
    const r = decideRankSuggestion(
      input({
        keyword: { currentBid: 1000, recentAvgRnk: 6 } as any,
        targetAvgRank: new Prisma.Decimal("3.5"),
        // position=4 행 = bid 1400
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.targetAvgRank).toBe(3.5)
      expect(r.action.suggestedBid).toBe(1400)
    }
  })

  it("targetAvgRank=Decimal — 이미 달성 케이스도 정상", () => {
    const r = decideRankSuggestion(
      input({
        keyword: { recentAvgRnk: 4 } as any,
        targetAvgRank: new Prisma.Decimal("5"),
      }),
    )
    expect(r.decision).toBe("hold")
    if (r.decision === "hold")
      expect(r.reason).toBe("already_at_or_above_target")
  })
})

describe("decideRankSuggestion — J. bidLowerBound 클램프", () => {
  it("estimate 50 (< bidLowerBound 70) + currentBid 40 — 70으로 끌어올림 후 진입", () => {
    // currentBid 40 + recentAvgRnk 7.5 + position=5 bid=50.
    // estimate 50 > currentBid 40 통과 → effectiveMax = 100000 (maxCpc null) →
    // suggestedBid = min(50, 100000) = 50 → max(70, 50) = 70 → 70 > 40 OK.
    const r = decideRankSuggestion(
      input({
        keyword: { currentBid: 40, recentAvgRnk: 7.5 } as any,
        estimateRows: makeRows([200, 150, 120, 90, 50]),
        maxCpc: null,
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.suggestedBid).toBe(70)
      // (70 - 40) / 40 * 100 = 75
      expect(r.action.deltaPct).toBe(75)
      expect(r.action.cappedByMaxCpc).toBe(false)
    }
  })

  it("config bidLowerBound override — 100으로 강제 상승", () => {
    const r = decideRankSuggestion(
      input({
        keyword: { currentBid: 50, recentAvgRnk: 7.5 } as any,
        estimateRows: makeRows([200, 150, 120, 90, 80]),
        config: { bidLowerBound: 100 },
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.suggestedBid).toBe(100)
    }
  })
})

describe("decideRankSuggestion — K. config 기본값 / deltaPct 정확도", () => {
  it("DEFAULT_RANK_CONFIG 노출", () => {
    expect(DEFAULT_RANK_CONFIG.defaultTargetRank).toBe(5)
    expect(DEFAULT_RANK_CONFIG.bidLowerBound).toBe(70)
    expect(DEFAULT_RANK_CONFIG.bidUpperBound).toBe(100_000)
  })

  it("deltaPct 소수점 2자리 반올림 — 1000 → 1234 = 23.4%", () => {
    const r = decideRankSuggestion(
      input({
        keyword: { currentBid: 1000, recentAvgRnk: 7.5 } as any,
        estimateRows: makeRows([3000, 2500, 2000, 1600, 1234]),
      }),
    )
    if (r.decision === "suggest") {
      // (1234 - 1000) / 1000 * 100 = 23.4
      expect(r.action.deltaPct).toBe(23.4)
    }
  })

  it("deltaPct 소수점 — 1000 → 1003 = 0.3%", () => {
    const r = decideRankSuggestion(
      input({
        keyword: { currentBid: 1000, recentAvgRnk: 7.5 } as any,
        estimateRows: makeRows([3000, 2500, 2000, 1600, 1003]),
      }),
    )
    if (r.decision === "suggest") {
      expect(r.action.deltaPct).toBe(0.3)
    }
  })
})

// =============================================================================
// 광고그룹 단위 — decideAdgroupRankSuggestion (Phase 2A)
// =============================================================================
//
// 키워드용과 분기 본체 공유 (evaluateRankBranch 헬퍼). 본 describe 는 핵심 분기만 검증:
//   - already_at_or_above_target / 정상 인상 / maxCpc 클램프 / capped_at_max_cpc /
//     targetAvgRank NULL 디폴트 5 / window/sample passthrough.
// 28건의 키워드용 테스트가 동일 분기 9단계 매트릭스를 보장.

function adgroupInput(
  over: Partial<AdgroupRankDecisionInput> = {},
): AdgroupRankDecisionInput {
  return {
    adgroup: {
      adgroupId: "ag1",
      nccAdgroupId: "nccAg1",
      currentBid: 1000,
      recentAvgRnk: 7.5,
      ...over.adgroup,
    },
    targetAvgRank: over.targetAvgRank !== undefined ? over.targetAvgRank : 5,
    maxCpc: over.maxCpc !== undefined ? over.maxCpc : null,
    estimateRows: over.estimateRows ?? makeRows([2500, 2000, 1600, 1400, 1200]),
    config: over.config,
    rankWindowHours: over.rankWindowHours,
    rankSampleImpressions: over.rankSampleImpressions,
  }
}

describe("decideAdgroupRankSuggestion — already_at_or_above_target", () => {
  it("recentAvgRnk=4 < target=5 → hold", () => {
    const r = decideAdgroupRankSuggestion(
      adgroupInput({ adgroup: { recentAvgRnk: 4 } as any, targetAvgRank: 5 }),
    )
    expect(r.decision).toBe("hold")
    if (r.decision === "hold")
      expect(r.reason).toBe("already_at_or_above_target")
  })
})

describe("decideAdgroupRankSuggestion — 정상 인상 (clean case)", () => {
  it("currentBid 1000 + estimate 1200 → suggest, kind/reasonCode/passthrough 검증", () => {
    const r = decideAdgroupRankSuggestion(
      adgroupInput({
        adgroup: {
          adgroupId: "agX",
          nccAdgroupId: "nccAgX",
          currentBid: 1000,
          recentAvgRnk: 7.5,
        },
        targetAvgRank: 5,
        maxCpc: null,
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.kind).toBe("adgroup_default_bid_update")
      expect(r.action.reasonCode).toBe("adgroup_below_target_rank")
      expect(r.action.adgroupId).toBe("agX")
      expect(r.action.nccAdgroupId).toBe("nccAgX")
      expect(r.action.direction).toBe("up")
      expect(r.action.currentBid).toBe(1000)
      expect(r.action.suggestedBid).toBe(1200)
      expect(r.action.deltaPct).toBe(20)
      expect(r.action.cappedByMaxCpc).toBe(false)
      expect(r.action.targetAvgRank).toBe(5)
      expect(r.action.currentAvgRank).toBe(7.5)
      expect(r.severity).toBe("info")
      expect(r.reason).toMatch(/광고그룹 평균 순위 7\.5위 > 목표 5위/)
      expect(r.reason).toMatch(/\+20% 인상 권고/)
    }
  })
})

describe("decideAdgroupRankSuggestion — maxCpc 클램프 (warn)", () => {
  it("estimate 1200 > maxCpc 1100 → suggestedBid=1100, capped warn", () => {
    const r = decideAdgroupRankSuggestion(
      adgroupInput({
        adgroup: { currentBid: 1000, recentAvgRnk: 7.5 } as any,
        maxCpc: 1100,
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.suggestedBid).toBe(1100)
      expect(r.action.cappedByMaxCpc).toBe(true)
      expect(r.severity).toBe("warn")
      expect(r.action.deltaPct).toBe(10)
      expect(r.reason).toMatch(/maxCpc/)
      expect(r.reason).toMatch(/절단/)
      expect(r.reason).toMatch(/광고그룹 평균 순위/)
    }
  })
})

describe("decideAdgroupRankSuggestion — capped_at_max_cpc", () => {
  it("currentBid 1100 + estimate 1200 + maxCpc 1100 → 클램프 1100 == currentBid → hold", () => {
    const r = decideAdgroupRankSuggestion(
      adgroupInput({
        adgroup: { currentBid: 1100, recentAvgRnk: 7.5 } as any,
        maxCpc: 1100,
      }),
    )
    expect(r.decision).toBe("hold")
    if (r.decision === "hold") expect(r.reason).toBe("capped_at_max_cpc")
  })
})

describe("decideAdgroupRankSuggestion — targetAvgRank=NULL 디폴트 5", () => {
  it("targetAvgRank=null + recentAvgRnk=7.5 → 디폴트 5위 적용 → suggest", () => {
    const r = decideAdgroupRankSuggestion(
      adgroupInput({
        adgroup: { currentBid: 1000, recentAvgRnk: 7.5 } as any,
        targetAvgRank: null,
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.targetAvgRank).toBe(5)
      expect(r.action.suggestedBid).toBe(1200)
    }
  })
})

describe("decideAdgroupRankSuggestion — rankWindowHours / rankSampleImpressions passthrough", () => {
  it("undefined 입력 → null 로 직렬화", () => {
    const r = decideAdgroupRankSuggestion(
      adgroupInput({
        adgroup: { currentBid: 1000, recentAvgRnk: 7.5 } as any,
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.rankWindowHours).toBeNull()
      expect(r.action.rankSampleImpressions).toBeNull()
    }
  })

  it("rankWindowHours=6, rankSampleImpressions=12345 passthrough", () => {
    const r = decideAdgroupRankSuggestion(
      adgroupInput({
        adgroup: { currentBid: 1000, recentAvgRnk: 7.5 } as any,
        rankWindowHours: 6,
        rankSampleImpressions: 12345,
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.rankWindowHours).toBe(6)
      expect(r.action.rankSampleImpressions).toBe(12345)
    }
  })
})

// =============================================================================
// L. MOBILE Estimate 확장 (selectedDevice / max 정책)
// =============================================================================
//
// 정책: Estimate 만 디바이스 분리 — `max(pcBid, mobileBid)` 적용 (PC·MOBILE 둘 다 5위 도달 보장).
// 측정값(StatHourly) 은 device='ALL' 만 적재 가능 (네이버 SA 한계) — 별도 검증.
// 광고그룹용 동일 검증은 M. 섹션.

describe("decideRankSuggestion — L1. PC만 (estimateRowsMobile 미전달, 기존 호환)", () => {
  it("MOBILE 미전달 → PC 기준, selectedDevice='PC', estimatedBidMobile=null", () => {
    const r = decideRankSuggestion(
      input({
        keyword: { currentBid: 1000, recentAvgRnk: 7.5 } as any,
        // estimateRowsMobile 미전달 — 기존 호환 동작
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.suggestedBid).toBe(1200)
      expect(r.action.selectedDevice).toBe("PC")
      expect(r.action.estimatedBidPc).toBe(1200)
      expect(r.action.estimatedBidMobile).toBeNull()
      expect(r.reason).toMatch(/\(PC 기준\)/)
    }
  })
})

describe("decideRankSuggestion — L2. MOBILE만 (PC 행 부재)", () => {
  it("PC estimateRows=[], MOBILE 데이터 → MOBILE 기준 권고, selectedDevice='MOBILE'", () => {
    const r = decideRankSuggestion({
      keyword: {
        keywordId: "kw1",
        nccKeywordId: "nccKw1",
        currentBid: 1000,
        recentAvgRnk: 7.5,
      },
      targetAvgRank: 5,
      maxCpc: null,
      estimateRows: [],
      estimateRowsMobile: makeRows([2500, 2000, 1600, 1400, 1300]),
    })
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.suggestedBid).toBe(1300)
      expect(r.action.selectedDevice).toBe("MOBILE")
      expect(r.action.estimatedBidPc).toBeNull()
      expect(r.action.estimatedBidMobile).toBe(1300)
      expect(r.reason).toMatch(/\(MOBILE 기준\)/)
      expect(r.action.deltaPct).toBe(30)
    }
  })
})

describe("decideRankSuggestion — L3. 둘 다 + PC > MOBILE", () => {
  it("PC 1500 / MOBILE 1200 → PC max, selectedDevice='PC', 둘 다 채워짐", () => {
    const r = decideRankSuggestion({
      keyword: {
        keywordId: "kw1",
        nccKeywordId: "nccKw1",
        currentBid: 1000,
        recentAvgRnk: 7.5,
      },
      targetAvgRank: 5,
      maxCpc: null,
      estimateRows: makeRows([2500, 2000, 1600, 1400, 1500]),
      estimateRowsMobile: makeRows([2200, 1800, 1500, 1300, 1200]),
    })
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.suggestedBid).toBe(1500)
      expect(r.action.selectedDevice).toBe("PC")
      expect(r.action.estimatedBidPc).toBe(1500)
      expect(r.action.estimatedBidMobile).toBe(1200)
      // 본문은 비교 형식 (PC ... / MOBILE ... — PC 기준 ...)
      expect(r.reason).toMatch(/PC 1,500원 \/ MOBILE 1,200원/)
      expect(r.reason).toMatch(/PC 기준/)
    }
  })
})

describe("decideRankSuggestion — L4. 둘 다 + MOBILE > PC", () => {
  it("PC 1200 / MOBILE 1500 → MOBILE max, selectedDevice='MOBILE'", () => {
    const r = decideRankSuggestion({
      keyword: {
        keywordId: "kw1",
        nccKeywordId: "nccKw1",
        currentBid: 1000,
        recentAvgRnk: 7.5,
      },
      targetAvgRank: 5,
      maxCpc: null,
      estimateRows: makeRows([2500, 2000, 1600, 1400, 1200]),
      estimateRowsMobile: makeRows([2800, 2300, 1900, 1700, 1500]),
    })
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.suggestedBid).toBe(1500)
      expect(r.action.selectedDevice).toBe("MOBILE")
      expect(r.action.estimatedBidPc).toBe(1200)
      expect(r.action.estimatedBidMobile).toBe(1500)
      expect(r.reason).toMatch(/PC 1,200원 \/ MOBILE 1,500원/)
      expect(r.reason).toMatch(/MOBILE 기준/)
    }
  })
})

describe("decideRankSuggestion — L5. 둘 다 동일 bid", () => {
  it("PC 1200 == MOBILE 1200 → selectedDevice='BOTH'", () => {
    const r = decideRankSuggestion({
      keyword: {
        keywordId: "kw1",
        nccKeywordId: "nccKw1",
        currentBid: 1000,
        recentAvgRnk: 7.5,
      },
      targetAvgRank: 5,
      maxCpc: null,
      estimateRows: makeRows([2500, 2000, 1600, 1400, 1200]),
      estimateRowsMobile: makeRows([2500, 2000, 1600, 1400, 1200]),
    })
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.suggestedBid).toBe(1200)
      expect(r.action.selectedDevice).toBe("BOTH")
      expect(r.action.estimatedBidPc).toBe(1200)
      expect(r.action.estimatedBidMobile).toBe(1200)
      expect(r.reason).toMatch(/PC·MOBILE 동일/)
    }
  })
})

describe("decideRankSuggestion — L6. 둘 다 부재 (estimate_position_not_found)", () => {
  it("estimateRows=[], estimateRowsMobile=[] → hold estimate_position_not_found", () => {
    const r = decideRankSuggestion({
      keyword: {
        keywordId: "kw1",
        nccKeywordId: "nccKw1",
        currentBid: 1000,
        recentAvgRnk: 7.5,
      },
      targetAvgRank: 5,
      maxCpc: null,
      estimateRows: [],
      estimateRowsMobile: [],
    })
    expect(r.decision).toBe("hold")
    if (r.decision === "hold") expect(r.reason).toBe("estimate_position_not_found")
  })

  it("PC position=5 누락 + MOBILE position=5 누락 → hold", () => {
    const r = decideRankSuggestion({
      keyword: {
        keywordId: "kw1",
        nccKeywordId: "nccKw1",
        currentBid: 1000,
        recentAvgRnk: 7.5,
      },
      targetAvgRank: 5,
      maxCpc: null,
      estimateRows: makeRows([2500, 2000, 1600, 1400]),
      estimateRowsMobile: makeRows([2200, 1800, 1500, 1300]),
    })
    expect(r.decision).toBe("hold")
    if (r.decision === "hold") expect(r.reason).toBe("estimate_position_not_found")
  })
})

describe("decideRankSuggestion — L7. 둘 다 currentBid 이하 (estimate_below_current)", () => {
  it("PC 800 / MOBILE 900 + currentBid 1000 → max=900 <= currentBid → hold", () => {
    const r = decideRankSuggestion({
      keyword: {
        keywordId: "kw1",
        nccKeywordId: "nccKw1",
        currentBid: 1000,
        recentAvgRnk: 7.5,
      },
      targetAvgRank: 5,
      maxCpc: null,
      estimateRows: makeRows([2500, 2000, 1600, 1200, 800]),
      estimateRowsMobile: makeRows([2200, 1800, 1500, 1100, 900]),
    })
    expect(r.decision).toBe("hold")
    if (r.decision === "hold") expect(r.reason).toBe("estimate_below_current")
  })
})

describe("decideRankSuggestion — L8. max(pcBid, mobileBid) > maxCpc (capped warn)", () => {
  it("PC 1500 / MOBILE 1300 + maxCpc 1100 → max 1500 > maxCpc → suggestedBid=1100, capped warn", () => {
    const r = decideRankSuggestion({
      keyword: {
        keywordId: "kw1",
        nccKeywordId: "nccKw1",
        currentBid: 1000,
        recentAvgRnk: 7.5,
      },
      targetAvgRank: 5,
      maxCpc: 1100,
      estimateRows: makeRows([2500, 2000, 1600, 1400, 1500]),
      estimateRowsMobile: makeRows([2200, 1800, 1500, 1300, 1300]),
    })
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.suggestedBid).toBe(1100)
      expect(r.action.cappedByMaxCpc).toBe(true)
      expect(r.severity).toBe("warn")
      expect(r.action.selectedDevice).toBe("PC") // 1500 > 1300
      expect(r.action.estimatedBidPc).toBe(1500)
      expect(r.action.estimatedBidMobile).toBe(1300)
      expect(r.reason).toMatch(/maxCpc/)
      expect(r.reason).toMatch(/절단/)
      // 비교 본문 — PC 1,500원 / MOBILE 1,300원
      expect(r.reason).toMatch(/PC 1,500원 \/ MOBILE 1,300원/)
    }
  })
})

// =============================================================================
// M. 광고그룹용 MOBILE 확장 — decideAdgroupRankSuggestion
// =============================================================================

describe("decideAdgroupRankSuggestion — M1. MOBILE 미전달 (기존 호환)", () => {
  it("PC만 → selectedDevice='PC', estimatedBidMobile=null", () => {
    const r = decideAdgroupRankSuggestion(
      adgroupInput({
        adgroup: { currentBid: 1000, recentAvgRnk: 7.5 } as any,
      }),
    )
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.selectedDevice).toBe("PC")
      expect(r.action.estimatedBidPc).toBe(1200)
      expect(r.action.estimatedBidMobile).toBeNull()
    }
  })
})

describe("decideAdgroupRankSuggestion — M2. MOBILE만", () => {
  it("PC 빈 + MOBILE 데이터 → MOBILE 기준", () => {
    const r = decideAdgroupRankSuggestion({
      adgroup: {
        adgroupId: "ag1",
        nccAdgroupId: "nccAg1",
        currentBid: 1000,
        recentAvgRnk: 7.5,
      },
      targetAvgRank: 5,
      maxCpc: null,
      estimateRows: [],
      estimateRowsMobile: makeRows([2500, 2000, 1600, 1400, 1300]),
    })
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.suggestedBid).toBe(1300)
      expect(r.action.selectedDevice).toBe("MOBILE")
      expect(r.action.estimatedBidMobile).toBe(1300)
      expect(r.reason).toMatch(/광고그룹 평균 순위/)
      expect(r.reason).toMatch(/\(MOBILE 기준\)/)
    }
  })
})

describe("decideAdgroupRankSuggestion — M3. PC > MOBILE max", () => {
  it("PC 1500 / MOBILE 1200 → PC max, 비교 본문", () => {
    const r = decideAdgroupRankSuggestion({
      adgroup: {
        adgroupId: "ag1",
        nccAdgroupId: "nccAg1",
        currentBid: 1000,
        recentAvgRnk: 7.5,
      },
      targetAvgRank: 5,
      maxCpc: null,
      estimateRows: makeRows([2500, 2000, 1600, 1400, 1500]),
      estimateRowsMobile: makeRows([2200, 1800, 1500, 1300, 1200]),
    })
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.suggestedBid).toBe(1500)
      expect(r.action.selectedDevice).toBe("PC")
      expect(r.action.estimatedBidPc).toBe(1500)
      expect(r.action.estimatedBidMobile).toBe(1200)
      expect(r.reason).toMatch(/PC 1,500원 \/ MOBILE 1,200원/)
    }
  })
})

describe("decideAdgroupRankSuggestion — M4. MOBILE > PC max", () => {
  it("MOBILE max → selectedDevice='MOBILE'", () => {
    const r = decideAdgroupRankSuggestion({
      adgroup: {
        adgroupId: "ag1",
        nccAdgroupId: "nccAg1",
        currentBid: 1000,
        recentAvgRnk: 7.5,
      },
      targetAvgRank: 5,
      maxCpc: null,
      estimateRows: makeRows([2500, 2000, 1600, 1400, 1200]),
      estimateRowsMobile: makeRows([2800, 2300, 1900, 1700, 1500]),
    })
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.suggestedBid).toBe(1500)
      expect(r.action.selectedDevice).toBe("MOBILE")
    }
  })
})

describe("decideAdgroupRankSuggestion — M5. 둘 다 동일", () => {
  it("PC == MOBILE → selectedDevice='BOTH'", () => {
    const r = decideAdgroupRankSuggestion({
      adgroup: {
        adgroupId: "ag1",
        nccAdgroupId: "nccAg1",
        currentBid: 1000,
        recentAvgRnk: 7.5,
      },
      targetAvgRank: 5,
      maxCpc: null,
      estimateRows: makeRows([2500, 2000, 1600, 1400, 1200]),
      estimateRowsMobile: makeRows([2500, 2000, 1600, 1400, 1200]),
    })
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.selectedDevice).toBe("BOTH")
      expect(r.reason).toMatch(/PC·MOBILE 동일/)
    }
  })
})

describe("decideAdgroupRankSuggestion — M6. 둘 다 부재", () => {
  it("estimateRows=[], estimateRowsMobile=[] → hold estimate_position_not_found", () => {
    const r = decideAdgroupRankSuggestion({
      adgroup: {
        adgroupId: "ag1",
        nccAdgroupId: "nccAg1",
        currentBid: 1000,
        recentAvgRnk: 7.5,
      },
      targetAvgRank: 5,
      maxCpc: null,
      estimateRows: [],
      estimateRowsMobile: [],
    })
    expect(r.decision).toBe("hold")
    if (r.decision === "hold") expect(r.reason).toBe("estimate_position_not_found")
  })
})

describe("decideAdgroupRankSuggestion — M7. max > maxCpc (capped warn)", () => {
  it("PC 1500 / MOBILE 1300 + maxCpc 1100 → 1100 / capped warn / 비교 본문 + 절단", () => {
    const r = decideAdgroupRankSuggestion({
      adgroup: {
        adgroupId: "ag1",
        nccAdgroupId: "nccAg1",
        currentBid: 1000,
        recentAvgRnk: 7.5,
      },
      targetAvgRank: 5,
      maxCpc: 1100,
      estimateRows: makeRows([2500, 2000, 1600, 1400, 1500]),
      estimateRowsMobile: makeRows([2200, 1800, 1500, 1300, 1300]),
    })
    expect(r.decision).toBe("suggest")
    if (r.decision === "suggest") {
      expect(r.action.suggestedBid).toBe(1100)
      expect(r.action.cappedByMaxCpc).toBe(true)
      expect(r.severity).toBe("warn")
      expect(r.action.selectedDevice).toBe("PC")
      expect(r.reason).toMatch(/PC 1,500원 \/ MOBILE 1,300원/)
      expect(r.reason).toMatch(/절단/)
    }
  })
})
