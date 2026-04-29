/**
 * 네이버 SA Estimate 모듈 (F-10.1 / F-10.2 / F-10.3 — 입찰가 시뮬레이터)
 *
 * 엔드포인트 (네이버 SA — 관찰 기반):
 *   POST /estimate/average-position-bid/keyword   — 순위 1~5위 입찰가 조회 (F-10.1)
 *   POST /estimate/exposure-minimum-bid/keyword   — 최소 노출 입찰가 (F-10.2)
 *   POST /estimate/performance-bulk               — 입찰가 후보 N개 → 예상 노출/클릭/CPC (F-10.3)
 *
 * 캐시 전략:
 *   - POST 라 client.ts cache 옵션 미사용 (GET 만 대상)
 *   - 30분 TTL 캐시는 backend layer 의 EstimateCache 테이블 책임 (본 모듈은 raw 호출만)
 *
 * Rate Limit:
 *   - client.ts 토큰 버킷 자동 통과 (광고주별 분리)
 *
 * HMAC 서명 / X-Customer / 재시도(429,1016)는 `lib/naver-sa/client.ts`만 수행.
 * 본 모듈에서 fetch 또는 직접 서명 금지.
 *
 * 시크릿 운영:
 *   - customerId 만 인자 — 평문 키/시크릿 직접 처리 X
 *   - 에러 메시지에 keyword / device / customerId 만 포함 (시크릿 X)
 *
 * 알려진 한계 (네이버 spec 미확정):
 *   - 응답 필드명/순서는 관찰 기반. passthrough 로 추가 필드 통과.
 *   - 운영 dry-run 1회 후 본 파일 Zod 갱신 권장.
 *   - 일부 키워드/디바이스 조합에서 데이터 부족 시 응답 row 누락 가능 — 호출부가 input 대비 결과 수 비교.
 *
 * 캐시 키 (backend EstimateCache):
 *   advertiserId + keywordId + device + type(avgpos|expmin|perf) + position 또는 bid
 *   본 모듈은 customerId/keyword 텍스트 인자만 받고, keywordId 매핑은 backend 책임.
 */

import { z } from "zod"

import { naverSaClient } from "@/lib/naver-sa/client"
import { NaverSaValidationError } from "@/lib/naver-sa/errors"

// =============================================================================
// 타입
// =============================================================================

/** 디바이스 분리 — 네이버 Estimate API 는 PC / MOBILE 별 분리 호출. */
export type EstimateDevice = "PC" | "MOBILE"

// =============================================================================
// Zod 스키마 (passthrough — spec 변경 대비 raw 보존)
// =============================================================================

/**
 * 평균 노출 순위별 입찰가 row (F-10.1).
 *
 * 응답 예 (관찰):
 *   { keyword: "신발", position: 1, bid: 1200 }
 *
 * - keyword optional: 일부 응답이 입력 keyword 를 그대로 echo 하지 않을 수 있음
 * - position int: 1~5
 * - bid int: 원화 — 0 또는 음수 도래 시에도 검증 통과 (호출부 sanity 체크 권장)
 */
export const AveragePositionBidRowSchema = z
  .object({
    keyword: z.string().optional(),
    position: z.number().int(),
    bid: z.number().int(),
  })
  .passthrough()

export type AveragePositionBidRow = z.infer<typeof AveragePositionBidRowSchema>

/**
 * 최소 노출 입찰가 row (F-10.2).
 *
 * 응답 예 (관찰):
 *   { keyword: "신발", minBid: 70 }
 *
 * - minBid int: 원화 (네이버 SA 최저 입찰가 정책에 따른 하한)
 */
export const ExposureMinimumBidRowSchema = z
  .object({
    keyword: z.string().optional(),
    minBid: z.number().int(),
  })
  .passthrough()

export type ExposureMinimumBidRow = z.infer<typeof ExposureMinimumBidRowSchema>

/**
 * 성과 예측 row (F-10.3).
 *
 * 응답 예 (관찰):
 *   { keyword: "신발", bid: 500, impressions: 1234, clicks: 56, cost: 28000, cpc: 500 }
 *
 * - 입찰가 후보 1개당 1 row
 * - impressions / clicks / cost / cpc 모두 nullable optional — 데이터 부족 시 누락 가능
 *   (호출부는 null 처리 또는 표시 안 함 정책 결정)
 */
export const PerformanceBulkRowSchema = z
  .object({
    keyword: z.string().optional(),
    bid: z.number().int(),
    impressions: z.number().nullable().optional(),
    clicks: z.number().nullable().optional(),
    cost: z.number().nullable().optional(),
    cpc: z.number().nullable().optional(),
  })
  .passthrough()

export type PerformanceBulkRow = z.infer<typeof PerformanceBulkRowSchema>

