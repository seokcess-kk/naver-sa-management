/**
 * 네이버 SA AdExtensions(확장소재) 모듈 (F-5.x 확장소재 목록·상세·수정·생성·삭제)
 *
 * 엔드포인트:
 *   GET    /ncc/ad-extensions?ownerId={adgroupId}&type={type}   — 광고그룹 단위 목록 조회 (필수 필터)
 *   GET    /ncc/ad-extensions/{nccExtId}                         — 단건 조회
 *   PUT    /ncc/ad-extensions/{nccExtId}?fields=...              — 단건 수정 (부분 수정 fields 명시)
 *   PUT    /ncc/ad-extensions?fields=...                         — 일괄 수정 (body: 배열)
 *   POST   /ncc/ad-extensions                                    — 생성 (body: 단건 또는 배열)
 *   DELETE /ncc/ad-extensions/{nccExtId}                         — 단건 삭제
 *
 * 캐시:
 *   GET 만 `structure` kind / TTL 600s. PUT / POST / DELETE 캐시 X.
 *
 * 호출자 주의:
 *   - customerId 인자는 광고주 customerId (X-Customer 헤더). 누락 시 client.ts가 차단.
 *   - 확장소재 조회는 **광고그룹(또는 캠페인) 단위**로만 제공. 광고주 전체를 한 번에 가져오는
 *     엔드포인트 없음. 광고그룹 N개 모두 동기화하려면 N번 listAdExtensions 호출 필요 (호출부 책임).
 *   - 청크 분할은 호출부(backend-engineer / batch-executor-job) 책임. 본 모듈은 단일 호출 그대로.
 *   - userLock 의미 (SPEC F-5.x): true = OFF, false = ON. P1 다중 선택 삭제는 비대상 → OFF로 대체.
 *   - type별로 응답·요청 페이로드가 다르다 (HEADLINE / DESCRIPTION / IMAGE / SUBLINK 등).
 *     본 모듈은 type 분기를 호출부(actions) 책임으로 두고, ad-extension 객체는 passthrough로
 *     raw 보존 — 호출부가 type에 맞춰 구성·해석.
 *   - P1 확장소재 범위는 3종(HEADLINE / DESCRIPTION / SUBLINK 등) — CLAUDE.md "비대상: P1 9종 확장소재".
 *     모듈은 9종 모두 호출 가능하게 열어두고, 사용 화이트리스트는 호출부에서 강제.
 *   - createAdExtensions 멱등성은 호출부의 externalId 키로 관리 (CSV 규격과 동일 — CLAUDE.md 참조).
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
 * 확장소재(AdExtension) type 화이트리스트 (호출부 입력 타입 가드 용도).
 *
 * 응답 스키마 자체는 string 으로 두어 신규 타입 추가 시 검증 실패를 피한다.
 *   - HEADLINE      추가 제목
 *   - DESCRIPTION   추가 설명
 *   - IMAGE         이미지형
 *   - SUBLINK       서브 링크
 *   - LOCATION      위치 정보
 *   - PRICELINK     가격 링크
 *   - CALCULATION   계산 위젯
 *   - RESERVATION   예약 위젯
 *   - TALKTALK      톡톡 연결
 *
 * 호출부는 본 타입의 값만 사용 (P1 화이트리스트 강제는 호출부 책임).
 */
export type AdExtensionType =
  | "HEADLINE"
  | "DESCRIPTION"
  | "IMAGE"
  | "SUBLINK"
  | "LOCATION"
  | "PRICELINK"
  | "CALCULATION"
  | "RESERVATION"
  | "TALKTALK"

