"use server"

/**
 * F-4.x — 소재 관리 (Server Actions)
 *
 * 책임:
 *   1. syncAds            — 광고주의 모든 광고그룹을 순회하며 NAVER SA listAds → DB upsert (F-4.1)
 *   2. bulkActionAds      — 다중 선택 ON/OFF 일괄 액션 (F-4.3 — 소재는 입찰가 없음 → toggle 만)
 *   3. deleteAdSingle     — 단건 삭제 (admin + 2차 확인) (F-4.7)
 *   4. createAdsBatch     — 텍스트 소재 일괄 생성 (F-4.6)
 *
 * 본 PR 비대상 (다른 ID 또는 후속 PR):
 *   - 미리보기(previewAdBulkAction) — 소재는 toggle 만이라 RSC props 로 충분 (UI 책임)
 *   - CSV 내보내기/가져오기 — 소재 본문 자유 JSON 이라 별도 설계 필요
 *   - 다중 선택 삭제 — P1 비대상 (CLAUDE.md "비대상")
 *
 * 운영 정책 (CLAUDE.md / backend-engineer.md):
 *   - 진입부 getCurrentAdvertiser(advertiserId) — admin / 화이트리스트 검증 + 광고주 객체
 *   - prisma 쿼리는 항상 `where: { adgroup: { campaign: { advertiserId } } }` 한정
 *     (Ad → AdGroup → Campaign → advertiserId join 으로 광고주 횡단 차단)
 *   - 모든 변경(toggle/create/delete) 은 ChangeBatch + ChangeItem 흐름 — staging 의무
 *   - SA API 호출용 customerId 와 앱 내부 advertiserId 분리
 *   - AuditLog 1건 (시크릿 X — Ad 응답엔 키 없음)
 *   - revalidatePath(`/${advertiserId}/ads`)
 *
 * 동기화 호출 패턴 (ads 모듈 특성):
 *   - 네이버 SA 소재 목록은 **광고그룹 단위** 만 제공 (광고주 전체 일괄 조회 엔드포인트 없음).
 *   - 따라서 광고그룹 N개 → listAds N번 호출.
 *   - Rate Limit 토큰 버킷이 광고주별 큐잉(client.ts) → 동일 광고주 내 순차 처리 자동.
 *
 * 시간 한계 (TODO):
 *   - P1 전제: 광고그룹 50~200개 + 그룹당 소재 1~5개. 본 PR 단순 동기 처리.
 *   - 한계 부딪히면 ChangeBatch + Chunk Executor 패턴(SPEC 3.5) 으로 이관 권고.
 *
 * 스키마 매핑 메모:
 *   - 앱 DB Ad.status: AdStatus enum (on/off/deleted)
 *   - 앱 DB Ad.inspectStatus: InspectStatus enum (pending/approved/rejected)
 *   - SA 응답: userLock(boolean) + status(string) + inspectStatus(string)
 *   - userLock=true → off, status='DELETED' → deleted, status='PAUSED' → off, else on
 *   - DB Ad 모델엔 userLock 컬럼 없음 → status enum 매핑으로만 표현
 *   - DB Ad 모델엔 externalId 컬럼 없음 → 멱등성은 ChangeItem.idempotencyKey 단일 방어
 *     (CSV CREATE 자연키 검사도 비대상 — 소재 본문이 자유 JSON 이라 자연키 정의 어려움)
 *   - inspectMemo 응답에 있으면 DB 저장 (검수 반려 사유 표시)
 */

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { prisma } from "@/lib/db/prisma"
import { getCurrentAdvertiser, assertRole } from "@/lib/auth/access"
import { logAudit } from "@/lib/audit/log"
import { recordSyncAt } from "@/lib/sync/last-sync-at"
import {
  createAds,
  deleteAd,
  listAds,
  updateAdsBulk,
  type Ad as SaAd,
  type AdBulkUpdateItem,
  type AdCreateItem,
} from "@/lib/naver-sa/ads"
import { NaverSaError } from "@/lib/naver-sa/errors"
import type { AdStatus, InspectStatus } from "@/lib/generated/prisma/client"
import type * as Prisma from "@/lib/generated/prisma/internal/prismaNamespace"

// =============================================================================
// 1. syncAds — NAVER → DB upsert
// =============================================================================

export type SyncAdsResult =
  | {
      ok: true
      syncedAds: number
      scannedAdgroups: number
      skipped: number
      durationMs: number
    }
  | { ok: false; error: string }

/**
 * `syncAds` 옵션 — 두 번째 인자.
 *
 * - `campaignIds` : 광고그룹 query 시 캠페인 화이트리스트(앱 DB Campaign.id). 미지정 시 광고주 전체.
 *                   UI에서 "선택한 캠페인만 동기화" 시 사용 (extensions 패턴 동일).
 *
 * SA `listAds` 는 광고그룹 단위 호출. → 광고그룹 query 단계에서 캠페인 필터 적용.
 */
export type SyncAdsOptions = {
  campaignIds?: string[]
}