/**
 * 응답 envelope: `{ data: [...] }` (Stats / 다른 모듈과 동일 패턴).
 *
 * 일부 응답은 배열 자체로도 올 수 있어 fallback 처리 — parseEstimateArray 참조.
 */
const AverageEnvelope = z.object({ data: z.array(AveragePositionBidRowSchema) })
const ExposureEnvelope = z.object({ data: z.array(ExposureMinimumBidRowSchema) })
const PerformanceEnvelope = z.object({ data: z.array(PerformanceBulkRowSchema) })

// =============================================================================
// 내부 헬퍼 — 응답 파싱 (envelope 우선, 배열 fallback, 실패 시 raw 보존 throw)
// =============================================================================

function parseAverageRows(
  res: unknown,
  ctx: { path: string; customerId: string; keyword: string; device: EstimateDevice },
): AveragePositionBidRow[] {
  const env = AverageEnvelope.safeParse(res)
  if (env.success) return env.data.data

  const bare = z.array(AveragePositionBidRowSchema).safeParse(res)
  if (bare.success) return bare.data

  throw new NaverSaValidationError(
    `POST ${ctx.path}: average-position-bid zod validation failed`,
    {
      method: "POST",
      path: ctx.path,
      customerId: ctx.customerId,
      raw: res,
    },
  )
}

function parseExposureRows(
  res: unknown,
  ctx: { path: string; customerId: string; keyword: string; device: EstimateDevice },
): ExposureMinimumBidRow[] {
  const env = ExposureEnvelope.safeParse(res)
  if (env.success) return env.data.data

  const bare = z.array(ExposureMinimumBidRowSchema).safeParse(res)
  if (bare.success) return bare.data

  throw new NaverSaValidationError(
    `POST ${ctx.path}: exposure-minimum-bid zod validation failed`,
    {
      method: "POST",
      path: ctx.path,
      customerId: ctx.customerId,
      raw: res,
    },
  )
}

function parsePerformanceRows(
  res: unknown,
  ctx: { path: string; customerId: string; keyword: string; device: EstimateDevice },
): PerformanceBulkRow[] {
  const env = PerformanceEnvelope.safeParse(res)
  if (env.success) return env.data.data

  const bare = z.array(PerformanceBulkRowSchema).safeParse(res)
  if (bare.success) return bare.data

  throw new NaverSaValidationError(
    `POST ${ctx.path}: performance-bulk zod validation failed`,
    {
      method: "POST",
      path: ctx.path,
      customerId: ctx.customerId,
      raw: res,
    },
  )
}

// =============================================================================
// public API
// =============================================================================

export type EstimateAveragePositionBidArgs = {
  /** 키워드 텍스트 (필수) */
  keyword: string
  /** PC / MOBILE */
  device: EstimateDevice
  /** 조회할 순위. 기본 [1, 2, 3, 4, 5]. 1~5 외 값도 그대로 전송. */
  positions?: number[]
}

/**
 * F-10.1: 평균 노출 순위별 입찰가 조회.
 *
 * 키워드 1개에 대해 순위 1~5위 입찰가를 조회.
 *
 * @param customerId 광고주 customerId (X-Customer 헤더)
 * @param args       keyword + device + positions
 * @returns          position 별 row 배열 (정상 응답이면 positions.length 와 동일)
 *
 * 사용 예:
 *   const rows = await estimateAveragePositionBid("c-1", {
 *     keyword: "신발",
 *     device: "PC",
 *     // positions 생략 → [1,2,3,4,5]
 *   })
 *   // rows = [{ keyword:"신발", position:1, bid:1200 }, ..., { ..., position:5, bid:300 }]
 *
 * spec 미확정 — 운영 dry-run 후 응답 shape 확정 시 Zod 갱신.
 */
export async function estimateAveragePositionBid(
  customerId: string,
  args: EstimateAveragePositionBidArgs,
): Promise<AveragePositionBidRow[]> {
  if (!customerId) {
    throw new NaverSaValidationError(
      "estimateAveragePositionBid: customerId is required",
    )
  }
  if (!args.keyword || args.keyword.trim() === "") {
    throw new NaverSaValidationError(
      "estimateAveragePositionBid: keyword is required",
    )
  }

  const positions =
    args.positions && args.positions.length > 0 ? args.positions : [1, 2, 3, 4, 5]

  const path = "/estimate/average-position-bid/keyword"
  const body = {
    device: args.device,
    items: positions.map((position) => ({
      keyword: args.keyword,
      position,
    })),
  }

  const res = await naverSaClient.request({
    customerId,
    method: "POST",
    path,
    body,
  })

  return parseAverageRows(res, {
    path,
    customerId,
    keyword: args.keyword,
    device: args.device,
  })
}

export type EstimateExposureMinimumBidArgs = {
  /** 키워드 텍스트 (필수) */
  keyword: string
  /** PC / MOBILE */
  device: EstimateDevice
}

