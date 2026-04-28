"use server"

/**
 * F-3.1 — 키워드 동기화 (Server Action)
 *
 * 책임 (SPEC v0.2 F-3.1, line 388):
 *   1. syncKeywords — 광고주의 모든 광고그룹을 순회하며 NAVER SA listKeywords → DB upsert
 *
 * 본 PR 범위 X (별도 ID로 분리):
 *   - F-3.2 인라인 편집 (staging 누적 → 미리보기 → 확정)
 *   - F-3.3 일괄 액션 (toggle/bid/useGroupBidAmt 등)
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

import { prisma } from "@/lib/db/prisma"
import { getCurrentAdvertiser } from "@/lib/auth/access"
import { logAudit } from "@/lib/audit/log"
import { listKeywords, type Keyword as SaKeyword } from "@/lib/naver-sa/keywords"
import { NaverSaError } from "@/lib/naver-sa/errors"
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
 * TODO: 광고그룹 200개 + 5천 키워드 동기화 시 Vercel 함수 시간 한계(10s/60s) 부딪힐 수 있음.
 *       현 시점은 단순 동기 처리. 측정 후 ChangeBatch + Chunk Executor (SPEC 3.5) 이관.
 */
export async function syncKeywords(
  advertiserId: string,
): Promise<SyncKeywordsResult> {
  const { advertiser, user } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    return { ok: false, error: "API 키/시크릿 미입력" }
  }

  const start = Date.now()

  // -- DB 광고그룹 매핑 테이블 (광고주 한정) -----------------------------------
  // 응답의 nccAdgroupId → DB AdGroup.id 룩업용. Keyword.adgroupId 는 AdGroup.id (cuid).
  const adgroups = await prisma.adGroup.findMany({
    where: { campaign: { advertiserId } },
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
        note: "no-adgroups",
      },
    })
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
  // 부분 실패 허용: 단일 광고그룹 실패는 다른 광고그룹 동기화에 영향 X.
  let syncedKeywords = 0
  let skipped = 0
  let scannedAdgroups = 0

  try {
    for (const ag of adgroups) {
      let remote: SaKeyword[]
      try {
        remote = await listKeywords(advertiser.customerId, {
          nccAdgroupId: ag.nccAdgroupId,
        })
      } catch (e) {
        // 단일 광고그룹 실패는 로그만 남기고 다음으로 (부분 동기화).
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

      // -- upsert 루프 ------------------------------------------------------
      for (const k of remote) {
        const dbAdgroupId = adgroupIdMap.get(k.nccAdgroupId)
        if (!dbAdgroupId) {
          // 광고그룹이 DB 에 없음 (광고그룹 미동기화 또는 삭제됨) → skip + 카운트.
          skipped++
          console.warn(
            `[syncKeywords] skip nccKeywordId=${k.nccKeywordId}: ` +
              `parent nccAdgroupId=${k.nccAdgroupId} not found in DB`,
          )
          continue
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
        syncedKeywords++
      }

      scannedAdgroups++
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
    },
  })

  revalidatePath(`/${advertiserId}/keywords`)

  return {
    ok: true,
    syncedKeywords,
    scannedAdgroups,
    skipped,
    durationMs: Date.now() - start,
  }
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