/**
 * 소재 동기화 (광고주 단위 — 모든 광고그룹 순회).
 *
 *   1. getCurrentAdvertiser — 권한 검증 + 광고주 객체
 *   2. hasKeys 확인 (시크릿 미입력이면 즉시 차단)
 *   3. DB AdGroup 매핑 테이블 구성 (nccAdgroupId → AdGroup.id)
 *      - 광고주 한정 (campaign.advertiserId join). 캠페인/광고그룹 사전 동기화 필요.
 *   4. 광고그룹 마다 listAds(customerId, { nccAdgroupId }) 순차 호출
 *      - Rate Limit 토큰 버킷이 광고주별로 큐잉 (client.ts) → 별도 throttle 불필요
 *      - 단일 광고그룹 호출 실패는 부분 실패로 처리 (다른 광고그룹은 계속)
 *   5. 각 row upsert (nccAdId unique)
 *      - adgroupIdMap 누락 시 skip + skippedCount (광고그룹 미동기화 또는 삭제됨)
 *      - adType / fields / inspectMemo 는 응답에 있을 때만 update (없으면 기존값 유지)
 *   6. AuditLog 1건 (요약, 시크릿 X)
 *
 * 본 액션은 "조회 → 적재" 만 — 외부 변경 X → ChangeBatch 미사용 (정책상 OK).
 *
 * TODO: 광고그룹 200개 + 다수 소재 동기화 시 Vercel 함수 시간 한계 부딪힐 수 있음.
 *       현 시점은 단순 동기 처리. 측정 후 ChangeBatch + Chunk Executor (SPEC 3.5) 이관.
 */
export async function syncAds(
  advertiserId: string,
  options: SyncAdsOptions = {},
): Promise<SyncAdsResult> {
  const { advertiser, user } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    return { ok: false, error: "API 키/시크릿 미입력" }
  }

  const { campaignIds } = options
  const hasCampaignFilter =
    Array.isArray(campaignIds) && campaignIds.length > 0

  const start = Date.now()

  // -- DB 광고그룹 매핑 테이블 (광고주 한정 + 선택한 캠페인 한정) ---------------
  const adgroups = await prisma.adGroup.findMany({
    where: {
      campaign: {
        advertiserId,
        ...(hasCampaignFilter ? { id: { in: campaignIds } } : {}),
      },
    },
    select: { id: true, nccAdgroupId: true },
  })

  if (adgroups.length === 0) {
    // 광고그룹이 없으면 동기화할 소재도 없음. 정상 종료.
    await logAudit({
      userId: user.id,
      action: "ad.sync",
      targetType: "Advertiser",
      targetId: advertiserId,
      before: null,
      after: {
        syncedAds: 0,
        scannedAdgroups: 0,
        skipped: 0,
        customerId: advertiser.customerId,
        campaignIds: hasCampaignFilter ? campaignIds : undefined,
        note: "no-adgroups",
      },
    })
    // lastSyncAt 갱신 — 광고그룹 0개도 "동기화 시도 완료" 로 기록 (UI 표시 일관성).
    // 단, 캠페인 필터 적용된 부분 동기화는 광고주 전체 sync 가 아니므로 lastSyncAt 갱신 X.
    if (!hasCampaignFilter) {
      await recordSyncAt(advertiserId, "ads")
    }
    revalidatePath(`/${advertiserId}/ads`)
    return {
      ok: true,
      syncedAds: 0,
      scannedAdgroups: 0,
      skipped: 0,
      durationMs: Date.now() - start,
    }
  }

  const adgroupIdMap = new Map<string, string>(
    adgroups.map((g) => [g.nccAdgroupId, g.id]),
  )

  // -- 광고그룹 단위 listAds 반복 ---------------------------------------------
  // SA 소재 조회는 광고그룹 단위만 제공. 광고그룹 N개 → 호출 N번.
  // 부분 실패 허용 (Promise.allSettled): 단일 광고그룹 실패는 다른 광고그룹 동기화에 영향 X.
  //
  // 성능: 광고그룹 chunk 5 병렬 호출 (Rate Limit 토큰 버킷이 광고주별 큐잉 → 자동 wait).
  //   - N=50 기준 기존 순차 ~15초 → chunk 5 병렬 ~3초 수준 (약 5배 단축).
  //   - DB upsert 는 chunk 결과 매핑 후 sequential — connection pool 보호.
  let syncedAds = 0
  let skipped = 0
  let scannedAdgroups = 0

  const CHUNK_SIZE = 5

  try {
    for (let i = 0; i < adgroups.length; i += CHUNK_SIZE) {
      const slice = adgroups.slice(i, i + CHUNK_SIZE)
      const settled = await Promise.allSettled(
        slice.map((ag) =>
          listAds(advertiser.customerId, { nccAdgroupId: ag.nccAdgroupId }),
        ),
      )

      for (let j = 0; j < slice.length; j++) {
        const ag = slice[j]
        const r = settled[j]
        if (r.status === "rejected") {
          // 단일 광고그룹 실패는 로그만 남기고 다음으로 (부분 동기화).
          const e = r.reason
          if (e instanceof NaverSaError) {
            console.warn(
              `[syncAds] listAds failed for nccAdgroupId=${ag.nccAdgroupId}: ${e.message}`,
            )
          } else {
            console.warn(
              `[syncAds] listAds unknown error for nccAdgroupId=${ag.nccAdgroupId}:`,
              e,
            )
          }
          scannedAdgroups++
          continue
        }
        const remote: SaAd[] = r.value

        // -- upsert 루프 ------------------------------------------------------
        for (const a of remote) {
          const dbAdgroupId = adgroupIdMap.get(a.nccAdgroupId)
          if (!dbAdgroupId) {
            // 광고그룹이 DB 에 없음 (광고그룹 미동기화 또는 삭제됨) → skip + 카운트.
            skipped++
            console.warn(
              `[syncAds] skip nccAdId=${a.nccAdId}: ` +
                `parent nccAdgroupId=${a.nccAdgroupId} not found in DB`,
            )
            continue
          }

          const mappedStatus = mapAdStatus(a)
          const mappedInspect = mapAdInspectStatus(a)

          // adType / fields / inspectMemo 는 응답에 있을 때만 반영 (없으면 기존값 유지).
          // AdSchema 는 passthrough 라 정의 외 필드는 그대로 통과 (any cast 안전).
          const adTypeVal =
            typeof a.adType === "string" && a.adType.length > 0
              ? a.adType
              : null
          const fieldsVal =
            a.ad && typeof a.ad === "object"
              ? (a.ad as unknown as Prisma.InputJsonValue)
              : null
          const inspectMemoVal =
            typeof a.inspectMemo === "string" && a.inspectMemo.length > 0
              ? a.inspectMemo
              : null

          const rawJson = a as unknown as Prisma.InputJsonValue

          // create / update 페이로드: 응답에 없는 nullable 필드는 키 자체를 제외하여
          // 기존값 유지 + Prisma Json optional 타입 호환 (null 대신 undefined).
          // adType: String? — null 그대로 OK
          // fields: Json? / inspectMemo: String? — Prisma Optional Json/String 의 update 입력 타입은
          //   null 을 허용하지 않으므로 키 자체를 제외 (응답에 있을 때만 반영).
          const baseCreateData: {
            adgroupId: string
            nccAdId: string
            inspectStatus: InspectStatus
            status: AdStatus
            raw: Prisma.InputJsonValue
            adType?: string | null
            fields?: Prisma.InputJsonValue
            inspectMemo?: string
          } = {
            adgroupId: dbAdgroupId,
            nccAdId: a.nccAdId,
            adType: adTypeVal,
            inspectStatus: mappedInspect,
            status: mappedStatus,
            raw: rawJson,
          }
          if (fieldsVal !== null) baseCreateData.fields = fieldsVal
          if (inspectMemoVal !== null)
            baseCreateData.inspectMemo = inspectMemoVal

          const baseUpdateData: {
            adgroupId: string
            inspectStatus: InspectStatus
            status: AdStatus
            raw: Prisma.InputJsonValue
            adType?: string
            fields?: Prisma.InputJsonValue
            inspectMemo?: string
          } = {
            adgroupId: dbAdgroupId,
            inspectStatus: mappedInspect,
            status: mappedStatus,
            raw: rawJson,
          }
          if (adTypeVal !== null) baseUpdateData.adType = adTypeVal
          if (fieldsVal !== null) baseUpdateData.fields = fieldsVal
          if (inspectMemoVal !== null)
            baseUpdateData.inspectMemo = inspectMemoVal

          await prisma.ad.upsert({
            where: { nccAdId: a.nccAdId },
            create: baseCreateData,
            update: baseUpdateData,
          })
          syncedAds++
        }

        scannedAdgroups++
      }
    }
  } catch (e) {
    // upsert 단계 자체 실패 (DB 연결 등 치명 오류).
    console.error("[syncAds] upsert failed:", e)
    return { ok: false, error: "DB 적재 중 오류" }
  }

  await logAudit({
    userId: user.id,
    action: "ad.sync",
    targetType: "Advertiser",
    targetId: advertiserId,
    before: null,
    after: {
      syncedAds,
      scannedAdgroups,
      skipped,
      customerId: advertiser.customerId,
      campaignIds: hasCampaignFilter ? campaignIds : undefined,
    },
  })

  // lastSyncAt 갱신 (UI 헤더 "마지막 동기화" 배지). 실패해도 sync 결과는 정상 반환.
  // 캠페인 필터 적용된 부분 동기화는 광고주 전체 sync 가 아니므로 lastSyncAt 갱신 X.
  if (!hasCampaignFilter) {
    await recordSyncAt(advertiserId, "ads")
  }

  revalidatePath(`/${advertiserId}/ads`)

  return {
    ok: true,
    syncedAds,
    scannedAdgroups,
    skipped,
    durationMs: Date.now() - start,
  }
}

