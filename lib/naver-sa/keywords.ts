/**
 * 네이버 SA Keywords 모듈 (F-3.1 키워드 목록 / F-3.2 인라인 편집 / F-3.4 CSV / F-3.6 일괄 액션 / F-3.7 단건 삭제)
 *
 * 엔드포인트:
 *   GET    /ncc/keywords?nccAdgroupId={id}                   — 광고그룹 단위 목록 조회 (필수 필터)
 *   GET    /ncc/keywords/{nccKeywordId}                      — 단건 조회
 *   PUT    /ncc/keywords/{nccKeywordId}?fields=...           — 단건 수정 (부분 수정 fields 명시)
 *   PUT    /ncc/keywords?fields=...                          — 일괄 수정 (body: 배열)
 *   POST   /ncc/keywords?nccAdgroupId={id}                   — 광고그룹 단위 일괄 생성 (body: 배열)
 *   DELETE /ncc/keywords/{nccKeywordId}                      — 단건 삭제 (F-3.7 admin 권한 한정)
 *
 * 캐시:
 *   GET 만 `structure` kind / TTL 600s. PUT / POST 캐시 X.
 *
 * 호출자 주의:
 *   - customerId 인자는 광고주 customerId (X-Customer 헤더). 누락 시 client.ts가 차단.
 *   - 키워드 조회는 **광고그룹 단위**로만 제공. 광고주 전체를 한 번에 가져오는 엔드포인트 없음.
 *     광고그룹 N개를 모두 동기화하려면 N번 listKeywords 호출 필요 (호출부 책임).
 *   - 청크 분할은 호출부(backend-engineer / batch-executor-job) 책임. 본 모듈은 단일 호출 그대로.
 *   - userLock 의미 (SPEC F-3.x): true = OFF, false = ON. P1 대량 삭제는 비대상 → OFF로 대체.
 *   - useGroupBidAmt = true 이면 keyword.bidAmt 무시되고 광고그룹 기본 입찰가 사용.
 *   - createKeywords 멱등성은 호출부의 externalId + (nccAdgroupId, keyword, matchType) natural key로 보장
 *     (CSV 처리 규격 — CLAUDE.md 참조). 본 모듈은 API 그대로 노출.
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
 * 키워드 응답 스키마.
 *
 * 주요 필드 (Java/Python sample 기준):
 *   - nccKeywordId: 네이버 키워드 ID
 *   - nccAdgroupId: 상위 광고그룹 ID
 *   - customerId: 광고주 customerId (외부 API는 number/string 양쪽 가능 → string으로 정규화)
 *   - keyword: 키워드 텍스트
 *   - bidAmt: 키워드 입찰가 (null 가능, useGroupBidAmt=true 면 무시됨)
 *   - useGroupBidAmt: 광고그룹 기본 입찰가 사용 여부 (true 면 bidAmt 대신 광고그룹 기본가 적용)
 *   - userLock: 사용자 잠금 (true=OFF, false=ON — SPEC F-3.x 컨벤션)
 *   - status: ELIGIBLE / PAUSED / DELETED 등
 *   - statusReason: 상태 사유
 *   - inspectStatus: 검수 상태 (UNDER_REVIEW / APPROVED 등)
 *   - links: 확장 입찰가·연결 정보 (응답마다 shape 다름 — passthrough 대상)
 *   - nccQi: 품질 지수 관련 식별자 (있다면)
 *
 * 응답 변경 대비 passthrough — 정의 안 된 필드(matchType, recentAvgRnk 등 응답마다 차이)는
 * 그대로 통과 (호출부 raw 보존 가능).
 */
export const KeywordSchema = z
  .object({
    nccKeywordId: z.string(),
    nccAdgroupId: z.string(),
    customerId: z.union([z.string(), z.number()]).transform((v) => String(v)),
    keyword: z.string(),
    bidAmt: z.number().nullable().optional(),
    useGroupBidAmt: z.boolean().optional(),
    userLock: z.boolean().optional(),
    status: z.string().optional(),
    statusReason: z.string().optional(),
    inspectStatus: z.string().optional(),
    links: z.object({}).passthrough().optional(),
    nccQi: z.string().optional(),
  })
  .passthrough()

export type Keyword = z.infer<typeof KeywordSchema>

// =============================================================================
// 내부 헬퍼
// =============================================================================

/**
 * Zod 검증 + 실패 시 raw 보존 도메인 에러.
 *
 * 단건 응답용. 응답 변경 대비 raw 그대로 컨텍스트에 첨부.
 */
