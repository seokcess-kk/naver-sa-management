/**
 * 최소 N위 노출 미달 키워드 입찰 인상 권고 결정 함수 (Phase B.2)
 *
 * 책임:
 *   - 키워드 1개의 측정 평균 순위(`recentAvgRnk`)와 Estimate API 5위 도달 입찰가를 입력받아
 *     "목표 순위 미달" 여부 판단 → BidSuggestion 적재 페이로드 생성.
 *   - 출력: Inbox 권고 (운영자 명시 승인 필요). 자동 실행 X.
 *
 * 사용자 결정사항 (2026-05-08):
 *   1. 측정값 우선 + Estimate 보조 — `recentAvgRnk > target` 키워드만 후보.
 *   2. maxCpc 로 클램프 후 권고. 클램프 발생 시 severity=warn.
 *   3. 그룹입찰가(useGroupBidAmt=true) 키워드는 본 기능 비대상 — 호출자가 제외.
 *      방어상 currentBid <= 0 → hold "use_group_bid_amt".
 *   4. BidAutomationConfig.targetAvgRank=NULL → 디폴트 5위 적용.
 *
 * 본 모듈 비대상:
 *   - Estimate API 호출 — 호출자가 `AveragePositionBidRow[]` 를 전달.
 *   - 7일 stats / baseline 사용 — 측정 평균 순위(`recentAvgRnk`) 만으로 결정.
 *   - 인하 권고 — 본 모듈은 항상 인상 (direction="up"). 인하는 marginal-score 책임.
 *
 * 단위 테스트(`decide-rank.test.ts`)가 분기 매트릭스 보장.
 */

import type { Prisma } from "@/lib/generated/prisma/client"
import type { AveragePositionBidRow } from "@/lib/naver-sa/estimate"

// =============================================================================
// 입력 타입
// =============================================================================

/** 키워드 단위 입력 — 호출자가 useGroupBidAmt / recentAvgRnk NULL 키워드는 사전 제외. */
export type RankKeywordInput = {
  keywordId: string
  nccKeywordId: string
  /** 현재 키워드 입찰가(원). > 0 가정 — useGroupBidAmt=true 키워드는 호출자가 제외. */
  currentBid: number
  /** 최근 평균 노출 순위. > 0. NULL 은 호출자가 제외. */
  recentAvgRnk: number
}

/** 시스템 한도 / 디폴트 — 호출자가 부분 override 가능. */
export type RankDecisionConfig = {
  /** 디폴트 목표 순위 (사용자 결정 #4: NULL → 5). */
  defaultTargetRank: number
  /** 입찰가 하한 (네이버 SA 70원). */
  bidLowerBound: number
  /** 입찰가 상한 (네이버 SA 100,000원). */
  bidUpperBound: number
}

export const DEFAULT_RANK_CONFIG: RankDecisionConfig = {
  defaultTargetRank: 5,
  bidLowerBound: 70,
  bidUpperBound: 100_000,
}

// =============================================================================
// 출력 타입
// =============================================================================

/**
 * 변경 권고 페이로드 — BidSuggestion.action JSON 으로 직렬화.
 *
 * marginal-score.ts 의 SuggestAction 과 호환되는 superset 구조:
 *   - kind / reasonCode 식별자 추가 (cron 적재 시 BidSuggestion.reasonCode 매핑).
 *   - targetAvgRank / currentAvgRank — 운영자 표시용 컨텍스트.
 *   - cappedByMaxCpc — Phase 2 'unreachable' 식별 여지.
 */
