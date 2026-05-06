"use server"

/**
 * F-3.1 / F-3.2 — 키워드 동기화 + 인라인 편집 (Server Actions)
 *
 * 책임:
 *   1. syncKeywords        — 광고주의 모든 광고그룹을 순회하며 NAVER SA listKeywords → DB upsert (F-3.1)
 *   2. bulkUpdateKeywords  — 인라인 편집 staging 누적분의 일괄 적용 (F-3.2)
 *
 * 본 PR 범위 X (별도 ID로 분리):
 *   - F-3.3 다중 선택 일괄 액션 (toggle/bid/useGroupBidAmt 등 — Action 단위 단순 형태)
 *   - F-3.4 / F-3.5 CSV 내보내기/가져오기
 *   - F-3.6 키워드 생성
 *   - F-3.7 단건 삭제 (admin + 2차 확인)
 *
 * 운영 정책 (CLAUDE.md / backend-engineer.md):
 *   - 진입부 getCurrentAdvertiser(advertiserId) — admin / 화이트리스트 검증 + 광고주 객체
 *   - prisma 쿼리는 항상 `where: { adgroup: { campaign: { advertiserId } } }` 한정
 *     (Keyword → AdGroup → Campaign → advertiserId join 으로 광고주 횡단 차단)
 *   - 본 액션은 "조회 → 적재" 만 — 외부 변경 X → ChangeBatch 미사용
 *   - SA API 호출용 customerId 와 앱 내부 advertiserId 는 분리
 *   - AuditLog 1건 (시크릿 X — Keyword 응답엔 키 없음)
 *   - revalidatePath(`/${advertiserId}/keywords`)
 *
 * 동기화 호출 패턴 (keywords 모듈 특성):
 *   - 네이버 SA 키워드 목록은 **광고그룹 단위** 만 제공 (광고주 전체 일괄 조회 엔드포인트 없음).
 *   - 따라서 광고그룹 N개 → listKeywords N번 호출.
 *   - Rate Limit 토큰 버킷이 광고주별 큐잉(client.ts) → 동일 광고주 내 순차 처리 자동.
 *
 * 시간 한계 (TODO):
 *   - P1 전제: 광고그룹 50~200개. 5천 키워드 동기화 = 200회 호출.
 *   - 본 PR은 단순 동기 처리 (Vercel 함수 시간 한계 내 처리 가정).
 *   - 한계 부딪히면 ChangeBatch + Chunk Executor 패턴(SPEC 3.5) 으로 이관 권고.
 *   - 우선 timeout 가드 없이 진행 — 운영 데이터로 한계 측정 후 후속 PR.
 *
 * 스키마 매핑 메모 (캠페인/광고그룹과 동일 패턴):
 *   - 앱 DB Keyword.status: KeywordStatus enum (on/off/deleted)
 *   - 앱 DB Keyword.inspectStatus: InspectStatus enum (pending/approved/rejected)
 *   - SA 응답: userLock(boolean) + status(string) + inspectStatus(string)
 *   - userLock=true → off, status='DELETED' → deleted, status='PAUSED' → off, else on
 *   - inspectStatus 응답 문자열은 다양 → 추정 안 되면 'pending' 폴백 + raw 보존
 *   - matchType / recentAvgRnk 는 응답에 있을 때만 update (없으면 기존값 유지)
 */

import { revalidatePath } from "next/cache"
import Papa from "papaparse"
import { z } from "zod"

import { prisma } from "@/lib/db/prisma"
import { getCurrentAdvertiser, assertRole } from "@/lib/auth/access"
import { logAudit } from "@/lib/audit/log"
import { recordSyncAt } from "@/lib/sync/last-sync-at"
import {
  getAdgroupChunkSize,
  logSyncTiming,
  mapWithConcurrency,
  UPSERT_CONCURRENCY,
} from "@/lib/sync/concurrency"
import {
  createKeywords,
  deleteKeyword,
  listKeywords,
  updateKeywordsBulk,
  type Keyword as SaKeyword,
  type KeywordBulkUpdateItem,
  type KeywordCreateItem,
} from "@/lib/naver-sa/keywords"
import { NaverSaError } from "@/lib/naver-sa/errors"
import { getStatsChunked } from "@/lib/naver-sa/stats"
import type { AdMetrics, AdsPeriod } from "@/lib/dashboard/metrics"
import type {
  KeywordStatus,
  InspectStatus,
} from "@/lib/generated/prisma/client"
import type * as Prisma from "@/lib/generated/prisma/internal/prismaNamespace"

// =============================================================================
// 1. syncKeywords — NAVER → DB upsert
// =============================================================================

export type SyncKeywordsResult =
  | {
      ok: true
      syncedKeywords: number
      scannedAdgroups: number
      skipped: number
      durationMs: number
    }
  | { ok: false; error: string }

/**
 * `syncKeywords` 옵션 — 두 번째 인자.
 *
 * - `campaignIds` : 광고그룹 query 시 캠페인 화이트리스트(앱 DB Campaign.id). 미지정 시 광고주 전체.
 *                   UI에서 "선택한 캠페인만 동기화" 시 사용 (extensions 패턴 동일).
 *
 * SA `listKeywords` 는 광고그룹 단위 호출. → 광고그룹 query 단계에서 캠페인 필터 적용.
 */
export type SyncKeywordsOptions = {
  campaignIds?: string[]
}

/**
 * 키워드 동기화 (광고주 단위 — 모든 광고그룹 순회).
 *
 *   1. getCurrentAdvertiser — 권한 검증 + 광고주 객체
 *   2. hasKeys 확인 (시크릿 미입력이면 즉시 차단)
 *   3. DB AdGroup 매핑 테이블 구성 (nccAdgroupId → AdGroup.id)
 *      - 광고주 한정 (campaign.advertiserId join). 캠페인/광고그룹 사전 동기화 필요.
 *   4. 광고그룹 마다 listKeywords(customerId, { nccAdgroupId }) 순차 호출
 *      - Rate Limit 토큰 버킷이 광고주별로 큐잉 (client.ts) → 별도 throttle 불필요
 *      - 단일 광고그룹 호출 실패는 부분 실패로 처리 (다른 광고그룹은 계속)
 *   5. 각 row upsert (nccKeywordId unique)
 *      - adgroupIdMap 누락 시 skip + skippedCount (광고그룹 미동기화 또는 삭제됨)
 *      - matchType / recentAvgRnk 는 응답에 있을 때만 update
 *   6. AuditLog 1건 (요약, 시크릿 X)
 *
 * 본 액션은 "조회 → 적재" 만 — 외부 변경 X → ChangeBatch 미사용 (정책상 OK).
 *
 * 시간 한계 (BACKLOG: 동기화 시간 한계 / 1차 개선):
 *   - maxDuration=300s + 광고그룹 chunk N(env SYNC_ADGROUP_CHUNK_SIZE, 기본 5) 병렬 list
 *     + chunk 내부 keyword upsert 10 병렬화 (UPSERT_CONCURRENCY).
 *   - 종료 시 logSyncTiming 으로 totalMs 출력 — totalMs > maxDuration*0.8 (240s) 지속 발생 시
 *     ChangeBatch + Chunk Executor (SPEC 3.5) 이관 트리거.
 */
export async function syncKeywords(
  advertiserId: string,
  options: SyncKeywordsOptions = {},
): Promise<SyncKeywordsResult> {
  const { advertiser, user } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    return { ok: false, error: "API 키/시크릿 미입력" }
  }

  const { campaignIds } = options
  const hasCampaignFilter =
    Array.isArray(campaignIds) && campaignIds.length > 0

  const start = Date.now()

  // -- DB 광고그룹 매핑 테이블 (광고주 한정 + 선택한 캠페인 한정) ---------------
  // 응답의 nccAdgroupId → DB AdGroup.id 룩업용. Keyword.adgroupId 는 AdGroup.id (cuid).
  // campaignIds 미지정 → 광고주 전체 광고그룹. 지정 → 화이트리스트 캠페인 산하 광고그룹만.
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
    // 광고그룹이 없으면 동기화할 키워드도 없음. 정상 종료.
    await logAudit({
      userId: user.id,
      action: "keyword.sync",
      targetType: "Advertiser",
      targetId: advertiserId,
      before: null,
      after: {
        syncedKeywords: 0,
        scannedAdgroups: 0,
        skipped: 0,
        customerId: advertiser.customerId,
        campaignIds: hasCampaignFilter ? campaignIds : undefined,
        note: "no-adgroups",
      },
    })
    // lastSyncAt 갱신 — 광고그룹 0개도 "동기화 시도 완료" 로 기록 (UI 표시 일관성).
    // 캠페인 필터로 부분 동기화한 경우에도 갱신 — "동기화했는데 표시 안 됨" 혼란 방지.
    await recordSyncAt(advertiserId, "keywords")
    revalidatePath(`/${advertiserId}/keywords`)
    return {
      ok: true,
      syncedKeywords: 0,
      scannedAdgroups: 0,
      skipped: 0,
      durationMs: Date.now() - start,
    }
  }

  const adgroupIdMap = new Map<string, string>(
    adgroups.map((g) => [g.nccAdgroupId, g.id]),
  )

  // -- 광고그룹 단위 listKeywords 반복 ----------------------------------------
  // SA 키워드 조회는 광고그룹 단위만 제공. 광고그룹 N개 → 호출 N번.
  // 부분 실패 허용 (Promise.allSettled): 단일 광고그룹 실패는 다른 광고그룹 동기화에 영향 X.
  //
  // 성능 1차 개선 (BACKLOG: 동기화 시간 한계):
  //   - 광고그룹 chunk N(env SYNC_ADGROUP_CHUNK_SIZE, 기본 5) 병렬 listKeywords (Rate Limit
  //     토큰 버킷이 광고주별 큐잉 → 자동 wait).
  //   - chunk 결과 도착 즉시 keyword upsert 도 UPSERT_CONCURRENCY=10 병렬화
  //     (Supabase pool 안전선 내) — 5천 행 sequential ~150s → 병렬 ~15s 약 10배 단축.
  let syncedKeywords = 0
  let skipped = 0
  let scannedAdgroups = 0

  const CHUNK_SIZE = getAdgroupChunkSize()

  try {
    for (let i = 0; i < adgroups.length; i += CHUNK_SIZE) {
      const slice = adgroups.slice(i, i + CHUNK_SIZE)
      const settled = await Promise.allSettled(
        slice.map((ag) =>
          listKeywords(advertiser.customerId, { nccAdgroupId: ag.nccAdgroupId }),
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
              `[syncKeywords] listKeywords failed for nccAdgroupId=${ag.nccAdgroupId}: ${e.message}`,
            )
          } else {
            console.warn(
              `[syncKeywords] listKeywords unknown error for nccAdgroupId=${ag.nccAdgroupId}:`,
              e,
            )
          }
          scannedAdgroups++
          continue
        }
        const remote: SaKeyword[] = r.value

        // -- upsert 병렬 (UPSERT_CONCURRENCY) -------------------------------
        // chunk 내부의 keyword 목록을 동시 N개씩 upsert. parent 광고그룹 미존재 행은 skip.
        // 결과 합산은 worker 외부에서 (closure 변수 race 회피 — mapWithConcurrency 가
        // results 배열 반환).
        const upsertResults = await mapWithConcurrency(
          remote,
          UPSERT_CONCURRENCY,
          async (k): Promise<"ok" | "skip"> => {
            const dbAdgroupId = adgroupIdMap.get(k.nccAdgroupId)
            if (!dbAdgroupId) {
              console.warn(
                `[syncKeywords] skip nccKeywordId=${k.nccKeywordId}: ` +
                  `parent nccAdgroupId=${k.nccAdgroupId} not found in DB`,
              )
              return "skip"
            }

            const mappedStatus = mapKeywordStatus(k)
            const mappedInspect = mapInspectStatus(k)
            const bidAmtVal = typeof k.bidAmt === "number" ? k.bidAmt : null
            const useGroupBidAmtVal =
              typeof k.useGroupBidAmt === "boolean" ? k.useGroupBidAmt : true
            const userLockVal =
              typeof k.userLock === "boolean" ? k.userLock : false

            // matchType / recentAvgRnk 는 응답에 있을 때만 반영 (없으면 기존값 유지).
            // KeywordSchema 는 passthrough 라 정의 외 필드는 그대로 통과 (any cast 안전).
            const anyK = k as unknown as {
              matchType?: string
              recentAvgRnk?: number | string | null
            }
            const matchTypeVal =
              typeof anyK.matchType === "string" && anyK.matchType.length > 0
                ? anyK.matchType.toUpperCase()
                : null

            const rawJson = k as unknown as Prisma.InputJsonValue

            // upsert: matchType / recentAvgRnk 는 update 시점엔 값이 있을 때만 덮어쓰기.
            // create 시에는 응답에 없으면 null 로 둠 (P1 표시 OK).
            const baseCreateData = {
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

            // update 페이로드: 응답에 없는 필드(matchType)는 빼서 기존값 유지.
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

            await prisma.keyword.upsert({
              where: { nccKeywordId: k.nccKeywordId },
              create: baseCreateData,
              update: baseUpdateData,
            })
            return "ok"
          },
        )

        for (const r of upsertResults) {
          if (r === "ok") syncedKeywords++
          else skipped++
        }

        scannedAdgroups++
      }
    }
  } catch (e) {
    // upsert 단계 자체 실패 (DB 연결 등 치명 오류).
    console.error("[syncKeywords] upsert failed:", e)
    return { ok: false, error: "DB 적재 중 오류" }
  }

  await logAudit({
    userId: user.id,
    action: "keyword.sync",
    targetType: "Advertiser",
    targetId: advertiserId,
    before: null,
    after: {
      syncedKeywords,
      scannedAdgroups,
      skipped,
      customerId: advertiser.customerId,
      campaignIds: hasCampaignFilter ? campaignIds : undefined,
    },
  })

  // lastSyncAt 갱신 (UI 헤더 "마지막 동기화" 배지). 실패해도 sync 결과는 정상 반환.
  // 캠페인 필터로 부분 동기화한 경우에도 갱신 — "동기화했는데 표시 안 됨" 혼란 방지.
  await recordSyncAt(advertiserId, "keywords")

  revalidatePath(`/${advertiserId}/keywords`)

  const totalMs = Date.now() - start
  // 운영 측정 데이터 — totalMs > maxDuration*0.8 시 trigger 표시.
  // maxDuration = 300s (Server Action 진입 page.tsx 설정).
  logSyncTiming({
    kind: "keywords",
    advertiserId,
    totalMs,
    scannedAdgroups,
    upserts: syncedKeywords,
    maxDurationMs: 300_000,
  })

  return {
    ok: true,
    syncedKeywords,
    scannedAdgroups,
    skipped,
    durationMs: totalMs,
  }
}

