/**
 * ChangeItem 변경 적용 분기 — Chunk Executor 호출 진입점.
 *
 * 본 모듈 책임:
 *   - ChangeItem.targetType / after.operation 기반으로 SA 호출 함수 매핑
 *   - 성공 시 DB(Keyword 등) upsert/update
 *   - 실패 시 throw — 호출자(`/api/batch/run`)가 ChangeItem.status='failed' + error 기록
 *
 * 화이트리스트 (targetType / action):
 *   - targetType="Keyword"  → CSV 일괄 가져오기 (operation: CREATE / UPDATE / OFF)
 *                            + bid_inbox.apply / approval_queue.apply
 *   - targetType="AdGroup"  → sync_keywords (광고그룹별 listKeywords 청크 동기화)
 *   - 그 외 targetType 은 throw ("unsupported targetType for chunk executor")
 *
 * 호출 진입점:
 *   - app/api/batch/run/route.ts — Vercel Cron 매분 호출 → lease 획득 → 본 함수 호출
 *
 * SPEC v0.2.1 3.5 (Job Table + Chunk Executor) 패턴.
 */

import { prisma } from "@/lib/db/prisma"
// 자격증명 resolver side-effect 등록 (Cron 단독 진입에서도 SA 호출 가능하게).
import "@/lib/naver-sa/credentials"
import {
  createKeywords,
  listKeywords,
  updateKeywordsBulk,
  type Keyword as SaKeyword,
  type KeywordBulkUpdateItem,
  type KeywordCreateItem,
  type KeywordUpdatePatch,
} from "@/lib/naver-sa/keywords"
import type { ChangeItem } from "@/lib/generated/prisma/client"
import type {
  InspectStatus,
  KeywordStatus,
} from "@/lib/generated/prisma/client"
import type * as Prisma from "@/lib/generated/prisma/internal/prismaNamespace"
import { mapWithConcurrency, UPSERT_CONCURRENCY } from "@/lib/sync/concurrency"

// =============================================================================
// 결과 타입
// =============================================================================

/**
 * applyChange 반환:
 *   - CREATE 성공: nccKeywordId 채움 (호출자가 ChangeItem.targetId 갱신)
 *   - UPDATE / OFF 성공: nccKeywordId 미반환 (이미 ChangeItem.targetId 에 채워짐)
 *   - sync_keywords (AdGroup 처리) 성공: syncSummary 채움 — 호출자가 ChangeItem.after 에 머지
 */
export type ApplyChangeResult = {
  nccKeywordId?: string
  /** sync_keywords 분기 전용. 호출자(/api/batch/run)가 after JSON 에 머지하여 finalize 합산. */
  syncSummary?: {
    syncedKeywords: number
    skipped: number
  }
}

// =============================================================================
// 본체
// =============================================================================

/**
 * ChangeItem 1건을 적용. 본 PR 은 targetType="Keyword" 만 처리.
 *
 * after JSON 형식 (CSV 적용 시):
 *   - operation: "CREATE" | "UPDATE" | "OFF"
 *   - customerId: 광고주 SA customerId (X-Customer 헤더)
 *   - CREATE: nccAdgroupId / keyword / matchType / bidAmt / useGroupBidAmt / userLock / externalId
 *   - UPDATE: nccKeywordId / fields("bidAmt,userLock") / patch{ bidAmt, useGroupBidAmt, userLock }
 *   - OFF:    nccKeywordId
 *
 * 동기 처리. 외부 변경 + DB 반영 모두 본 함수 안에서.
 */