export type RankSuggestAction = {
  kind: "keyword_bid_update"
  reasonCode: "below_target_rank"
  currentBid: number
  suggestedBid: number
  /** 양수 (인상 권고만). round((suggestedBid - currentBid) / currentBid * 100, 2). */
  deltaPct: number
  /** 본 모듈은 항상 인상. */
  direction: "up"
  /** 정규화된 목표 순위 (NULL → defaultTargetRank). */
  targetAvgRank: number
  /** 입력 recentAvgRnk 그대로. */
  currentAvgRank: number
  /** Estimate 산출 bid 가 maxCpc 초과로 클램프된 경우 true. severity=warn. */
  cappedByMaxCpc: boolean
  /**
   * 입력 `currentAvgRank` 산출 윈도 (단위: 시간).
   *
   * - `6` — `StatHourly` 최근 N시간 노출 가중평균 사용 (cron 단 보정).
   * - `null` — last non-null 단일 시간값 (`Keyword.recentAvgRnk`) 사용 — fallback.
   *
   * 본 모듈은 단순 passthrough — 호출자(cron route)가 결정하여 전달.
   * UI 운영자 라벨용 (다음 task: 윈도 표시).
   */
  rankWindowHours: number | null
  /**
   * 가중평균 계산에 사용된 노출수 합계.
   *
   * `rankWindowHours != null` 일 때만 의미 있음. fallback (last non-null) 시 null.
   */
  rankSampleImpressions: number | null
  /**
   * PC Estimate position=ceil(target) 행의 bid (없으면 null).
   *
   * 본 모듈은 PC + MOBILE 둘 다 받아 `max(pcBid, mobileBid)` 를 적용. UI 라벨은
   * `selectedDevice` 로 어느 쪽이 채택됐는지 표시.
   */
  estimatedBidPc: number | null
  /** MOBILE Estimate position=ceil(target) 행의 bid (없으면 null). */
  estimatedBidMobile: number | null
  /**
   * `suggestedBid` 결정에 사용된 Estimate 디바이스.
   *
   * - "PC" — PC bid 가 채택 (MOBILE 미전달 / MOBILE 행 부재 / PC > MOBILE).
   * - "MOBILE" — MOBILE bid 가 채택 (PC 행 부재 / MOBILE > PC).
   * - "BOTH" — PC bid == MOBILE bid (둘 다 동일 — UI 표기 분리용).
   */
  selectedDevice: "PC" | "MOBILE" | "BOTH"
}

export type RankDecision =
  | { decision: "hold"; reason: string }
  | {
      decision: "suggest"
      reason: string
      action: RankSuggestAction
      severity: "info" | "warn"
    }

export type RankDecisionInput = {
  keyword: RankKeywordInput
  /**
   * BidAutomationConfig.targetAvgRank — NULL 허용.
   * NULL → defaultTargetRank 적용. Decimal 입력 시 Number 변환.
   */
  targetAvgRank: Prisma.Decimal | number | null
  /** BidAutomationConfig.maxCpc — NULL 허용. NULL → bidUpperBound 만 적용. */
  maxCpc: number | null
  /**
   * PC Estimate API 응답 (F-10.1 estimateAveragePositionBid, device='PC').
   * position [1..5] 5행 가정. 빈 배열 / position=N 누락 + MOBILE 도 부재 시 hold.
   */
  estimateRows: AveragePositionBidRow[]
  /**
   * MOBILE Estimate API 응답 (옵셔널 — 미전달 시 PC 만 사용 = 기존 동작 호환).
   *
   * 둘 다 전달되면 `max(pcBid, mobileBid)` 를 적용 (보수적 — PC·MOBILE 둘 다 도달 보장).
   * 둘 다 행 부재 시 hold "estimate_position_not_found".
   */
  estimateRowsMobile?: AveragePositionBidRow[]
  config?: Partial<RankDecisionConfig>
  /**
   * `keyword.recentAvgRnk` 산출 윈도 (시간).
   *
   * 호출자(cron) 가 결정해 그대로 action.rankWindowHours 로 전달.
   * - `6` — StatHourly 최근 6시간 노출 가중평균 사용.
   * - `null` (default) — `Keyword.recentAvgRnk` last non-null 단일 시간값.
   */
  rankWindowHours?: number | null
  /**
   * 가중평균 산출에 사용된 노출수 합계.
   *
   * `rankWindowHours != null` 일 때만 의미. action.rankSampleImpressions 로 passthrough.
   */
  rankSampleImpressions?: number | null
}

// =============================================================================
// 핵심 로직
// =============================================================================