/**
 * 확장소재 응답 스키마.
 *
 * 주요 필드 (네이버 SA sample 기준):
 *   - nccExtId: 네이버 확장소재 ID
 *   - ownerId: 상위 광고그룹/캠페인 ID
 *   - ownerType: "ADGROUP" / "CAMPAIGN" (응답에 항상 있지는 않음 — optional)
 *   - type: AdExtensionType 문자열 (HEADLINE / DESCRIPTION / IMAGE 등)
 *   - customerId: 광고주 customerId (외부 API는 number/string 양쪽 가능 → string으로 정규화)
 *   - userLock: 사용자 잠금 (true=OFF, false=ON — SPEC F-5.x 컨벤션)
 *   - status: ELIGIBLE / PAUSED / DELETED 등
 *   - inspectStatus: 검수 상태 문자열 (UNDER_REVIEW / APPROVED / REJECTED 등)
 *   - inspectMemo: 검수 반려 사유
 *
 * type별 페이로드(headline / description / image / pc / mobile / period 등)는
 * 응답마다 shape 가 다르므로 passthrough 로 raw 보존.
 * 호출부가 type 분기로 안전하게 해석.
 */
export const AdExtensionSchema = z
  .object({
    nccExtId: z.string(),
    ownerId: z.string(),
    ownerType: z.string().optional(),
    type: z.string(),
    customerId: z.union([z.string(), z.number()]).transform((v) => String(v)),
    userLock: z.boolean().optional(),
    status: z.string().optional(),
    inspectStatus: z.string().optional(),
    inspectMemo: z.string().optional(),
  })
  .passthrough()

export type AdExtension = z.infer<typeof AdExtensionSchema>

// =============================================================================
// 내부 헬퍼
// =============================================================================

/**
 * Zod 검증 + 실패 시 raw 보존 도메인 에러.
 *
 * 단건 응답용. 응답 변경 대비 raw 그대로 컨텍스트에 첨부.
 */