export async function applyChange(item: ChangeItem): Promise<ApplyChangeResult> {
  // sync_keywords 분기 — targetType='AdGroup' (광고그룹별 listKeywords + Keyword upsert).
  // 본 분기는 operation 미사용 (after = { customerId, dbAdgroupId, advertiserId } 만).
  if (item.targetType === "AdGroup") {
    return applySyncKeywordsAdgroup(item)
  }

  if (item.targetType !== "Keyword") {
    throw new Error(
      `unsupported targetType for chunk executor: ${item.targetType}`,
    )
  }

  // after 는 CSV 적재 시 plain object 로 직렬화됨 (Prisma JSON).
  const after = (item.after ?? {}) as Record<string, unknown>

  const operation = String(after.operation ?? "")
  const customerId = String(after.customerId ?? "")
  if (!customerId) {
    throw new Error("customerId 누락 — ChangeItem.after.customerId 필수")
  }

  switch (operation) {
    case "CREATE":
      return applyCreate(item, after, customerId)
    case "UPDATE":
      return applyUpdate(item, after, customerId)
    case "OFF":
      return applyOff(item, after, customerId)
    default:
      throw new Error(`unsupported operation: ${operation}`)
  }
}

// =============================================================================
// CREATE
// =============================================================================
// 1행 → createKeywords([1건]) 호출. 광고그룹 단위 그룹화는 호출자(Server Action)가 아닌
// Cron 단위 처리에서는 단순화 — 행마다 단일 호출 (Rate Limit 토큰 버킷이 광고주별 큐잉).
// 같은 광고그룹 다수 행을 묶을 수도 있으나 본 PR 은 안전한 단순 모드 (1행 1호출).

async function applyCreate(
  item: ChangeItem,
  after: Record<string, unknown>,
  customerId: string,
): Promise<ApplyChangeResult> {
  const nccAdgroupId = String(after.nccAdgroupId ?? "")
  const keyword = String(after.keyword ?? "")
  const matchType =
    typeof after.matchType === "string" ? after.matchType.toUpperCase() : ""
  const externalId =
    typeof after.externalId === "string" ? after.externalId : undefined
  const bidAmt =
    typeof after.bidAmt === "number" ? after.bidAmt : null
  const useGroupBidAmt =
    typeof after.useGroupBidAmt === "boolean" ? after.useGroupBidAmt : undefined
  const userLock =
    typeof after.userLock === "boolean" ? after.userLock : undefined

  if (!nccAdgroupId) throw new Error("CREATE: nccAdgroupId 누락")
  if (!keyword) throw new Error("CREATE: keyword 누락")
  if (!matchType) throw new Error("CREATE: matchType 누락")
  if (!externalId) throw new Error("CREATE: externalId 누락")

  // 멱등성 이중 방어 — natural key 사전 검사.
  // ChangeBatch 생성 시 1차 검사했으나, Cron 처리 사이 시간차로 외부 변경 가능성.
  // 같은 (nccAdgroupId, keyword, matchType) 가 이미 DB 에 있으면 skip 처리 (done 으로).
  const existingByNat = await prisma.keyword.findFirst({
    where: {
      keyword,
      matchType,
      adgroup: { nccAdgroupId },
    },
    select: { nccKeywordId: true },
  })
  if (existingByNat) {
    // 이미 존재 — 응답으로 nccKeywordId 갱신 (멱등 처리, error 아님)
    return { nccKeywordId: existingByNat.nccKeywordId }
  }

  // 광고주 한정 광고그룹 internal id 조회 (DB upsert 시 필요)
  const dbAdgroup = await prisma.adGroup.findUnique({
    where: { nccAdgroupId },
    select: { id: true },
  })
  if (!dbAdgroup) {
    throw new Error(`광고그룹 미존재: ${nccAdgroupId}`)
  }

  const items: KeywordCreateItem[] = [
    {
      keyword,
      bidAmt,
      useGroupBidAmt,
      userLock,
      externalId,
    },
  ]

  const created = await createKeywords(customerId, nccAdgroupId, items)
  const u: SaKeyword | undefined = created[0]
  if (!u) {
    throw new Error("응답에 누락 (createKeywords 빈 응답)")
  }

  // 응답 raw 보존
  const anyU = u as unknown as { matchType?: string }
  const mtFromResp =
    typeof anyU.matchType === "string" && anyU.matchType.length > 0
      ? anyU.matchType.toUpperCase()
      : matchType

  const userLockResp =
    typeof u.userLock === "boolean" ? u.userLock : userLock ?? false
  const useGroupBidResp =
    typeof u.useGroupBidAmt === "boolean"
      ? u.useGroupBidAmt
      : useGroupBidAmt ?? true
  const bidAmtResp = typeof u.bidAmt === "number" ? u.bidAmt : bidAmt

  await prisma.keyword.upsert({
    where: { nccKeywordId: u.nccKeywordId },
    create: {
      adgroupId: dbAdgroup.id,
      nccKeywordId: u.nccKeywordId,
      keyword: u.keyword,
      matchType: mtFromResp,
      bidAmt: bidAmtResp,
      useGroupBidAmt: useGroupBidResp,
      userLock: userLockResp,
      externalId,
      status: mapKeywordStatusFromSa(u),
      raw: u as unknown as Prisma.InputJsonValue,
    },
    update: {
      adgroupId: dbAdgroup.id,
      keyword: u.keyword,
      matchType: mtFromResp ?? undefined,
      bidAmt: bidAmtResp,
      useGroupBidAmt: useGroupBidResp,
      userLock: userLockResp,
      externalId,
      status: mapKeywordStatusFromSa(u),
      raw: u as unknown as Prisma.InputJsonValue,
    },
  })

  return { nccKeywordId: u.nccKeywordId }
}