// =============================================================================
// 2. bulkUpdateKeywords — 인라인 편집 staging 일괄 적용 (F-3.2)
// =============================================================================
//
// UI 흐름 (CLAUDE.md / SPEC F-3.2):
//   - 사용자가 셀 편집(bidAmt / useGroupBidAmt / userLock) → 클라이언트 staging 누적
//   - "변경 검토" 모달 → 미리보기 → 확정
//   - 확정 시 staging 의 patch 배열을 그대로 본 액션에 전달 (단일 action 호출)
//
// 다중 선택 일괄 액션(F-3.3) 과의 차이:
//   - F-3.3 은 action 단위(toggle/bid/...) — 모든 row 동일 필드 변경
//   - F-3.2 는 row 마다 변경 필드 조합이 다름 (한 행은 bidAmt, 다른 행은 userLock 등)
//   - SA `?fields=` 쿼리는 단일 호출에 union 으로 명시 (예: "bidAmt,userLock")
//   - update 시 patch 에 명시되지 않은 필드는 SA 가 변경하지 않음 (fields 누락 효과)

const bulkUpdateKeywordsSchema = z.object({
  items: z
    .array(
      z
        .object({
          keywordId: z.string().min(1), // 앱 DB Keyword.id
          bidAmt: z.number().int().min(0).nullable().optional(),
          useGroupBidAmt: z.boolean().optional(),
          userLock: z.boolean().optional(),
        })
        // 각 item 에 patch 필드 최소 1개 — 빈 변경 항목 차단
        .refine(
          (v) =>
            v.bidAmt !== undefined ||
            v.useGroupBidAmt !== undefined ||
            v.userLock !== undefined,
          {
            message:
              "bidAmt / useGroupBidAmt / userLock 중 최소 하나의 필드 필요",
          },
        ),
    )
    .min(1)
    .max(500),
})

export type BulkUpdateKeywordsInput = z.infer<typeof bulkUpdateKeywordsSchema>

export type BulkUpdateKeywordItemResult = {
  keywordId: string
  ok: boolean
  error?: string
}

export type BulkUpdateKeywordsResult = {
  batchId: string
  total: number
  success: number
  failed: number
  items: BulkUpdateKeywordItemResult[]
}

type DbKeywordSnapshot = {
  id: string
  nccKeywordId: string
  keyword: string
  bidAmt: number | null
  useGroupBidAmt: boolean
  userLock: boolean
  status: KeywordStatus
}

/** 단건 staging patch — schema 와 동일하나 keywordId 제외(맵 값으로 사용). */
type KeywordPatch = {
  bidAmt?: number | null
  useGroupBidAmt?: boolean
  userLock?: boolean
}

/**
 * 인라인 편집 staging 일괄 적용.
 *
 *   1. getCurrentAdvertiser — 권한 검증 + 광고주 객체
 *   2. Zod 검증 (items 배열 / 각 item 에 patch 필드 최소 1개)
 *   3. keywordId 중복은 마지막 항목으로 dedup (idempotencyKey unique 충족)
 *   4. 대상 키워드 광고주 한정 조회 (adgroup.campaign.advertiserId join)
 *   5. ChangeBatch (status='running') 생성 + ChangeItem 일괄 생성
 *      - before/after 는 patch 에 등장한 필드만 기록 (변경 안 한 컬럼은 비교 대상 X)
 *      - idempotencyKey = `${batchId}:${nccKeywordId}` (ChangeItem unique 제약 충족)
 *   6. fields 쿼리 union 산출 (items 전체에서 등장한 필드의 합집합)
 *   7. updateKeywordsBulk(customerId, items, fields) — 단일 PUT
 *   8. 응답 매핑: 성공 → DB update + ChangeItem='done'. 누락/예외 → 'failed'
 *      - patch 에 없는 필드는 DB update 에서도 빼서 기존값 유지
 *   9. ChangeBatch finalize (success>0 → done, 0 → failed) + finishedAt
 *  10. AuditLog 1건 (요약, 시크릿 X — raw 응답 통째 첨부 금지)
 *  11. revalidatePath
 *
 * 반환: UI 가 keywordId → row.nccKeywordId 매핑하여 BulkActionResult 형태로 변환.
 */
export async function bulkUpdateKeywords(
  advertiserId: string,
  input: BulkUpdateKeywordsInput,
): Promise<BulkUpdateKeywordsResult> {
  const { advertiser, user } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    throw new Error("API 키/시크릿 미입력")
  }

  const parsed = bulkUpdateKeywordsSchema.parse(input)

  // -- 입력 정규화: keywordId 중복은 마지막 항목으로 대체 ---------------------
  // (idempotencyKey unique 제약 충돌 방지 — F-2.2 광고그룹 패턴과 동일)
  const patchByKeywordId = new Map<string, KeywordPatch>()
  for (const it of parsed.items) {
    const patch: KeywordPatch = {}
    if (it.bidAmt !== undefined) patch.bidAmt = it.bidAmt
    if (it.useGroupBidAmt !== undefined) patch.useGroupBidAmt = it.useGroupBidAmt
    if (it.userLock !== undefined) patch.userLock = it.userLock
    patchByKeywordId.set(it.keywordId, patch)
  }
  const keywordIds = Array.from(patchByKeywordId.keys())

  // -- 대상 키워드 광고주 한정 조회 (adgroup → campaign → advertiserId join) --
  const dbKeywords = await prisma.keyword.findMany({
    where: {
      adgroup: { campaign: { advertiserId } }, // 광고주 횡단 차단
      id: { in: keywordIds },
    },
    select: {
      id: true,
      nccKeywordId: true,
      keyword: true,
      bidAmt: true,
      useGroupBidAmt: true,
      userLock: true,
      status: true,
    },
  })

  if (dbKeywords.length !== keywordIds.length) {
    throw new Error("일부 키워드가 광고주 소속이 아닙니다")
  }

  const beforeMap = new Map<string, DbKeywordSnapshot>(
    dbKeywords.map((k) => [
      k.id,
      {
        id: k.id,
        nccKeywordId: k.nccKeywordId,
        keyword: k.keyword,
        bidAmt: k.bidAmt === null ? null : Number(k.bidAmt),
        useGroupBidAmt: k.useGroupBidAmt,
        userLock: k.userLock,
        status: k.status,
      },
    ]),
  )

  // -- ChangeBatch 생성 -------------------------------------------------------
  const action = "keyword.inline_update"
  const total = keywordIds.length

  const batch = await prisma.changeBatch.create({
    data: {
      userId: user.id,
      action,
      status: "running",
      total,
      processed: 0,
      attempt: 1,
      summary: { advertiserId, action, total },
    },
  })

  // -- SA API 호출용 payload + ChangeItem before/after ------------------------
  // before/after 는 patch 에 등장한 필드만 기록 (변경 안 한 필드는 의미 없으므로 제외).
  // 이 약속은 추후 F-6.4 롤백에서도 동일하게 활용된다.
  const itemsForApi: KeywordBulkUpdateItem[] = []
  const fieldUnion = new Set<"bidAmt" | "useGroupBidAmt" | "userLock">()

  type ChangeItemSeed = {
    batchId: string
    targetType: string
    targetId: string
    before: Prisma.InputJsonValue
    after: Prisma.InputJsonValue
    idempotencyKey: string
    status: "pending"
  }
  const changeItemData: ChangeItemSeed[] = keywordIds.map((kid) => {
    const dbK = beforeMap.get(kid)!
    const patch = patchByKeywordId.get(kid)!

    const beforeObj: Record<string, unknown> = {}
    const afterObj: Record<string, unknown> = {}

    if (patch.bidAmt !== undefined) {
      beforeObj.bidAmt = dbK.bidAmt
      afterObj.bidAmt = patch.bidAmt
      fieldUnion.add("bidAmt")
    }
    if (patch.useGroupBidAmt !== undefined) {
      beforeObj.useGroupBidAmt = dbK.useGroupBidAmt
      afterObj.useGroupBidAmt = patch.useGroupBidAmt
      fieldUnion.add("useGroupBidAmt")
    }
    if (patch.userLock !== undefined) {
      beforeObj.userLock = dbK.userLock
      afterObj.userLock = patch.userLock
      fieldUnion.add("userLock")
    }

    // SA API 호출 payload — patch 에 등장한 필드만 (fields 쿼리와 일치).
    // 키워드 단위에서 변경 안 하는 필드를 SA item 에 넣지 않는 이유:
    //   네이버 SA 의 `?fields=` 가 union 이라 이 row 에는 영향 없는 필드여도
    //   payload 에 같이 들어가 있으면 응답에 반영될 수 있다 (sample 별 차이 존재).
    //   안전하게 row 마다 자기가 변경하는 필드만 보낸다.
    const apiItem: KeywordBulkUpdateItem = { nccKeywordId: dbK.nccKeywordId }
    if (patch.bidAmt !== undefined) apiItem.bidAmt = patch.bidAmt
    if (patch.useGroupBidAmt !== undefined)
      apiItem.useGroupBidAmt = patch.useGroupBidAmt
    if (patch.userLock !== undefined) apiItem.userLock = patch.userLock
    itemsForApi.push(apiItem)

    return {
      batchId: batch.id,
      targetType: "Keyword",
      targetId: dbK.nccKeywordId,
      before: beforeObj as Prisma.InputJsonValue,
      after: afterObj as Prisma.InputJsonValue,
      idempotencyKey: `${batch.id}:${dbK.nccKeywordId}`,
      status: "pending",
    }
  })

  await prisma.changeItem.createMany({ data: changeItemData })

  // -- fields 쿼리 산출 (items 전체에서 등장한 필드의 union) ------------------
  // 빈 fields 는 schema refine 단계에서 차단되지만 안전망으로 한 번 더 검사.
  if (fieldUnion.size === 0) {
    await prisma.changeItem.updateMany({
      where: { batchId: batch.id },
      data: { status: "failed", error: "변경 필드 없음" },
    })
    await prisma.changeBatch.update({
      where: { id: batch.id },
      data: { status: "failed", processed: total, finishedAt: new Date() },
    })
    throw new Error("변경 필드 없음")
  }
  const fields = Array.from(fieldUnion).join(",")

  // -- SA API 호출 ------------------------------------------------------------
  let success = 0
  let failed = 0
  const results: BulkUpdateKeywordItemResult[] = []

  try {
    const updated = await updateKeywordsBulk(
      advertiser.customerId,
      itemsForApi,
      fields,
    )
    const updatedMap = new Map(updated.map((k) => [k.nccKeywordId, k]))

    for (const kid of keywordIds) {
      const dbK = beforeMap.get(kid)!
      const patch = patchByKeywordId.get(kid)!
      const u = updatedMap.get(dbK.nccKeywordId)

      if (u) {
        // DB 반영 — patch 에 등장한 필드만 update (나머지는 기존값 유지).
        // status 는 userLock 이 patch 에 있으면 응답 기반으로 재계산.
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
          // userLock 변경 시 status 재계산 (mapKeywordStatus 재사용 — userLock + status 종합)
          updateData.status = mapKeywordStatus(u)
        }

        await prisma.keyword.update({
          where: { id: dbK.id },
          data: updateData,
        })
        await prisma.changeItem.updateMany({
          where: { batchId: batch.id, targetId: dbK.nccKeywordId },
          data: { status: "done" },
        })
        success++
        results.push({ keywordId: kid, ok: true })
      } else {
        await prisma.changeItem.updateMany({
          where: { batchId: batch.id, targetId: dbK.nccKeywordId },
          data: { status: "failed", error: "응답에 누락" },
        })
        failed++
        results.push({ keywordId: kid, ok: false, error: "응답 누락" })
      }
    }
  } catch (e) {
    // 일괄 실패 — 모든 ChangeItem failed (raw 응답 통째 첨부 X — 메시지만 마스킹된 형태로)
    const msg = e instanceof Error ? e.message : String(e)
    const safeMsg = msg.slice(0, 500)
    await prisma.changeItem.updateMany({
      where: { batchId: batch.id },
      data: { status: "failed", error: safeMsg },
    })
    failed = total
    success = 0
    results.length = 0
    for (const kid of keywordIds) {
      results.push({ keywordId: kid, ok: false, error: safeMsg })
    }
  }

  // -- ChangeBatch finalize ---------------------------------------------------
  // success > 0 이면 done (부분 성공도 done — 실패 항목은 ChangeItem 에 기록).
  const finalStatus: "done" | "failed" = success === 0 ? "failed" : "done"

  await prisma.changeBatch.update({
    where: { id: batch.id },
    data: {
      status: finalStatus,
      processed: total,
      finishedAt: new Date(),
    },
  })

  // -- AuditLog 1건 (요약, 시크릿 X — raw 응답 첨부 금지) ---------------------
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

  revalidatePath(`/${advertiserId}/keywords`)

  return { batchId: batch.id, total, success, failed, items: results }
}