/**
 * 입찰 인상 권고 결정 (목표 순위 미달 키워드).
 *
 * 분기 우선순위 (지정 순서):
 *   1. currentBid <= 0 → hold "use_group_bid_amt" (호출자 가드 백업)
 *   2. targetAvgRank 정규화 (NULL → defaultTargetRank, Decimal → Number)
 *   3. recentAvgRnk <= targetAvgRank → hold "already_at_or_above_target"
 *   4. estimateRows 에서 position === ceil(targetAvgRank) 행 찾기. 없으면 hold "estimate_position_not_found"
 *   5. 해당 행의 bid <= 0 → hold "estimate_invalid_bid"
 *   6. estimatedBid <= currentBid → hold "estimate_below_current"
 *      (이미 충분히 입찰 중인데 측정 평균만 미달 — 권고 의미 없음)
 *   7. maxCpc / bidUpperBound 클램프 + bidLowerBound 방어
 *   8. 클램프 결과 suggestedBid <= currentBid → hold "capped_at_max_cpc"
 *   9. deltaPct 계산 + reason 본문 + severity 결정
 */
export function decideRankSuggestion(input: RankDecisionInput): RankDecision {
  const config = { ...DEFAULT_RANK_CONFIG, ...input.config }
  const { keyword, targetAvgRank, maxCpc, estimateRows, estimateRowsMobile } = input
  const { currentBid, recentAvgRnk } = keyword
  const rankWindowHours =
    input.rankWindowHours === undefined ? null : input.rankWindowHours
  const rankSampleImpressions =
    input.rankSampleImpressions === undefined ? null : input.rankSampleImpressions

  const outcome = evaluateRankBranch({
    currentBid,
    recentAvgRnk,
    targetAvgRank,
    maxCpc,
    estimateRows,
    estimateRowsMobile,
    config,
  })

  if (outcome.kind === "hold") {
    return { decision: "hold", reason: outcome.reason }
  }

  const severity: "info" | "warn" = outcome.cappedByMaxCpc ? "warn" : "info"

  const reason = formatKeywordReason({
    recentAvgRnk: outcome.recentAvgRnk,
    target: outcome.target,
    lookupPosition: outcome.lookupPosition,
    estimatedBid: outcome.estimatedBid,
    suggestedBid: outcome.suggestedBid,
    estimatedBidPc: outcome.estimatedBidPc,
    estimatedBidMobile: outcome.estimatedBidMobile,
    selectedDevice: outcome.selectedDevice,
    cappedByMaxCpc: outcome.cappedByMaxCpc,
    maxCpc: outcome.maxCpc,
    deltaPct: outcome.deltaPct,
  })

  return {
    decision: "suggest",
    reason,
    action: {
      kind: "keyword_bid_update",
      reasonCode: "below_target_rank",
      currentBid: outcome.currentBid,
      suggestedBid: outcome.suggestedBid,
      deltaPct: outcome.deltaPct,
      direction: "up",
      targetAvgRank: outcome.target,
      currentAvgRank: outcome.recentAvgRnk,
      cappedByMaxCpc: outcome.cappedByMaxCpc,
      rankWindowHours,
      rankSampleImpressions,
      estimatedBidPc: outcome.estimatedBidPc,
      estimatedBidMobile: outcome.estimatedBidMobile,
      selectedDevice: outcome.selectedDevice,
    },
    severity,
  }
}

// =============================================================================
// 광고그룹 단위 권고 (Phase 2A)
// =============================================================================
//
// 트리거: 광고그룹 평균 노출 순위 미달 → AdGroup.bidAmt 인상 권고.
//   - 적용 대상: 광고그룹 내 useGroupBidAmt=true 키워드 (그룹입찰가 사용 키워드).
//   - 측정 평균 순위: 광고그룹 단위 가중평균 (StatHourly 기반) 또는 last non-null 평균.
//   - Estimate API 호출 키워드: 광고그룹 내 useGroupBidAmt=true 키워드 중 노출 TOP 1
//     (호출자가 결정해 estimateRows 전달).
//
// 분기 로직은 키워드용 `decideRankSuggestion` 과 동일 9단계 — action shape / reason 본문만 다름.
// 가독성 위해 공통 헬퍼 (`evaluateRankBranch`) 로 분기 본체 추출.

