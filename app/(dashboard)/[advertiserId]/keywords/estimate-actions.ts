"use server"

/**
 * F-10.1 / F-10.2 / F-10.3 — 입찰가 시뮬레이터 Server Actions (조회 + 30분 캐시)
 *
 * 본 모듈은 `keywords/actions.ts` 와 분리. 사유:
 *   - actions.ts 는 변경/적재 (sync / bulkUpdate / CSV 등) — ChangeBatch / AuditLog 흐름
 *   - 본 모듈은 조회 only — ChangeBatch / AuditLog 미사용. 캐시 키 매트릭스가 별도 관심사.
 *
 * 3개 Server Action:
 *   (a) getAveragePositionBid   — F-10.1 (positions 1..5 고정 단일 캐시 entry)
 *   (b) getExposureMinimumBid   — F-10.2 (단일 캐시 entry)
 *   (c) getPerformanceBulk      — F-10.3 (bid 별 캐시 entry — 부분 hit/miss 처리)
 *
 * 캐시 정책:
 *   - 30분 TTL. read 시 lazy 만료 검사 (expiresAt > now() 이면 hit).
 *   - 만료 행 정리는 cleanup cron 후속 PR 권고. 본 PR 은 lazy 만.
 *   - sentinel: position=0 / bid=0 (UNIQUE 컬럼 NOT NULL 유지 위해).
 *
 * 캐시 키 매트릭스:
 *   ┌────────────────────┬───────────┬───────────┬───────────────────────────┐
 *   │ type               │ position  │ bid       │ result Json shape         │
 *   ├────────────────────┼───────────┼───────────┼───────────────────────────┤
 *   │ average_position   │ 0 (sent.) │ 0 (sent.) │ AveragePositionBidRow[]   │
 *   │ exposure_minimum   │ 0 (sent.) │ 0 (sent.) │ ExposureMinimumBidRow     │
 *   │ performance_bulk   │ 0 (sent.) │ <bid>     │ PerformanceBulkRow        │
 *   └────────────────────┴───────────┴───────────┴───────────────────────────┘
 *
 *   F-10.1: positions 는 [1..5] 고정 (사용자 변경 비대상) → 1 entry / device 당 묶음 통째 보존.
 *   F-10.3: bid 별 1 entry → 부분 hit/miss 시 hit 결과 + miss bids 만 SA 호출.
 *
 * 권한:
 *   - getCurrentAdvertiser(advertiserId) 진입부 검증 (admin / 화이트리스트).
 *   - viewer 도 가능 (read 성격).
 *
 * 시크릿 / 마스킹:
 *   - ActionResult.error 에 customerId 포함 X (advertiserId / keywordId 만).
 *   - catch 한 e 의 message 는 scrubString 통과 + 200 자 절단.
 *
 * 광고주 횡단 차단:
 *   - Keyword.findUnique 시 `adgroup.campaign.advertiserId === advertiserId` join 검증.
 *   - 다른 광고주 키워드 ID 가 들어와도 결과 0 → ActionResult.ok=false.
 *
 * SPEC 참조: SPEC v0.2.1 F-10.1 / F-10.2 / F-10.3, 안전장치 1·4·5.
 */

import { z } from "zod"

import { prisma } from "@/lib/db/prisma"
import { getCurrentAdvertiser } from "@/lib/auth/access"
import { scrubString } from "@/lib/crypto/scrub-string"
import {
  estimateAveragePositionBid,
  estimateExposureMinimumBid,
  estimatePerformanceBulk,
  type AveragePositionBidRow,
  type ExposureMinimumBidRow,
  type PerformanceBulkRow,
} from "@/lib/naver-sa/estimate"
import { EstimateType, StatDevice } from "@/lib/generated/prisma/enums"

// =============================================================================
// 공통 타입 / 상수
// =============================================================================

/** 30분 TTL (네이버 spec 미확정 — 운영 측정 후 조정 가능). */
const CACHE_TTL_MS = 30 * 60 * 1000

/**
 * 모든 Estimate Server Action 의 반환 envelope.
 *
 * 성공 시 데이터 + cached 메타. 실패 시 사용자 표시용 message.
 * cachedAll: 응답 전체가 캐시 hit 인지 (F-10.3 부분 hit/miss 시 false + cachedCount 추가).
 */
export type EstimateActionResult<T> =
  | {
      ok: true
      data: T
      /** 응답 전부 캐시에서 왔으면 true. 하나라도 SA 호출 발생했으면 false. */
      cachedAll: boolean
      /** 부분 hit (performance_bulk) 일 때 hit 개수. F-10.1/10.2 는 0 또는 1. */
      cachedCount: number
    }
  | { ok: false; error: string }

