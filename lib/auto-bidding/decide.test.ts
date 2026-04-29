/**
 * F-11.2 — decideBidAdjustment 분기 매트릭스 단위 테스트.
 *
 * 외부 호출 0 — 순수 함수 테스트.
 *
 * 검증 분기:
 *   1. rank_unavailable (recentAvgRnk == null)
 *   2. on_target (|recentAvgRnk - targetRank| <= 1)
 *   3. estimate_unavailable (positions 에 targetRank 없음)
 *   4. estimate_invalid (bid <= 0)
 *   5. policy.maxBid cap
 *   6. policy.minBid cap
 *   7. guardrail upper cap (Estimate > 현재 ±20%)
 *   8. guardrail lower cap (Estimate < 현재 ±20%)
 *   9. currentBid=null → guardrail skip + Estimate 그대로
 *  10. currentBid=0 → guardrail skip
 *  11. no_change (clamp 결과가 currentBid 와 동일)
 *  12. happy path (Estimate 그대로 적용)
 *  13. skipReasonToRunResult 매핑 검증
 */

import { describe, it, expect } from "vitest"

import {
  decideBidAdjustment,
  skipReasonToRunResult,
  type DecideInput,
} from "@/lib/auto-bidding/decide"

// 공통 base — 각 케이스에서 override
function baseInput(over?: Partial<DecideInput>): DecideInput {
  return {
    policy: {
      id: "p_1",
      advertiserId: "adv_1",
      keywordId: "kw_1",
      device: "PC",
      targetRank: 1,
      maxBid: null,
      minBid: null,
    },
    keyword: {
      id: "kw_1",
      nccKeywordId: "ncc_kw_1",
      bidAmt: 1000,
      recentAvgRnk: 5.5,
    },
    estimateBids: [
      { keyword: "신발", position: 1, bid: 1500 },
      { keyword: "신발", position: 2, bid: 1100 },
      { keyword: "신발", position: 3, bid: 800 },
      { keyword: "신발", position: 4, bid: 600 },
      { keyword: "신발", position: 5, bid: 400 },
    ],
    guardrail: { maxBidChangePct: 20 },
    ...over,
  }
}