// =============================================================================
// helpers — SA Ad → 앱 enum 매핑
// =============================================================================

/**
 * 네이버 SA Ad → 앱 AdStatus enum 매핑.
 *
 * 매핑 정책 (keywords/adgroups 와 동일 패턴):
 *   - status='DELETED' (또는 deleted=true)        → 'deleted'
 *   - userLock=true                               → 'off' (사용자가 OFF)
 *   - status='PAUSED'                             → 'off'
 *   - 그 외 (ELIGIBLE / 그 외)                    → 'on'
 *
 * 참고: SA 응답엔 `userLock`(boolean) 과 `status`(string) 가 모두 존재.
 *       ON/OFF 토글은 일반적으로 userLock 으로 다룸 → userLock=true 는 즉시 'off'.
 *       DB Ad 모델엔 userLock 컬럼 없음 → status enum 으로만 표현.
 */
function mapAdStatus(a: SaAd): AdStatus {
  const anyA = a as unknown as {
    userLock?: boolean
    status?: string
    deleted?: boolean
  }
  if (anyA.deleted === true) return "deleted"
  if (
    typeof anyA.status === "string" &&
    anyA.status.toUpperCase() === "DELETED"
  ) {
    return "deleted"
  }
  if (anyA.userLock === true) return "off"
  if (
    typeof anyA.status === "string" &&
    anyA.status.toUpperCase() === "PAUSED"
  ) {
    return "off"
  }
  return "on"
}

/**
 * 네이버 SA Ad.inspectStatus → 앱 InspectStatus enum 매핑.
 *
 * 앱 enum (prisma/schema.prisma):
 *   - pending / approved / rejected
 *
 * SA 응답 문자열은 정확한 코드가 sample 마다 차이 (UNDER_REVIEW / APPROVED / REJECTED 등).
 * 안전 매핑 (keywords helper 와 동일):
 *   - APPROVED / PASSED / OK / ELIGIBLE   → approved
 *   - REJECTED / FAILED / DENIED          → rejected
 *   - 그 외 (UNDER_REVIEW / 미정 / 누락)  → pending
 *
 * 추정 안 되면 'pending' 폴백 + raw 보존 (정확한 코드는 운영 sample 확인 후 후속 PR 보강).
 */
