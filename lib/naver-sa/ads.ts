/**
 * 네이버 SA Ads(소재) 모듈 (F-4.x 소재 목록·상세·수정·생성·삭제)
 *
 * 엔드포인트:
 *   GET    /ncc/ads?nccAdgroupId={id}                       — 광고그룹 단위 목록 조회 (필수 필터)
 *   GET    /ncc/ads/{nccAdId}                               — 단건 조회
 *   PUT    /ncc/ads/{nccAdId}?fields=...                    — 단건 수정 (부분 수정 fields 명시)
 *   PUT    /ncc/ads?fields=...                              — 일괄 수정 (body: 배열)
 *   POST   /ncc/ads?nccAdgroupId={id}                       — 광고그룹 단위 일괄 생성 (body: 배열)
 *   DELETE /ncc/ads/{nccAdId}                               — 단건 삭제
 *
 * 캐시:
 *   GET 만 `structure` kind / TTL 600s. PUT / POST / DELETE 캐시 X.
 *
 * 호출자 주의:
 *   - customerId 인자는 광고주 customerId (X-Customer 헤더). 누락 시 client.ts가 차단.
 *   - 소재 조회는 **광고그룹 단위**로만 제공. 광고주 전체를 한 번에 가져오는 엔드포인트 없음.
 *     광고그룹 N개를 모두 동기화하려면 N번 listAds 호출 필요 (호출부 책임).
 *   - 청크 분할은 호출부(backend-engineer / batch-executor-job) 책임. 본 모듈은 단일 호출 그대로.
 *   - userLock 의미 (SPEC F-4.x): true = OFF, false = ON. P1 다중 선택 삭제는 비대상 → OFF로 대체.
 *   - adType 별로 ad 객체 필드 구성이 다르다 (TEXT_45 / RSA_AD 등). 본 모듈은 ad 를 record 로
 *     passthrough — 호출부가 adType 에 맞춰 구성. 응답 raw 그대로 보존.
 *   - createAds 멱등성은 호출부의 externalId 키로 관리 (CSV CREATE 규격과 동일 — CLAUDE.md 참조).
 *     본 모듈은 API 그대로 노출.
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
 * 소재(Ad) 응답 스키마.
 *
 * 주요 필드 (Java/Python sample 기준):
 *   - nccAdId: 네이버 소재 ID
 *   - nccAdgroupId: 상위 광고그룹 ID
 *   - customerId: 광고주 customerId (외부 API는 number/string 양쪽 가능 → string으로 정규화)
 *   - adType: 소재 타입 문자열 (예: "TEXT_45", "RSA_AD" 등 — 응답마다 차이)
 *   - ad: 소재 본문 객체 (제목/설명/URL/headline/description 등 — adType별 상이)
 *         passthrough 로 raw 보존
 *   - userLock: 사용자 잠금 (true=OFF, false=ON — SPEC F-4.x 컨벤션)
 *   - status: ELIGIBLE / PAUSED / DELETED 등
 *   - statusReason: 상태 사유
 *   - inspectStatus: 검수 상태 문자열 (UNDER_REVIEW / APPROVED / REJECTED 등)
 *   - inspectMemo: 검수 반려 사유
 *
 * 응답 변경 대비 passthrough — 정의 안 된 필드(editTm / regTm / 신규 adType별 필드 등)는
 * 그대로 통과 (호출부 raw 보존 가능).
 */
export const AdSchema = z
  .object({
    nccAdId: z.string(),
    nccAdgroupId: z.string(),
    customerId: z.union([z.string(), z.number()]).transform((v) => String(v)),
    adType: z.string().optional(),
    ad: z.object({}).passthrough().optional(),
    userLock: z.boolean().optional(),
    status: z.string().optional(),
    statusReason: z.string().optional(),
    inspectStatus: z.string().optional(),
    inspectMemo: z.string().optional(),
  })
  .passthrough()

export type Ad = z.infer<typeof AdSchema>

// =============================================================================
// 내부 헬퍼
// =============================================================================

/**
 * Zod 검증 + 실패 시 raw 보존 도메인 에러.
 *
 * 단건 응답용. 응답 변경 대비 raw 그대로 컨텍스트에 첨부.
 */