// =============================================================================
// UPDATE
// =============================================================================

async function applyUpdate(
  item: ChangeItem,
  after: Record<string, unknown>,
  customerId: string,
): Promise<ApplyChangeResult> {
  const nccKeywordId = String(after.nccKeywordId ?? "")
  if (!nccKeywordId) throw new Error("UPDATE: nccKeywordId 누락")

  const fieldsRaw = typeof after.fields === "string" ? after.fields : ""
  const patchRaw =
    after.patch && typeof after.patch === "object"
      ? (after.patch as Record<string, unknown>)
      : {}

  const patch: KeywordUpdatePatch = {}
  if (typeof patchRaw.bidAmt === "number") patch.bidAmt = patchRaw.bidAmt
  if (patchRaw.bidAmt === null) patch.bidAmt = null
  if (typeof patchRaw.useGroupBidAmt === "boolean") {
    patch.useGroupBidAmt = patchRaw.useGroupBidAmt
  }
  if (typeof patchRaw.userLock === "boolean") {
    patch.userLock = patchRaw.userLock
  }

  // fields 미지정 시 patch 키로 추론 (안전장치)
  const fields =
    fieldsRaw.length > 0 ? fieldsRaw : Object.keys(patch).join(",")
  if (!fields) throw new Error("UPDATE: 변경 필드 없음")

  const items: KeywordBulkUpdateItem[] = [{ nccKeywordId, ...patch }]
  const updated = await updateKeywordsBulk(customerId, items, fields)
  const u: SaKeyword | undefined = updated[0]
  if (!u) throw new Error("응답에 누락 (updateKeywordsBulk 빈 응답)")

  // DB update — 광고주 한정 강제는 호출 진입(Cron) 단에서 검증 X.
  // 본 PR 은 ChangeBatch 생성 시 광고주 소속 검증을 마쳤다는 가정 (시간차 외부 변경은
  // existsByNcc 로 1차 검출, 미존재면 skip 대신 throw 로 가시성 확보).
  const dbKeyword = await prisma.keyword.findUnique({
    where: { nccKeywordId },
    select: { id: true },
  })
  if (!dbKeyword) throw new Error(`키워드 미존재 (DB): ${nccKeywordId}`)

  const updateData: {
    bidAmt?: number | null
    useGroupBidAmt?: boolean
    userLock?: boolean
    status?: KeywordStatus
    raw: Prisma.InputJsonValue
  } = {
    raw: u as unknown as Prisma.InputJsonValue,
  }
  if (patch.bidAmt !== undefined) {
    updateData.bidAmt =
      typeof u.bidAmt === "number" ? u.bidAmt : patch.bidAmt
  }
  if (patch.useGroupBidAmt !== undefined) {
    updateData.useGroupBidAmt =
      typeof u.useGroupBidAmt === "boolean"
        ? u.useGroupBidAmt
        : patch.useGroupBidAmt
  }
  if (patch.userLock !== undefined) {
    updateData.userLock =
      typeof u.userLock === "boolean" ? u.userLock : patch.userLock
    updateData.status = mapKeywordStatusFromSa(u)
  }

  await prisma.keyword.update({
    where: { id: dbKeyword.id },
    data: updateData,
  })

  return {}
}