function mapAdInspectStatus(a: SaAd): InspectStatus {
  const raw = (a.inspectStatus ?? "").toString().toUpperCase().trim()
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

// =============================================================================
// 2. bulkActionAds — 다중 선택 ON/OFF 일괄 액션 (F-4.3)
// =============================================================================
//
// UI 흐름:
//   - 사용자가 소재 row 다중 선택 → 액션 모달(toggle ON/OFF) 선택
//   - RSC props 기반 미리보기로 충분 (소재는 입찰가 없음 → 산출 계산 X)
//   - 확정 시 본 액션 호출
//
// 액션 1종:
//   - toggle: userLock 일괄 적용 (true=OFF, false=ON)
//
// TODO(5천 건 한계): 본 PR 은 단일 PUT 시도. updateAdsBulk 의 SA 응답 한계가 부딪히면
//   batch-executor-job 패턴 (Job Table + Cron + Chunk Executor) 으로 이관.

const bulkActionAdsSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("toggle"),
    items: z
      .array(
        z.object({
          adId: z.string().min(1), // 앱 DB Ad.id
          // userLock=true → OFF, false → ON
          userLock: z.boolean(),
        }),
      )
      .min(1)
      .max(500),
  }),
])

export type BulkActionAdsInput = z.infer<typeof bulkActionAdsSchema>

export type BulkActionAdItemResult = {
  adId: string
  ok: boolean
  error?: string
}

export type BulkActionAdsResult = {
  batchId: string
  total: number
  success: number
  failed: number
  items: BulkActionAdItemResult[]
}

/**
 * 다중 선택 일괄 액션 확정 (소재).
 *
 *   1. getCurrentAdvertiser — 권한 검증 + advertiser
 *   2. Zod 검증 + adId dedup (마지막 항목으로 대체 — idempotencyKey unique 충족)
 *   3. 광고주 한정 조회 (adgroup.campaign.advertiserId join)
 *   4. ChangeBatch (status='running', action='ad.toggle') 생성
 *   5. ChangeItem createMany — before/after 에 userLock 만 (소재는 입찰가 없음)
 *   6. updateAdsBulk(customerId, items, "userLock") — 단일 PUT
 *   7. 응답 매핑 — 성공 row → DB update (status 재계산) + ChangeItem='done'
 *      누락 → 'failed' + "응답 누락"
 *   8. ChangeBatch finalize (success>0 → done, 0 → failed)
 *   9. AuditLog 1건 — ad.toggle, after={advertiserId, total, success, failed}
 *  10. revalidatePath
 */