function parseAdExtension(
  res: unknown,
  ctx: { method: "GET" | "PUT" | "POST"; path: string; customerId: string },
): AdExtension {
  const parsed = AdExtensionSchema.safeParse(res)
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
function parseAdExtensionArray(
  res: unknown,
  ctx: { method: "GET" | "PUT" | "POST"; path: string; customerId: string },
): AdExtension[] {
  const parsed = z.array(AdExtensionSchema).safeParse(res)
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
 * 광고그룹 하위 확장소재 목록 조회.
 *
 * 네이버 SA는 확장소재 조회를 **소유자 단위(ownerId)**로만 제공한다.
 * 본 함수는 광고그룹 단위 조회 (ownerId = nccAdgroupId) 만 노출 — P1 SPEC 범위.
 * 캠페인 단위 조회가 필요해지면 ownerId/ownerType 인자로 일반화 (별도 PR).
 *
 * type 미지정 시 광고그룹의 모든 확장소재를 가져온다 (네이버 API 동작 기준).
 *
 * @param customerId 광고주 customerId (X-Customer 헤더로 부착)
 * @param opts.nccAdgroupId 광고그룹 ID (필수, ownerId 로 전달)
 * @param opts.type 조회할 확장소재 타입 필터 (선택)
 *
 * 사용 예:
 *   const adgroups = await listAdgroups(customerId)
 *   const extensions = (
 *     await Promise.all(
 *       adgroups.map((g) => listAdExtensions(customerId, { nccAdgroupId: g.nccAdgroupId })),
 *     )
 *   ).flat()
 */
export async function listAdExtensions(
  customerId: string,
  opts: { nccAdgroupId: string; type?: AdExtensionType },
): Promise<AdExtension[]> {
  const params = new URLSearchParams({ ownerId: opts.nccAdgroupId })
  if (opts.type) params.set("type", opts.type)
  const path = `/ncc/ad-extensions?${params.toString()}`
  const res = await naverSaClient.request({
    customerId,
    method: "GET",
    path,
    cache: { kind: "structure", ttl: 600 },
  })
  return parseAdExtensionArray(res, { method: "GET", path, customerId })
}

/**
 * 확장소재 단건 조회.
 *
 * @param customerId 광고주 customerId (X-Customer 헤더로 부착)
 * @param nccExtId 네이버 확장소재 ID
 */
export async function getAdExtension(
  customerId: string,
  nccExtId: string,
): Promise<AdExtension> {
  const path = `/ncc/ad-extensions/${encodeURIComponent(nccExtId)}`
  const res = await naverSaClient.request({
    customerId,
    method: "GET",
    path,
    cache: { kind: "structure", ttl: 600 },
  })
  return parseAdExtension(res, { method: "GET", path, customerId })
}

/**
 * 단건/일괄 수정에서 허용하는 패치 필드.
 *
 * P1 본 PR 범위:
 *   - userLock (true=OFF / false=ON 토글) — 다중 선택 OFF 액션의 필수 필드
 *   - headline / description: HEADLINE / DESCRIPTION 타입 텍스트 부분 수정 (호출부 fields 인자로 명시)
 *
 * P1 보강 후보 (현재 미포함):
 *   - image / pc / mobile / period 등 type별 복합 필드.
 *     type별 허용 필드가 다르므로 별도 PR에서 타입 보강 후 추가.
 *
 * 호출부 주의: type별로 패치 가능 필드가 다르다.
 *   - HEADLINE: headline + userLock
 *   - DESCRIPTION: description + userLock
 *   - SUBLINK / IMAGE 등: userLock 위주 (텍스트/URL 수정은 type별 PR로 별도 추가)
 *   본 모듈은 fields 쿼리 문자열만 받고, 분기 검증은 호출부 책임.
 */
export type AdExtensionUpdatePatch = {
  userLock?: boolean
  headline?: string
  description?: string
}

/**
 * 확장소재 단건 수정.
 *
 * 네이버 SA의 부분 수정은 `?fields=` 쿼리 파라미터로 변경 대상 필드를 명시해야 한다.
 *
 * @param customerId 광고주 customerId
 * @param nccExtId 네이버 확장소재 ID
 * @param patch 변경할 필드 (P1: userLock / headline / description)
 * @param fields 변경 대상 필드 콤마 구분 문자열 (예: "userLock", "headline")
 *
 * 사용 예:
 *   await updateAdExtension(customerId, "ext-1", { userLock: true }, "userLock")
 *   await updateAdExtension(customerId, "ext-1", { headline: "신상품 출시" }, "headline")
 */
export async function updateAdExtension(
  customerId: string,
  nccExtId: string,
  patch: AdExtensionUpdatePatch,
  fields: string,
): Promise<AdExtension> {
  const path = `/ncc/ad-extensions/${encodeURIComponent(nccExtId)}?fields=${encodeURIComponent(
    fields,
  )}`
  const res = await naverSaClient.request({
    customerId,
    method: "PUT",
    path,
    body: { ...patch, nccExtId },
  })
  return parseAdExtension(res, { method: "PUT", path, customerId })
}

/** 일괄 수정 항목 (nccExtId 필수 + 패치 필드). */
export type AdExtensionBulkUpdateItem = { nccExtId: string } & AdExtensionUpdatePatch

/**
 * 확장소재 일괄 수정.
 *
 * 네이버 SA의 부분 수정은 `?fields=` 쿼리 파라미터로 변경 대상 필드를 명시한다.
 * 본 함수는 단일 호출 API 그대로 노출하며, 청크 분할(예: 100건 단위)은 호출부 책임.
 *
 * @param customerId 광고주 customerId
 * @param items 수정 대상 항목 배열 (각 항목에 nccExtId + 패치 필드)
 * @param fields 변경 대상 필드 콤마 구분 문자열 (예: "userLock")
 *
 * 사용 예:
 *   await updateAdExtensionsBulk(
 *     customerId,
 *     [
 *       { nccExtId: "ext-1", userLock: true },
 *       { nccExtId: "ext-2", userLock: true },
 *     ],
 *     "userLock",
 *   )
 */
export async function updateAdExtensionsBulk(
  customerId: string,
  items: AdExtensionBulkUpdateItem[],
  fields: string,
): Promise<AdExtension[]> {
  const path = `/ncc/ad-extensions?fields=${encodeURIComponent(fields)}`
  const res = await naverSaClient.request({
    customerId,
    method: "PUT",
    path,
    body: items,
  })
  return parseAdExtensionArray(res, { method: "PUT", path, customerId })
}

/**
 * 확장소재 생성 항목 (POST body 1건).
 *
 * - ownerId 필수: 부착할 광고그룹/캠페인 ID
 * - ownerType: 기본 "ADGROUP" (캠페인 단위 확장소재는 ownerType="CAMPAIGN")
 * - type 필수: AdExtensionType 중 하나
 * - type별 페이로드(headline / description / image / pc / mobile 등):
 *     자유 JSON 으로 전달 (passthrough). 호출부가 type 에 맞춰 구성.
 * - externalId: 호출부 멱등키 (DB ChangeItem.externalId와 매핑)
 *   네이버 API는 본 필드를 무시할 수 있으므로 호출부는 응답 매핑 시 (ownerId, type, externalId)
 *   또는 응답 nccExtId로 재조회/대조.
 */
export type AdExtensionCreateItem = {
  ownerId: string
  ownerType?: string
  type: AdExtensionType
  headline?: string
  description?: string
  image?: Record<string, unknown>
  pc?: { final?: string }
  mobile?: { final?: string }
  externalId?: string
} & Record<string, unknown>

/**
 * 확장소재 생성 (단건 또는 배열).
 *
 * 네이버 SA POST /ncc/ad-extensions 는 body 에 단건 객체 또는 배열을 모두 허용한다.
 * 호출자 편의·일관성을 위해 본 함수는 **항상 배열 입력**으로 통일 (단건이면 [item]).
 * body 는 그대로 배열로 전달한다.
 *
 * 호출자는 type 별로 items 를 그룹화하거나 섞어서 전달 가능 — 네이버 API 가 처리.
 * 다만 type별 필드 누락은 호출부에서 검증 (스키마 분기는 본 모듈 비대상).
 *
 * @param customerId 광고주 customerId
 * @param items 생성할 확장소재 배열 (각 항목에 ownerId / type 필수)
 *
 * 사용 예 (단건 — 배열 1개):
 *   await createAdExtensions(customerId, [
 *     {
 *       ownerId: "grp-1",
 *       ownerType: "ADGROUP",
 *       type: "HEADLINE",
 *       headline: "신상품 출시",
 *       externalId: "csv-row-12",
 *     },
 *   ])
 *
 * 사용 예 (혼합):
 *   await createAdExtensions(customerId, [
 *     { ownerId: "grp-1", type: "HEADLINE", headline: "할인 50%" },
 *     { ownerId: "grp-1", type: "DESCRIPTION", description: "지금 구매 시 무료 배송" },
 *   ])
 *
 * 멱등성: 호출부는 ChangeItem.externalId 키로 재시도 시 중복 생성을 차단한다 (본 모듈은 API 그대로 노출).
 */
export async function createAdExtensions(
  customerId: string,
  items: AdExtensionCreateItem[],
): Promise<AdExtension[]> {
  const path = `/ncc/ad-extensions`
  const res = await naverSaClient.request({
    customerId,
    method: "POST",
    path,
    body: items,
  })
  return parseAdExtensionArray(res, { method: "POST", path, customerId })
}

/**
 * 확장소재 단건 삭제.
 *
 * 네이버 SA: DELETE /ncc/ad-extensions/{nccExtId}
 *
 * @param customerId 광고주 customerId (X-Customer 헤더로 부착)
 * @param nccExtId 네이버 확장소재 ID
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
 *   await deleteAdExtension(customerId, "ext-1")
 */
export async function deleteAdExtension(
  customerId: string,
  nccExtId: string,
): Promise<void> {
  const path = `/ncc/ad-extensions/${encodeURIComponent(nccExtId)}`
  await naverSaClient.request({
    customerId,
    method: "DELETE",
    path,
  })
}