/** scrubString + 200자 절단 — 외부 API 에러 메시지를 그대로 노출하지 않게. */
function safeErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const scrubbed = scrubString(raw)
  return scrubbed.length > 200 ? scrubbed.slice(0, 200) + "…" : scrubbed
}

// =============================================================================
// 입력 검증 스키마
// =============================================================================

const deviceSchema = z.enum(["PC", "MOBILE"])
const keywordIdSchema = z.string().trim().min(1).max(128)
const advertiserIdSchema = z.string().trim().min(1).max(128)

const averagePositionInputSchema = z.object({
  advertiserId: advertiserIdSchema,
  keywordId: keywordIdSchema,
  device: deviceSchema,
})

const exposureMinimumInputSchema = z.object({
  advertiserId: advertiserIdSchema,
  keywordId: keywordIdSchema,
  device: deviceSchema,
})

const performanceBulkInputSchema = z.object({
  advertiserId: advertiserIdSchema,
  keywordId: keywordIdSchema,
  device: deviceSchema,
  bids: z
    .array(z.number().int().positive().max(100_000))
    .min(1)
    .max(20)
    .refine((arr) => new Set(arr).size === arr.length, {
      message: "bids must be unique",
    }),
})

export type GetAveragePositionBidInput = z.infer<
  typeof averagePositionInputSchema
>
export type GetExposureMinimumBidInput = z.infer<
  typeof exposureMinimumInputSchema
>
export type GetPerformanceBulkInput = z.infer<
  typeof performanceBulkInputSchema
>

// =============================================================================
// 광고주 횡단 차단 헬퍼 — Keyword.findUnique + adgroup.campaign.advertiserId 일치 확인
// =============================================================================

type ResolvedKeyword = {
  id: string
  nccKeywordId: string
  keyword: string
}

async function loadKeywordForAdvertiser(
  advertiserId: string,
  keywordId: string,
): Promise<ResolvedKeyword | null> {
  const k = await prisma.keyword.findFirst({
    where: {
      id: keywordId,
      adgroup: { campaign: { advertiserId } },
    },
    select: { id: true, nccKeywordId: true, keyword: true },
  })
  return k
}

// =============================================================================
// 캐시 read/write 헬퍼
// =============================================================================

/**
 * 단일 캐시 entry 조회. expiresAt > now 만 hit.
 *
 * @returns 만료 또는 미존재 시 null. 그 외 result Json (caller가 shape 알고 cast).
 */
async function readCacheEntry(args: {
  advertiserId: string
  keywordId: string
  device: StatDevice
  type: EstimateType
  position: number
  bid: number
}): Promise<unknown | null> {
  const row = await prisma.estimateCache.findUnique({
    where: {
      advertiserId_keywordId_device_type_position_bid: {
        advertiserId: args.advertiserId,
        keywordId: args.keywordId,
        device: args.device,
        type: args.type,
        position: args.position,
        bid: args.bid,
      },
    },
    select: { result: true, expiresAt: true },
  })
  if (!row) return null
  if (row.expiresAt.getTime() <= Date.now()) return null
  return row.result
}