export async function bulkActionAds(
  advertiserId: string,
  input: BulkActionAdsInput,
): Promise<BulkActionAdsResult> {
  const { advertiser, user } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    throw new Error("API 키/시크릿 미입력")
  }

  const parsed = bulkActionAdsSchema.parse(input)

  // -- 입력 정규화 + dedup ----------------------------------------------------
  // adId 중복은 마지막 항목으로 대체 (idempotencyKey unique 충족 — 키워드 패턴 동일).
  const toggleByAdId = new Map<string, boolean>()
  for (const it of parsed.items) {
    toggleByAdId.set(it.adId, it.userLock)
  }
  const adIds = Array.from(toggleByAdId.keys())

  // -- 광고주 한정 조회 (adgroup → campaign → advertiserId join) -------------
  const dbAds = await prisma.ad.findMany({
    where: {
      adgroup: { campaign: { advertiserId } }, // 광고주 횡단 차단
      id: { in: adIds },
    },
    select: {
      id: true,
      nccAdId: true,
      status: true,
    },
  })

  if (dbAds.length !== adIds.length) {
    throw new Error("일부 소재가 광고주 소속이 아닙니다")
  }

  const rowById = new Map(dbAds.map((a) => [a.id, a]))

  // -- ChangeBatch 생성 -------------------------------------------------------
  const action = "ad.toggle"
  const total = adIds.length

  const batch = await prisma.changeBatch.create({
    data: {
      userId: user.id,
      action,
      status: "running",
      total,
      processed: 0,
      attempt: 1,
      summary: {
        advertiserId,
        action: parsed.action,
        total,
      } as Prisma.InputJsonValue,
    },
  })

  // -- SA payload + ChangeItem before/after 산출 ------------------------------
  const itemsForApi: AdBulkUpdateItem[] = []
  type ChangeItemSeed = {
    batchId: string
    targetType: string
    targetId: string
    before: Prisma.InputJsonValue
    after: Prisma.InputJsonValue
    idempotencyKey: string
    status: "pending"
  }
  const changeItemSeeds: ChangeItemSeed[] = []

  for (const aid of adIds) {
    const r = rowById.get(aid)!
    const newLock = toggleByAdId.get(aid)!
    // before: DB status 기반으로 userLock 추론 (off → true, on → false).
    // 정확한 SA userLock 값은 응답 raw 에 보존.
    const beforeLock = r.status === "off"
    const before = { userLock: beforeLock } as Prisma.InputJsonValue
    const after = { userLock: newLock } as Prisma.InputJsonValue

    itemsForApi.push({
      nccAdId: r.nccAdId,
      userLock: newLock,
    })
    changeItemSeeds.push({
      batchId: batch.id,
      targetType: "Ad",
      targetId: r.nccAdId,
      before,
      after,
      idempotencyKey: `${batch.id}:${r.nccAdId}`,
      status: "pending",
    })
  }

  await prisma.changeItem.createMany({
    data: changeItemSeeds.map((s) => ({
      batchId: s.batchId,
      targetType: s.targetType,
      targetId: s.targetId,
      before: s.before,
      after: s.after,
      idempotencyKey: s.idempotencyKey,
      status: s.status,
    })),
  })

  // -- SA API 호출 ------------------------------------------------------------
  // TODO(5천 건 한계): 본 PR 은 단일 PUT. 운영 측정 후 batch-executor-job 패턴 이관.
  let success = 0
  let failed = 0
  const results: BulkActionAdItemResult[] = []

  try {
    const updated = await updateAdsBulk(
      advertiser.customerId,
      itemsForApi,
      "userLock",
    )
    const updatedMap = new Map(updated.map((u) => [u.nccAdId, u]))

    for (const aid of adIds) {
      const r = rowById.get(aid)!
      const u = updatedMap.get(r.nccAdId)

      if (u) {
        // userLock 변경 → status 재계산 (mapAdStatus)
        await prisma.ad.update({
          where: { id: r.id },
          data: {
            status: mapAdStatus(u),
            raw: u as unknown as Prisma.InputJsonValue,
          },
        })
        await prisma.changeItem.updateMany({
          where: { batchId: batch.id, targetId: r.nccAdId },
          data: { status: "done" },
        })
        success++
        results.push({ adId: aid, ok: true })
      } else {
        await prisma.changeItem.updateMany({
          where: { batchId: batch.id, targetId: r.nccAdId },
          data: { status: "failed", error: "응답에 누락" },
        })
        failed++
        results.push({ adId: aid, ok: false, error: "응답 누락" })
      }
    }
  } catch (e) {
    // 일괄 실패 — 모든 ChangeItem failed (raw 응답 첨부 X — 메시지만 마스킹된 상한)
    const msg = e instanceof Error ? e.message : String(e)
    const safeMsg = msg.slice(0, 500)
    await prisma.changeItem.updateMany({
      where: { batchId: batch.id, status: "pending" },
      data: { status: "failed", error: safeMsg },
    })
    success = 0
    failed = total
    results.length = 0
    for (const aid of adIds) {
      results.push({ adId: aid, ok: false, error: safeMsg })
    }
  }

  // -- ChangeBatch finalize ---------------------------------------------------
  const finalStatus: "done" | "failed" = success === 0 ? "failed" : "done"
  await prisma.changeBatch.update({
    where: { id: batch.id },
    data: {
      status: finalStatus,
      processed: total,
      finishedAt: new Date(),
    },
  })

  // -- AuditLog 1건 (요약, 시크릿 X — raw 응답 첨부 X) ------------------------
  await logAudit({
    userId: user.id,
    action,
    targetType: "ChangeBatch",
    targetId: batch.id,
    before: null,
    after: {
      batchId: batch.id,
      advertiserId,
      total,
      success,
      failed,
    },
  })

  revalidatePath(`/${advertiserId}/ads`)

  return { batchId: batch.id, total, success, failed, items: results }
}

// =============================================================================
// 3. deleteAdSingle — 소재 단건 삭제 (F-4.7, admin + 2차 확인)
// =============================================================================
//
// CLAUDE.md "비대상" 정책:
//   - 다중 선택 삭제는 P1 비대상 (OFF로 대체)
//   - 단건 삭제도 admin 권한 + 2차 확인 필수
//
// 흐름 (deleteKeywordSingle 패턴 동일):
//   1. assertRole("admin") — operator/viewer 차단 (AuthorizationError throw)
//   2. getCurrentAdvertiser — 광고주 권한 + hasKeys 검증
//   3. Zod 검증
//   4. 광고주 한정 소재 조회 (campaign.advertiserId join)
//   5. 2차 확인 검증 — 입력 confirmText 가 nccAdId 와 정확 일치
//      (소재는 keyword 같은 사용자 친화 텍스트 식별자 없음 → nccAdId 자체 입력)
//   6. idempotent 처리 — 이미 status='deleted' 면 ChangeBatch 미생성, 정상 반환 + AuditLog
//   7. ChangeBatch 생성 (action='ad.delete', total=1)
//   8. ChangeItem 1건 (idempotencyKey: `${batchId}:delete:${nccAdId}`)
//   9. SA deleteAd 호출
//      - 성공: DB Ad.status='deleted' 업데이트 (row 삭제 X — 감사 추적 보존)
//      - 실패: ChangeItem failed + ChangeBatch failed
//  10. ChangeBatch finalize
//  11. AuditLog (targetType='Ad' — admin 액션은 소재 자체 추적)
//  12. revalidatePath

const deleteAdSchema = z.object({
  adId: z.string().min(1), // 앱 DB Ad.id
  // 2차 확인: 사용자가 입력한 confirmText 가 실제 nccAdId 와 정확 일치해야 함
  // (소재는 keyword 같은 사용자 친화 텍스트가 없음 → nccAdId 전체 입력)
  confirmText: z.string().min(1),
})

export type DeleteAdInput = z.infer<typeof deleteAdSchema>

export type DeleteAdResult =
  | { ok: true; batchId: string; nccAdId: string }
  | { ok: false; error: string }

/**
 * 소재 단건 삭제 (F-4.7).
 *
 * admin 권한 한정 + 2차 확인 (사용자가 nccAdId 재입력) 흐름.
 *
 * @throws AuthorizationError — admin 권한 부족 시 (UI에서 catch)
 * @throws Error("확인 텍스트 불일치") — 2차 확인 실패 (UI에서 catch)
 */