describe("decideBidAdjustment", () => {
  it("1. recentAvgRnk null → skip rank_unavailable", () => {
    const r = decideBidAdjustment(
      baseInput({
        keyword: {
          id: "kw_1",
          nccKeywordId: "ncc",
          bidAmt: 1000,
          recentAvgRnk: null,
        },
      }),
    )
    expect(r.skip).toBe(true)
    if (!r.skip) return
    expect(r.reason).toBe("rank_unavailable")
  })

  it("2. |rank - target| <= 1 → skip on_target (1.5 vs target 1)", () => {
    const r = decideBidAdjustment(
      baseInput({
        keyword: {
          id: "kw_1",
          nccKeywordId: "ncc",
          bidAmt: 1000,
          recentAvgRnk: 1.5,
        },
      }),
    )
    expect(r.skip).toBe(true)
    if (!r.skip) return
    expect(r.reason).toBe("on_target")
  })

  it("2b. 정확히 ±1 차이도 on_target (boundary)", () => {
    const r = decideBidAdjustment(
      baseInput({
        keyword: {
          id: "kw_1",
          nccKeywordId: "ncc",
          bidAmt: 1000,
          recentAvgRnk: 2.0,
        },
      }),
    )
    expect(r.skip).toBe(true)
    if (!r.skip) return
    expect(r.reason).toBe("on_target")
  })

  it("3. Estimate row 에 targetRank position 없음 → skip estimate_unavailable", () => {
    const r = decideBidAdjustment(
      baseInput({
        policy: {
          id: "p",
          advertiserId: "adv",
          keywordId: "kw",
          device: "PC",
          targetRank: 7,
          maxBid: null,
          minBid: null,
        },
      }),
    )
    expect(r.skip).toBe(true)
    if (!r.skip) return
    expect(r.reason).toBe("estimate_unavailable")
  })

  it("4. Estimate row.bid <= 0 → skip estimate_invalid", () => {
    const r = decideBidAdjustment(
      baseInput({
        estimateBids: [{ keyword: "신발", position: 1, bid: 0 }],
      }),
    )
    expect(r.skip).toBe(true)
    if (!r.skip) return
    expect(r.reason).toBe("estimate_invalid")
  })

  it("5. policy.maxBid cap — Estimate 1500 + maxBid 1100 → 1100", () => {
    // currentBid 1000, maxBidChangePct 20 → upper = 1200 (1000*1.2)
    // base=1500 → maxBid 1100 (cap), guardrail upper 1200 (no further cap), final=1100
    const r = decideBidAdjustment(
      baseInput({
        policy: {
          id: "p",
          advertiserId: "adv",
          keywordId: "kw",
          device: "PC",
          targetRank: 1,
          maxBid: 1100,
          minBid: null,
        },
      }),
    )
    expect(r.skip).toBe(false)
    if (r.skip) return
    expect(r.newBidAmt).toBe(1100)
  })

  it("6. policy.minBid cap — Estimate 400 + minBid 500 (target 5, rank 1.0) → 800", () => {
    // recentAvgRnk 1.0, targetRank 5 → |1.0-5|=4 > 1 → on_target 아님 (진행)
    // currentBid 1000, minBid 500, Estimate 400
    // base=400 → minBid 500 (raise), guardrail lower=ceil(1000*0.8)=800
    // 500 < 800 → guardrail lower cap → final 800
    // 검증: minBid cap 적용된 후 guardrail 도 적용 (직렬 cascading) — 결과 800
    const r = decideBidAdjustment(
      baseInput({
        policy: {
          id: "p",
          advertiserId: "adv",
          keywordId: "kw",
          device: "PC",
          targetRank: 5,
          maxBid: null,
          minBid: 500,
        },
        keyword: {
          id: "kw_1",
          nccKeywordId: "ncc_kw_1",
          bidAmt: 1000,
          recentAvgRnk: 1.0,
        },
      }),
    )
    expect(r.skip).toBe(false)
    if (r.skip) return
    // 800 (guardrail lower) — minBid 만으로 멈추지 않음. Guardrail 까지 거쳐 안전 입찰가 도출.
    expect(r.newBidAmt).toBe(800)
  })

  it("7. Guardrail upper cap — Estimate 1500 vs current 1000 (±20%) → 1200", () => {
    // currentBid 1000, pct 20 → upper=1200, lower=800
    // base=1500 > 1200 → 1200
    const r = decideBidAdjustment(baseInput())
    expect(r.skip).toBe(false)
    if (r.skip) return
    expect(r.newBidAmt).toBe(1200)
  })

  it("8. Guardrail lower cap — Estimate 100 vs current 1000 (target 5, rank 1.0) → 800", () => {
    // recentAvgRnk 1.0 vs targetRank 5 → 차이 4 → on_target 아님 (진행)
    // Estimate 100 → guardrail lower=ceil(1000*0.8)=800 → 800
    const r = decideBidAdjustment(
      baseInput({
        policy: {
          id: "p",
          advertiserId: "adv",
          keywordId: "kw",
          device: "PC",
          targetRank: 5,
          maxBid: null,
          minBid: null,
        },
        keyword: {
          id: "kw_1",
          nccKeywordId: "ncc_kw_1",
          bidAmt: 1000,
          recentAvgRnk: 1.0,
        },
        estimateBids: [{ keyword: "신발", position: 5, bid: 100 }],
      }),
    )
    expect(r.skip).toBe(false)
    if (r.skip) return
    expect(r.newBidAmt).toBe(800)
  })

  it("9. currentBid=null → guardrail skip, Estimate 그대로 적용 (1500)", () => {
    const r = decideBidAdjustment(
      baseInput({
        keyword: {
          id: "kw",
          nccKeywordId: "ncc",
          bidAmt: null,
          recentAvgRnk: 5.5,
        },
      }),
    )
    expect(r.skip).toBe(false)
    if (r.skip) return
    expect(r.newBidAmt).toBe(1500)
  })

  it("10. currentBid=0 → guardrail skip, Estimate 그대로 (1500)", () => {
    const r = decideBidAdjustment(
      baseInput({
        keyword: {
          id: "kw",
          nccKeywordId: "ncc",
          bidAmt: 0,
          recentAvgRnk: 5.5,
        },
      }),
    )
    expect(r.skip).toBe(false)
    if (r.skip) return
    expect(r.newBidAmt).toBe(1500)
  })

  it("11. no_change — clamp 결과가 currentBid 와 동일하면 skip", () => {
    // currentBid 1200, Estimate 1500, pct 20 → upper 1440, lower 960
    // base=1500 → upper 1440 → final 1440 (currentBid 1200 != 1440 → 변경)
    // no_change 케이스: Estimate 1200 그대로 (cap 무관) + currentBid 1200
    const r = decideBidAdjustment(
      baseInput({
        keyword: {
          id: "kw",
          nccKeywordId: "ncc",
          bidAmt: 1200,
          recentAvgRnk: 5.5,
        },
        estimateBids: [{ keyword: "신발", position: 1, bid: 1200 }],
      }),
    )
    expect(r.skip).toBe(true)
    if (!r.skip) return
    expect(r.reason).toBe("no_change")
  })

  it("12. happy path — Estimate 1100 (in-range) → 1100 적용", () => {
    // currentBid 1000, pct 20 → upper 1200, lower 800
    // Estimate position 1 = 1100 → in range → 1100
    const r = decideBidAdjustment(
      baseInput({
        estimateBids: [
          { keyword: "신발", position: 1, bid: 1100 },
          { keyword: "신발", position: 2, bid: 900 },
          { keyword: "신발", position: 3, bid: 700 },
          { keyword: "신발", position: 4, bid: 500 },
          { keyword: "신발", position: 5, bid: 300 },
        ],
      }),
    )
    expect(r.skip).toBe(false)
    if (r.skip) return
    expect(r.newBidAmt).toBe(1100)
    expect(r.reason).toBe("estimate_target_rank")
  })

  it("13. Math.round — guardrail clamp 정수 보장 (currentBid 1003, Estimate 9999)", () => {
    // currentBid 1003, pct 20 → upper = floor(1003*120/100) = floor(1203.6)=1203
    const r = decideBidAdjustment(
      baseInput({
        keyword: {
          id: "kw",
          nccKeywordId: "ncc",
          bidAmt: 1003,
          recentAvgRnk: 5.5,
        },
        estimateBids: [{ keyword: "신발", position: 1, bid: 9999 }],
      }),
    )
    expect(r.skip).toBe(false)
    if (r.skip) return
    expect(r.newBidAmt).toBe(1203)
  })

  it("14. maxBidChangePct=100 — clamp upper 2x / lower 0", () => {
    // currentBid 1000, pct 100 → upper 2000, lower 0
    // Estimate 1500 → in range → 1500
    const r = decideBidAdjustment(
      baseInput({
        guardrail: { maxBidChangePct: 100 },
      }),
    )
    expect(r.skip).toBe(false)
    if (r.skip) return
    expect(r.newBidAmt).toBe(1500)
  })

  it("15. maxBid + Guardrail 동시 — Estimate 9999 / maxBid 5000 / current 1000 → 1200", () => {
    const r = decideBidAdjustment(
      baseInput({
        policy: {
          id: "p",
          advertiserId: "adv",
          keywordId: "kw",
          device: "PC",
          targetRank: 1,
          maxBid: 5000,
          minBid: null,
        },
        estimateBids: [{ keyword: "신발", position: 1, bid: 9999 }],
      }),
    )
    expect(r.skip).toBe(false)
    if (r.skip) return
    expect(r.newBidAmt).toBe(1200)
  })
})