// =============================================================================
// helpers
// =============================================================================

/**
 * 네이버 SA Keyword → 앱 KeywordStatus enum 매핑.
 *
 * 매핑 정책 (campaigns/adgroups 와 동일 패턴):
 *   - status='DELETED' (또는 deleted=true)        → 'deleted'
 *   - userLock=true                               → 'off' (사용자가 OFF)
 *   - status='PAUSED'                             → 'off'
 *   - 그 외 (ELIGIBLE / 그 외)                    → 'on'
 *
 * 참고: SA 응답엔 `userLock`(boolean) 과 `status`(string) 가 모두 존재.
 *       ON/OFF 토글은 일반적으로 userLock 으로 다룸 → userLock=true 는 즉시 'off'.
 */
function mapKeywordStatus(k: SaKeyword): KeywordStatus {
  // SA 응답 형태가 모듈마다 다를 수 있으므로 안전하게 union 검사.
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
 * 앱 enum (prisma/schema.prisma):
 *   - pending / approved / rejected
 *
 * SA 응답 문자열은 정확한 코드가 sample 마다 차이 (UNDER_REVIEW / APPROVED / REJECTED 등).
 * 안전 매핑:
 *   - APPROVED / PASSED / OK / ELIGIBLE   → approved
 *   - REJECTED / FAILED / DENIED          → rejected
 *   - 그 외 (UNDER_REVIEW / 미정 / 누락)  → pending
 *
 * 추정 안 되면 'pending' 폴백 + raw 보존 (정확한 코드는 운영 sample 확인 후 후속 PR로 보강).
 */
function mapInspectStatus(k: SaKeyword): InspectStatus {
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

// =============================================================================
// 3. bulkActionKeywords — 다중 선택 일괄 액션 (F-3.3)
// =============================================================================
//
// UI 흐름 (CLAUDE.md / SPEC F-3.3):
//   - 사용자가 키워드 row 다중 선택 → 액션 모달(toggle ON/OFF, bid 변경) 선택
//   - 미리보기(previewBulkAction)로 baseline + 산출값 확인 → 확정 시 본 액션 호출
//   - F-3.2 (인라인 편집 staging) 과 분리된 즉시 흐름. row 마다 patch 가 다른 게 아니라
//     "선택된 모든 row 에 동일 액션 적용" 형태라 action 단위 discriminated union 사용.
//
// 액션 3종:
//   - toggle:        userLock 일괄 적용 (true=OFF, false=ON)
//   - bid absolute:  bidAmt 동일 절대값 + useGroupBidAmt=false 강제
//   - bid ratio:     각 row baseline 재조회 + (1+percent/100) 계산 (옵션 B — 서버에서 계산)
//                    baseline 우선순위:
//                      1) keyword.bidAmt 가 number
//                      2) useGroupBidAmt=true 면 광고그룹 bidAmt
//                      3) 둘 다 null → 해당 row 사전 'failed' (다른 row 는 정상 진행)
//                    산출값 = round(baseline * (1+percent/100) / roundTo) * roundTo, 0 클램프
//
// TODO(5천 건 한계): 본 PR 은 단일 PUT 시도. updateKeywordsBulk 의 SA 응답 한계가 부딪히면
//   batch-executor-job 패턴 (Job Table + Cron + Chunk Executor) 으로 이관.

const bulkActionKeywordsSchema = z.discriminatedUnion("action", [
  // ON/OFF 토글 (userLock)
  z.object({
    action: z.literal("toggle"),
    items: z
      .array(
        z.object({
          keywordId: z.string().min(1), // 앱 DB Keyword.id
          // userLock=true → OFF, false → ON
          userLock: z.boolean(),
        }),
      )
      .min(1)
      .max(500),
  }),
  // 입찰가 절대값
  z.object({
    action: z.literal("bid"),
    mode: z.literal("absolute"),
    bidAmt: z.number().int().min(0),
    keywordIds: z.array(z.string().min(1)).min(1).max(500),
  }),
  // 입찰가 비율 (-90% ~ +900%)
  z.object({
    action: z.literal("bid"),
    mode: z.literal("ratio"),
    percent: z.number().min(-90).max(900),
    roundTo: z.number().int().min(1).default(10),
    keywordIds: z.array(z.string().min(1)).min(1).max(500),
  }),
])

export type BulkActionKeywordsInput = z.infer<typeof bulkActionKeywordsSchema>

export type BulkActionKeywordItemResult = {
  keywordId: string
  ok: boolean
  error?: string
}

export type BulkActionKeywordsResult = {
  batchId: string
  total: number
  success: number
  failed: number
  items: BulkActionKeywordItemResult[]
}

/**
 * 미리보기 / 확정 흐름에서 공통으로 쓰이는 row baseline 스냅샷.
 * adgroup.bidAmt 는 ratio 모드에서 keyword.bidAmt null + useGroupBidAmt=true 시 폴백.
 */
type DbKeywordWithAdgroupSnapshot = {
  id: string
  nccKeywordId: string
  keyword: string
  bidAmt: number | null
  useGroupBidAmt: boolean
  userLock: boolean
  status: KeywordStatus
  adgroupName: string
  adgroupBidAmt: number | null
}

/**
 * 광고주 한정 + id IN(...) 으로 키워드 + 광고그룹(name, bidAmt) 조회.
 * keywordIds 는 호출 측에서 dedup 후 전달.
 * 길이 mismatch (광고주 횡단 / 미존재) 면 throw.
 */
async function loadKeywordsWithAdgroup(
  advertiserId: string,
  keywordIds: string[],
): Promise<DbKeywordWithAdgroupSnapshot[]> {
  const dbKeywords = await prisma.keyword.findMany({
    where: {
      adgroup: { campaign: { advertiserId } }, // 광고주 횡단 차단
      id: { in: keywordIds },
    },
    select: {
      id: true,
      nccKeywordId: true,
      keyword: true,
      bidAmt: true,
      useGroupBidAmt: true,
      userLock: true,
      status: true,
      adgroup: {
        select: {
          name: true,
          bidAmt: true,
        },
      },
    },
  })

  if (dbKeywords.length !== keywordIds.length) {
    throw new Error("일부 키워드가 광고주 소속이 아닙니다")
  }

  return dbKeywords.map((k) => ({
    id: k.id,
    nccKeywordId: k.nccKeywordId,
    keyword: k.keyword,
    bidAmt: k.bidAmt === null ? null : Number(k.bidAmt),
    useGroupBidAmt: k.useGroupBidAmt,
    userLock: k.userLock,
    status: k.status,
    adgroupName: k.adgroup.name,
    adgroupBidAmt: k.adgroup.bidAmt === null ? null : Number(k.adgroup.bidAmt),
  }))
}

/**
 * ratio 모드 baseline 산출:
 *   1) keyword.bidAmt 가 number → 그 값 사용
 *   2) useGroupBidAmt=true 이고 adgroupBidAmt 가 number → 광고그룹 bidAmt 사용
 *   3) 둘 다 null → null 반환 (호출부가 skip 처리)
 */
function resolveRatioBaseline(
  row: Pick<
    DbKeywordWithAdgroupSnapshot,
    "bidAmt" | "useGroupBidAmt" | "adgroupBidAmt"
  >,
): number | null {
  if (typeof row.bidAmt === "number") return row.bidAmt
  if (row.useGroupBidAmt && typeof row.adgroupBidAmt === "number") {
    return row.adgroupBidAmt
  }
  return null
}

/**
 * ratio 산출값 계산: round(baseline * (1+percent/100) / roundTo) * roundTo, 0 클램프.
 */
function computeRatioBid(
  baseline: number,
  percent: number,
  roundTo: number,
): number {
  const next = baseline * (1 + percent / 100)
  const rounded = Math.round(next / roundTo) * roundTo
  return rounded < 0 ? 0 : rounded
}

/**
 * 일괄 액션 미리보기.
 *
 * UI 모달이 baseline 정확도 (서버 시점 DB 값 + 광고그룹 bidAmt 폴백) 를 보장받기 위해
 * RSC props 가 아닌 본 헬퍼를 호출. ChangeBatch / SA 호출 X — 순수 계산.
 *
 * 반환 shape: items 배열 (keywordId / keyword / nccKeywordId / adgroupName / before / after).
 *   - after=null + skipReason 필드는 ratio baseline 없는 row 표시용.
 */
export async function previewBulkAction(
  advertiserId: string,
  input: BulkActionKeywordsInput,
): Promise<{
  items: Array<{
    keywordId: string
    keyword: string
    nccKeywordId: string
    adgroupName: string
    before: { bidAmt: number | null; useGroupBidAmt: boolean; userLock: boolean }
    after: {
      bidAmt: number | null
      useGroupBidAmt: boolean
      userLock: boolean
    } | null
    skipReason?: string
  }>
}> {
  // 권한 체크 — admin / 화이트리스트 검증 (advertiser 객체 자체는 본 헬퍼에서 미사용).
  await getCurrentAdvertiser(advertiserId)

  const parsed = bulkActionKeywordsSchema.parse(input)

  // 액션별 keywordIds 집합 산출 (dedup).
  const keywordIds: string[] =
    parsed.action === "toggle"
      ? Array.from(new Set(parsed.items.map((it) => it.keywordId)))
      : Array.from(new Set(parsed.keywordIds))

  const rows = await loadKeywordsWithAdgroup(advertiserId, keywordIds)
  const rowById = new Map(rows.map((r) => [r.id, r]))

  // toggle 의 경우 keywordId → userLock 매핑 (마지막 항목으로 dedup)
  const toggleByKeywordId =
    parsed.action === "toggle"
      ? (() => {
          const m = new Map<string, boolean>()
          for (const it of parsed.items) m.set(it.keywordId, it.userLock)
          return m
        })()
      : null

  const items = keywordIds.map((kid) => {
    const r = rowById.get(kid)!
    const before = {
      bidAmt: r.bidAmt,
      useGroupBidAmt: r.useGroupBidAmt,
      userLock: r.userLock,
    }
    const baseEntry = {
      keywordId: r.id,
      keyword: r.keyword,
      nccKeywordId: r.nccKeywordId,
      adgroupName: r.adgroupName,
      before,
    }

    if (parsed.action === "toggle") {
      const newLock = toggleByKeywordId!.get(kid)!
      return {
        ...baseEntry,
        after: {
          bidAmt: r.bidAmt,
          useGroupBidAmt: r.useGroupBidAmt,
          userLock: newLock,
        },
      }
    }

    // bid 변경 — absolute / ratio
    if (parsed.mode === "absolute") {
      return {
        ...baseEntry,
        after: {
          bidAmt: parsed.bidAmt,
          useGroupBidAmt: false,
          userLock: r.userLock,
        },
      }
    }

    // ratio
    const baseline = resolveRatioBaseline(r)
    if (baseline === null) {
      return {
        ...baseEntry,
        after: null,
        skipReason: "입찰가 baseline 없음",
      }
    }
    const newBid = computeRatioBid(baseline, parsed.percent, parsed.roundTo)
    return {
      ...baseEntry,
      after: {
        bidAmt: newBid,
        useGroupBidAmt: false,
        userLock: r.userLock,
      },
    }
  })

  return { items }
}

/**
 * 다중 선택 일괄 액션 확정.
 *
 *   1. getCurrentAdvertiser — 권한 검증 + advertiser
 *   2. Zod 검증 + keywordIds dedup
 *   3. 광고주 한정 조회 (adgroup.campaign.advertiserId join) + 광고그룹 bidAmt 함께 로드
 *   4. ChangeBatch (status='running', action=`keyword.${parsed.action}`) 생성
 *   5. 액션별 SA payload + ChangeItem before/after 산출:
 *      - toggle:       items=[{nccKeywordId, userLock}], fields="userLock"
 *      - bid absolute: items=[{... bidAmt, useGroupBidAmt:false}], fields="bidAmt,useGroupBidAmt"
 *      - bid ratio:    각 row baseline 산출 → 산출값 또는 사전 'failed'
 *                      유효 row 만 itemsForApi 에 push
 *   6. ChangeItem createMany — ratio 사전 skip 행은 status='failed' + error 즉시 기록
 *   7. updateKeywordsBulk(customerId, validItems, fields) — 단일 PUT
 *      ※ TODO: 5천 건 한계 측정 후 batch-executor-job 패턴 이관
 *   8. 응답 매핑 — 성공 row → DB update + ChangeItem='done', 누락 → 'failed' + "응답 누락"
 *      userLock 변경 시 mapKeywordStatus 로 status 재계산
 *   9. ChangeBatch finalize (success>0 → done, 0 → failed)
 *  10. AuditLog 1건 — keyword.${parsed.action}, after={advertiserId, total, success, failed, mode?, percent?}
 *  11. revalidatePath
 */
export async function bulkActionKeywords(
  advertiserId: string,
  input: BulkActionKeywordsInput,
): Promise<BulkActionKeywordsResult> {
  const { advertiser, user } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    throw new Error("API 키/시크릿 미입력")
  }

  const parsed = bulkActionKeywordsSchema.parse(input)

  // -- 입력 정규화 + dedup -----------------------------------------------------
  // toggle: keywordId 중복은 마지막 항목으로 대체 (idempotencyKey unique 충족)
  // bid:    keywordIds 단순 Set dedup
  const toggleByKeywordId =
    parsed.action === "toggle"
      ? (() => {
          const m = new Map<string, boolean>()
          for (const it of parsed.items) m.set(it.keywordId, it.userLock)
          return m
        })()
      : null
  const keywordIds: string[] =
    parsed.action === "toggle"
      ? Array.from(toggleByKeywordId!.keys())
      : Array.from(new Set(parsed.keywordIds))

  // -- 광고주 한정 조회 (adgroup → campaign → advertiserId join) -------------
  const rows = await loadKeywordsWithAdgroup(advertiserId, keywordIds)
  const rowById = new Map(rows.map((r) => [r.id, r]))

  // -- ChangeBatch 생성 -------------------------------------------------------
  const action = `keyword.${parsed.action}` as const
  const total = keywordIds.length

  const batchSummary: Record<string, unknown> = {
    advertiserId,
    action: parsed.action,
    total,
  }
  if (parsed.action === "bid") {
    batchSummary.mode = parsed.mode
    if (parsed.mode === "absolute") {
      batchSummary.bidAmt = parsed.bidAmt
    } else {
      batchSummary.percent = parsed.percent
      batchSummary.roundTo = parsed.roundTo
    }
  }

  const batch = await prisma.changeBatch.create({
    data: {
      userId: user.id,
      action,
      status: "running",
      total,
      processed: 0,
      attempt: 1,
      summary: batchSummary as Prisma.InputJsonValue,
    },
  })

  // -- SA payload + ChangeItem before/after 산출 ------------------------------
  // ratio 모드에서 baseline 없는 row 는 사전 'failed' (payload 미포함, 다른 row 는 정상 진행).
  type ChangeItemSeed = {
    batchId: string
    targetType: string
    targetId: string
    before: Prisma.InputJsonValue
    after: Prisma.InputJsonValue
    idempotencyKey: string
    status: "pending" | "failed"
    error?: string
  }

  const itemsForApi: KeywordBulkUpdateItem[] = []
  const changeItemSeeds: ChangeItemSeed[] = []
  // ratio 사전 실패 keywordId — 호출 후 결과 매핑에 즉시 반영하기 위해 보존.
  const preFailed = new Map<string, string>() // keywordId → error
  // ratio 모드의 산출 bid 보존 (DB update 시 응답 누락 대비 fallback).
  const ratioComputed = new Map<string, number>() // keywordId → newBid

  let fields: string

  switch (parsed.action) {
    case "toggle": {
      fields = "userLock"
      for (const kid of keywordIds) {
        const r = rowById.get(kid)!
        const newLock = toggleByKeywordId!.get(kid)!
        const before = { userLock: r.userLock } as Prisma.InputJsonValue
        const after = { userLock: newLock } as Prisma.InputJsonValue

        itemsForApi.push({
          nccKeywordId: r.nccKeywordId,
          userLock: newLock,
        })
        changeItemSeeds.push({
          batchId: batch.id,
          targetType: "Keyword",
          targetId: r.nccKeywordId,
          before,
          after,
          idempotencyKey: `${batch.id}:${r.nccKeywordId}`,
          status: "pending",
        })
      }
      break
    }
    case "bid": {
      fields = "bidAmt,useGroupBidAmt"
      for (const kid of keywordIds) {
        const r = rowById.get(kid)!

        // before: 액션이 영향 주는 필드만 (bidAmt + useGroupBidAmt)
        const before = {
          bidAmt: r.bidAmt,
          useGroupBidAmt: r.useGroupBidAmt,
        } as Prisma.InputJsonValue

        if (parsed.mode === "absolute") {
          const newBid = parsed.bidAmt
          const after = {
            bidAmt: newBid,
            useGroupBidAmt: false,
          } as Prisma.InputJsonValue

          itemsForApi.push({
            nccKeywordId: r.nccKeywordId,
            bidAmt: newBid,
            useGroupBidAmt: false,
          })
          changeItemSeeds.push({
            batchId: batch.id,
            targetType: "Keyword",
            targetId: r.nccKeywordId,
            before,
            after,
            idempotencyKey: `${batch.id}:${r.nccKeywordId}`,
            status: "pending",
          })
        } else {
          // ratio
          const baseline = resolveRatioBaseline(r)
          if (baseline === null) {
            const errMsg = "입찰가 baseline 없음"
            preFailed.set(r.id, errMsg)
            changeItemSeeds.push({
              batchId: batch.id,
              targetType: "Keyword",
              targetId: r.nccKeywordId,
              before,
              after: {} as Prisma.InputJsonValue,
              idempotencyKey: `${batch.id}:${r.nccKeywordId}`,
              status: "failed",
              error: errMsg,
            })
            continue
          }
          const newBid = computeRatioBid(
            baseline,
            parsed.percent,
            parsed.roundTo,
          )
          ratioComputed.set(r.id, newBid)

          const after = {
            bidAmt: newBid,
            useGroupBidAmt: false,
          } as Prisma.InputJsonValue

          itemsForApi.push({
            nccKeywordId: r.nccKeywordId,
            bidAmt: newBid,
            useGroupBidAmt: false,
          })
          changeItemSeeds.push({
            batchId: batch.id,
            targetType: "Keyword",
            targetId: r.nccKeywordId,
            before,
            after,
            idempotencyKey: `${batch.id}:${r.nccKeywordId}`,
            status: "pending",
          })
        }
      }
      break
    }
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
      error: s.error,
    })),
  })

  // -- SA API 호출 ------------------------------------------------------------
  // TODO(5천 건 한계): 본 PR 은 단일 PUT. 운영 측정 후 batch-executor-job 패턴 이관.
  let success = 0
  let failed = preFailed.size
  const results: BulkActionKeywordItemResult[] = []

  // ratio 사전 실패 row 결과 즉시 추가 (UI 결과 표시용)
  for (const [kid, err] of preFailed) {
    results.push({ keywordId: kid, ok: false, error: err })
  }

  if (itemsForApi.length === 0) {
    // 모든 row 가 사전 실패 (ratio baseline 전부 없음)
    await prisma.changeBatch.update({
      where: { id: batch.id },
      data: {
        status: "failed",
        processed: total,
        finishedAt: new Date(),
      },
    })

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
        success: 0,
        failed: total,
        ...(parsed.action === "bid" ? { mode: parsed.mode } : {}),
        ...(parsed.action === "bid" && parsed.mode === "ratio"
          ? { percent: parsed.percent }
          : {}),
        note: "all-rows-pre-failed",
      },
    })

    revalidatePath(`/${advertiserId}/keywords`)
    return { batchId: batch.id, total, success: 0, failed, items: results }
  }

  try {
    const updated = await updateKeywordsBulk(
      advertiser.customerId,
      itemsForApi,
      fields,
    )
    const updatedMap = new Map(updated.map((k) => [k.nccKeywordId, k]))

    // SA 호출 대상 row 만 매핑 (preFailed 제외)
    for (const kid of keywordIds) {
      if (preFailed.has(kid)) continue
      const r = rowById.get(kid)!
      const u = updatedMap.get(r.nccKeywordId)

      if (u) {
        // DB 반영 — 액션별로 다르게 update
        const rawJson = u as unknown as Prisma.InputJsonValue
        if (parsed.action === "toggle") {
          // userLock 변경 → status 재계산 (mapKeywordStatus)
          const newLock =
            typeof u.userLock === "boolean"
              ? u.userLock
              : toggleByKeywordId!.get(kid)!
          await prisma.keyword.update({
            where: { id: r.id },
            data: {
              userLock: newLock,
              status: mapKeywordStatus(u),
              raw: rawJson,
            },
          })
        } else {
          // bid (absolute / ratio) — bidAmt + useGroupBidAmt
          const fallbackBid =
            parsed.mode === "absolute"
              ? parsed.bidAmt
              : (ratioComputed.get(kid) ?? null)
          const newBid =
            typeof u.bidAmt === "number" ? u.bidAmt : fallbackBid
          const newUseGroup =
            typeof u.useGroupBidAmt === "boolean" ? u.useGroupBidAmt : false
          await prisma.keyword.update({
            where: { id: r.id },
            data: {
              bidAmt: newBid,
              useGroupBidAmt: newUseGroup,
              raw: rawJson,
            },
          })
        }

        await prisma.changeItem.updateMany({
          where: { batchId: batch.id, targetId: r.nccKeywordId },
          data: { status: "done" },
        })
        success++
        results.push({ keywordId: kid, ok: true })
      } else {
        await prisma.changeItem.updateMany({
          where: { batchId: batch.id, targetId: r.nccKeywordId },
          data: { status: "failed", error: "응답에 누락" },
        })
        failed++
        results.push({ keywordId: kid, ok: false, error: "응답 누락" })
      }
    }
  } catch (e) {
    // 일괄 실패 — preFailed 외 모든 ChangeItem failed (raw 응답 첨부 X — 메시지만, 마스킹된 상한)
    const msg = e instanceof Error ? e.message : String(e)
    const safeMsg = msg.slice(0, 500)
    await prisma.changeItem.updateMany({
      where: { batchId: batch.id, status: "pending" },
      data: { status: "failed", error: safeMsg },
    })
    // results 재구성: preFailed 유지 + 나머지 모두 실패
    success = 0
    failed = total
    results.length = 0
    for (const [kid, err] of preFailed) {
      results.push({ keywordId: kid, ok: false, error: err })
    }
    for (const kid of keywordIds) {
      if (preFailed.has(kid)) continue
      results.push({ keywordId: kid, ok: false, error: safeMsg })
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
      ...(parsed.action === "bid" ? { mode: parsed.mode } : {}),
      ...(parsed.action === "bid" && parsed.mode === "ratio"
        ? { percent: parsed.percent, roundTo: parsed.roundTo }
        : {}),
      ...(parsed.action === "bid" && parsed.mode === "absolute"
        ? { bidAmt: parsed.bidAmt }
        : {}),
    },
  })

  revalidatePath(`/${advertiserId}/keywords`)

  return { batchId: batch.id, total, success, failed, items: results }
}