export async function deleteAdSingle(
  advertiserId: string,
  input: DeleteAdInput,
): Promise<DeleteAdResult> {
  // -- 1. admin 권한 강제 (진입부) -------------------------------------------
  await assertRole("admin")

  // -- 2. 광고주 권한 + 객체 -------------------------------------------------
  const { advertiser, user } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    return { ok: false, error: "API 키/시크릿 미입력" }
  }

  // -- 3. Zod 검증 -----------------------------------------------------------
  const parsed = deleteAdSchema.parse(input)

  // -- 4. 광고주 한정 소재 조회 ---------------------------------------------
  // campaign.advertiserId join 으로 광고주 횡단 차단.
  const dbAd = await prisma.ad.findFirst({
    where: {
      id: parsed.adId,
      adgroup: { campaign: { advertiserId } },
    },
    select: {
      id: true,
      nccAdId: true,
      adType: true,
      status: true,
    },
  })
  if (!dbAd) {
    return { ok: false, error: "소재를 찾을 수 없거나 광고주 소속 아님" }
  }

  // -- 5. 2차 확인 검증 ------------------------------------------------------
  // 사용자가 입력한 confirmText 가 nccAdId 와 정확 일치해야 함 (양 끝 trim 비교).
  // UI 가 nccAdId 를 노출하므로 사용자가 보고 정확히 입력 가능.
  if (parsed.confirmText.trim() !== dbAd.nccAdId.trim()) {
    throw new Error("확인 텍스트 불일치")
  }

  // -- 6. idempotent 처리 (이미 deleted) -------------------------------------
  if (dbAd.status === "deleted") {
    await logAudit({
      userId: user.id,
      action: "ad.delete",
      targetType: "Ad",
      targetId: dbAd.nccAdId,
      before: { status: dbAd.status, adType: dbAd.adType },
      after: { status: "deleted", note: "already-deleted (idempotent)" },
    })
    return { ok: true, batchId: "", nccAdId: dbAd.nccAdId }
  }

  // -- 7. ChangeBatch 생성 ---------------------------------------------------
  const action = "ad.delete"
  const batch = await prisma.changeBatch.create({
    data: {
      userId: user.id,
      action,
      status: "running",
      total: 1,
      processed: 0,
      attempt: 1,
      summary: {
        advertiserId,
        nccAdId: dbAd.nccAdId,
        adType: dbAd.adType,
      } as Prisma.InputJsonValue,
    },
  })

  // -- 8. ChangeItem (1건) ---------------------------------------------------
  const idempotencyKey = `${batch.id}:delete:${dbAd.nccAdId}`
  await prisma.changeItem.create({
    data: {
      batchId: batch.id,
      targetType: "Ad",
      targetId: dbAd.nccAdId,
      before: { status: dbAd.status } as Prisma.InputJsonValue,
      after: { status: "deleted" } as Prisma.InputJsonValue,
      idempotencyKey,
      status: "pending",
    },
  })

  // -- 9. SA deleteAd 호출 ---------------------------------------------------
  let success = false
  let errorMsg: string | null = null
  try {
    await deleteAd(advertiser.customerId, dbAd.nccAdId)
    success = true
  } catch (e) {
    // 메시지만 500자 컷. raw 응답 / 시크릿 노출 X.
    const msg = e instanceof Error ? e.message : String(e)
    errorMsg = msg.slice(0, 500)
  }

  if (success) {
    // DB 반영: row 삭제 X — status='deleted' 만 (감사 추적 보존).
    await prisma.ad.update({
      where: { id: dbAd.id },
      data: { status: "deleted" satisfies AdStatus },
    })

    await prisma.changeItem.updateMany({
      where: { batchId: batch.id, idempotencyKey },
      data: { status: "done" },
    })
  } else {
    await prisma.changeItem.updateMany({
      where: { batchId: batch.id, idempotencyKey },
      data: { status: "failed", error: errorMsg ?? "삭제 실패" },
    })
  }

  // -- 10. ChangeBatch finalize ----------------------------------------------
  const finalStatus: "done" | "failed" = success ? "done" : "failed"
  await prisma.changeBatch.update({
    where: { id: batch.id },
    data: {
      status: finalStatus,
      processed: 1,
      finishedAt: new Date(),
    },
  })

  // -- 11. AuditLog (targetType='Ad') ----------------------------------------
  await logAudit({
    userId: user.id,
    action,
    targetType: "Ad",
    targetId: dbAd.nccAdId,
    before: { status: dbAd.status, adType: dbAd.adType },
    after: success
      ? { status: "deleted", batchId: batch.id }
      : { status: dbAd.status, batchId: batch.id, error: errorMsg },
  })

  // -- 12. revalidatePath ----------------------------------------------------
  revalidatePath(`/${advertiserId}/ads`)

  if (!success) {
    return { ok: false, error: errorMsg ?? "삭제 실패" }
  }
  return { ok: true, batchId: batch.id, nccAdId: dbAd.nccAdId }
}

// =============================================================================
// 4. createAdsBatch — 텍스트 소재 일괄 생성 (F-4.6)
// =============================================================================
//
// UI 흐름 (SPEC F-4.6):
//   - 사용자 폼 입력: 광고그룹 + adType + ads 배열 (각 텍스트 소재 본문)
//   - "추가하기" → 단일 Server Action 호출
//   - 폼 화면이 곧 미리보기 (별도 미리보기 단계 X)
//   - 결과 화면에서 성공/실패 분리 노출
//
// 자연키 충돌 정책:
//   - 소재 본문은 자유 JSON (adType 별 fields 구조 상이) → 자연키 정의 어려움
//   - 본 PR 은 자연키 사전 검사 X. externalId 멱등성만으로 1차 방어
//   - 사용자가 동일 소재를 두 번 등록하지 않는다고 가정
//   - 후속 PR: adType 별 자연키 룰 추가 (예: TEXT_45 의 headline + description 조합)
//
// 멱등성:
//   - externalId: 자동 생성 — `add-${crypto.randomUUID()}` (사용자 부담 X)
//   - idempotencyKey: `${batchId}:create:${externalId}` (ChangeItem unique 충족)
//   - DB Ad 모델엔 externalId 컬럼 없음 → ChangeItem 단일 방어