// =============================================================================
// F-11.4 — targetingWeight 적용 분기
// =============================================================================

describe("decideBidAdjustment — targetingWeight (F-11.4)", () => {
  it("16. targetingWeight 미지정 → 기존 동작 (default 1.0)", () => {
    // Estimate 1100 in [800, 1200] → 1100 (weight 1.0 동등)
    const r = decideBidAdjustment(
      baseInput({
        estimateBids: [{ keyword: "신발", position: 1, bid: 1100 }],
      }),
    )
    expect(r.skip).toBe(false)
    if (r.skip) return
    expect(r.newBidAmt).toBe(1100)
  })

  it("17. targetingWeight 1.5 → Estimate 1100 × 1.5 = 1650, but guardrail upper 1200 → 1200", () => {
    // currentBid 1000, pct 20 → upper 1200, lower 800
    // Estimate 1100 × weight 1.5 = 1650 → guardrail upper 1200 → 1200
    const r = decideBidAdjustment(
      baseInput({
        estimateBids: [{ keyword: "신발", position: 1, bid: 1100 }],
        targetingWeight: 1.5,
      }),
    )
    expect(r.skip).toBe(false)
    if (r.skip) return
    expect(r.newBidAmt).toBe(1200)
  })

  it("18. targetingWeight 1.5 + maxBidChangePct 100 → 1100 × 1.5 = 1650 in [0..2000] → 1650", () => {
    const r = decideBidAdjustment(
      baseInput({
        estimateBids: [{ keyword: "신발", position: 1, bid: 1100 }],
        guardrail: { maxBidChangePct: 100 }, // upper=2000, lower=0
        targetingWeight: 1.5,
      }),
    )
    expect(r.skip).toBe(false)
    if (r.skip) return
    expect(r.newBidAmt).toBe(1650)
  })

  it("19. targetingWeight 0.8 + Estimate 1100 → 880 in [800, 1200] → 880", () => {
    const r = decideBidAdjustment(
      baseInput({
        estimateBids: [{ keyword: "신발", position: 1, bid: 1100 }],
        targetingWeight: 0.8,
      }),
    )
    expect(r.skip).toBe(false)
    if (r.skip) return
    expect(r.newBidAmt).toBe(880)
  })

  it("20. targetingWeight 0.5 → 1100 × 0.5 = 550, but guardrail lower 800 → 800", () => {
    // currentBid 1000, pct 20 → lower 800
    // Estimate 1100 × 0.5 = 550 → guardrail lower 800 → 800
    const r = decideBidAdjustment(
      baseInput({
        estimateBids: [{ keyword: "신발", position: 1, bid: 1100 }],
        targetingWeight: 0.5,
      }),
    )
    expect(r.skip).toBe(false)
    if (r.skip) return
    expect(r.newBidAmt).toBe(800)
  })

  it("21. targetingWeight × maxBid cap — Estimate 800 × 2 = 1600, maxBid 1500 → 1500 (guardrail upper 1200 → 1200)", () => {
    // currentBid 1000, pct 20 → upper 1200
    // Estimate 800 × 2.0 = 1600 → maxBid cap 1500 → guardrail upper 1200 → 1200
    const r = decideBidAdjustment(
      baseInput({
        policy: {
          id: "p",
          advertiserId: "adv",
          keywordId: "kw",
          device: "PC",
          targetRank: 1,
          maxBid: 1500,
          minBid: null,
        },
        estimateBids: [{ keyword: "신발", position: 1, bid: 800 }],
        targetingWeight: 2.0,
      }),
    )
    expect(r.skip).toBe(false)
    if (r.skip) return
    expect(r.newBidAmt).toBe(1200)
  })

  it("22. targetingWeight × minBid cap — Estimate 1000 × 0.3 = 300, minBid 700 → 800 (guardrail lower 800)", () => {
    // recentAvgRnk 1.0 vs targetRank 5 → 진행
    // Estimate 1000 × 0.3 = 300 → minBid cap 700 → guardrail lower 800 → 800
    const r = decideBidAdjustment(
      baseInput({
        policy: {
          id: "p",
          advertiserId: "adv",
          keywordId: "kw",
          device: "PC",
          targetRank: 5,
          maxBid: null,
          minBid: 700,
        },
        keyword: {
          id: "kw_1",
          nccKeywordId: "ncc_kw_1",
          bidAmt: 1000,
          recentAvgRnk: 1.0,
        },
        estimateBids: [{ keyword: "신발", position: 5, bid: 1000 }],
        targetingWeight: 0.3,
      }),
    )
    expect(r.skip).toBe(false)
    if (r.skip) return
    expect(r.newBidAmt).toBe(800)
  })

  it("23. targetingWeight 0 (비정상) → 1.0 fallback (decide 내부 안전선)", () => {
    // weight 0 은 decide 가 거부하고 1.0 으로 처리 → Estimate 1100 그대로 (in range) → 1100
    const r = decideBidAdjustment(
      baseInput({
        estimateBids: [{ keyword: "신발", position: 1, bid: 1100 }],
        targetingWeight: 0,
      }),
    )
    expect(r.skip).toBe(false)
    if (r.skip) return
    expect(r.newBidAmt).toBe(1100)
  })

  it("24. targetingWeight NaN → 1.0 fallback", () => {
    const r = decideBidAdjustment(
      baseInput({
        estimateBids: [{ keyword: "신발", position: 1, bid: 1100 }],
        targetingWeight: Number.NaN,
      }),
    )
    expect(r.skip).toBe(false)
    if (r.skip) return
    expect(r.newBidAmt).toBe(1100)
  })

  it("25. targetingWeight 1.0 → no_change 발생 (Estimate 1000 × 1.0 = 1000 = currentBid)", () => {
    // Estimate 1000 × weight 1.0 = 1000, currentBid 1000 → skip no_change
    const r = decideBidAdjustment(
      baseInput({
        estimateBids: [{ keyword: "신발", position: 1, bid: 1000 }],
        targetingWeight: 1.0,
      }),
    )
    expect(r.skip).toBe(true)
    if (!r.skip) return
    expect(r.reason).toBe("no_change")
  })

  it("26. targetingWeight 1.1 + Estimate 1000 → 1100, no_change 회피 (변경 발생)", () => {
    // currentBid 1000, Estimate 1000 × 1.1 = 1100 in [800, 1200] → 1100
    const r = decideBidAdjustment(
      baseInput({
        estimateBids: [{ keyword: "신발", position: 1, bid: 1000 }],
        targetingWeight: 1.1,
      }),
    )
    expect(r.skip).toBe(false)
    if (r.skip) return
    expect(r.newBidAmt).toBe(1100)
  })
})

describe("skipReasonToRunResult", () => {
  it("매핑 5종", () => {
    expect(skipReasonToRunResult("rank_unavailable")).toBe(
      "skipped_rank_unavailable",
    )
    expect(skipReasonToRunResult("on_target")).toBe("skipped_on_target")
    expect(skipReasonToRunResult("estimate_unavailable")).toBe(
      "skipped_estimate_unavailable",
    )
    expect(skipReasonToRunResult("estimate_invalid")).toBe(
      "skipped_estimate_invalid",
    )
    expect(skipReasonToRunResult("no_change")).toBe("skipped_no_change")
  })

  it("미매핑 reason → skipped_unknown", () => {
    expect(skipReasonToRunResult("xxx")).toBe("skipped_unknown")
  })
})
