/**
 * 네이버 SA Campaigns 모듈 (F-2.1 / F-2.3 캠페인 목록·상세·수정)
 *
 * 엔드포인트:
 *   GET /ncc/campaigns                  — 광고주의 모든 캠페인 (X-Customer 헤더로 광고주 지정)
 *   GET /ncc/campaigns/{nccCampaignId}  — 단건 조회
 *   PUT /ncc/campaigns/{nccCampaignId}?fields=...  — 단건 수정 (부분 수정 fields 명시)
 *   PUT /ncc/campaigns?fields=...                  — 일괄 수정 (body: 배열)
 *
 * 캐시:
 *   GET 만 `structure` kind / TTL 600s. PUT 캐시 X.
 *
 * 호출자 주의:
 *   - customerId 인자는 광고주 customerId (X-Customer 헤더). 누락 시 client.ts가 차단.
 *   - 청크 분할은 호출부(backend-engineer / batch-executor-job) 책임. 본 모듈은 단일 호출 그대로.
 *   - userLock 의미 (SPEC F-2.1 / F-2.3): true = OFF, false = ON.
 *
 * HMAC 서명 / fetch는 `lib/naver-sa/client.ts`만 수행. 본 모듈에서 직접 호출 금지.
 */

import { z } from "zod"

import { naverSaClient } from "@/lib/naver-sa/client"
import { NaverSaValidationError } from "@/lib/naver-sa/errors"

// =============================================================================
// 스키마
// =============================================================================

/**
 * 캠페인 응답 스키마.
 *
 * 주요 필드 (Java/Python sample 기준):
 *   - nccCampaignId: 네이버 캠페인 ID
 *   - customerId: 광고주 customerId (외부 API는 number/string 양쪽 가능 → string으로 정규화)
 *   - name: 캠페인 이름
 *   - campaignTp: 캠페인 유형 (WEB_SITE / SHOPPING / POWER_CONTENTS 등)
 *   - dailyBudget: 일 예산 (null 가능)
 *   - useDailyBudget: 일 예산 사용 여부
 *   - status: ELIGIBLE / PAUSED / DELETED 등
 *   - statusReason: 상태 사유
 *   - userLock: 사용자 잠금 (true=OFF, false=ON — SPEC F-2.1 컨벤션)
 *
 * 응답 변경 대비 passthrough — 정의 안 된 필드는 그대로 통과 (호출부 raw 보존 가능).
 */
export const CampaignSchema = z
  .object({
    nccCampaignId: z.string(),
    customerId: z.union([z.string(), z.number()]).transform((v) => String(v)),
    name: z.string(),
    campaignTp: z.string().optional(),
    dailyBudget: z.number().nullable().optional(),
    useDailyBudget: z.boolean().optional(),
    status: z.string().optional(),
    statusReason: z.string().optional(),
    userLock: z.boolean().optional(),
  })
  .passthrough()

export type Campaign = z.infer<typeof CampaignSchema>

// =============================================================================
// 내부 헬퍼
// =============================================================================

/**
 * Zod 검증 + 실패 시 raw 보존 도메인 에러.
 *
 * 단건 응답용. 응답 변경 대비 raw 그대로 컨텍스트에 첨부.
 */
function parseCampaign(
  res: unknown,
  ctx: { method: "GET" | "PUT"; path: string; customerId: string },
): Campaign {
  const parsed = CampaignSchema.safeParse(res)
  if (!parsed.success) {
    throw new NaverSaValidationError(`${ctx.method} ${ctx.path}: zod validation failed`, {
      method: ctx.method,
      path: ctx.path,
      customerId: ctx.customerId,
      raw: res,
    })
  }
  return parsed.data
}

/**
 * Zod 검증 + 실패 시 raw 보존 도메인 에러.
 *
 * 배열 응답용. 응답이 배열이 아닐 경우도 검증 실패로 처리.
 */
function parseCampaignArray(
  res: unknown,
  ctx: { method: "GET" | "PUT"; path: string; customerId: string },
): Campaign[] {
  const parsed = z.array(CampaignSchema).safeParse(res)
  if (!parsed.success) {
    throw new NaverSaValidationError(`${ctx.method} ${ctx.path}: zod validation failed`, {
      method: ctx.method,
      path: ctx.path,
      customerId: ctx.customerId,
      raw: res,
    })
  }
  return parsed.data
}

