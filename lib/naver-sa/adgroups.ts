/**
 * 네이버 SA AdGroups 모듈 (F-2.2 광고그룹 목록·상세·수정)
 *
 * 엔드포인트:
 *   GET /ncc/adgroups                              — 광고주의 모든 광고그룹 (?nccCampaignId= 옵션 필터)
 *   GET /ncc/adgroups/{nccAdgroupId}               — 단건 조회
 *   PUT /ncc/adgroups/{nccAdgroupId}?fields=...    — 단건 수정 (부분 수정 fields 명시)
 *   PUT /ncc/adgroups?fields=...                   — 일괄 수정 (body: 배열)
 *
 * 캐시:
 *   GET 만 `structure` kind / TTL 600s. PUT 캐시 X.
 *
 * 호출자 주의:
 *   - customerId 인자는 광고주 customerId (X-Customer 헤더). 누락 시 client.ts가 차단.
 *   - 청크 분할은 호출부(backend-engineer / batch-executor-job) 책임. 본 모듈은 단일 호출 그대로.
 *   - userLock 의미 (SPEC F-2.2): true = OFF, false = ON.
 *   - SPEC F-2.2 "기본 매체 ON/OFF" = PC/모바일 채널 키 전환. 채널 키 필드명은 응답 sample마다 차이가 있을 수 있어
 *     본 모듈은 서명/HTTP 호출만 책임지고 fields 문자열은 호출부가 그대로 전달한다. 스키마는 passthrough.
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
 * 광고그룹 응답 스키마.
 *
 * 주요 필드 (Java/Python sample 기준):
 *   - nccAdgroupId: 네이버 광고그룹 ID
 *   - nccCampaignId: 상위 캠페인 ID
 *   - customerId: 광고주 customerId (외부 API는 number/string 양쪽 가능 → string으로 정규화)
 *   - name: 광고그룹 이름
 *   - bidAmt: 광고그룹 기본 입찰가 (null 가능)
 *   - dailyBudget: 일 예산 (null 가능)
 *   - useDailyBudget: 일 예산 사용 여부
 *   - userLock: 사용자 잠금 (true=OFF, false=ON — SPEC F-2.2 컨벤션)
 *   - status: ELIGIBLE / PAUSED / DELETED 등
 *   - statusReason: 상태 사유
 *   - pcChannelKey / mobileChannelKey: 기본 매체(PC/모바일) 채널 키
 *
 * 응답 변경 대비 passthrough — 정의 안 된 필드(targetingTp, contentsNetworkBidWeight 등)는
 * 그대로 통과 (호출부 raw 보존 가능).
 */
export const AdGroupSchema = z
  .object({
    nccAdgroupId: z.string(),
    nccCampaignId: z.string(),
    customerId: z.union([z.string(), z.number()]).transform((v) => String(v)),
    name: z.string(),
    bidAmt: z.number().nullable().optional(),
    dailyBudget: z.number().nullable().optional(),
    useDailyBudget: z.boolean().optional(),
    userLock: z.boolean().optional(),
    status: z.string().optional(),
    statusReason: z.string().optional(),
    pcChannelKey: z.string().optional(),
    mobileChannelKey: z.string().optional(),
  })
  .passthrough()

export type AdGroup = z.infer<typeof AdGroupSchema>

// =============================================================================
// 내부 헬퍼
// =============================================================================

/**
 * Zod 검증 + 실패 시 raw 보존 도메인 에러.
 *
 * 단건 응답용. 응답 변경 대비 raw 그대로 컨텍스트에 첨부.
 */