/** 광고그룹 단위 입력. */
export type AdgroupRankInput = {
  adgroupId: string
  nccAdgroupId: string
  /** 현재 광고그룹 default bid (AdGroup.bidAmt). > 0 가정. */
  currentBid: number
  /** 광고그룹 가중평균 또는 last non-null fallback. > 0. */
  recentAvgRnk: number
}

/** 광고그룹 권고 페이로드. */
export type AdgroupRankSuggestAction = {
  kind: "adgroup_default_bid_update"
  reasonCode: "adgroup_below_target_rank"
  adgroupId: string
  nccAdgroupId: string
  currentBid: number
  suggestedBid: number
  deltaPct: number
  direction: "up"
  targetAvgRank: number
  currentAvgRank: number
  cappedByMaxCpc: boolean
  rankWindowHours: number | null
  rankSampleImpressions: number | null
  /** PC Estimate position=ceil(target) 행의 bid (없으면 null). */
  estimatedBidPc: number | null
  /** MOBILE Estimate position=ceil(target) 행의 bid (없으면 null). */
  estimatedBidMobile: number | null
  /** `suggestedBid` 결정에 사용된 Estimate 디바이스 (`max(pcBid, mobileBid)` 정책). */
  selectedDevice: "PC" | "MOBILE" | "BOTH"
}

export type AdgroupRankDecision =
  | { decision: "hold"; reason: string }
  | {
      decision: "suggest"
      reason: string
      action: AdgroupRankSuggestAction
      severity: "info" | "warn"
    }

export type AdgroupRankDecisionInput = {
  adgroup: AdgroupRankInput
  targetAvgRank: Prisma.Decimal | number | null
  maxCpc: number | null
  /** 대표 키워드 1개의 PC Estimate 결과. position [1..5]. */
  estimateRows: AveragePositionBidRow[]
  /**
   * 대표 키워드 1개의 MOBILE Estimate 결과 (옵셔널 — 미전달 시 PC 만 사용).
   * 둘 다 전달되면 `max(pcBid, mobileBid)` 적용.
   */
  estimateRowsMobile?: AveragePositionBidRow[]
  config?: Partial<RankDecisionConfig>
  rankWindowHours?: number | null
  rankSampleImpressions?: number | null
}

/**
 * 분기 본체 — 키워드 / 광고그룹 공용. action shape 만 호출자가 합성.
 *
 * 반환:
 *   - "hold": reason
 *   - "ok": currentBid / suggestedBid / deltaPct / cappedByMaxCpc / targetAvgRank / lookupPosition
 */
type RankBranchOutcome =
  | { kind: "hold"; reason: string }
  | {
      kind: "ok"
      target: number
      lookupPosition: number
      currentBid: number
      recentAvgRnk: number
      /** max(pcBid, mobileBid) — 미클램프 raw Estimate bid (UI / reason 본문용). */
      estimatedBid: number
      suggestedBid: number
      deltaPct: number
      cappedByMaxCpc: boolean
      maxCpc: number | null
      /** PC Estimate position=ceil(target) bid (없으면 null). */
      estimatedBidPc: number | null
      /** MOBILE Estimate position=ceil(target) bid (없으면 null). */
      estimatedBidMobile: number | null
      /** max 결정 — UI 라벨 / reason 본문 분기. */
      selectedDevice: "PC" | "MOBILE" | "BOTH"
    }

/**
 * estimateRows 의 position=lookupPosition 행을 추출 + bid 유효성 검사.
 *
 * 반환:
 *   - 양수 bid 면 그 값
 *   - 행 부재 / bid <= 0 → null (호출자가 PC + MOBILE 둘 다 null 인 경우 hold 결정)
 */
function extractPositionBid(
  rows: AveragePositionBidRow[] | undefined,
  lookupPosition: number,
): number | null {
  if (!rows || rows.length === 0) return null
  const row = rows.find((r) => r.position === lookupPosition)
  if (!row) return null
  if (row.bid == null || !Number.isFinite(row.bid) || row.bid <= 0) return null
  return row.bid
}

