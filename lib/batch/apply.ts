/**
 * ChangeItem 변경 적용 분기 — Chunk Executor 호출 진입점.
 *
 * 본 모듈 책임:
 *   - ChangeItem.targetType / after.operation 기반으로 SA 호출 함수 매핑
 *   - 성공 시 DB(Keyword 등) upsert/update
 *   - 실패 시 throw — 호출자(`/api/batch/run`)가 ChangeItem.status='failed' + error 기록
 *
 * 본 PR(F-3.4) 범위:
 *   - targetType="Keyword" 만 (CSV 일괄 가져오기 — operation: CREATE / UPDATE / OFF)
 *   - 그 외 targetType (Ad / AdExtension / Campaign / AdGroup) 은 throw
 *     ("unsupported targetType for chunk executor") — 후속 PR 에서 화이트리스트 확장
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
  updateKeywordsBulk,
  type Keyword as SaKeyword,
  type KeywordBulkUpdateItem,
  type KeywordCreateItem,
  type KeywordUpdatePatch,
} from "@/lib/naver-sa/keywords"
import type { ChangeItem } from "@/lib/generated/prisma/client"
import type { KeywordStatus } from "@/lib/generated/prisma/client"
import type * as Prisma from "@/lib/generated/prisma/internal/prismaNamespace"

// =============================================================================
// 결과 타입
// =============================================================================

/**
 * applyChange 반환:
 *   - CREATE 성공: nccKeywordId 채움 (호출자가 ChangeItem.targetId 갱신)
 *   - UPDATE / OFF 성공: nccKeywordId 미반환 (이미 ChangeItem.targetId 에 채워짐)
 */
export type ApplyChangeResult = {
  nccKeywordId?: string
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