// =============================================================================
// public API
// =============================================================================

/**
 * 광고주의 모든 캠페인 목록 조회.
 *
 * @param customerId 광고주 customerId (X-Customer 헤더로 부착)
 *
 * 사용 예:
 *   const campaigns = await listCampaigns(advertiser.customerId)
 */
export async function listCampaigns(customerId: string): Promise<Campaign[]> {
  const path = "/ncc/campaigns"
  const res = await naverSaClient.request({
    customerId,
    method: "GET",
    path,
    cache: { kind: "structure", ttl: 600 },
  })
  return parseCampaignArray(res, { method: "GET", path, customerId })
}

/**
 * 캠페인 단건 조회.
 *
 * @param customerId 광고주 customerId (X-Customer 헤더로 부착)
 * @param nccCampaignId 네이버 캠페인 ID
 */
export async function getCampaign(
  customerId: string,
  nccCampaignId: string,
): Promise<Campaign> {
  const path = `/ncc/campaigns/${encodeURIComponent(nccCampaignId)}`
  const res = await naverSaClient.request({
    customerId,
    method: "GET",
    path,
    cache: { kind: "structure", ttl: 600 },
  })
  return parseCampaign(res, { method: "GET", path, customerId })
}

/** 단건/일괄 수정에서 허용하는 패치 필드. */
export type CampaignUpdatePatch = Partial<
  Pick<Campaign, "dailyBudget" | "useDailyBudget" | "userLock" | "name">
>

/**
 * 캠페인 단건 수정.
 *
 * 네이버 SA의 부분 수정은 `?fields=` 쿼리 파라미터로 변경 대상 필드를 명시해야 한다.
 *
 * @param customerId 광고주 customerId
 * @param nccCampaignId 네이버 캠페인 ID
 * @param patch 변경할 필드 (dailyBudget / useDailyBudget / userLock / name)
 * @param fields 변경 대상 필드 콤마 구분 문자열 (예: "dailyBudget,userLock")
 *
 * 사용 예:
 *   await updateCampaign(customerId, "cmp-1", { userLock: true }, "userLock")
 */
export async function updateCampaign(
  customerId: string,
  nccCampaignId: string,
  patch: CampaignUpdatePatch,
  fields: string,
): Promise<Campaign> {
  const path = `/ncc/campaigns/${encodeURIComponent(nccCampaignId)}?fields=${encodeURIComponent(
    fields,
  )}`
  const res = await naverSaClient.request({
    customerId,
    method: "PUT",
    path,
    body: { ...patch, nccCampaignId },
  })
  return parseCampaign(res, { method: "PUT", path, customerId })
}

/** 일괄 수정 항목 (nccCampaignId 필수 + 패치 필드). name은 일괄 수정 대상 외. */
export type CampaignBulkUpdateItem = { nccCampaignId: string } & Partial<
  Pick<Campaign, "dailyBudget" | "useDailyBudget" | "userLock">
>

/**
 * 캠페인 일괄 수정.
 *
 * 네이버 SA의 부분 수정은 `?fields=` 쿼리 파라미터로 변경 대상 필드를 명시한다.
 * 본 함수는 단일 호출 API 그대로 노출하며, 청크 분할(예: 100건 단위)은 호출부 책임.
 *
 * @param customerId 광고주 customerId
 * @param items 수정 대상 항목 배열 (각 항목에 nccCampaignId + 패치 필드)
 * @param fields 변경 대상 필드 콤마 구분 문자열 (예: "dailyBudget,userLock")
 *
 * 사용 예:
 *   await updateCampaignsBulk(
 *     customerId,
 *     [{ nccCampaignId: "cmp-1", userLock: true }, { nccCampaignId: "cmp-2", userLock: true }],
 *     "userLock",
 *   )
 */
export async function updateCampaignsBulk(
  customerId: string,
  items: CampaignBulkUpdateItem[],
  fields: string,
): Promise<Campaign[]> {
  const path = `/ncc/campaigns?fields=${encodeURIComponent(fields)}`
  const res = await naverSaClient.request({
    customerId,
    method: "PUT",
    path,
    body: items,
  })
  return parseCampaignArray(res, { method: "PUT", path, customerId })
}