/** 단일 캐시 entry upsert. expiresAt = now + 30min. */
async function upsertCacheEntry(args: {
  advertiserId: string
  keywordId: string
  device: StatDevice
  type: EstimateType
  position: number
  bid: number
  // Prisma 의 Json 입력 — 직렬화 가능한 값 ( unknown 으로 받고 cast).
  result: unknown
}): Promise<void> {
  const expiresAt = new Date(Date.now() + CACHE_TTL_MS)
  await prisma.estimateCache.upsert({
    where: {
      advertiserId_keywordId_device_type_position_bid: {
        advertiserId: args.advertiserId,
        keywordId: args.keywordId,
        device: args.device,
        type: args.type,
        position: args.position,
        bid: args.bid,
      },
    },
    create: {
      advertiserId: args.advertiserId,
      keywordId: args.keywordId,
      device: args.device,
      type: args.type,
      position: args.position,
      bid: args.bid,
      // Prisma Json 컬럼은 InputJsonValue. 직렬화 가능 값(객체/배열/원시) 만 허용.
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
// (a) getAveragePositionBid — F-10.1
// =============================================================================
//
// positions 은 [1, 2, 3, 4, 5] 고정 (사용자 변경 비대상). 캐시 entry 1개 / device 당:
//   key  = (advertiserId, keywordId, device, type=average_position, position=0, bid=0)
//   shape = AveragePositionBidRow[]  (5개 row 통째 저장)
//
// 부분 positions 요청은 본 PR 비대상 — UI 가 5개 모두 표시.

const AVERAGE_POSITIONS = [1, 2, 3, 4, 5] as const

export async function getAveragePositionBid(
  input: GetAveragePositionBidInput,
): Promise<EstimateActionResult<AveragePositionBidRow[]>> {
  // 1) 입력 검증
  const parsed = averagePositionInputSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: `입력 검증 실패: ${parsed.error.issues
        .map((i) => i.message)
        .join(", ")}`,
    }
  }
  const { advertiserId, keywordId, device } = parsed.data

  try {
    // 2) 권한 검증 + 광고주 객체
    const { advertiser } = await getCurrentAdvertiser(advertiserId)
    if (!advertiser.hasKeys) {
      return { ok: false, error: "API 키/시크릿 미입력" }
    }

    // 3) 광고주 횡단 차단 — Keyword 가 본 광고주 소속인지 확인
    const kw = await loadKeywordForAdvertiser(advertiserId, keywordId)
    if (!kw) {
      return {
        ok: false,
        error: `키워드를 찾을 수 없거나 접근 권한이 없습니다 (keywordId=${keywordId})`,
      }
    }

    // 4) 캐시 조회 (단일 entry — positions [1..5] 묶음)
    const cached = await readCacheEntry({
      advertiserId,
      keywordId,
      device,
      type: EstimateType.average_position,
      position: 0,
      bid: 0,
    })

    if (cached !== null) {
      return {
        ok: true,
        data: cached as AveragePositionBidRow[],
        cachedAll: true,
        cachedCount: 1,
      }
    }

    // 5) 캐시 miss — SA 호출 후 upsert
    const rows = await estimateAveragePositionBid(advertiser.customerId, {
      keyword: kw.keyword,
      device,
      positions: [...AVERAGE_POSITIONS],
    })

    await upsertCacheEntry({
      advertiserId,
      keywordId,
      device,
      type: EstimateType.average_position,
      position: 0,
      bid: 0,
      result: rows,
    })

    return { ok: true, data: rows, cachedAll: false, cachedCount: 0 }
  } catch (e) {
    return { ok: false, error: safeErrorMessage(e) }
  }
}

// =============================================================================
// (b) getExposureMinimumBid — F-10.2
// =============================================================================
//
// 단일 캐시 entry:
//   key  = (advertiserId, keywordId, device, type=exposure_minimum, position=0, bid=0)
//   shape = ExposureMinimumBidRow

export async function getExposureMinimumBid(
  input: GetExposureMinimumBidInput,
): Promise<EstimateActionResult<ExposureMinimumBidRow>> {
  // 1) 입력 검증
  const parsed = exposureMinimumInputSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: `입력 검증 실패: ${parsed.error.issues
        .map((i) => i.message)
        .join(", ")}`,
    }
  }
  const { advertiserId, keywordId, device } = parsed.data

  try {
    const { advertiser } = await getCurrentAdvertiser(advertiserId)
    if (!advertiser.hasKeys) {
      return { ok: false, error: "API 키/시크릿 미입력" }
    }

    const kw = await loadKeywordForAdvertiser(advertiserId, keywordId)
    if (!kw) {
      return {
        ok: false,
        error: `키워드를 찾을 수 없거나 접근 권한이 없습니다 (keywordId=${keywordId})`,
      }
    }

    const cached = await readCacheEntry({
      advertiserId,
      keywordId,
      device,
      type: EstimateType.exposure_minimum,
      position: 0,
      bid: 0,
    })

    if (cached !== null) {
      return {
        ok: true,
        data: cached as ExposureMinimumBidRow,
        cachedAll: true,
        cachedCount: 1,
      }
    }

    // SA 호출 — 응답 row 0개면 estimateExposureMinimumBid 가 throw
    const row = await estimateExposureMinimumBid(advertiser.customerId, {
      keyword: kw.keyword,
      device,
    })

    await upsertCacheEntry({
      advertiserId,
      keywordId,
      device,
      type: EstimateType.exposure_minimum,
      position: 0,
      bid: 0,
      result: row,
    })

    return { ok: true, data: row, cachedAll: false, cachedCount: 0 }
  } catch (e) {
    return { ok: false, error: safeErrorMessage(e) }
  }
}