// =============================================================================
// 4. parseAndValidateCsv / applyCsvChangeBatch — CSV 일괄 가져오기 (F-3.4)
// =============================================================================
//
// 2단계 흐름 (CLAUDE.md "CSV 처리 규격" + SPEC F-3.4):
//   1) parseAndValidateCsv  — 파싱·검증·충돌 검사. ChangeBatch 미생성. 미리보기용.
//   2) applyCsvChangeBatch  — 사용자 확정 후. ChangeBatch 생성 + 청크별 SA 호출.
//
// 컬럼: operation / nccKeywordId / nccAdgroupId / keyword / matchType / bidAmt /
//       useGroupBidAmt / userLock / externalId
// DELETE 비대상 (OFF 로 대체).
// CREATE 멱등성 이중 방어:
//   1) externalId — 동일 키 status='done' 이력 → conflict
//   2) Natural key (nccAdgroupId, keyword, matchType) — 기존 Keyword 존재 → conflict
//      (사용자 선택: skip / UPDATE 전환 / 전체 중단)
// UPDATE/OFF 멱등성: nccKeywordId 가 자연 식별자.
//
// 본 PR 규모 제약 (F-3.4 5천행 전환):
//   - **5000행 상한** — Job Table + Chunk Executor 패턴(SPEC v0.2.1 3.5).
//   - applyCsvChangeBatch 는 ChangeBatch + ChangeItem(status='pending') 적재까지만 동기.
//   - 실제 SA 호출 / DB 반영은 /api/batch/run Cron 이 처리 (lib/batch/apply.ts).
//   - UI 는 GET /api/batch/{id} 로 진행률 polling.

// -- 공용 타입 ---------------------------------------------------------------

export type CsvOperation = "CREATE" | "UPDATE" | "OFF"

export type CsvRow = {
  /** 1-based. 헤더는 0. */
  rowIndex: number
  operation: CsvOperation
  nccKeywordId?: string
  nccAdgroupId?: string
  keyword?: string
  matchType?: string
  /** null = 빈 셀 (변경 안 함 의도). */
  bidAmt?: number | null
  useGroupBidAmt?: boolean | null
  userLock?: boolean | null
  externalId?: string
}

export type CsvValidationItem =
  | { kind: "valid"; row: CsvRow }
  /** 중복 행(첫 행) 등 — 마지막 행만 적용. items 에는 첫 행이 warning 으로 기록됨. */
  | { kind: "warning"; row: CsvRow; warnings: string[] }
  | {
      kind: "error"
      rowIndex: number
      raw: Record<string, string>
      errors: string[]
    }
  | {
      kind: "conflict"
      row: CsvRow
      reason: "external_id_exists" | "natural_key_exists"
      /** natural_key_exists 시 기존 Keyword 의 nccKeywordId — 사용자가 UPDATE 전환 선택 시 사용. */
      existingNccKeywordId?: string
    }