// =============================================================================
// OFF
// =============================================================================

async function applyOff(
  item: ChangeItem,
  after: Record<string, unknown>,
  customerId: string,
): Promise<ApplyChangeResult> {
  const nccKeywordId = String(after.nccKeywordId ?? "")
  if (!nccKeywordId) throw new Error("OFF: nccKeywordId 누락")

  const items: KeywordBulkUpdateItem[] = [
    { nccKeywordId, userLock: true },
  ]
  const updated = await updateKeywordsBulk(customerId, items, "userLock")
  const u: SaKeyword | undefined = updated[0]
  if (!u) throw new Error("응답에 누락 (updateKeywordsBulk 빈 응답)")

  const dbKeyword = await prisma.keyword.findUnique({
    where: { nccKeywordId },
    select: { id: true },
  })
  if (!dbKeyword) throw new Error(`키워드 미존재 (DB): ${nccKeywordId}`)

  const newLock = typeof u.userLock === "boolean" ? u.userLock : true
  await prisma.keyword.update({
    where: { id: dbKeyword.id },
    data: {
      userLock: newLock,
      status: mapKeywordStatusFromSa(u),
      raw: u as unknown as Prisma.InputJsonValue,
    },
  })

  return {}
}

// =============================================================================
// helpers
// =============================================================================
// keywords/actions.ts 의 mapKeywordStatus 와 동일 정책. 본 모듈에서 재사용을 위해 내부 복제
// (순환 import 방지). 정책 변경 시 양쪽 동기화 필요.

function mapKeywordStatusFromSa(k: SaKeyword): KeywordStatus {
  const anyK = k as unknown as {
    userLock?: boolean
    status?: string
    deleted?: boolean
  }
  if (anyK.deleted === true) return "deleted"
  if (
    typeof anyK.status === "string" &&
    anyK.status.toUpperCase() === "DELETED"
  ) {
    return "deleted"
  }
  if (anyK.userLock === true) return "off"
  if (
    typeof anyK.status === "string" &&
    anyK.status.toUpperCase() === "PAUSED"
  ) {
    return "off"
  }
  return "on"
}

/**
 * 네이버 SA Keyword.inspectStatus → 앱 InspectStatus enum 매핑.
 *
 * keywords/actions.ts 의 mapInspectStatus 와 동일 정책. 정책 변경 시 양쪽 동기화 필요.
 *   - APPROVED / PASSED / OK / ELIGIBLE   → approved
 *   - REJECTED / FAILED / DENIED          → rejected
 *   - 그 외 (UNDER_REVIEW / 미정 / 누락)  → pending
 */
function mapInspectStatusFromSa(k: SaKeyword): InspectStatus {
  const raw = (k.inspectStatus ?? "").toString().toUpperCase().trim()
  if (
    raw === "APPROVED" ||
    raw === "PASSED" ||
    raw === "OK" ||
    raw === "ELIGIBLE"
  ) {
    return "approved"
  }
  if (raw === "REJECTED" || raw === "FAILED" || raw === "DENIED") {
    return "rejected"
  }
  return "pending"
}

/**
 * recentAvgRnk 응답 파싱 — 숫자 / 문자열 / null 모두 받아 number | null 반환.
 * keywords/actions.ts 와 동일한 안전 캐스팅 패턴.
 */