function parseAd(
  res: unknown,
  ctx: { method: "GET" | "PUT" | "POST"; path: string; customerId: string },
): Ad {
  const parsed = AdSchema.safeParse(res)
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
function parseAdArray(
  res: unknown,
  ctx: { method: "GET" | "PUT" | "POST"; path: string; customerId: string },
): Ad[] {
  const parsed = z.array(AdSchema).safeParse(res)
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
 * 광고그룹 하위 소재 목록 조회.
 *
 * 네이버 SA는 소재 조회를 **광고그룹 단위**로만 제공한다 (광고주 전체 일괄 조회 엔드포인트 없음).
 * 광고주의 모든 소재를 동기화하려면 광고그룹 목록을 먼저 받고 각각에 대해 본 함수 호출 필요.
 *
 * @param customerId 광고주 customerId (X-Customer 헤더로 부착)
 * @param opts.nccAdgroupId 광고그룹 ID (필수)
 *
 * 사용 예:
 *   const adgroups = await listAdgroups(customerId)
 *   const ads = (
 *     await Promise.all(
 *       adgroups.map((g) => listAds(customerId, { nccAdgroupId: g.nccAdgroupId })),
 *     )
 *   ).flat()
 */
export async function listAds(
  customerId: string,
  opts: { nccAdgroupId: string },
): Promise<Ad[]> {
  const path = `/ncc/ads?nccAdgroupId=${encodeURIComponent(opts.nccAdgroupId)}`
  const res = await naverSaClient.request({
    customerId,
    method: "GET",
    path,
    cache: { kind: "structure", ttl: 600 },
  })
  return parseAdArray(res, { method: "GET", path, customerId })
}

/**
 * 소재 단건 조회.
 *
 * @param customerId 광고주 customerId (X-Customer 헤더로 부착)
 * @param nccAdId 네이버 소재 ID
 */
export async function getAd(customerId: string, nccAdId: string): Promise<Ad> {
  const path = `/ncc/ads/${encodeURIComponent(nccAdId)}`
  const res = await naverSaClient.request({
    customerId,
    method: "GET",
    path,
    cache: { kind: "structure", ttl: 600 },
  })
  return parseAd(res, { method: "GET", path, customerId })
}

/**
 * 단건/일괄 수정에서 허용하는 패치 필드.
 *
 * P1 본 PR 범위:
 *   - userLock (true=OFF / false=ON 토글)
 *
 * P1 보강 후보 (현재 미포함):
 *   - ad: Record<string, unknown> 으로 텍스트/RSA 소재 필드 일부 수정.
 *     adType별 허용 필드가 다르므로 별도 PR에서 타입 보강 후 추가.
 */
export type AdUpdatePatch = {
  userLock?: boolean
}

/**
 * 소재 단건 수정.
 *
 * 네이버 SA의 부분 수정은 `?fields=` 쿼리 파라미터로 변경 대상 필드를 명시해야 한다.
 *
 * @param customerId 광고주 customerId
 * @param nccAdId 네이버 소재 ID
 * @param patch 변경할 필드 (P1: userLock)
 * @param fields 변경 대상 필드 콤마 구분 문자열 (예: "userLock")
 *
 * 사용 예:
 *   await updateAd(customerId, "ad-1", { userLock: true }, "userLock")
 */
export async function updateAd(
  customerId: string,
  nccAdId: string,
  patch: AdUpdatePatch,
  fields: string,
): Promise<Ad> {
  const path = `/ncc/ads/${encodeURIComponent(nccAdId)}?fields=${encodeURIComponent(fields)}`
  const res = await naverSaClient.request({
    customerId,
    method: "PUT",
    path,
    body: { ...patch, nccAdId },
  })
  return parseAd(res, { method: "PUT", path, customerId })
}

/** 일괄 수정 항목 (nccAdId 필수 + 패치 필드). */
export type AdBulkUpdateItem = { nccAdId: string } & AdUpdatePatch

/**
 * 소재 일괄 수정.
 *
 * 네이버 SA의 부분 수정은 `?fields=` 쿼리 파라미터로 변경 대상 필드를 명시한다.
 * 본 함수는 단일 호출 API 그대로 노출하며, 청크 분할(예: 100건 단위)은 호출부 책임.
 *
 * @param customerId 광고주 customerId
 * @param items 수정 대상 항목 배열 (각 항목에 nccAdId + 패치 필드)
 * @param fields 변경 대상 필드 콤마 구분 문자열 (예: "userLock")
 *
 * 사용 예:
 *   await updateAdsBulk(
 *     customerId,
 *     [
 *       { nccAdId: "ad-1", userLock: true },
 *       { nccAdId: "ad-2", userLock: true },
 *     ],
 *     "userLock",
 *   )
 */
export async function updateAdsBulk(
  customerId: string,
  items: AdBulkUpdateItem[],
  fields: string,
): Promise<Ad[]> {
  const path = `/ncc/ads?fields=${encodeURIComponent(fields)}`
  const res = await naverSaClient.request({
    customerId,
    method: "PUT",
    path,
    body: items,
  })
  return parseAdArray(res, { method: "PUT", path, customerId })
}

/**
 * 소재 생성 항목 (POST body 1건).
 *
 * - adType 필수: "TEXT_45" / "RSA_AD" 등 — 응답·요청 sample 기준 그대로 전달
 * - ad: 소재 본문 객체. adType별 허용 필드가 다르므로 record 로 통과
 *   (호출부에서 SPEC F-4.x 가이드 또는 네이버 sample 기준으로 구성)
 * - userLock: 생성 시점 잠금 여부 (선택, 기본 false=ON)
 * - externalId: 호출부 멱등키 (DB ChangeItem.externalId와 매핑)
 *   네이버 API는 본 필드를 무시할 수 있으므로 호출부는 응답 매핑 시 (nccAdgroupId, externalId)
 *   또는 응답 nccAdId로 재조회/대조.
 */
export type AdCreateItem = {
  adType: string
  ad: Record<string, unknown>
  userLock?: boolean
  externalId?: string
}

/**
 * 광고그룹 하위 소재 일괄 생성.
 *
 * 네이버 SA는 소재 생성도 **광고그룹 단위**로만 제공한다.
 * 호출자는 nccAdgroupId 별로 items 를 그룹화해서 본 함수를 광고그룹 수만큼 호출.
 *
 * @param customerId 광고주 customerId
 * @param nccAdgroupId 소재를 생성할 광고그룹 ID
 * @param items 생성할 소재 배열 (광고그룹은 path에 부착되므로 item에는 adType·ad·lock만)
 *
 * 사용 예:
 *   await createAds(customerId, "grp-1", [
 *     {
 *       adType: "TEXT_45",
 *       ad: { headline: "신발 할인", description: "지금 50% 세일", pc: { final: "https://..." } },
 *       externalId: "csv-row-12",
 *     },
 *   ])
 *
 * 멱등성: 호출부는 ChangeItem.externalId 키로 재시도 시 중복 생성을 차단한다 (본 모듈은 API 그대로 노출).
 */
export async function createAds(
  customerId: string,
  nccAdgroupId: string,
  items: AdCreateItem[],
): Promise<Ad[]> {
  const path = `/ncc/ads?nccAdgroupId=${encodeURIComponent(nccAdgroupId)}`
  const res = await naverSaClient.request({
    customerId,
    method: "POST",
    path,
    body: items,
  })
  return parseAdArray(res, { method: "POST", path, customerId })
}

/**
 * 소재 단건 삭제.
 *
 * 네이버 SA: DELETE /ncc/ads/{nccAdId}
 *
 * @param customerId 광고주 customerId (X-Customer 헤더로 부착)
 * @param nccAdId 네이버 소재 ID
 *
 * 호출자 주의:
 *   - admin 권한 한정 + 2차 확인 흐름 (Server Action에서 강제) — CLAUDE.md "단건 삭제도 admin + 2차 확인 필수"
 *   - 다중 선택 삭제는 P1 비대상 (OFF로 대체) — CLAUDE.md "비대상" 참조
 *   - 삭제 후 DB 측은 status='deleted' 반영 또는 row 삭제 정책 결정 (호출부 책임)
 *   - 응답 body가 빈 경우(204 등) 정상 반환 — naverSaClient가 처리
 *   - 캐시 무관 (DELETE는 캐시 전략 X)
 *   - HMAC 서명 / 토큰 버킷 / 에러 매핑은 client.ts에서 통일 처리
 *
 * 사용 예:
 *   await deleteAd(customerId, "ad-1")
 */
export async function deleteAd(customerId: string, nccAdId: string): Promise<void> {
  const path = `/ncc/ads/${encodeURIComponent(nccAdId)}`
  await naverSaClient.request({
    customerId,
    method: "DELETE",
    path,
  })
}