export type ParseAndValidateResult = {
  total: number
  byKind: { valid: number; warning: number; error: number; conflict: number }
  items: CsvValidationItem[]
  /** CREATE 행 중 광고주 DB 에 존재하지 않는 nccAdgroupId 목록 (UI 경고용). */
  unknownAdgroupIds: string[]
}

const CSV_MAX_ROWS = 5000

/** 빈 셀 / 미정의 → undefined. 문자열은 trim 후 빈 문자열도 undefined. */
function normCell(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  const s = typeof v === "string" ? v : String(v)
  const t = s.trim()
  return t.length === 0 ? undefined : t
}

/** "true" / "false" / 빈값 → boolean | null. 그 외 문자열은 sentinel "invalid". */
function parseBoolCell(v: string | undefined): boolean | null | "invalid" {
  if (v === undefined) return null
  const lower = v.toLowerCase()
  if (lower === "true" || lower === "1") return true
  if (lower === "false" || lower === "0") return false
  return "invalid"
}

/** 정수 cell — 빈값 null, 숫자 변환 실패 sentinel "invalid". */
function parseIntCell(v: string | undefined): number | null | "invalid" {
  if (v === undefined) return null
  if (!/^-?\d+$/.test(v)) return "invalid"
  const n = Number.parseInt(v, 10)
  if (!Number.isFinite(n)) return "invalid"
  return n
}

const MATCH_TYPES = new Set(["EXACT", "PHRASE", "BROAD"])
const OPERATIONS = new Set<CsvOperation>(["CREATE", "UPDATE", "OFF"])

// =============================================================================
// 4-1. parseAndValidateCsv
// =============================================================================
//
// 처리 순서:
//   1. getCurrentAdvertiser — 권한
//   2. PapaParse parse(header:true, skipEmptyLines:true) — 컬럼 순서 무관
//   3. 1000행 초과 시 즉시 throw
//   4. 행별 수동 검증 (operation enum / 필수 컬럼 / 타입 변환)
//   5. 중복 행 처리 — 첫 행 warning + 마지막 행만 valid
//   6. 광고주 한정 사전 조회:
//      - CREATE 의 nccAdgroupId 광고주 소속 검사
//      - UPDATE/OFF 의 nccKeywordId 광고주 소속 검사
//   7. CREATE 멱등성 충돌 검사 — externalId 기존 done / Natural key 기존 Keyword
//   8. items 배열 + summary 반환
//
// 안전장치:
//   - 모든 prisma 조회 광고주 한정 (campaign.advertiserId join)
//   - SA API 호출 X (검증만)
//   - AuditLog 미기록 (변경 X)
//   - 검증 실패 행을 도중에 throw 하지 않음 — 모든 행 검증 후 종합 반환

/**
 * CSV 텍스트 파싱·검증·충돌 검사. ChangeBatch 생성 X — 미리보기 단계에서만 호출.
 */
export async function parseAndValidateCsv(
  advertiserId: string,
  csvText: string,
): Promise<ParseAndValidateResult> {
  // -- 권한 ---------------------------------------------------------------
  await getCurrentAdvertiser(advertiserId)

  // -- PapaParse ---------------------------------------------------------
  // BOM 허용 — PapaParse 가 자동 처리. 컬럼 순서 무관 (header:true).
  const parseResult = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  })

  const rawRows = parseResult.data ?? []

  if (rawRows.length > CSV_MAX_ROWS) {
    throw new Error(
      `${CSV_MAX_ROWS}행 초과 (${rawRows.length}행) — 더 작은 단위로 분할해 업로드`,
    )
  }

  // -- 1차: 행별 검증 ----------------------------------------------------
  // rowIndex 는 1-based (헤더는 0).
  type Stage1Item =
    | { kind: "ok"; row: CsvRow }
    | {
        kind: "err"
        rowIndex: number
        raw: Record<string, string>
        errors: string[]
      }
  const stage1: Stage1Item[] = rawRows.map((raw, idx) => {
    const rowIndex = idx + 1
    const errors: string[] = []

    const operation = normCell(raw.operation)?.toUpperCase()
    if (!operation) {
      errors.push("operation 필수")
    } else if (!OPERATIONS.has(operation as CsvOperation)) {
      errors.push(`operation 값 무효: ${operation}`)
    }

    const nccKeywordId = normCell(raw.nccKeywordId)
    const nccAdgroupId = normCell(raw.nccAdgroupId)
    const keyword = normCell(raw.keyword)
    const matchTypeRaw = normCell(raw.matchType)?.toUpperCase()
    const externalId = normCell(raw.externalId)

    let matchType: string | undefined
    if (matchTypeRaw !== undefined) {
      if (!MATCH_TYPES.has(matchTypeRaw)) {
        errors.push(`matchType 값 무효: ${matchTypeRaw}`)
      } else {
        matchType = matchTypeRaw
      }
    }

    // 정수 / 불리언 변환 (빈값 = null = 변경 안 함).
    const bidAmtParsed = parseIntCell(normCell(raw.bidAmt))
    if (bidAmtParsed === "invalid") errors.push("bidAmt 정수 변환 실패")
    if (typeof bidAmtParsed === "number" && bidAmtParsed < 0) {
      errors.push("bidAmt 음수 불가")
    }
    const useGroupBidAmtParsed = parseBoolCell(normCell(raw.useGroupBidAmt))
    if (useGroupBidAmtParsed === "invalid") {
      errors.push("useGroupBidAmt 불리언 변환 실패")
    }
    const userLockParsed = parseBoolCell(normCell(raw.userLock))
    if (userLockParsed === "invalid") {
      errors.push("userLock 불리언 변환 실패")
    }

    // operation 별 필수 컬럼.
    if (operation === "CREATE") {
      if (!nccAdgroupId) errors.push("CREATE: nccAdgroupId 필수")
      if (!keyword) errors.push("CREATE: keyword 필수")
      if (!matchTypeRaw) errors.push("CREATE: matchType 필수")
      if (!externalId) errors.push("CREATE: externalId 필수")
    } else if (operation === "UPDATE" || operation === "OFF") {
      if (!nccKeywordId) errors.push(`${operation}: nccKeywordId 필수`)
    }

    if (errors.length > 0 || !operation) {
      return { kind: "err", rowIndex, raw, errors }
    }

    const row: CsvRow = {
      rowIndex,
      operation: operation as CsvOperation,
      nccKeywordId,
      nccAdgroupId,
      keyword,
      matchType,
      bidAmt: bidAmtParsed === "invalid" ? null : (bidAmtParsed as number | null),
      useGroupBidAmt:
        useGroupBidAmtParsed === "invalid"
          ? null
          : (useGroupBidAmtParsed as boolean | null),
      userLock:
        userLockParsed === "invalid" ? null : (userLockParsed as boolean | null),
      externalId,
    }
    return { kind: "ok", row }
  })

  // -- 2차: 중복 행 처리 -------------------------------------------------
  // 같은 키의 행이 N개 → 마지막 행만 valid, 그 외는 warning.
  // 키 정의:
  //   UPDATE/OFF: `${operation}:${nccKeywordId}`
  //   CREATE:     `${operation}:${nccAdgroupId}:${keyword}:${matchType}`
  const dupKeyToLastIdx = new Map<string, number>()
  stage1.forEach((s, i) => {
    if (s.kind !== "ok") return
    const r = s.row
    let key: string
    if (r.operation === "CREATE") {
      key = `CREATE:${r.nccAdgroupId}:${r.keyword}:${r.matchType}`
    } else {
      key = `${r.operation}:${r.nccKeywordId}`
    }
    dupKeyToLastIdx.set(key, i) // 마지막 발견 인덱스 갱신
  })

  // CREATE externalId 중복 검사 — 같은 CSV 내에서 동일 externalId 가 자연키 다른
  // 두 CREATE 행에 사용되면 ChangeItem.idempotencyKey unique([batchId, idem]) 충돌.
  // 사용자 멱등키이므로 중복 자체가 의도 오류일 가능성 — 모든 충돌 행을 error 처리.
  const externalIdToRowIdxs = new Map<string, number[]>()
  stage1.forEach((s, i) => {
    if (s.kind !== "ok") return
    const r = s.row
    if (r.operation !== "CREATE" || !r.externalId) return
    const list = externalIdToRowIdxs.get(r.externalId) ?? []
    list.push(i)
    externalIdToRowIdxs.set(r.externalId, list)
  })
  const conflictedExternalIdsInBatch = new Set<string>()
  for (const [eid, idxs] of externalIdToRowIdxs) {
    if (idxs.length <= 1) continue
    // 자연키도 동일하면 일반 dup 처리(마지막 행만 valid)로 충분 — 자연키가 서로 다른 경우만 충돌
    const natKeys = new Set<string>()
    for (const i of idxs) {
      const r = (stage1[i] as { kind: "ok"; row: CsvRow }).row
      natKeys.add(`${r.nccAdgroupId}:${r.keyword}:${r.matchType}`)
    }
    if (natKeys.size > 1) {
      conflictedExternalIdsInBatch.add(eid)
    }
  }

  // -- 3차: 광고주 한정 사전 조회 ---------------------------------------
  // CREATE 의 nccAdgroupId / UPDATE·OFF 의 nccKeywordId 가 광고주 소속인지 검증.
  const okRows = stage1.filter(
    (s): s is { kind: "ok"; row: CsvRow } => s.kind === "ok",
  )

  const createAdgroupIds = new Set(
    okRows
      .filter((s) => s.row.operation === "CREATE" && s.row.nccAdgroupId)
      .map((s) => s.row.nccAdgroupId!),
  )
  const updateOffKeywordIds = new Set(
    okRows
      .filter(
        (s) =>
          (s.row.operation === "UPDATE" || s.row.operation === "OFF") &&
          s.row.nccKeywordId,
      )
      .map((s) => s.row.nccKeywordId!),
  )

  const adgroupRows =
    createAdgroupIds.size > 0
      ? await prisma.adGroup.findMany({
          where: {
            nccAdgroupId: { in: Array.from(createAdgroupIds) },
            campaign: { advertiserId },
          },
          select: { id: true, nccAdgroupId: true },
        })
      : []
  const validAdgroupSet = new Set(adgroupRows.map((g) => g.nccAdgroupId))
  const unknownAdgroupIds = Array.from(createAdgroupIds).filter(
    (id) => !validAdgroupSet.has(id),
  )

  const keywordRows =
    updateOffKeywordIds.size > 0
      ? await prisma.keyword.findMany({
          where: {
            nccKeywordId: { in: Array.from(updateOffKeywordIds) },
            adgroup: { campaign: { advertiserId } },
          },
          select: { nccKeywordId: true },
        })
      : []
  const validKeywordSet = new Set(keywordRows.map((k) => k.nccKeywordId))

  // -- 4차: CREATE 멱등성 충돌 검사 -------------------------------------
  // (a) externalId — 과거 ChangeItem(idempotencyKey 또는 endsWith pattern) 의 done 이력
  //     1차 PR 단순 매칭: idempotencyKey 가 정확히 externalId 와 일치 또는 `:create:${eid}` 로 끝나는 경우
  //     CSV CREATE 의 idem 형식이 `${batchId}:create:${externalId}` 이므로 endsWith 검사.
  // (b) Natural key — DB Keyword 에 (nccAdgroupId, keyword, matchType) 일치 행 존재
  const createOkRows = okRows.filter((s) => s.row.operation === "CREATE")

  // (a) externalId 충돌 — Postgres ILIKE 못 쓰는 prisma 한계 → 단순 일괄 조회 후 endsWith 매칭
  // 광고주 한정: ChangeBatch.summary 에 advertiserId 가 저장되어 있으므로 (L2050)
  // Prisma path filter `summary -> advertiserId` 로 본 광고주 batch 의 ChangeItem 만 조회.
  // 다른 광고주의 done 이력에 false-positive conflict 매칭되는 문제 차단.
  const createExternalIds = createOkRows
    .map((s) => s.row.externalId)
    .filter((v): v is string => typeof v === "string" && v.length > 0)

  const existingDoneExternalIds = new Set<string>()
  if (createExternalIds.length > 0) {
    // idempotencyKey 후미 매칭 — Prisma `endsWith` 지원
    const orClauses = createExternalIds.map((eid) => ({
      idempotencyKey: { endsWith: `:create:${eid}` },
    }))
    const dones = await prisma.changeItem.findMany({
      where: {
        status: "done",
        OR: orClauses,
        // 광고주 한정 — ChangeBatch.summary.advertiserId 와 일치하는 batch 만
        batch: {
          summary: { path: ["advertiserId"], equals: advertiserId },
        },
      },
      select: { idempotencyKey: true },
    })
    for (const d of dones) {
      // idempotencyKey 의 마지막 토큰이 externalId
      const m = d.idempotencyKey.match(/:create:(.+)$/)
      if (m) existingDoneExternalIds.add(m[1])
    }
  }

  // (b) Natural key 충돌 — 광고주 한정
  const naturalKeyTuples = createOkRows
    .filter(
      (s) =>
        s.row.nccAdgroupId &&
        s.row.keyword &&
        s.row.matchType &&
        validAdgroupSet.has(s.row.nccAdgroupId!),
    )
    .map((s) => ({
      nccAdgroupId: s.row.nccAdgroupId!,
      keyword: s.row.keyword!,
      matchType: s.row.matchType!,
    }))

  const existingByNatKey = new Map<string, string>() // key → existingNccKeywordId
  if (naturalKeyTuples.length > 0) {
    const adgroupNccs = Array.from(
      new Set(naturalKeyTuples.map((t) => t.nccAdgroupId)),
    )
    const adgroupNccToInternal = new Map(
      adgroupRows.map((g) => [g.nccAdgroupId, g.id]),
    )
    const internalAdgroupIds = adgroupNccs
      .map((nid) => adgroupNccToInternal.get(nid))
      .filter((v): v is string => typeof v === "string")

    const existingKeywords = await prisma.keyword.findMany({
      where: {
        adgroupId: { in: internalAdgroupIds },
        adgroup: { campaign: { advertiserId } },
        keyword: { in: Array.from(new Set(naturalKeyTuples.map((t) => t.keyword))) },
      },
      select: {
        nccKeywordId: true,
        keyword: true,
        matchType: true,
        adgroup: { select: { nccAdgroupId: true } },
      },
    })
    for (const k of existingKeywords) {
      if (k.matchType === null) continue
      const key = `${k.adgroup.nccAdgroupId}:${k.keyword}:${k.matchType.toUpperCase()}`
      existingByNatKey.set(key, k.nccKeywordId)
    }
  }

  // -- 5차: 최종 items 배열 산출 ----------------------------------------
  const items: CsvValidationItem[] = []
  for (let i = 0; i < stage1.length; i++) {
    const s = stage1[i]
    if (s.kind === "err") {
      items.push({
        kind: "error",
        rowIndex: s.rowIndex,
        raw: s.raw,
        errors: s.errors,
      })
      continue
    }

    const r = s.row

    // 광고주 한정 사전 조회 누락 검사 — error 처리
    if (r.operation === "CREATE" && r.nccAdgroupId) {
      if (!validAdgroupSet.has(r.nccAdgroupId)) {
        items.push({
          kind: "error",
          rowIndex: r.rowIndex,
          raw: rawRows[i],
          errors: [`광고그룹이 광고주 소속 아님 (${r.nccAdgroupId})`],
        })
        continue
      }
    }
    if ((r.operation === "UPDATE" || r.operation === "OFF") && r.nccKeywordId) {
      if (!validKeywordSet.has(r.nccKeywordId)) {
        items.push({
          kind: "error",
          rowIndex: r.rowIndex,
          raw: rawRows[i],
          errors: [`키워드가 광고주 소속 아님 (${r.nccKeywordId})`],
        })
        continue
      }
    }

    // 중복 행 처리 — 마지막 행만 valid, 그 외는 warning
    let dupKey: string
    if (r.operation === "CREATE") {
      dupKey = `CREATE:${r.nccAdgroupId}:${r.keyword}:${r.matchType}`
    } else {
      dupKey = `${r.operation}:${r.nccKeywordId}`
    }
    const lastIdx = dupKeyToLastIdx.get(dupKey)
    if (lastIdx !== undefined && lastIdx !== i) {
      items.push({
        kind: "warning",
        row: r,
        warnings: ["중복 행 — 마지막 행만 적용됨"],
      })
      continue
    }

    // CREATE externalId 중복(자연키 상이) — error 처리
    // ChangeItem.idempotencyKey unique 충돌 방지 + 사용자 멱등키 의도 오류 의심
    if (
      r.operation === "CREATE" &&
      r.externalId &&
      conflictedExternalIdsInBatch.has(r.externalId)
    ) {
      items.push({
        kind: "error",
        rowIndex: r.rowIndex,
        raw: rawRows[i],
        errors: [
          `externalId 중복 — 동일 CSV 내 다른 자연키 CREATE 행에 사용됨 (${r.externalId})`,
        ],
      })
      continue
    }

    // CREATE 멱등성 충돌 검사
    if (r.operation === "CREATE") {
      if (r.externalId && existingDoneExternalIds.has(r.externalId)) {
        items.push({
          kind: "conflict",
          row: r,
          reason: "external_id_exists",
        })
        continue
      }
      if (r.nccAdgroupId && r.keyword && r.matchType) {
        const natKey = `${r.nccAdgroupId}:${r.keyword}:${r.matchType}`
        const existing = existingByNatKey.get(natKey)
        if (existing) {
          items.push({
            kind: "conflict",
            row: r,
            reason: "natural_key_exists",
            existingNccKeywordId: existing,
          })
          continue
        }
      }
    }

    items.push({ kind: "valid", row: r })
  }

  // -- 카운트 ------------------------------------------------------------
  const byKind = { valid: 0, warning: 0, error: 0, conflict: 0 }
  for (const it of items) {
    byKind[it.kind]++
  }

  return {
    total: rawRows.length,
    byKind,
    items,
    unknownAdgroupIds,
  }
}