function parseRecentAvgRnk(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

// =============================================================================
// sync_keywords (AdGroup 단위) — listKeywords + Keyword upsert
// =============================================================================
//
// 흐름:
//   1. item.after 검증 (customerId / dbAdgroupId / advertiserId 모두 string)
//   2. 광고그룹 DB 재검증 (시간차 외부 변경 / 광고주 횡단 차단)
//   3. listKeywords(customerId, { nccAdgroupId }) — 토큰 버킷 큐잉 (client.ts 자동 처리)
//   4. 응답 키워드 배열을 nccKeywordId unique 로 prisma.keyword.upsert (자연 멱등)
//      - 응답의 nccAdgroupId 가 dbAdgroupId 와 다르면 (정상 케이스 X) skip 카운트
//   5. syncSummary 반환 — 호출자(/api/batch/run)가 ChangeItem.after 에 머지
//
// 멱등성:
//   - ChangeItem 재시도 시 동일 nccAdgroupId 로 listKeywords 재호출 + upsert 자연 멱등.
//
// 광고주 횡단 차단:
//   - actions.ts(enqueue) 시점 검증 + 본 함수에서 dbAdgroupId.campaign.advertiserId 재검증
//     (시간차로 광고그룹 deleted 됐거나 캠페인 이동 시 throw → ChangeItem.status='failed').

async function applySyncKeywordsAdgroup(
  item: ChangeItem,
): Promise<ApplyChangeResult> {
  const after = (item.after ?? {}) as Record<string, unknown>
  const customerId = String(after.customerId ?? "")
  const dbAdgroupId = String(after.dbAdgroupId ?? "")
  const advertiserId = String(after.advertiserId ?? "")
  const nccAdgroupId = item.targetId ?? ""

  if (!customerId) {
    throw new Error("sync_keywords: customerId 누락 (after.customerId)")
  }
  if (!dbAdgroupId) {
    throw new Error("sync_keywords: dbAdgroupId 누락 (after.dbAdgroupId)")
  }
  if (!advertiserId) {
    throw new Error("sync_keywords: advertiserId 누락 (after.advertiserId)")
  }
  if (!nccAdgroupId) {
    throw new Error("sync_keywords: targetId(nccAdgroupId) 누락")
  }

  // -- 광고그룹 재검증 (시간차 / 광고주 횡단 가드) -----------------------------
  // enqueue 후 Cron 픽업 사이에 광고그룹이 deleted 됐거나, 같은 nccAdgroupId 가 다른 광고주로
  // 이동했을 가능성 (운영상 드물지만 가드).
  const dbAdgroup = await prisma.adGroup.findUnique({
    where: { id: dbAdgroupId },
    select: {
      id: true,
      nccAdgroupId: true,
      campaign: { select: { advertiserId: true } },
    },
  })
  if (!dbAdgroup) {
    throw new Error(`sync_keywords: 광고그룹 미존재(DB) id=${dbAdgroupId}`)
  }
  if (dbAdgroup.nccAdgroupId !== nccAdgroupId) {
    // enqueue 시점 nccAdgroupId 와 현재 DB 값이 불일치 — drift. throw 로 가시성 확보.
    throw new Error(
      `sync_keywords: nccAdgroupId drift (item=${nccAdgroupId} db=${dbAdgroup.nccAdgroupId})`,
    )
  }
  if (dbAdgroup.campaign.advertiserId !== advertiserId) {
    throw new Error("sync_keywords: 광고주 일치 검증 실패")
  }

  // -- listKeywords 호출 (토큰 버킷이 광고주별 큐잉 자동) ---------------------
  const remote: SaKeyword[] = await listKeywords(customerId, { nccAdgroupId })

  // -- 응답 키워드 upsert (nccKeywordId unique 자연 멱등) --------------------
  // -- upsert 병렬 (UPSERT_CONCURRENCY=10) -----------------------------------
  // 광고그룹당 키워드 600개 환경에서 직렬 upsert 는 ~30초 — Vercel 함수 60s 한계 안에서
  // 다른 광고그룹 처리 여지 X. mapWithConcurrency 로 ~10배 단축 (Supabase pool 안전선 내).
  const upsertResults = await mapWithConcurrency(
    remote,
    UPSERT_CONCURRENCY,
    async (k): Promise<"ok" | "skip"> => {
      // 응답의 nccAdgroupId 가 우리가 요청한 광고그룹과 다르면 skip (정상 케이스 X — 안전 가드).
      if (k.nccAdgroupId !== nccAdgroupId) return "skip"

      const mappedStatus = mapKeywordStatusFromSa(k)
      const mappedInspect = mapInspectStatusFromSa(k)
      const bidAmtVal = typeof k.bidAmt === "number" ? k.bidAmt : null
      const useGroupBidAmtVal =
        typeof k.useGroupBidAmt === "boolean" ? k.useGroupBidAmt : true
      const userLockVal =
        typeof k.userLock === "boolean" ? k.userLock : false

      // matchType / recentAvgRnk 는 응답에 있을 때만 update 에 포함 (없으면 기존값 유지).
      // KeywordSchema 는 passthrough 라 정의 외 필드는 그대로 통과 (any cast 안전).
      const anyK = k as unknown as {
        matchType?: string
        recentAvgRnk?: number | string | null
      }
      const matchTypeVal =
        typeof anyK.matchType === "string" && anyK.matchType.length > 0
          ? anyK.matchType.toUpperCase()
          : null
      const recentAvgRnkVal = parseRecentAvgRnk(anyK.recentAvgRnk)

      const rawJson = k as unknown as Prisma.InputJsonValue

      const baseCreateData: {
        adgroupId: string
        nccKeywordId: string
        keyword: string
        matchType: string | null
        bidAmt: number | null
        useGroupBidAmt: boolean
        userLock: boolean
        status: KeywordStatus
        inspectStatus: InspectStatus
        raw: Prisma.InputJsonValue
        recentAvgRnk?: number
      } = {
        adgroupId: dbAdgroupId,
        nccKeywordId: k.nccKeywordId,
        keyword: k.keyword,
        matchType: matchTypeVal,
        bidAmt: bidAmtVal,
        useGroupBidAmt: useGroupBidAmtVal,
        userLock: userLockVal,
        status: mappedStatus,
        inspectStatus: mappedInspect,
        raw: rawJson,
      }
      if (recentAvgRnkVal !== null) {
        baseCreateData.recentAvgRnk = recentAvgRnkVal
      }

      // update 페이로드: 응답에 없는 필드(matchType / recentAvgRnk)는 빼서 기존값 유지.
      const baseUpdateData: {
        adgroupId: string
        keyword: string
        bidAmt: number | null
        useGroupBidAmt: boolean
        userLock: boolean
        status: KeywordStatus
        inspectStatus: InspectStatus
        raw: Prisma.InputJsonValue
        matchType?: string
        recentAvgRnk?: number
      } = {
        adgroupId: dbAdgroupId,
        keyword: k.keyword,
        bidAmt: bidAmtVal,
        useGroupBidAmt: useGroupBidAmtVal,
        userLock: userLockVal,
        status: mappedStatus,
        inspectStatus: mappedInspect,
        raw: rawJson,
      }
      if (matchTypeVal !== null) {
        baseUpdateData.matchType = matchTypeVal
      }
      if (recentAvgRnkVal !== null) {
        baseUpdateData.recentAvgRnk = recentAvgRnkVal
      }

      await prisma.keyword.upsert({
        where: { nccKeywordId: k.nccKeywordId },
        create: baseCreateData,
        update: baseUpdateData,
      })
      return "ok"
    },
  )

  let syncedKeywords = 0
  let skipped = 0
  for (const r of upsertResults) {
    if (r === "ok") syncedKeywords++
    else skipped++
  }

  return {
    syncSummary: { syncedKeywords, skipped },
  }
}