function parseKeyword(
  res: unknown,
  ctx: { method: "GET" | "PUT" | "POST"; path: string; customerId: string },
): Keyword {
  const parsed = KeywordSchema.safeParse(res)
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
function parseKeywordArray(
  res: unknown,
  ctx: { method: "GET" | "PUT" | "POST"; path: string; customerId: string },
): Keyword[] {
  const parsed = z.array(KeywordSchema).safeParse(res)
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
 * 광고그룹 하위 키워드 목록 조회.
 *
 * 네이버 SA는 키워드 조회를 **광고그룹 단위**로만 제공한다 (광고주 전체 일괄 조회 엔드포인트 없음).
 * 광고주의 모든 키워드를 동기화하려면 광고그룹 목록을 먼저 받고 각각에 대해 본 함수 호출 필요.
 *
 * @param customerId 광고주 customerId (X-Customer 헤더로 부착)
 * @param opts.nccAdgroupId 광고그룹 ID (필수)
 *
 * 사용 예:
 *   const adgroups = await listAdgroups(customerId)
 *   const keywords = (
 *     await Promise.all(
 *       adgroups.map((g) => listKeywords(customerId, { nccAdgroupId: g.nccAdgroupId })),
 *     )
 *   ).flat()
 */
export async function listKeywords(
  customerId: string,
  opts: { nccAdgroupId: string },
): Promise<Keyword[]> {
  const path = `/ncc/keywords?nccAdgroupId=${encodeURIComponent(opts.nccAdgroupId)}`
  const res = await naverSaClient.request({
    customerId,
    method: "GET",
    path,
    cache: { kind: "structure", ttl: 600 },
  })
  return parseKeywordArray(res, { method: "GET", path, customerId })
}

/**
 * 키워드 단건 조회.
 *
 * @param customerId 광고주 customerId (X-Customer 헤더로 부착)
 * @param nccKeywordId 네이버 키워드 ID
 */
export async function getKeyword(
  customerId: string,
  nccKeywordId: string,
): Promise<Keyword> {
  const path = `/ncc/keywords/${encodeURIComponent(nccKeywordId)}`
  const res = await naverSaClient.request({
    customerId,
    method: "GET",
    path,
    cache: { kind: "structure", ttl: 600 },
  })
  return parseKeyword(res, { method: "GET", path, customerId })
}

/** 단건/일괄 수정에서 허용하는 패치 필드. */
export type KeywordUpdatePatch = Partial<Pick<Keyword, "bidAmt" | "useGroupBidAmt" | "userLock">>

/**
 * 키워드 단건 수정.
 *
 * 네이버 SA의 부분 수정은 `?fields=` 쿼리 파라미터로 변경 대상 필드를 명시해야 한다.
 *
 * @param customerId 광고주 customerId
 * @param nccKeywordId 네이버 키워드 ID
 * @param patch 변경할 필드 (bidAmt / useGroupBidAmt / userLock)
 * @param fields 변경 대상 필드 콤마 구분 문자열 (예: "bidAmt,userLock")
 *
 * 사용 예:
 *   await updateKeyword(customerId, "kwd-1", { bidAmt: 500, useGroupBidAmt: false }, "bidAmt,useGroupBidAmt")
 *   await updateKeyword(customerId, "kwd-1", { userLock: true }, "userLock")
 */
export async function updateKeyword(
  customerId: string,
  nccKeywordId: string,
  patch: KeywordUpdatePatch,
  fields: string,
): Promise<Keyword> {
  const path = `/ncc/keywords/${encodeURIComponent(nccKeywordId)}?fields=${encodeURIComponent(
    fields,
  )}`
  const res = await naverSaClient.request({
    customerId,
    method: "PUT",
    path,
    body: { ...patch, nccKeywordId },
  })
  return parseKeyword(res, { method: "PUT", path, customerId })
}

/** 일괄 수정 항목 (nccKeywordId 필수 + 패치 필드). */
export type KeywordBulkUpdateItem = { nccKeywordId: string } & KeywordUpdatePatch

/**
 * 키워드 일괄 수정.
 *
 * 네이버 SA의 부분 수정은 `?fields=` 쿼리 파라미터로 변경 대상 필드를 명시한다.
 * 본 함수는 단일 호출 API 그대로 노출하며, 청크 분할(예: 100건 단위)은 호출부 책임.
 *
 * @param customerId 광고주 customerId
 * @param items 수정 대상 항목 배열 (각 항목에 nccKeywordId + 패치 필드)
 * @param fields 변경 대상 필드 콤마 구분 문자열 (예: "bidAmt,userLock")
 *
 * 사용 예:
 *   await updateKeywordsBulk(
 *     customerId,
 *     [
 *       { nccKeywordId: "kwd-1", bidAmt: 500, useGroupBidAmt: false },
 *       { nccKeywordId: "kwd-2", bidAmt: 600, useGroupBidAmt: false },
 *     ],
 *     "bidAmt,useGroupBidAmt",
 *   )
 */
export async function updateKeywordsBulk(
  customerId: string,
  items: KeywordBulkUpdateItem[],
  fields: string,
): Promise<Keyword[]> {
  const path = `/ncc/keywords?fields=${encodeURIComponent(fields)}`
  const res = await naverSaClient.request({
    customerId,
    method: "PUT",
    path,
    body: items,
  })
  return parseKeywordArray(res, { method: "PUT", path, customerId })
}

/**
 * 키워드 생성 항목 (POST body 1건).
 *
 * - keyword 필수
 * - bidAmt 미지정 또는 useGroupBidAmt=true 면 광고그룹 기본 입찰가 사용
 * - externalId: 호출부 멱등키 (CSV CREATE 규격 — DB ChangeItem.externalId와 매핑)
 *   네이버 API는 본 필드를 무시하므로 호출부는 응답 매핑 시 (nccAdgroupId, keyword, matchType)
 *   natural key로 재조회/대조 (CLAUDE.md "CREATE 멱등성 (이중 방어)").
 */
export type KeywordCreateItem = {
  keyword: string
  bidAmt?: number | null
  useGroupBidAmt?: boolean
  userLock?: boolean
  externalId?: string
}

/**
 * 광고그룹 하위 키워드 일괄 생성.
 *
 * 네이버 SA는 키워드 생성도 **광고그룹 단위**로만 제공한다.
 * 호출자는 nccAdgroupId 별로 items 를 그룹화해서 본 함수를 광고그룹 수만큼 호출.
 *
 * @param customerId 광고주 customerId
 * @param nccAdgroupId 키워드를 생성할 광고그룹 ID
 * @param items 생성할 키워드 배열 (광고그룹은 path에 부착되므로 item에는 keyword·bid·lock만)
 *
 * 사용 예:
 *   await createKeywords(customerId, "grp-1", [
 *     { keyword: "신발", bidAmt: 500, externalId: "csv-row-12" },
 *     { keyword: "운동화", useGroupBidAmt: true, externalId: "csv-row-13" },
 *   ])
 *
 * 멱등성: 호출부는 ChangeItem.externalId 와 (nccAdgroupId + keyword + matchType) natural key를
 * 함께 검사해 재시도 시 중복 생성을 차단한다 (본 모듈은 API 그대로 노출).
 */
export async function createKeywords(
  customerId: string,
  nccAdgroupId: string,
  items: KeywordCreateItem[],
): Promise<Keyword[]> {
  const path = `/ncc/keywords?nccAdgroupId=${encodeURIComponent(nccAdgroupId)}`
  const res = await naverSaClient.request({
    customerId,
    method: "POST",
    path,
    body: items,
  })
  return parseKeywordArray(res, { method: "POST", path, customerId })
}

/**
 * 키워드 단건 삭제.
 *
 * 네이버 SA: DELETE /ncc/keywords/{nccKeywordId}
 *
 * @param customerId 광고주 customerId (X-Customer 헤더로 부착)
 * @param nccKeywordId 네이버 키워드 ID
 *
 * 호출자 주의:
 *   - F-3.7 admin 권한 한정 + 2차 확인 흐름 (Server Action에서 강제)
 *   - 다중 선택 삭제는 P1 비대상 (OFF로 대체) — CLAUDE.md "비대상" 참조
 *   - 삭제 후 DB 측은 status='deleted' 반영 또는 row 삭제 정책 결정 (호출부 책임)
 *   - 응답 body가 빈 경우(204 등) 정상 반환 — naverSaClient가 처리
 *   - 캐시 무관 (DELETE는 캐시 전략 X)
 *   - HMAC 서명 / 토큰 버킷 / 에러 매핑은 client.ts에서 통일 처리
 *
 * 사용 예:
 *   await deleteKeyword(customerId, "kwd-1")
 */
export async function deleteKeyword(
  customerId: string,
  nccKeywordId: string,
): Promise<void> {
  const path = `/ncc/keywords/${encodeURIComponent(nccKeywordId)}`
  await naverSaClient.request({
    customerId,
    method: "DELETE",
    path,
  })
}