function evaluateRankBranch(args: {
  currentBid: number
  recentAvgRnk: number
  targetAvgRank: Prisma.Decimal | number | null
  maxCpc: number | null
  estimateRows: AveragePositionBidRow[]
  estimateRowsMobile?: AveragePositionBidRow[]
  config: RankDecisionConfig
}): RankBranchOutcome {
  const {
    currentBid,
    recentAvgRnk,
    targetAvgRank,
    maxCpc,
    estimateRows,
    estimateRowsMobile,
    config,
  } = args

  // -- 1. 가드 --------------------------------------------------------------
  if (currentBid <= 0) {
    return { kind: "hold", reason: "use_group_bid_amt" }
  }

  // -- 2. targetAvgRank 정규화 ----------------------------------------------
  const target =
    targetAvgRank == null
      ? config.defaultTargetRank
      : typeof targetAvgRank === "number"
        ? targetAvgRank
        : Number(targetAvgRank)

  // -- 3. 이미 목표 달성 -----------------------------------------------------
  if (recentAvgRnk <= target) {
    return { kind: "hold", reason: "already_at_or_above_target" }
  }

  // -- 4. Estimate 행 lookup (PC + MOBILE 둘 다) ----------------------------
  const lookupPosition = Math.ceil(target)
  const pcBid = extractPositionBid(estimateRows, lookupPosition)
  const mobileBid = extractPositionBid(estimateRowsMobile, lookupPosition)

  // -- 5. 둘 다 부재 → hold "estimate_position_not_found" --------------------
  // PC / MOBILE 어느 한쪽이라도 양수 bid 면 진입. 둘 다 부재(행 없음 OR bid<=0)면 hold.
  // 단 — 기존 호환: estimateRowsMobile 미전달(undefined) + PC 행은 있으나 bid<=0 인 경우
  // 기존엔 "estimate_invalid_bid" 였음. PC 행은 존재하지만 bid<=0 인 케이스 분리 유지.
  if (pcBid == null && mobileBid == null) {
    // PC 행 자체가 존재하면서 bid 가 0/음수 인지 추가 확인 (기존 invalid_bid 호환)
    if (estimateRowsMobile === undefined) {
      const pcRow = estimateRows.find((r) => r.position === lookupPosition)
      if (pcRow && (pcRow.bid == null || pcRow.bid <= 0)) {
        return { kind: "hold", reason: "estimate_invalid_bid" }
      }
    }
    return { kind: "hold", reason: "estimate_position_not_found" }
  }

  // -- 6. max(pcBid, mobileBid) + selectedDevice 결정 -----------------------
  let estimatedBid: number
  let selectedDevice: "PC" | "MOBILE" | "BOTH"
  if (pcBid != null && mobileBid != null) {
    if (pcBid > mobileBid) {
      estimatedBid = pcBid
      selectedDevice = "PC"
    } else if (mobileBid > pcBid) {
      estimatedBid = mobileBid
      selectedDevice = "MOBILE"
    } else {
      estimatedBid = pcBid
      selectedDevice = "BOTH"
    }
  } else if (pcBid != null) {
    estimatedBid = pcBid
    selectedDevice = "PC"
  } else {
    // mobileBid != null (위에서 둘 다 null 가드)
    estimatedBid = mobileBid as number
    selectedDevice = "MOBILE"
  }

  // -- 7. Estimate <= currentBid → 권고 의미 없음 ----------------------------
  if (estimatedBid <= currentBid) {
    return { kind: "hold", reason: "estimate_below_current" }
  }

  // -- 8. maxCpc / bidUpperBound 클램프 --------------------------------------
  const effectiveMax =
    maxCpc != null ? Math.min(config.bidUpperBound, maxCpc) : config.bidUpperBound
  let suggestedBid = Math.min(estimatedBid, effectiveMax)
  suggestedBid = Math.max(config.bidLowerBound, suggestedBid)
  const cappedByMaxCpc = maxCpc != null && estimatedBid > maxCpc

  // -- 9. 클램프 결과 currentBid 이하 → 권고 불가 ----------------------------
  if (suggestedBid <= currentBid) {
    return { kind: "hold", reason: "capped_at_max_cpc" }
  }

  // -- 10. deltaPct ----------------------------------------------------------
  const deltaPct =
    Math.round(((suggestedBid - currentBid) / currentBid) * 10_000) / 100

  return {
    kind: "ok",
    target,
    lookupPosition,
    currentBid,
    recentAvgRnk,
    estimatedBid,
    suggestedBid,
    deltaPct,
    cappedByMaxCpc,
    maxCpc,
    estimatedBidPc: pcBid,
    estimatedBidMobile: mobileBid,
    selectedDevice,
  }
}