// =============================================================================
// 4-2. applyCsvChangeBatch
// =============================================================================

export type CsvApplyDirective =
  | { kind: "valid"; row: CsvRow }
  | {
      kind: "conflict"
      row: CsvRow
      /** skip: 적용 안 함. update: operation 을 UPDATE 로 강제. */
      resolution: "skip" | "update"
    }

/**
 * 비동기 Job Table 패턴 — applyCsvChangeBatch 는 ChangeBatch + ChangeItem(pending)
 * 적재까지만 동기 처리하고 즉시 batchId 반환. 실제 SA 호출 / DB 반영은 Cron 이 처리.
 *
 * UI 는 GET /api/batch/{batchId} 로 진행률 polling.
 *
 * status:
 *   - "queued" : ChangeBatch 적재 완료 (DB 상 ChangeBatch.status='pending')
 *
 * 후속 응답(polling)에서 success/failed/items 를 받음. 본 응답 시점에는 미정.
 */
export type ApplyCsvResult = {
  batchId: string
  /** ChangeItem(pending) 적재 행 수. */
  total: number
  /** 즉시 반환 시점에는 항상 'queued'. Cron 이 처리하면서 done/failed 로 전이. */
  status: "queued"
  byOperation: {
    CREATE: number
    UPDATE: number
    OFF: number
  }
}

/**
 * 사용자 확정 후 CSV 적재. ChangeBatch + ChangeItem 생성 → 즉시 batchId 반환.
 *
 *   1. getCurrentAdvertiser — 권한 + advertiser. hasKeys=false throw
 *   2. directives 5000행 상한 검증
 *   3. directives → 효과 행 변환:
 *      - kind:"valid": 그대로
 *      - kind:"conflict" + skip: 제외
 *      - kind:"conflict" + update: operation=UPDATE 강제, row.nccKeywordId 사용 (클라이언트 책임)
 *   4. 광고주 한정 사전 조회 재검증 (시간차 외부 변경 보호)
 *   5. ChangeBatch (status='pending', action='keyword.csv') 생성 — Cron 이 lease 획득
 *   6. ChangeItem.createMany(status='pending') — Cron 이 status 정렬 픽업
 *      after JSON 에 Cron 이 SA 호출에 필요한 모든 필드 포함 (operation/customerId/...)
 *   7. AuditLog 1건 (적재 시점) — Cron 처리 결과는 별도 로깅 (현 PR 비대상)
 *   8. revalidatePath — 적재 결과를 사용자가 즉시 볼 수 있게 (Cron 이 처리하면 후속 polling)
 *
 * 안전장치:
 *   - SA 호출 X (Cron 이 처리)
 *   - idempotencyKey unique([batchId, idem]) — 재시도 시 중복 적용 차단
 *   - ChangeItem.after 에 customerId 만 (시크릿 키 평문 X)
 */
export async function applyCsvChangeBatch(
  advertiserId: string,
  directives: CsvApplyDirective[],
): Promise<ApplyCsvResult> {
  const { advertiser, user } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    throw new Error("API 키/시크릿 미입력")
  }

  if (directives.length === 0) {
    throw new Error("적용 대상 행 없음")
  }
  if (directives.length > CSV_MAX_ROWS) {
    throw new Error(
      `${CSV_MAX_ROWS}행 초과 (${directives.length}행) — 더 작은 단위로 분할해 업로드`,
    )
  }

  // -- 1. directives → 효과 행 (effective rows) -------------------------
  const effRows: CsvRow[] = []
  for (const d of directives) {
    if (d.kind === "valid") {
      effRows.push(d.row)
    } else if (d.kind === "conflict") {
      if (d.resolution === "skip") continue
      // update — operation=UPDATE 강제. row.nccKeywordId 는 클라이언트가
      // existingNccKeywordId 로 채워서 보냄 (parseAndValidateCsv 결과 활용).
      if (!d.row.nccKeywordId) {
        throw new Error(
          `conflict update 행에 nccKeywordId 누락 (rowIndex=${d.row.rowIndex})`,
        )
      }
      effRows.push({ ...d.row, operation: "UPDATE" })
    }
  }

  if (effRows.length === 0) {
    throw new Error("적용 대상 행 없음 (모두 skip)")
  }
  if (effRows.length > CSV_MAX_ROWS) {
    throw new Error(
      `${CSV_MAX_ROWS}행 초과 (${effRows.length}행) — 더 작은 단위로 분할해 업로드`,
    )
  }

  // -- 2. 광고주 한정 재검증 (시간차 외부 변경 보호) -------------------
  const createRows = effRows.filter((r) => r.operation === "CREATE")
  const updateRows = effRows.filter((r) => r.operation === "UPDATE")
  const offRows = effRows.filter((r) => r.operation === "OFF")

  const createAdgroupIdSet = new Set(
    createRows.map((r) => r.nccAdgroupId).filter((v): v is string => !!v),
  )
  const updateOffKeywordIdSet = new Set(
    [...updateRows, ...offRows]
      .map((r) => r.nccKeywordId)
      .filter((v): v is string => !!v),
  )

  const adgroupRows =
    createAdgroupIdSet.size > 0
      ? await prisma.adGroup.findMany({
          where: {
            nccAdgroupId: { in: Array.from(createAdgroupIdSet) },
            campaign: { advertiserId },
          },
          select: { id: true, nccAdgroupId: true },
        })
      : []
  const validAdgroupNccToInternal = new Map(
    adgroupRows.map((g) => [g.nccAdgroupId, g.id]),
  )
  for (const r of createRows) {
    if (!r.nccAdgroupId || !validAdgroupNccToInternal.has(r.nccAdgroupId)) {
      throw new Error(
        `광고그룹이 광고주 소속 아님 — rowIndex=${r.rowIndex} nccAdgroupId=${r.nccAdgroupId}`,
      )
    }
  }

  const keywordRows =
    updateOffKeywordIdSet.size > 0
      ? await prisma.keyword.findMany({
          where: {
            nccKeywordId: { in: Array.from(updateOffKeywordIdSet) },
            adgroup: { campaign: { advertiserId } },
          },
          select: {
            id: true,
            nccKeywordId: true,
            keyword: true,
            bidAmt: true,
            useGroupBidAmt: true,
            userLock: true,
            matchType: true,
            adgroupId: true,
          },
        })
      : []
  const validKeywordByNcc = new Map(
    keywordRows.map((k) => [k.nccKeywordId, k]),
  )
  for (const r of [...updateRows, ...offRows]) {
    if (!r.nccKeywordId || !validKeywordByNcc.has(r.nccKeywordId)) {
      throw new Error(
        `키워드가 광고주 소속 아님 — rowIndex=${r.rowIndex} nccKeywordId=${r.nccKeywordId}`,
      )
    }
  }

  // -- 3. ChangeBatch + ChangeItem 생성 (status='pending') --------------
  // SPEC v0.2.1 3.5 (Job Table + Chunk Executor):
  //   - ChangeBatch.status='pending' → /api/batch/run Cron 이 lease 획득 → 처리.
  //   - ChangeItem.after 에 Cron 이 SA 호출에 필요한 모든 필드 포함:
  //       CREATE: operation/customerId/nccAdgroupId/keyword/matchType/bidAmt/useGroupBidAmt/userLock/externalId
  //       UPDATE: operation/customerId/nccKeywordId/fields/patch
  //       OFF:    operation/customerId/nccKeywordId
  //   - customerId 만 포함 (시크릿 키 평문 X — credentials.ts 가 customerId → enc 룩업)
  const total = effRows.length
  const action = "keyword.csv"

  const batchSummary = {
    advertiserId,
    action,
    total,
    byOperation: {
      CREATE: createRows.length,
      UPDATE: updateRows.length,
      OFF: offRows.length,
    },
  }

  const batch = await prisma.changeBatch.create({
    data: {
      userId: user.id,
      action,
      status: "pending", // ← Cron 이 lease 획득 (SPEC 3.5)
      total,
      processed: 0,
      attempt: 0,
      summary: batchSummary as Prisma.InputJsonValue,
    },
  })

  type ItemSeed = {
    batchId: string
    targetType: string
    targetId: string
    before: Prisma.InputJsonValue
    after: Prisma.InputJsonValue
    idempotencyKey: string
    status: "pending"
  }

  const seeds: ItemSeed[] = []

  for (const r of createRows) {
    if (!r.externalId) {
      // 검증 단계에서 걸러졌어야 함 — 안전망
      throw new Error(`CREATE: externalId 필수 (rowIndex=${r.rowIndex})`)
    }
    seeds.push({
      batchId: batch.id,
      targetType: "Keyword",
      targetId: `pending:${r.externalId}`,
      before: {} as Prisma.InputJsonValue,
      after: {
        operation: "CREATE",
        customerId: advertiser.customerId,
        nccAdgroupId: r.nccAdgroupId,
        keyword: r.keyword,
        matchType: r.matchType,
        bidAmt: r.bidAmt ?? null,
        useGroupBidAmt: r.useGroupBidAmt ?? null,
        userLock: r.userLock ?? null,
        externalId: r.externalId,
        rowIndex: r.rowIndex,
      } as Prisma.InputJsonValue,
      idempotencyKey: `${batch.id}:create:${r.externalId}`,
      status: "pending",
    })
  }

  for (const r of updateRows) {
    const k = validKeywordByNcc.get(r.nccKeywordId!)!
    const beforeObj: Record<string, unknown> = {}
    const patchObj: Record<string, unknown> = {}
    const fieldsArr: string[] = []
    if (r.bidAmt !== undefined && r.bidAmt !== null) {
      beforeObj.bidAmt = k.bidAmt === null ? null : Number(k.bidAmt)
      patchObj.bidAmt = r.bidAmt
      fieldsArr.push("bidAmt")
    }
    if (r.useGroupBidAmt !== undefined && r.useGroupBidAmt !== null) {
      beforeObj.useGroupBidAmt = k.useGroupBidAmt
      patchObj.useGroupBidAmt = r.useGroupBidAmt
      fieldsArr.push("useGroupBidAmt")
    }
    if (r.userLock !== undefined && r.userLock !== null) {
      beforeObj.userLock = k.userLock
      patchObj.userLock = r.userLock
      fieldsArr.push("userLock")
    }
    seeds.push({
      batchId: batch.id,
      targetType: "Keyword",
      targetId: r.nccKeywordId!,
      before: beforeObj as Prisma.InputJsonValue,
      after: {
        operation: "UPDATE",
        customerId: advertiser.customerId,
        nccKeywordId: r.nccKeywordId,
        fields: fieldsArr.join(","),
        patch: patchObj,
        rowIndex: r.rowIndex,
      } as Prisma.InputJsonValue,
      idempotencyKey: `${batch.id}:update:${r.nccKeywordId}`,
      status: "pending",
    })
  }

  for (const r of offRows) {
    const k = validKeywordByNcc.get(r.nccKeywordId!)!
    // 자기 멱등성: 이미 userLock=true 행을 다시 OFF 로 적용해도 before=after 로
    // ChangeItem 기록. F-6.4 롤백 도입 시 before === after 행 무시 처리 필요 (TODO).
    seeds.push({
      batchId: batch.id,
      targetType: "Keyword",
      targetId: r.nccKeywordId!,
      before: { userLock: k.userLock } as Prisma.InputJsonValue,
      after: {
        operation: "OFF",
        customerId: advertiser.customerId,
        nccKeywordId: r.nccKeywordId,
        userLock: true,
        rowIndex: r.rowIndex,
      } as Prisma.InputJsonValue,
      idempotencyKey: `${batch.id}:off:${r.nccKeywordId}`,
      status: "pending",
    })
  }

  await prisma.changeItem.createMany({ data: seeds })

  // -- 4. SA 호출 / DB 반영 / finalize ---------------------------------
  // 동기 처리 X — Cron(/api/batch/run)이 lease 획득 후 lib/batch/apply.ts 의
  // applyChange 로 행별 처리. 결과 status 는 ChangeBatch.status / ChangeItem.status
  // 로 적재되며 UI 는 GET /api/batch/{batchId} polling 으로 받음.

  // -- 5. AuditLog (적재 시점) -----------------------------------------
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
      status: "queued",
      byOperation: batchSummary.byOperation,
    },
  })

  revalidatePath(`/${advertiserId}/keywords`)

  return {
    batchId: batch.id,
    total,
    status: "queued",
    byOperation: batchSummary.byOperation,
  }
}