function parseAdgroup(
  res: unknown,
  ctx: { method: "GET" | "PUT"; path: string; customerId: string },
): AdGroup {
  const parsed = AdGroupSchema.safeParse(res)
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
function parseAdgroupArray(
  res: unknown,
  ctx: { method: "GET" | "PUT"; path: string; customerId: string },
): AdGroup[] {
  const parsed = z.array(AdGroupSchema).safeParse(res)
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
 * 광고주의 광고그룹 목록 조회.
 *
 * @param customerId 광고주 customerId (X-Customer 헤더로 부착)
 * @param opts.nccCampaignId 특정 캠페인 하위만 조회 (옵션)
 *
 * 사용 예:
 *   const adgroups = await listAdgroups(advertiser.customerId)
 *   const cmpAdgroups = await listAdgroups(advertiser.customerId, { nccCampaignId: "cmp-1" })
 */
export async function listAdgroups(
  customerId: string,
  opts?: { nccCampaignId?: string },
): Promise<AdGroup[]> {
  const path = opts?.nccCampaignId
    ? `/ncc/adgroups?nccCampaignId=${encodeURIComponent(opts.nccCampaignId)}`
    : "/ncc/adgroups"
  const res = await naverSaClient.request({
    customerId,
    method: "GET",
    path,
    cache: { kind: "structure", ttl: 600 },
  })
  return parseAdgroupArray(res, { method: "GET", path, customerId })
}

/**
 * 광고그룹 단건 조회.
 *
 * @param customerId 광고주 customerId (X-Customer 헤더로 부착)
 * @param nccAdgroupId 네이버 광고그룹 ID
 */
export async function getAdgroup(
  customerId: string,
  nccAdgroupId: string,
): Promise<AdGroup> {
  const path = `/ncc/adgroups/${encodeURIComponent(nccAdgroupId)}`
  const res = await naverSaClient.request({
    customerId,
    method: "GET",
    path,
    cache: { kind: "structure", ttl: 600 },
  })
  return parseAdgroup(res, { method: "GET", path, customerId })
}

/** 단건/일괄 수정에서 허용하는 패치 필드. */
export type AdgroupUpdatePatch = Partial<
  Pick<
    AdGroup,
    "bidAmt" | "dailyBudget" | "useDailyBudget" | "userLock" | "name" | "pcChannelKey" | "mobileChannelKey"
  >
>

/**
 * 광고그룹 단건 수정.
 *
 * 네이버 SA의 부분 수정은 `?fields=` 쿼리 파라미터로 변경 대상 필드를 명시해야 한다.
 *
 * @param customerId 광고주 customerId
 * @param nccAdgroupId 네이버 광고그룹 ID
 * @param patch 변경할 필드 (bidAmt / dailyBudget / useDailyBudget / userLock / name / 채널 키)
 * @param fields 변경 대상 필드 콤마 구분 문자열 (예: "bidAmt,userLock")
 *
 * 사용 예:
 *   await updateAdgroup(customerId, "grp-1", { bidAmt: 500 }, "bidAmt")
 *   await updateAdgroup(customerId, "grp-1", { userLock: true }, "userLock")
 */
export async function updateAdgroup(
  customerId: string,
  nccAdgroupId: string,
  patch: AdgroupUpdatePatch,
  fields: string,
): Promise<AdGroup> {
  const path = `/ncc/adgroups/${encodeURIComponent(nccAdgroupId)}?fields=${encodeURIComponent(
    fields,
  )}`
  const res = await naverSaClient.request({
    customerId,
    method: "PUT",
    path,
    body: { ...patch, nccAdgroupId },
  })
  return parseAdgroup(res, { method: "PUT", path, customerId })
}

/** 일괄 수정 항목 (nccAdgroupId 필수 + 패치 필드). name은 일괄 수정 대상 외. */
export type AdgroupBulkUpdateItem = { nccAdgroupId: string } & Partial<
  Pick<
    AdGroup,
    "bidAmt" | "dailyBudget" | "useDailyBudget" | "userLock" | "pcChannelKey" | "mobileChannelKey"
  >
>

/**
 * 광고그룹 일괄 수정.
 *
 * 네이버 SA의 부분 수정은 `?fields=` 쿼리 파라미터로 변경 대상 필드를 명시한다.
 * 본 함수는 단일 호출 API 그대로 노출하며, 청크 분할(예: 100건 단위)은 호출부 책임.
 *
 * @param customerId 광고주 customerId
 * @param items 수정 대상 항목 배열 (각 항목에 nccAdgroupId + 패치 필드)
 * @param fields 변경 대상 필드 콤마 구분 문자열 (예: "bidAmt,userLock")
 *
 * 사용 예:
 *   await updateAdgroupsBulk(
 *     customerId,
 *     [{ nccAdgroupId: "grp-1", bidAmt: 500 }, { nccAdgroupId: "grp-2", bidAmt: 600 }],
 *     "bidAmt",
 *   )
 */
export async function updateAdgroupsBulk(
  customerId: string,
  items: AdgroupBulkUpdateItem[],
  fields: string,
): Promise<AdGroup[]> {
  const path = `/ncc/adgroups?fields=${encodeURIComponent(fields)}`
  const res = await naverSaClient.request({
    customerId,
    method: "PUT",
    path,
    body: items,
  })
  return parseAdgroupArray(res, { method: "PUT", path, customerId })
}