/**
 * 키워드 권고 reason 본문 빌더 — selectedDevice 별 4분기.
 *
 *   - PC 만:   "... Estimate 5위 도달 1,200원 (PC 기준)으로 +20% 인상 권고"
 *   - MOBILE 만: "... Estimate 5위 도달 1,200원 (MOBILE 기준)으로 +20% 인상 권고"
 *   - BOTH (동일): "... Estimate 5위 도달 1,200원 (PC·MOBILE 동일)으로 +20% 인상 권고"
 *   - max(pc != mobile): "... Estimate 5위 도달 PC 1,200원 / MOBILE 1,500원 — MOBILE 기준 1,500원으로 +25% 인상 권고"
 *
 * capped 패턴은 동일 4분기에 maxCpc 절단 부가.
 */
function formatKeywordReason(args: {
  recentAvgRnk: number
  target: number
  lookupPosition: number
  estimatedBid: number
  suggestedBid: number
  estimatedBidPc: number | null
  estimatedBidMobile: number | null
  selectedDevice: "PC" | "MOBILE" | "BOTH"
  cappedByMaxCpc: boolean
  maxCpc: number | null
  deltaPct: number
}): string {
  const head = `평균 순위 ${args.recentAvgRnk.toFixed(1)}위 > 목표 ${args.target}위 — Estimate ${args.lookupPosition}위 도달`
  const deviceTail = formatDeviceClause({
    estimatedBid: args.estimatedBid,
    suggestedBid: args.suggestedBid,
    estimatedBidPc: args.estimatedBidPc,
    estimatedBidMobile: args.estimatedBidMobile,
    selectedDevice: args.selectedDevice,
    cappedByMaxCpc: args.cappedByMaxCpc,
    maxCpc: args.maxCpc,
    deltaPct: args.deltaPct,
  })
  return `${head} ${deviceTail}`
}

/** 광고그룹 / 키워드 공용 device 절 빌더. */
function formatDeviceClause(args: {
  estimatedBid: number
  suggestedBid: number
  estimatedBidPc: number | null
  estimatedBidMobile: number | null
  selectedDevice: "PC" | "MOBILE" | "BOTH"
  cappedByMaxCpc: boolean
  maxCpc: number | null
  deltaPct: number
}): string {
  const {
    estimatedBid,
    suggestedBid,
    estimatedBidPc,
    estimatedBidMobile,
    selectedDevice,
    cappedByMaxCpc,
    maxCpc,
    deltaPct,
  } = args

  // 둘 다 있으면서 다른 값 — 비교 본문
  const bothDifferent =
    estimatedBidPc != null &&
    estimatedBidMobile != null &&
    estimatedBidPc !== estimatedBidMobile

  if (cappedByMaxCpc) {
    if (bothDifferent) {
      return `PC ${estimatedBidPc!.toLocaleString()}원 / MOBILE ${estimatedBidMobile!.toLocaleString()}원 — ${selectedDevice} 기준 ${estimatedBid.toLocaleString()}원이지만 maxCpc ${maxCpc!.toLocaleString()}원으로 절단 +${deltaPct}% 권고`
    }
    if (selectedDevice === "BOTH") {
      return `${estimatedBid.toLocaleString()}원 (PC·MOBILE 동일)이지만 maxCpc ${maxCpc!.toLocaleString()}원으로 절단 +${deltaPct}% 권고`
    }
    return `${estimatedBid.toLocaleString()}원 (${selectedDevice} 기준)이지만 maxCpc ${maxCpc!.toLocaleString()}원으로 절단 +${deltaPct}% 권고`
  }

  if (bothDifferent) {
    return `PC ${estimatedBidPc!.toLocaleString()}원 / MOBILE ${estimatedBidMobile!.toLocaleString()}원 — ${selectedDevice} 기준 ${suggestedBid.toLocaleString()}원으로 +${deltaPct}% 인상 권고`
  }
  if (selectedDevice === "BOTH") {
    return `${suggestedBid.toLocaleString()}원 (PC·MOBILE 동일)으로 +${deltaPct}% 인상 권고`
  }
  return `${suggestedBid.toLocaleString()}원 (${selectedDevice} 기준)으로 +${deltaPct}% 인상 권고`
}