/**
 * F-10.2: 최소 노출 입찰가 조회.
 *
 * 키워드 1개에 대해 노출이 시작되는 최저 입찰가를 조회.
 *
 * @param customerId 광고주 customerId (X-Customer 헤더)
 * @param args       keyword + device
 * @returns          { keyword, minBid } 단일 결과 (응답 row 1개)
 *
 * 사용 예:
 *   const r = await estimateExposureMinimumBid("c-1", {
 *     keyword: "신발",
 *     device: "MOBILE",
 *   })
 *   // r = { keyword: "신발", minBid: 70 }
 *
 * 응답 row 0개 (네이버가 데이터 부족으로 결과 미반환) 시 NaverSaValidationError throw.
 * 호출부가 catch 후 사용자에게 "데이터 부족" 안내.
 */
export async function estimateExposureMinimumBid(
  customerId: string,
  args: EstimateExposureMinimumBidArgs,
): Promise<ExposureMinimumBidRow> {
  if (!customerId) {
    throw new NaverSaValidationError(
      "estimateExposureMinimumBid: customerId is required",
    )
  }
  if (!args.keyword || args.keyword.trim() === "") {
    throw new NaverSaValidationError(
      "estimateExposureMinimumBid: keyword is required",
    )
  }

  const path = "/estimate/exposure-minimum-bid/keyword"
  const body = {
    device: args.device,
    items: [{ keyword: args.keyword }],
  }

  const res = await naverSaClient.request({
    customerId,
    method: "POST",
    path,
    body,
  })

  const rows = parseExposureRows(res, {
    path,
    customerId,
    keyword: args.keyword,
    device: args.device,
  })

  if (rows.length === 0) {
    throw new NaverSaValidationError(
      `${path}: exposure-minimum-bid returned 0 rows (insufficient data)`,
      {
        method: "POST",
        path,
        customerId,
        raw: res,
      },
    )
  }

  return rows[0]
}

export type EstimatePerformanceBulkArgs = {
  /** 키워드 텍스트 (필수) */
  keyword: string
  /** PC / MOBILE */
  device: EstimateDevice
  /** 입찰가 후보 N개. 빈 배열 → 즉시 [] (네트워크 호출 X). */
  bids: number[]
}

/**
 * F-10.3: 입찰가 후보별 성과 예측.
 *
 * 키워드 1개에 대해 입찰가 N개 후보 → 예상 노출/클릭/비용/CPC.
 *
 * @param customerId 광고주 customerId (X-Customer 헤더)
 * @param args       keyword + device + bids (입찰가 후보)
 * @returns          bid 별 row 배열 (정상 응답이면 bids.length 와 동일)
 *
 * 사용 예 (한계효용 분석):
 *   const rows = await estimatePerformanceBulk("c-1", {
 *     keyword: "신발",
 *     device: "PC",
 *     bids: [100, 200, 300, 500, 800, 1000],
 *   })
 *   // rows = [{ bid:100, impressions:50, ... }, { bid:200, ... }, ...]
 *
 * bids 빈 배열 → 즉시 [] 반환 (네이버 호출 0회).
 * 응답 row 0개 (데이터 부족) 시에도 [] 반환 (호출부가 input 길이와 비교해 표시 정책 결정).
 *
 * spec 미확정 — impressions/clicks/cost/cpc 일부가 null 도래 가능 → Zod nullable.
 */
export async function estimatePerformanceBulk(
  customerId: string,
  args: EstimatePerformanceBulkArgs,
): Promise<PerformanceBulkRow[]> {
  if (!customerId) {
    throw new NaverSaValidationError(
      "estimatePerformanceBulk: customerId is required",
    )
  }
  if (!args.keyword || args.keyword.trim() === "") {
    throw new NaverSaValidationError(
      "estimatePerformanceBulk: keyword is required",
    )
  }

  // bids 빈 배열 → 즉시 [] (네트워크 호출 X)
  if (!args.bids || args.bids.length === 0) {
    return []
  }

  const path = "/estimate/performance-bulk"
  const body = {
    device: args.device,
    items: args.bids.map((bid) => ({
      keyword: args.keyword,
      bid,
    })),
  }

  const res = await naverSaClient.request({
    customerId,
    method: "POST",
    path,
    body,
  })

  return parsePerformanceRows(res, {
    path,
    customerId,
    keyword: args.keyword,
    device: args.device,
  })
}

// =============================================================================
// 테스트 전용 internal export
// =============================================================================
// 운영 코드에서는 import 금지. 단위 테스트(estimate.test.ts)에서 헬퍼 회귀 가드 용도.
export const __test__ = {
  parseAverageRows,
  parseExposureRows,
  parsePerformanceRows,
}