// =============================================================================
// (c) getPerformanceBulk — F-10.3
// =============================================================================
//
// bid 별 캐시 entry — 부분 hit/miss 처리:
//   key  = (advertiserId, keywordId, device, type=performance_bulk, position=0, bid=<input bid>)
//   shape = PerformanceBulkRow (단일 row, bid 컬럼 포함)
//
// 흐름:
//   1) bids 각각 readCacheEntry → hit 분류 / miss bids 분류
//   2) miss bids 만 SA 호출 → 응답 row 의 r.bid 키로 입력 bids 와 매칭하여 upsert
//   3) hit + miss 응답 합쳐서 입력 bids 순서로 정렬 반환
//
// 응답 row 누락 케이스 (네이버 데이터 부족):
//   - SA 응답에 일부 bid 가 빠질 수 있음 → 호출부가 "데이터 부족 표시" 결정.
//   - 본 모듈은 SA 가 돌려준 row 만 캐시에 저장 (누락 bid 는 캐시에 안 들어감 → 다음 호출에 재시도).

export async function getPerformanceBulk(
  input: GetPerformanceBulkInput,
): Promise<EstimateActionResult<PerformanceBulkRow[]>> {
  // 1) 입력 검증
  const parsed = performanceBulkInputSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: `입력 검증 실패: ${parsed.error.issues
        .map((i) => i.message)
        .join(", ")}`,
    }
  }
  const { advertiserId, keywordId, device, bids } = parsed.data
  // 정렬 (UI 호출부에서 다양한 순서로 들어와도 일관된 캐시 / 결과 보장)
  const sortedBids = [...bids].sort((a, b) => a - b)

  try {
    const { advertiser } = await getCurrentAdvertiser(advertiserId)
    if (!advertiser.hasKeys) {
      return { ok: false, error: "API 키/시크릿 미입력" }
    }

    const kw = await loadKeywordForAdvertiser(advertiserId, keywordId)
    if (!kw) {
      return {
        ok: false,
        error: `키워드를 찾을 수 없거나 접근 권한이 없습니다 (keywordId=${keywordId})`,
      }
    }

    // 2) bid 별 캐시 조회 — 병렬
    const cacheLookups = await Promise.all(
      sortedBids.map((bid) =>
        readCacheEntry({
          advertiserId,
          keywordId,
          device,
          type: EstimateType.performance_bulk,
          position: 0,
          bid,
        }).then((res) => ({ bid, cached: res })),
      ),
    )

    // 3) hit / miss 분류
    const hitMap = new Map<number, PerformanceBulkRow>()
    const missBids: number[] = []
    for (const { bid, cached } of cacheLookups) {
      if (cached !== null) {
        hitMap.set(bid, cached as PerformanceBulkRow)
      } else {
        missBids.push(bid)
      }
    }

    // 4) miss bids 가 있으면 SA 호출 (1회만 — bids 합쳐서)
    const cachedAll = missBids.length === 0
    if (missBids.length > 0) {
      const fresh = await estimatePerformanceBulk(advertiser.customerId, {
        keyword: kw.keyword,
        device,
        bids: missBids,
      })

      // 응답 row 의 r.bid 로 매칭 (응답 순서 보장 X — naver-sa-specialist 명시).
      // SA 가 input bid 와 다른 값을 돌려줄 가능성도 있으나 그대로 신뢰.
      const freshByBid = new Map<number, PerformanceBulkRow>()
      for (const r of fresh) {
        if (typeof r.bid === "number") freshByBid.set(r.bid, r)
      }

      // upsert — SA 가 돌려준 row 만 (누락 bid 는 캐시 X)
      await Promise.all(
        Array.from(freshByBid.entries()).map(([bid, row]) =>
          upsertCacheEntry({
            advertiserId,
            keywordId,
            device,
            type: EstimateType.performance_bulk,
            position: 0,
            bid,
            result: row,
          }),
        ),
      )

      // hitMap 에 fresh 합치기
      for (const [bid, row] of freshByBid) {
        hitMap.set(bid, row)
      }
    }

    // 5) 입력 bids 순서대로 결과 배열 구성 (누락 bid 는 결과에서 제외 — UI 가 길이 비교)
    const data: PerformanceBulkRow[] = []
    for (const bid of sortedBids) {
      const r = hitMap.get(bid)
      if (r) data.push(r)
    }

    return {
      ok: true,
      data,
      cachedAll,
      cachedCount: cacheLookups.filter((c) => c.cached !== null).length,
    }
  } catch (e) {
    return { ok: false, error: safeErrorMessage(e) }
  }
}
