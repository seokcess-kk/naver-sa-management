/**
 * Estimate average-position-bid 캐시 헬퍼 (cron + Server Action 공용).
 *
 * 본 모듈은 `app/(dashboard)/[advertiserId]/keywords/estimate-actions.ts` 의
 * average-position 캐시 로직 (readCacheEntry / upsertCacheEntry) 을 추출.
 *
 * 공유 사유:
 *   - F-11.2 cron 은 매시간 정책 100개 평가 → Estimate 캐시 hit 율이 곧 비용 절감
 *   - Server Action (F-10.1 시뮬레이터 UI) 도 동일 캐시 사용 — 코드 중복 제거
 *
 * 캐시 정책:
 *   - 30분 TTL (lazy expire — read 시 expiresAt > now() 검사)
 *   - sentinel: type=average_position / position=0 / bid=0 (UNIQUE 컬럼 NOT NULL 유지)
 *   - shape: AveragePositionBidRow[] (5개 row 통째 저장)
 *
 * 호출 흐름:
 *   - hit:  EstimateCache row 의 result Json 복원 → return cachedAll=true
 *   - miss: estimateAveragePositionBid (lib/naver-sa/estimate) 호출 + upsert → cachedAll=false
 *
 * cron 컨텍스트:
 *   - keywordText 는 호출부가 Keyword.keyword 텍스트 명시 전달 (DB read 책임 분리)
 *   - customerId 는 호출부가 Advertiser.customerId 전달
 *
 * SPEC: SPEC v0.2.1 F-10.1 / F-11.2
 */

import { prisma } from "@/lib/db/prisma"
import {
  estimateAveragePositionBid,
  type AveragePositionBidRow,
} from "@/lib/naver-sa/estimate"
import { EstimateType, StatDevice } from "@/lib/generated/prisma/enums"

// =============================================================================
// 상수
// =============================================================================

/** 30분 TTL — estimate-actions.ts 와 동일 (운영 측정 후 조정 가능). */
const CACHE_TTL_MS = 30 * 60 * 1000

/** average_position 은 [1..5] 묶음 통째 저장 — sentinel position=0 / bid=0. */
const SENTINEL_POSITION = 0
const SENTINEL_BID = 0
const AVERAGE_POSITIONS = [1, 2, 3, 4, 5] as const

// =============================================================================
// 타입
// =============================================================================

export type GetCachedAveragePositionBidArgs = {
  /** 광고주 내부 id (FK). */
  advertiserId: string
  /** 광고주 customerId (X-Customer 헤더). */
  customerId: string
  /** Keyword 내부 id (FK). */
  keywordId: string
  /** Keyword 텍스트 (Estimate 호출 body 의 keyword 필드). */
  keywordText: string
  /** PC / MOBILE — Estimate 는 디바이스 분리 호출. */
  device: "PC" | "MOBILE"
}

export type CachedAveragePositionBidResult = {
  data: AveragePositionBidRow[]
  /** 응답 전부 캐시 hit 이면 true. miss 발생 시 false. */
  cachedAll: boolean
}

// =============================================================================
// 캐시 read/write 내부 헬퍼
// =============================================================================

async function readCacheEntry(args: {
  advertiserId: string
  keywordId: string
  device: StatDevice
}): Promise<AveragePositionBidRow[] | null> {
  const row = await prisma.estimateCache.findUnique({
    where: {
      advertiserId_keywordId_device_type_position_bid: {
        advertiserId: args.advertiserId,
        keywordId: args.keywordId,
        device: args.device,
        type: EstimateType.average_position,
        position: SENTINEL_POSITION,
        bid: SENTINEL_BID,
      },
    },
    select: { result: true, expiresAt: true },
  })
  if (!row) return null
  if (row.expiresAt.getTime() <= Date.now()) return null
  return row.result as AveragePositionBidRow[]
}

async function upsertCacheEntry(args: {
  advertiserId: string
  keywordId: string
  device: StatDevice
  result: AveragePositionBidRow[]
}): Promise<void> {
  const expiresAt = new Date(Date.now() + CACHE_TTL_MS)
  await prisma.estimateCache.upsert({
    where: {
      advertiserId_keywordId_device_type_position_bid: {
        advertiserId: args.advertiserId,
        keywordId: args.keywordId,
        device: args.device,
        type: EstimateType.average_position,
        position: SENTINEL_POSITION,
        bid: SENTINEL_BID,
      },
    },
    create: {
      advertiserId: args.advertiserId,
      keywordId: args.keywordId,
      device: args.device,
      type: EstimateType.average_position,
      position: SENTINEL_POSITION,
      bid: SENTINEL_BID,
      result: args.result as never,
      expiresAt,
    },
    update: {
      result: args.result as never,
      expiresAt,
    },
  })
}

// =============================================================================
// public API
// =============================================================================

/**
 * Estimate 평균 노출 순위 입찰가 (1..5위) 조회 — 30분 캐시 우선.
 *
 * - hit  : EstimateCache 에서 복원 → cachedAll=true
 * - miss : estimateAveragePositionBid 호출 후 upsert → cachedAll=false
 *
 * 본 함수는 권한 검사 / 광고주 횡단 차단 X — 호출부 책임:
 *   - cron: CRON_SECRET 가드 + Advertiser.findMany active filter
 *   - Server Action: getCurrentAdvertiser + loadKeywordForAdvertiser
 *
 * throw 정책:
 *   - estimateAveragePositionBid 가 throw 하면 그대로 전파 (호출부에서 OptimizationRun
 *     result='failed' / errorMessage 적재).
 */
export async function getCachedAveragePositionBid(
  args: GetCachedAveragePositionBidArgs,
): Promise<CachedAveragePositionBidResult> {
  const cached = await readCacheEntry({
    advertiserId: args.advertiserId,
    keywordId: args.keywordId,
    device: args.device,
  })
  if (cached !== null) {
    return { data: cached, cachedAll: true }
  }

  const rows = await estimateAveragePositionBid(args.customerId, {
    keyword: args.keywordText,
    device: args.device,
    positions: [...AVERAGE_POSITIONS],
  })

  await upsertCacheEntry({
    advertiserId: args.advertiserId,
    keywordId: args.keywordId,
    device: args.device,
    result: rows,
  })

  return { data: rows, cachedAll: false }
}