/**
 * 광고그룹 default bid 인상 권고 결정.
 *
 * 분기 로직은 `decideRankSuggestion` 과 동일 — 본 함수는 action shape / reason 본문만 차이.
 * 적용 단위 차이:
 *   - 키워드: 키워드 단위 입찰가 (Keyword.bidAmt) → 키워드 1건 영향.
 *   - 광고그룹: 광고그룹 default 입찰가 (AdGroup.bidAmt) → useGroupBidAmt=true 키워드 N건 영향.
 *
 * 호출자 책임:
 *   - 광고그룹 평균 순위 산출 (StatHourly 가중평균 또는 last non-null 평균).
 *   - 대표 키워드 (광고그룹 내 useGroupBidAmt=true 키워드 중 노출 TOP 1) 의 Estimate API 호출.
 */
export function decideAdgroupRankSuggestion(
  input: AdgroupRankDecisionInput,
): AdgroupRankDecision {
  const config = { ...DEFAULT_RANK_CONFIG, ...input.config }
  const { adgroup, targetAvgRank, maxCpc, estimateRows, estimateRowsMobile } = input
  const rankWindowHours =
    input.rankWindowHours === undefined ? null : input.rankWindowHours
  const rankSampleImpressions =
    input.rankSampleImpressions === undefined ? null : input.rankSampleImpressions

  const outcome = evaluateRankBranch({
    currentBid: adgroup.currentBid,
    recentAvgRnk: adgroup.recentAvgRnk,
    targetAvgRank,
    maxCpc,
    estimateRows,
    estimateRowsMobile,
    config,
  })

  if (outcome.kind === "hold") {
    return { decision: "hold", reason: outcome.reason }
  }

  const severity: "info" | "warn" = outcome.cappedByMaxCpc ? "warn" : "info"
  const head = `광고그룹 평균 순위 ${outcome.recentAvgRnk.toFixed(1)}위 > 목표 ${outcome.target}위 — Estimate ${outcome.lookupPosition}위 도달`
  const deviceTail = formatDeviceClause({
    estimatedBid: outcome.estimatedBid,
    suggestedBid: outcome.suggestedBid,
    estimatedBidPc: outcome.estimatedBidPc,
    estimatedBidMobile: outcome.estimatedBidMobile,
    selectedDevice: outcome.selectedDevice,
    cappedByMaxCpc: outcome.cappedByMaxCpc,
    maxCpc: outcome.maxCpc,
    deltaPct: outcome.deltaPct,
  })
  const reason = `${head} ${deviceTail}`

  return {
    decision: "suggest",
    reason,
    action: {
      kind: "adgroup_default_bid_update",
      reasonCode: "adgroup_below_target_rank",
      adgroupId: adgroup.adgroupId,
      nccAdgroupId: adgroup.nccAdgroupId,
      currentBid: outcome.currentBid,
      suggestedBid: outcome.suggestedBid,
      deltaPct: outcome.deltaPct,
      direction: "up",
      targetAvgRank: outcome.target,
      currentAvgRank: outcome.recentAvgRnk,
      cappedByMaxCpc: outcome.cappedByMaxCpc,
      rankWindowHours,
      rankSampleImpressions,
      estimatedBidPc: outcome.estimatedBidPc,
      estimatedBidMobile: outcome.estimatedBidMobile,
      selectedDevice: outcome.selectedDevice,
    },
    severity,
  }
}
