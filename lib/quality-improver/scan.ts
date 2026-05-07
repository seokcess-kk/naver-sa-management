/**
 * 품질지수 개선 엔진 (Phase E.1).
 *
 * 책임:
 *   - 광고주의 활성 키워드 14일 stats 합산 → "노출 있는데 클릭 0" 또는 "CTR < 임계" 키워드를 OFF 후보로 추출
 *   - 출력: QualityCandidate[] — cron 호출자가 BidSuggestion(engineSource='quality') 으로 적재
 *
 * 핵심 원칙 (사용자 검토 반영):
 *   - "14일 노출 0 / CTR<0.3% → OFF" 는 후보 룰 (절대 X)
 *   - 브랜드 / 고관여 / 저검색량 예외는 후속 PR (Keyword.tags 또는 별도 플래그)
 *   - 자동 OFF X — 모든 변경은 운영자 승인 (BidSuggestion 으로 권고)
 *   - "품질지수 1점 ≈ 14~17% CPC 절감" 같은 정량 수치는 사례·추정 — UI 본문에서 표시 X
 *
 * 비대상:
 *   - Keyword.qualityScore 기반 OFF 권고 (이건 quality_stagnation 알림 — Phase C)
 *   - 광고그룹·캠페인 단위 OFF 권고 — 본 PR 은 키워드 단위
 *
 * 입력 데이터 source:
 *   - StatDaily level='keyword' 14일 합산 (P2 F-9.1 cron 이 적재)
 */

import { prisma } from "@/lib/db/prisma"
import { STAT_DAILY_DEVICE_FILTER } from "@/lib/stat-daily/device-filter"

// =============================================================================
// 타입
// =============================================================================

/** OFF 후보 1건. */
export type QualityCandidate = {
  keywordId: string
  nccKeywordId: string
  adgroupId: string
  reasonCode: "no_clicks_14d" | "low_ctr_14d"
  metrics: {
    impressions14d: number
    clicks14d: number
    cost14d: number
    /** % (예: 0.20 = 0.20%). */
    ctr14d: number
  }
}

/** 스캔 임계. 운영 데이터 누적 후 튜닝. */
export type QualityScanConfig = {
  /** 윈도 일수. 기본 14. */
  windowDays: number
  /** CTR 임계 (%, 0.3 = 0.30%). 기본 0.3. */
  minCtrPct: number
  /** 비용 표본 임계 (원). 미만 키워드는 평가 의미 없음. 기본 10000. */
  minCostKrw: number
}

export const DEFAULT_QUALITY_SCAN_CONFIG: QualityScanConfig = {
  windowDays: 14,
  minCtrPct: 0.3,
  minCostKrw: 10_000,
}

// =============================================================================
// 핵심 함수
// =============================================================================

/**
 * 광고주 단위 OFF 후보 산출.
 *
 * 흐름:
 *   1. StatDaily level='keyword' 14일 합산 (cost ≥ minCostKrw 표본 충족만)
 *   2. Keyword 매핑 (status≠'deleted' AND userLock=false) — 이미 OFF 키워드 제외
 *   3. 행마다 룰 평가:
 *      - clicks=0 AND impressions>0 → 'no_clicks_14d'
 *      - ctr < minCtrPct → 'low_ctr_14d'
 *      - 그 외 → 정상 (candidate 미생성)
 */
export async function scanQualityCandidates(
  advertiserId: string,
  cfg: QualityScanConfig = DEFAULT_QUALITY_SCAN_CONFIG,
): Promise<QualityCandidate[]> {
  const since = new Date()
  since.setUTCDate(since.getUTCDate() - cfg.windowDays)

  // StatDaily 14일 합산 — 비용 표본 충족 키워드만 (groupBy + having 필터)
  // device 이중집계 방지 — lib/stat-daily/device-filter.ts 참조.
  const stats = await prisma.statDaily.groupBy({
    by: ["refId"],
    where: {
      advertiserId,
      level: "keyword",
      date: { gte: since },
      ...STAT_DAILY_DEVICE_FILTER,
    },
    _sum: { impressions: true, clicks: true, cost: true },
  })

  if (stats.length === 0) return []

  // 비용 표본 필터 (Decimal 비교)
  const filtered = stats.filter((s) => {
    const cost = s._sum.cost ? Number(s._sum.cost) : 0
    return cost >= cfg.minCostKrw
  })
  if (filtered.length === 0) return []

  // Keyword 매핑 (이미 OFF / 삭제된 키워드 제외)
  const nccIds = filtered.map((s) => s.refId)
  const keywords = await prisma.keyword.findMany({
    where: {
      nccKeywordId: { in: nccIds },
      status: { not: "deleted" },
      userLock: false,
      adgroup: { campaign: { advertiserId } },
    },
    select: {
      id: true,
      nccKeywordId: true,
      adgroupId: true,
    },
  })
  const keywordMap = new Map(keywords.map((k) => [k.nccKeywordId, k]))

  const candidates: QualityCandidate[] = []
  for (const s of filtered) {
    const k = keywordMap.get(s.refId)
    if (!k) continue

    const imps = s._sum.impressions ?? 0
    const clicks = s._sum.clicks ?? 0
    const cost = s._sum.cost ? Number(s._sum.cost) : 0
    const ctr = imps > 0 ? (clicks / imps) * 100 : 0

    let reasonCode: QualityCandidate["reasonCode"] | null = null
    if (clicks === 0 && imps > 0) {
      reasonCode = "no_clicks_14d"
    } else if (ctr > 0 && ctr < cfg.minCtrPct) {
      // ctr=0 인 경우는 위 분기(clicks=0)에서 처리. ctr>0 + 임계 미만만 별도 분류.
      reasonCode = "low_ctr_14d"
    }
    if (reasonCode === null) continue

    candidates.push({
      keywordId: k.id,
      nccKeywordId: k.nccKeywordId,
      adgroupId: k.adgroupId,
      reasonCode,
      metrics: {
        impressions14d: imps,
        clicks14d: clicks,
        cost14d: cost,
        ctr14d: Number(ctr.toFixed(3)),
      },
    })
  }

  return candidates
}