// =============================================================================
// 5. createKeywordsBatch — 키워드 추가 (단건·다건) (F-3.6)
// =============================================================================
//
// UI 흐름 (SPEC F-3.6):
//   - 사용자 폼 입력: 광고그룹 + 매치타입 + 입찰가(or useGroupBidAmt) + 키워드 목록
//   - "추가하기" → 단일 Server Action 호출
//   - 폼 화면이 곧 미리보기 (별도 미리보기 단계 X)
//   - 결과 화면에서 성공/실패/충돌(skip) 분리 노출
//
// 자연키 충돌 정책:
//   - (nccAdgroupId + keyword + matchType) 조합이 DB 에 이미 존재하면 자동 skip
//   - skip 행은 result.conflicts 에 노출 (사용자 인지)
//   - 모든 키워드가 충돌이면 ChangeBatch 미생성 → batchId="" 반환
//
// 멱등성 (CSV CREATE 와 동일 이중 방어):
//   - externalId: 자동 생성 — `add-${crypto.randomUUID()}` (사용자 부담 X)
//     별도 cuid 의존성 추가 안 함. 충돌 거의 0
//   - natural key 사전 검사 + idempotencyKey unique 로 ChangeItem 레벨 멱등 확보

const createKeywordsSchema = z
  .object({
    nccAdgroupId: z.string().min(1),
    matchType: z.enum(["EXACT", "PHRASE", "BROAD"]),
    // useGroupBidAmt=true: bidAmt 무시, 광고그룹 기본가 사용
    // useGroupBidAmt=false: bidAmt 정수(원 단위) 필수
    useGroupBidAmt: z.boolean(),
    bidAmt: z.number().int().min(0).optional(),
    userLock: z.boolean().default(false),
    // 키워드 목록 — 1~100건 (단건도 1건)
    keywords: z.array(z.string().min(1).max(50)).min(1).max(100),
  })
  .refine(
    (v) => v.useGroupBidAmt === true || typeof v.bidAmt === "number",
    { message: "bidAmt 또는 useGroupBidAmt 중 하나 필수" },
  )

export type CreateKeywordsBatchInput = z.infer<typeof createKeywordsSchema>

export type CreateKeywordsBatchItem = {
  keyword: string
  ok: boolean
  nccKeywordId?: string // 성공 시
  error?: string // 실패 시
}

export type CreateKeywordsConflict = {
  keyword: string
  matchType: string
  existingNccKeywordId: string // 이미 존재하는 키워드의 ID
}

export type CreateKeywordsBatchResult = {
  batchId: string
  total: number // 충돌 제외 후 실제 시도 건수
  success: number
  failed: number
  conflicts: CreateKeywordsConflict[] // skip된 자연키 충돌 행
  items: CreateKeywordsBatchItem[]
}

/**
 * 키워드 추가 (단건·다건) Server Action.
 *
 *   1. getCurrentAdvertiser — 권한 검증 + 광고주 객체 (hasKeys 체크)
 *   2. Zod 검증
 *   3. 광고그룹 광고주 한정 검증 (campaign.advertiserId join)
 *   4. keywords 배열 dedup (UI 검증의 안전망)
 *   5. natural key 충돌 사전 검사 — 충돌은 conflicts 로 분리 + 시도 대상에서 제외
 *      모든 키워드가 충돌이면 ChangeBatch 미생성 후 즉시 반환
 *   6. ChangeBatch 생성 (status='running')
 *   7. ChangeItem createMany (충돌 제외 행만)
 *      - externalId 자동 생성: `add-${crypto.randomUUID()}` (사용자 부담 X)
 *      - idempotencyKey: `${batch.id}:create:${externalId}`
 *   8. SA createKeywords 호출 (광고그룹 단위 1회 — 단일 nccAdgroupId 가정)
 *   9. 응답 매핑 — applyCsvChangeBatch CREATE 패턴 그대로
 *      - 길이 일치 → 인덱스 매핑
 *      - 길이 불일치 → (keyword, matchType) 정확 매칭만 (matchType 누락 응답 fallback X)
 *  10. DB upsert + ChangeItem 'done'/'failed' 갱신 (targetId pending → nccKeywordId)
 *  11. ChangeBatch finalize (success>0 → done, 0 → failed) + finishedAt
 *  12. AuditLog 1건 (요약, 시크릿 X)
 *  13. revalidatePath
 *
 * 안전장치:
 *   - 광고주 횡단 차단: 광고그룹·기존 keyword 조회 모두 campaign.advertiserId join
 *   - 시크릿 마스킹: AuditLog after / 콘솔 / throw 메시지에 키 노출 X (메시지만 500자 컷)
 *   - SA 호출 실패 → 모든 ChangeItem failed + batch failed
 */
export async function createKeywordsBatch(
  advertiserId: string,
  input: CreateKeywordsBatchInput,
): Promise<CreateKeywordsBatchResult> {
  const { advertiser, user } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    throw new Error("API 키/시크릿 미입력")
  }

  const parsed = createKeywordsSchema.parse(input)
  const matchTypeUpper = parsed.matchType.toUpperCase()

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

  // -- keywords 배열 dedup (동일 keyword 중복 → 첫 항목만 유지) ----------------
  // matchType 은 입력에서 단일 값. 같은 keyword 중복은 첫 항목만 유지.
  const seenKw = new Set<string>()
  const dedupedKeywords: string[] = []
  for (const kw of parsed.keywords) {
    if (!seenKw.has(kw)) {
      seenKw.add(kw)
      dedupedKeywords.push(kw)
    }
  }

  // -- natural key 충돌 사전 검사 ---------------------------------------------
  // (adgroupId + keyword + matchType) 조합이 DB 에 이미 존재하면 skip → conflicts.
  const existingRows = await prisma.keyword.findMany({
    where: {
      adgroupId: dbAdgroup.id,
      keyword: { in: dedupedKeywords },
      matchType: matchTypeUpper,
    },
    select: {
      keyword: true,
      nccKeywordId: true,
      matchType: true,
    },
  })

  const conflictByKeyword = new Map<string, { ncc: string; mt: string }>()
  for (const row of existingRows) {
    conflictByKeyword.set(row.keyword, {
      ncc: row.nccKeywordId,
      mt: row.matchType ?? matchTypeUpper,
    })
  }

  const conflicts: CreateKeywordsConflict[] = []
  const targetKeywords: string[] = []
  for (const kw of dedupedKeywords) {
    const hit = conflictByKeyword.get(kw)
    if (hit) {
      conflicts.push({
        keyword: kw,
        matchType: hit.mt,
        existingNccKeywordId: hit.ncc,
      })
    } else {
      targetKeywords.push(kw)
    }
  }

  // 모든 키워드가 충돌 → ChangeBatch 미생성, 즉시 반환
  if (targetKeywords.length === 0) {
    return {
      batchId: "",
      total: 0,
      success: 0,
      failed: 0,
      conflicts,
      items: [],
    }
  }

  // -- externalId 자동 생성 ---------------------------------------------------
  // crypto.randomUUID() 로 충분 (cuid 의존성 추가 안 함). `add-${uuid}` prefix 로 가독성 확보.
  const externalIds = targetKeywords.map(() => `add-${crypto.randomUUID()}`)

  // -- ChangeBatch 생성 -------------------------------------------------------
  const action = "keyword.create"
  const total = targetKeywords.length

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
        matchType: matchTypeUpper,
        count: total,
      } as Prisma.InputJsonValue,
    },
  })

  // -- ChangeItem createMany (충돌 제외 행만) --------------------------------
  type CreateItemSeed = {
    batchId: string
    targetType: string
    targetId: string
    before: Prisma.InputJsonValue
    after: Prisma.InputJsonValue
    idempotencyKey: string
    status: "pending"
  }

  const seeds: CreateItemSeed[] = targetKeywords.map((kw, i) => ({
    batchId: batch.id,
    targetType: "Keyword",
    targetId: `pending:${externalIds[i]}`,
    before: {} as Prisma.InputJsonValue,
    after: {
      keyword: kw,
      matchType: matchTypeUpper,
      bidAmt: parsed.useGroupBidAmt ? null : (parsed.bidAmt ?? null),
      useGroupBidAmt: parsed.useGroupBidAmt,
      userLock: parsed.userLock ?? false,
    } as Prisma.InputJsonValue,
    idempotencyKey: `${batch.id}:create:${externalIds[i]}`,
    status: "pending" as const,
  }))

  await prisma.changeItem.createMany({ data: seeds })

  // -- SA createKeywords 호출 -------------------------------------------------
  const items: KeywordCreateItem[] = targetKeywords.map((kw, i) => ({
    keyword: kw,
    bidAmt: parsed.useGroupBidAmt ? undefined : parsed.bidAmt,
    useGroupBidAmt: parsed.useGroupBidAmt,
    userLock: parsed.userLock ?? false,
    externalId: externalIds[i],
  }))

  let successTotal = 0
  let failedTotal = 0
  const resultItems: CreateKeywordsBatchItem[] = []

  try {
    const created = await createKeywords(
      advertiser.customerId,
      parsed.nccAdgroupId,
      items,
    )

    // 응답 매핑 — applyCsvChangeBatch CREATE 패턴 그대로
    //   1차: 응답 길이 == 입력 길이 → 인덱스 기반 매핑
    //   2차(불일치): (keyword, matchType) 정확 매칭만. matchType 누락 응답은 매칭 불가
    const indexMatch = created.length === items.length
    const respByExactKey = new Map<string, SaKeyword>()
    if (!indexMatch) {
      for (const k of created) {
        const anyK = k as unknown as { matchType?: string }
        const mt =
          typeof anyK.matchType === "string" && anyK.matchType.length > 0
            ? anyK.matchType.toUpperCase()
            : ""
        if (mt) respByExactKey.set(`${k.keyword}::${mt}`, k)
      }
    }

    for (let idx = 0; idx < targetKeywords.length; idx++) {
      const kw = targetKeywords[idx]
      const externalId = externalIds[idx]
      let u: SaKeyword | undefined
      if (indexMatch) {
        u = created[idx]
      } else {
        u = respByExactKey.get(`${kw}::${matchTypeUpper}`)
      }

      if (u) {
        // ChangeItem.targetId 갱신 (pending → 실제 nccKeywordId) + status='done'
        await prisma.changeItem.updateMany({
          where: {
            batchId: batch.id,
            idempotencyKey: `${batch.id}:create:${externalId}`,
          },
          data: { targetId: u.nccKeywordId, status: "done" },
        })

        // DB upsert (nccKeywordId unique) — 응답 매핑 패턴은 CSV CREATE 와 동일.
        // matchType 응답 누락 시 입력 matchType 사용 (passthrough 가정).
        const anyU = u as unknown as { matchType?: string }
        const mtFromResp =
          typeof anyU.matchType === "string" && anyU.matchType.length > 0
            ? anyU.matchType.toUpperCase()
            : matchTypeUpper

        const userLockResp =
          typeof u.userLock === "boolean" ? u.userLock : (parsed.userLock ?? false)
        const useGroupBidResp =
          typeof u.useGroupBidAmt === "boolean"
            ? u.useGroupBidAmt
            : parsed.useGroupBidAmt
        const bidAmtResp =
          typeof u.bidAmt === "number"
            ? u.bidAmt
            : parsed.useGroupBidAmt
              ? null
              : (parsed.bidAmt ?? null)

        const rawJson = u as unknown as Prisma.InputJsonValue

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
            status: mapKeywordStatus(u),
            inspectStatus: mapInspectStatus(u),
            raw: rawJson,
          },
          update: {
            adgroupId: dbAdgroup.id,
            keyword: u.keyword,
            matchType: mtFromResp,
            bidAmt: bidAmtResp,
            useGroupBidAmt: useGroupBidResp,
            userLock: userLockResp,
            externalId,
            status: mapKeywordStatus(u),
            inspectStatus: mapInspectStatus(u),
            raw: rawJson,
          },
        })

        resultItems.push({
          keyword: kw,
          ok: true,
          nccKeywordId: u.nccKeywordId,
        })
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
        resultItems.push({
          keyword: kw,
          ok: false,
          error: errMsg,
        })
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
    for (const kw of targetKeywords) {
      resultItems.push({ keyword: kw, ok: false, error: safeMsg })
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
      matchType: matchTypeUpper,
      total,
      success: successTotal,
      failed: failedTotal,
      conflicts: conflicts.length,
    },
  })

  revalidatePath(`/${advertiserId}/keywords`)

  return {
    batchId: batch.id,
    total,
    success: successTotal,
    failed: failedTotal,
    conflicts,
    items: resultItems,
  }
}