const createAdsSchema = z.object({
  nccAdgroupId: z.string().min(1),
  // adType 은 SA sample 기준 문자열 ("TEXT_45" / "RSA_AD" 등). UI 에서 선택 옵션 제공.
  adType: z.string().min(1),
  // ads 배열: 각 ad 객체는 adType 별 fields 구조 (자유 JSON, 백엔드는 passthrough)
  // ad 필수 — 빈 객체는 SA 가 거부. UI 에서 최소 검증 후 전달.
  ads: z
    .array(
      z.object({
        ad: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1)
    .max(50),
  userLock: z.boolean().default(false),
})

export type CreateAdsBatchInput = z.infer<typeof createAdsSchema>

export type CreateAdsBatchItem = {
  index: number // 입력 ads 배열 0-based 인덱스 (UI 결과 매핑)
  ok: boolean
  nccAdId?: string // 성공 시
  error?: string // 실패 시
}

export type CreateAdsBatchResult = {
  batchId: string
  total: number
  success: number
  failed: number
  items: CreateAdsBatchItem[]
}

/**
 * 텍스트 소재 일괄 생성 Server Action.
 *
 *   1. getCurrentAdvertiser — 권한 검증 + 광고주 객체 (hasKeys 체크)
 *   2. Zod 검증
 *   3. 광고그룹 광고주 한정 검증 (campaign.advertiserId join)
 *   4. ChangeBatch 생성 (status='running', action='ad.create')
 *   5. ChangeItem createMany (입력 순서 보존)
 *      - externalId 자동 생성: `add-${crypto.randomUUID()}` (사용자 부담 X)
 *      - idempotencyKey: `${batch.id}:create:${externalId}`
 *      - targetId: `pending:${externalId}` (응답 매핑 후 nccAdId 로 갱신)
 *   6. SA createAds 호출 (광고그룹 단위 1회 — 단일 nccAdgroupId 가정)
 *   7. 응답 매핑 (createKeywordsBatch 패턴):
 *      - 길이 일치 → 인덱스 매핑 (가장 정확)
 *      - 길이 불일치 → 응답 fallback 매핑 어려움 (소재는 자연키 정의 X)
 *        → 모두 failed 처리 + 사용자에게 매핑 실패 안내
 *   8. DB upsert (nccAdId unique) + ChangeItem 'done'/'failed' 갱신
 *   9. ChangeBatch finalize (success>0 → done, 0 → failed) + finishedAt
 *  10. AuditLog 1건 (요약, 시크릿 X)
 *  11. revalidatePath
 *
 * 안전장치:
 *   - 광고주 횡단 차단: 광고그룹 조회 campaign.advertiserId join
 *   - 시크릿 마스킹: AuditLog after / 콘솔 / throw 메시지에 키 노출 X (메시지만 500자 컷)
 *   - SA 호출 실패 → 모든 ChangeItem failed + batch failed
 */
export async function createAdsBatch(
  advertiserId: string,
  input: CreateAdsBatchInput,
): Promise<CreateAdsBatchResult> {
  const { advertiser, user } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    throw new Error("API 키/시크릿 미입력")
  }

  const parsed = createAdsSchema.parse(input)

  // -- 광고그룹 광고주 한정 검증 (campaign.advertiserId join) -----------------
  const dbAdgroup = await prisma.adGroup.findFirst({
    where: {
      nccAdgroupId: parsed.nccAdgroupId,
      campaign: { advertiserId },
    },
    select: { id: true },
  })
  if (!dbAdgroup) {
    throw new Error("광고그룹이 광고주 소속 아님")
  }

  // -- externalId 자동 생성 ---------------------------------------------------
  // crypto.randomUUID() 로 충분 (cuid 의존성 추가 안 함). `add-${uuid}` prefix.
  const externalIds = parsed.ads.map(() => `add-${crypto.randomUUID()}`)

  // -- ChangeBatch 생성 -------------------------------------------------------
  const action = "ad.create"
  const total = parsed.ads.length

  const batch = await prisma.changeBatch.create({
    data: {
      userId: user.id,
      action,
      status: "running",
      total,
      processed: 0,
      attempt: 1,
      summary: {
        advertiserId,
        nccAdgroupId: parsed.nccAdgroupId,
        adType: parsed.adType,
        count: total,
      } as Prisma.InputJsonValue,
    },
  })

  // -- ChangeItem createMany --------------------------------------------------
  type CreateItemSeed = {
    batchId: string
    targetType: string
    targetId: string
    before: Prisma.InputJsonValue
    after: Prisma.InputJsonValue
    idempotencyKey: string
    status: "pending"
  }

  const seeds: CreateItemSeed[] = parsed.ads.map((entry, i) => ({
    batchId: batch.id,
    targetType: "Ad",
    targetId: `pending:${externalIds[i]}`,
    before: {} as Prisma.InputJsonValue,
    after: {
      adType: parsed.adType,
      ad: entry.ad,
      userLock: parsed.userLock ?? false,
    } as Prisma.InputJsonValue,
    idempotencyKey: `${batch.id}:create:${externalIds[i]}`,
    status: "pending" as const,
  }))

  await prisma.changeItem.createMany({ data: seeds })

  // -- SA createAds 호출 ------------------------------------------------------
  const items: AdCreateItem[] = parsed.ads.map((entry, i) => ({
    adType: parsed.adType,
    ad: entry.ad,
    userLock: parsed.userLock ?? false,
    externalId: externalIds[i],
  }))

  let successTotal = 0
  let failedTotal = 0
  const resultItems: CreateAdsBatchItem[] = []

  try {
    const created = await createAds(
      advertiser.customerId,
      parsed.nccAdgroupId,
      items,
    )

    // 응답 매핑 — 1차: 응답 길이 == 입력 길이 → 인덱스 기반 매핑
    // 소재는 keyword 같은 자연키가 없어 fallback 매핑이 어렵다.
    // 길이 불일치 시 매핑 실패로 모두 failed 처리.
    const indexMatch = created.length === items.length

    for (let idx = 0; idx < parsed.ads.length; idx++) {
      const externalId = externalIds[idx]
      const u: SaAd | undefined = indexMatch ? created[idx] : undefined

      if (u) {
        // ChangeItem.targetId 갱신 (pending → 실제 nccAdId) + status='done'
        await prisma.changeItem.updateMany({
          where: {
            batchId: batch.id,
            idempotencyKey: `${batch.id}:create:${externalId}`,
          },
          data: { targetId: u.nccAdId, status: "done" },
        })

        // DB upsert (nccAdId unique)
        const adTypeVal =
          typeof u.adType === "string" && u.adType.length > 0
            ? u.adType
            : parsed.adType
        const fieldsVal =
          u.ad && typeof u.ad === "object"
            ? (u.ad as unknown as Prisma.InputJsonValue)
            : (parsed.ads[idx].ad as unknown as Prisma.InputJsonValue)
        const inspectMemoVal =
          typeof u.inspectMemo === "string" && u.inspectMemo.length > 0
            ? u.inspectMemo
            : null

        const rawJson = u as unknown as Prisma.InputJsonValue

        // create 시 fields 는 항상 존재 (입력 ad 또는 응답 ad fallback) — nullable 처리 불필요.
        // inspectMemo 는 응답에 있을 때만 — null 이면 키 제외 (Prisma Optional String update 타입 호환).
        const createData: {
          adgroupId: string
          nccAdId: string
          adType: string
          fields: Prisma.InputJsonValue
          inspectStatus: InspectStatus
          status: AdStatus
          raw: Prisma.InputJsonValue
          inspectMemo?: string
        } = {
          adgroupId: dbAdgroup.id,
          nccAdId: u.nccAdId,
          adType: adTypeVal,
          fields: fieldsVal,
          inspectStatus: mapAdInspectStatus(u),
          status: mapAdStatus(u),
          raw: rawJson,
        }
        if (inspectMemoVal !== null) createData.inspectMemo = inspectMemoVal

        const updateData: {
          adgroupId: string
          adType: string
          fields: Prisma.InputJsonValue
          inspectStatus: InspectStatus
          status: AdStatus
          raw: Prisma.InputJsonValue
          inspectMemo?: string
        } = {
          adgroupId: dbAdgroup.id,
          adType: adTypeVal,
          fields: fieldsVal,
          inspectStatus: mapAdInspectStatus(u),
          status: mapAdStatus(u),
          raw: rawJson,
        }
        if (inspectMemoVal !== null) updateData.inspectMemo = inspectMemoVal

        await prisma.ad.upsert({
          where: { nccAdId: u.nccAdId },
          create: createData,
          update: updateData,
        })

        resultItems.push({ index: idx, ok: true, nccAdId: u.nccAdId })
        successTotal++
      } else {
        const errMsg = indexMatch
          ? "응답에 누락"
          : `응답 매핑 실패 (응답 길이=${created.length}, 입력=${items.length})`
        await prisma.changeItem.updateMany({
          where: {
            batchId: batch.id,
            idempotencyKey: `${batch.id}:create:${externalId}`,
          },
          data: { status: "failed", error: errMsg },
        })
        resultItems.push({ index: idx, ok: false, error: errMsg })
        failedTotal++
      }
    }
  } catch (e) {
    // SA 호출 자체 실패 — 모든 ChangeItem failed (메시지만 500자 컷)
    const msg = e instanceof Error ? e.message : String(e)
    const safeMsg = msg.slice(0, 500)
    await prisma.changeItem.updateMany({
      where: { batchId: batch.id },
      data: { status: "failed", error: safeMsg },
    })
    successTotal = 0
    failedTotal = total
    resultItems.length = 0
    for (let idx = 0; idx < parsed.ads.length; idx++) {
      resultItems.push({ index: idx, ok: false, error: safeMsg })
    }
  }

  // -- ChangeBatch finalize ---------------------------------------------------
  const finalStatus: "done" | "failed" = successTotal === 0 ? "failed" : "done"
  await prisma.changeBatch.update({
    where: { id: batch.id },
    data: {
      status: finalStatus,
      processed: total,
      finishedAt: new Date(),
    },
  })

  // -- AuditLog 1건 (시크릿 X — raw 응답 첨부 X) -----------------------------
  await logAudit({
    userId: user.id,
    action,
    targetType: "ChangeBatch",
    targetId: batch.id,
    before: null,
    after: {
      advertiserId,
      nccAdgroupId: parsed.nccAdgroupId,
      adType: parsed.adType,
      total,
      success: successTotal,
      failed: failedTotal,
    },
  })

  revalidatePath(`/${advertiserId}/ads`)

  return {
    batchId: batch.id,
    total,
    success: successTotal,
    failed: failedTotal,
    items: resultItems,
  }
}