// =============================================================================
// 6. deleteKeywordSingle — 키워드 단건 삭제 (F-3.7, admin + 2차 확인)
// =============================================================================
//
// CLAUDE.md "비대상" 정책:
//   - 다중 선택 삭제는 P1 비대상 (OFF로 대체)
//   - 단건 삭제도 admin 권한 + 2차 확인 필수
//
// 흐름:
//   1. assertRole("admin") — operator/viewer 차단 (AuthorizationError throw)
//   2. getCurrentAdvertiser — 광고주 권한 + hasKeys 검증
//   3. Zod 검증
//   4. 광고주 한정 키워드 조회 (campaign.advertiserId join)
//   5. 2차 확인 검증 — 입력 keyword 텍스트가 DB keyword 와 정확 일치
//   6. idempotent 처리 — 이미 status='deleted' 면 ChangeBatch 미생성, 정상 반환 + AuditLog
//   7. ChangeBatch 생성 (action='keyword.delete', total=1)
//   8. ChangeItem 1건 (idempotencyKey: `${batchId}:delete:${nccKeywordId}`)
//   9. SA deleteKeyword 호출
//      - 성공: DB Keyword.status='deleted' 업데이트 (row 삭제 X — 감사 추적 보존)
//      - 실패: ChangeItem failed + ChangeBatch failed
//  10. ChangeItem='done' / ChangeBatch finalize
//  11. AuditLog (targetType='Keyword' — admin 액션은 키워드 자체 추적)
//  12. revalidatePath
//
// 안전장치:
//   - admin 권한 강제 (진입부 assertRole)
//   - 광고주 횡단 차단 (campaign.advertiserId join)
//   - 2차 확인 (오타·잘못된 행 보호)
//   - DB row 삭제 X — status='deleted' 만 (감사 추적 보존)
//   - 시크릿 마스킹 (AuditLog/throw 메시지에 키 노출 X)
//   - SA 실패 → ChangeItem failed + ChangeBatch failed + return ok:false

const deleteKeywordSchema = z.object({
  keywordId: z.string().min(1), // 앱 DB Keyword.id
  // 2차 확인: 사용자가 입력한 키워드 텍스트가 실제 keyword 와 일치해야 함
  confirmKeyword: z.string().min(1),
})

export type DeleteKeywordInput = z.infer<typeof deleteKeywordSchema>

export type DeleteKeywordResult =
  | { ok: true; batchId: string; nccKeywordId: string }
  | { ok: false; error: string }

/**
 * 키워드 단건 삭제 (F-3.7).
 *
 * admin 권한 한정 + 2차 확인 (사용자가 키워드 텍스트 재입력) 흐름.
 *
 * @throws AuthorizationError — admin 권한 부족 시 (UI에서 catch)
 * @throws Error("확인 키워드 텍스트 불일치") — 2차 확인 실패 (UI에서 catch)
 */
export async function deleteKeywordSingle(
  advertiserId: string,
  input: DeleteKeywordInput,
): Promise<DeleteKeywordResult> {
  // -- 1. admin 권한 강제 (진입부) -------------------------------------------
  // assertRole 은 부족 시 AuthorizationError throw — UI 에서 catch.
  await assertRole("admin")

  // -- 2. 광고주 권한 + 객체 -------------------------------------------------
  const { advertiser, user } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    return { ok: false, error: "API 키/시크릿 미입력" }
  }

  // -- 3. Zod 검증 -----------------------------------------------------------
  const parsed = deleteKeywordSchema.parse(input)

  // -- 4. 광고주 한정 키워드 조회 -------------------------------------------
  // campaign.advertiserId join 으로 광고주 횡단 차단.
  const dbKeyword = await prisma.keyword.findFirst({
    where: {
      id: parsed.keywordId,
      adgroup: { campaign: { advertiserId } },
    },
    select: {
      id: true,
      nccKeywordId: true,
      keyword: true,
      status: true,
    },
  })
  if (!dbKeyword) {
    return { ok: false, error: "키워드를 찾을 수 없거나 광고주 소속 아님" }
  }

  // -- 5. 2차 확인 검증 ------------------------------------------------------
  // 사용자가 입력한 keyword 텍스트가 DB keyword 와 정확 일치해야 함 (양 끝 trim 비교).
  if (parsed.confirmKeyword.trim() !== dbKeyword.keyword.trim()) {
    throw new Error("확인 키워드 텍스트 불일치")
  }

  // -- 6. idempotent 처리 (이미 deleted) -------------------------------------
  // 이미 삭제된 키워드 재호출 → ChangeBatch 미생성. AuditLog 1줄만 (중복 호출 추적용).
  if (dbKeyword.status === "deleted") {
    await logAudit({
      userId: user.id,
      action: "keyword.delete",
      targetType: "Keyword",
      targetId: dbKeyword.nccKeywordId,
      before: { status: dbKeyword.status, keyword: dbKeyword.keyword },
      after: { status: "deleted", note: "already-deleted (idempotent)" },
    })
    return { ok: true, batchId: "", nccKeywordId: dbKeyword.nccKeywordId }
  }

  // -- 7. ChangeBatch 생성 ---------------------------------------------------
  const action = "keyword.delete"
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
        nccKeywordId: dbKeyword.nccKeywordId,
        keyword: dbKeyword.keyword,
      } as Prisma.InputJsonValue,
    },
  })

  // -- 8. ChangeItem (1건) ---------------------------------------------------
  const idempotencyKey = `${batch.id}:delete:${dbKeyword.nccKeywordId}`
  await prisma.changeItem.create({
    data: {
      batchId: batch.id,
      targetType: "Keyword",
      targetId: dbKeyword.nccKeywordId,
      before: { status: dbKeyword.status } as Prisma.InputJsonValue,
      after: { status: "deleted" } as Prisma.InputJsonValue,
      idempotencyKey,
      status: "pending",
    },
  })

  // -- 9. SA deleteKeyword 호출 ---------------------------------------------
  let success = false
  let errorMsg: string | null = null
  try {
    await deleteKeyword(advertiser.customerId, dbKeyword.nccKeywordId)
    success = true
  } catch (e) {
    // 메시지만 500자 컷. raw 응답 / 시크릿 노출 X.
    const msg = e instanceof Error ? e.message : String(e)
    errorMsg = msg.slice(0, 500)
  }

  if (success) {
    // DB 반영: row 삭제 X — status='deleted' 만 (감사 추적 보존).
    // 사용자 키워드 페이지에서 status 필터로 deleted 분리 노출 가능.
    await prisma.keyword.update({
      where: { id: dbKeyword.id },
      data: { status: "deleted" satisfies KeywordStatus },
    })

    // -- 10. ChangeItem='done' ----------------------------------------------
    await prisma.changeItem.updateMany({
      where: { batchId: batch.id, idempotencyKey },
      data: { status: "done" },
    })
  } else {
    // SA 실패 → ChangeItem failed
    await prisma.changeItem.updateMany({
      where: { batchId: batch.id, idempotencyKey },
      data: { status: "failed", error: errorMsg ?? "삭제 실패" },
    })
  }

  // -- 11. ChangeBatch finalize ---------------------------------------------
  const finalStatus: "done" | "failed" = success ? "done" : "failed"
  await prisma.changeBatch.update({
    where: { id: batch.id },
    data: {
      status: finalStatus,
      processed: 1,
      finishedAt: new Date(),
    },
  })

  // -- 12. AuditLog (targetType='Keyword') ----------------------------------
  // admin 액션은 감사 중요 — 키워드 자체를 추적 (다른 액션은 ChangeBatch 추적).
  await logAudit({
    userId: user.id,
    action,
    targetType: "Keyword",
    targetId: dbKeyword.nccKeywordId,
    before: { status: dbKeyword.status, keyword: dbKeyword.keyword },
    after: success
      ? { status: "deleted", batchId: batch.id }
      : { status: dbKeyword.status, batchId: batch.id, error: errorMsg },
  })

  // -- 13. revalidatePath ----------------------------------------------------
  revalidatePath(`/${advertiserId}/keywords`)

  if (!success) {
    return { ok: false, error: errorMsg ?? "삭제 실패" }
  }
  return { ok: true, batchId: batch.id, nccKeywordId: dbKeyword.nccKeywordId }
}

// =============================================================================
// fetchKeywordsStats — client streaming (Suspense 대안)
// =============================================================================

/**
 * 키워드별 stats 조회 (광고주 단위 batch).
 *
 * 호출 패턴 / 권한 / 캐시는 fetchAdsStats 와 동일.
 *   - page.tsx 가 stats 호출 X → 즉시 화면 표시
 *   - KeywordsTable client useEffect 가 본 액션 호출 → metric 셀 점진 채움
 *   - getStatsChunked 자체 캐시 (오늘 5분 / 과거 1시간)
 */
export type FetchKeywordsStatsResult =
  | { ok: true; metrics: Array<{ id: string } & AdMetrics> }
  | { ok: false; error: string }

export async function fetchKeywordsStats(
  advertiserId: string,
  period: AdsPeriod,
): Promise<FetchKeywordsStatsResult> {
  const { advertiser } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    return { ok: false, error: "API 키/시크릿 미입력" }
  }

  const keywordRows = await prisma.keyword.findMany({
    where: { adgroup: { campaign: { advertiserId } } },
    select: { nccKeywordId: true },
    take: 5000,
  })
  const ids = keywordRows.map((k) => k.nccKeywordId)
  if (ids.length === 0) return { ok: true, metrics: [] }

  try {
    const statsRows = await getStatsChunked(advertiser.customerId, {
      ids,
      fields: ["impCnt", "clkCnt", "ctr", "cpc", "salesAmt"],
      datePreset: period,
    })
    const out: Array<{ id: string } & AdMetrics> = []
    for (const r of statsRows) {
      if (typeof r.id !== "string") continue
      out.push({
        id: r.id,
        impCnt: typeof r.impCnt === "number" ? r.impCnt : 0,
        clkCnt: typeof r.clkCnt === "number" ? r.clkCnt : 0,
        ctr: typeof r.ctr === "number" ? r.ctr : 0,
        cpc: typeof r.cpc === "number" ? r.cpc : 0,
        salesAmt: typeof r.salesAmt === "number" ? r.salesAmt : 0,
      })
    }
    return { ok: true, metrics: out }
  } catch (e) {
    const error =
      e instanceof NaverSaError
        ? e.message
        : e instanceof Error
          ? e.message
          : "알 수 없는 오류"
    console.warn("[fetchKeywordsStats] failed:", e)
    return { ok: false, error }
  }
}
