"use server"

/**
 * F-5.x — 확장소재 관리 (Server Actions, P1 텍스트 2종 + 이미지)
 *
 * 본 PR 범위:
 *   1. syncAdExtensions          — 광고그룹 순회 → listAdExtensions(type 별) → DB upsert (F-5.1/F-5.2/F-5.3)
 *   2. bulkActionAdExtensions    — 다중 선택 ON/OFF (toggle, userLock) 일괄
 *   3. createAdExtensionsBatch   — 광고그룹 N × (텍스트 또는 이미지) M 일괄 생성 (F-5.3/F-5.4)
 *   4. deleteAdExtensionSingle   — 단건 삭제 (admin + 2차 확인) — image 시 Storage cleanup 동반
 *   5. uploadImage               — Supabase Storage 업로드 → publicURL 반환 (F-5.3)
 *
 * 본 PR 비대상 (후속 PR):
 *   - 인라인 편집(text 변경)     — type 별 fields 다양해 별도 PR
 *   - 다중 선택 삭제             — P1 비대상 (CLAUDE.md "비대상")
 *   - 9종 모든 type              — P1 화이트리스트는 headline / description / image (CLAUDE.md "비대상: P1 9종 확장소재")
 *   - 이미지 리사이즈/최적화     — 네이버 SA 사양 따름
 *   - signedURL                  — 본 PR은 publicURL 사용
 *
 * 운영 정책 (CLAUDE.md / backend-engineer.md):
 *   - 진입부 getCurrentAdvertiser(advertiserId) — 권한 + advertiser 객체
 *   - prisma 쿼리는 항상 `where: { adgroup: { campaign: { advertiserId } } }` 한정
 *     (AdExtension(ownerType=adgroup) → AdGroup → Campaign → advertiserId join)
 *   - 모든 변경(toggle/create/delete)은 ChangeBatch + ChangeItem (staging 의무)
 *   - SA 호출은 lib/naver-sa/ad-extensions 모듈만 통과 (HMAC / 토큰 버킷 / 에러 매핑은 client.ts)
 *   - AuditLog 1건 (시크릿 X — 메시지만 500자 컷)
 *   - revalidatePath(`/${advertiserId}/extensions`)
 *
 * 동기화 호출 패턴:
 *   - 네이버 SA 확장소재 목록은 **광고그룹 단위(ownerId)** 만 제공.
 *   - 광고그룹 N개 × type 2종 = 호출 N×2 회 (또는 type 미지정 시 광고그룹 당 1회).
 *   - Rate Limit 토큰 버킷이 광고주별 큐잉 → 별도 throttle 불필요.
 *
 * 시간 한계 (TODO):
 *   - P1 전제: 광고그룹 50~200개 × 광고그룹 당 확장소재 0~5개 → 단순 동기 처리 OK.
 *   - 한계 부딪히면 ChangeBatch + Chunk Executor 패턴(SPEC 3.5) 이관.
 *
 * 스키마 매핑 메모:
 *   - 앱 DB AdExtension.status: AdExtensionStatus enum (on/off/deleted)
 *   - 앱 DB AdExtension.inspectStatus: InspectStatus enum (pending/approved/rejected)
 *   - 앱 DB AdExtension.type: AdExtensionType enum (headline/description/image/...)
 *   - SA 응답 type 은 대문자(HEADLINE/DESCRIPTION) → 소문자 enum 으로 매핑
 *   - SA 응답: userLock(boolean) + status(string) + inspectStatus(string) → ads 패턴 동일
 *   - userLock=true → off, status='DELETED' → deleted, status='PAUSED' → off, else on
 *   - DB AdExtension.payload(Json): type 별 텍스트(headline/description) 추출 저장
 *     * headline: { headline: "..." }
 *     * description: { description: "..." }
 *   - DB AdExtension.ownerType = "adgroup" 고정 (P1)
 *   - DB AdExtension 모델엔 externalId 컬럼 없음 → 멱등성은 ChangeItem.idempotencyKey 단일 방어
 */

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { prisma } from "@/lib/db/prisma"
import { getCurrentAdvertiser, assertRole } from "@/lib/auth/access"
import { logAudit } from "@/lib/audit/log"
import { recordSyncAt } from "@/lib/sync/last-sync-at"
import { logSyncTiming } from "@/lib/sync/concurrency"
import { getAdminSupabase } from "@/lib/supabase/admin"
import {
  createAdExtensions,
  deleteAdExtension,
  listAdExtensions,
  updateAdExtensionsBulk,
  type AdExtension as SaAdExtension,
  type AdExtensionBulkUpdateItem,
  type AdExtensionCreateItem,
  type AdExtensionType as SaAdExtensionType,
} from "@/lib/naver-sa/ad-extensions"
import { NaverSaError, NaverSaValidationError } from "@/lib/naver-sa/errors"
import { getStatsChunked } from "@/lib/naver-sa/stats"
import type { AdMetrics, AdsPeriod } from "@/lib/dashboard/metrics"
import type {
  AdExtensionStatus,
  AdExtensionType,
  InspectStatus,
} from "@/lib/generated/prisma/client"
import type * as Prisma from "@/lib/generated/prisma/internal/prismaNamespace"

// =============================================================================
// 입력 type 화이트리스트 (P1: 텍스트 2종 + 이미지)
// =============================================================================
//
// CLAUDE.md "비대상: P1 9종 확장소재(P1은 3종만)".
// P1 화이트리스트: headline / description / image.
//
// 백엔드 ↔ SA 사이 type 변환:
//   - 입력(소문자): "headline" / "description" / "image"   (Prisma AdExtensionType enum 과 동일)
//   - SA 호출(대문자): "HEADLINE" / "DESCRIPTION" / "IMAGE" (lib/naver-sa/ad-extensions SaAdExtensionType)
//   - 응답 매핑(소문자): SA 응답 type 문자열 → 소문자 enum
//
// 텍스트 type(headline/description)과 이미지 type(image)은 페이로드 shape 가 다르다:
//   - 텍스트: { headline: "..." } / { description: "..." }
//   - 이미지: { image: { url, storagePath? } }
// → createAdExtensionsBatch / sync / single delete 모두 type 분기로 처리.

const InputTypeSchema = z.enum(["headline", "description", "image"])
type InputType = z.infer<typeof InputTypeSchema>

/** 텍스트 입력만 받는 type (이미지 입력 분기와 구분). */
type TextInputType = "headline" | "description"

const TYPE_TO_SA: Record<InputType, SaAdExtensionType> = {
  headline: "HEADLINE",
  description: "DESCRIPTION",
  image: "IMAGE",
}

/**
 * type 별 텍스트 길이 상한 (네이버 SA 가이드 기준 — P1 호출부 검증).
 * 이미지(image)는 텍스트 길이 적용 안 함 — undefined.
 */
const TYPE_MAX_LEN: Record<TextInputType, number> = {
  headline: 15,
  description: 45,
}

// =============================================================================
// 1. syncAdExtensions — NAVER → DB upsert (F-5.1 / F-5.2)
// =============================================================================

export type SyncExtensionsResult =
  | {
      ok: true
      synced: number
      scannedAdgroups: number
      skipped: number
      unsupportedAdgroupTypes: number
      durationMs: number
    }
  | { ok: false; error: string }

/**
 * `syncAdExtensions` 옵션 — 두 번째 인자.
 *
 * - `type`         : 단일 type 만 동기화 (미지정 시 headline/description/image 모두)
 * - `campaignIds`  : 광고그룹 query 시 캠페인 화이트리스트(앱 DB Campaign.id). 미지정 시 광고주 전체.
 *                    UI에서 "선택한 캠페인만 동기화" 시 사용 (F-5.1 부분 동기화).
 */
export type SyncAdExtensionsOptions = {
  type?: InputType
  campaignIds?: string[]
}

/**
 * 네이버 SA 가 "이 광고그룹은 이 확장소재 type 미지원" 을 알리는 응답 패턴 판별.
 *
 * 관찰된 메시지 예: "Cannot handle the request" — `mapHttpToDomainError` 가 title 그대로 둠.
 * 부분 실패가 아니라 **정상 skip** 으로 취급 (errors 누적 X). 호출부에서 카운터로만 집계.
 */
function isUnsupportedExtensionTypeError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  return e.message.includes("Cannot handle the request")
}

/**
 * 확장소재 동기화 (광고주 단위 — 광고그룹 순회).
 *
 *   1. getCurrentAdvertiser — 권한 검증 + advertiser
 *   2. hasKeys 확인 (시크릿 미입력이면 즉시 차단)
 *   3. DB AdGroup 매핑 테이블 (광고주 한정 + options.campaignIds 화이트리스트 적용 시 캠페인 한정)
 *   4. 각 광고그룹 × 각 type(headline/description/image) 마다 listAdExtensions 호출
 *      - type 미지정 시 셋 다 동기화
 *      - 단일 광고그룹 / type 호출 실패는 부분 실패 (다른 호출은 계속)
 *      - "Cannot handle the request" 응답은 silent skip (`unsupportedAdgroupTypes` 카운터)
 *      - 응답 type 은 입력 type 과 동일하다고 가정하나, 응답에 다른 type 섞여 있으면 입력 화이트리스트 외는 skip
 *   5. nccExtId unique upsert
 *      - ownerType = "adgroup" 고정 (P1)
 *      - payload: type 별 텍스트 추출 ({ headline: "..." } 또는 { description: "..." })
 *      - status / inspectStatus mapping (ads 패턴 동일)
 *      - 광고그룹 미동기화 row 는 skip + skippedCount
 *   6. AuditLog 1건
 *
 * 본 액션은 "조회 → 적재" 만 — 외부 변경 X → ChangeBatch 미사용.
 *
 * 시간 한계 (BACKLOG: 동기화 시간 한계):
 *   - extensions 는 광고그룹 단위 sequential listAdExtensions (catch 분기 정밀해서
 *     keywords/ads 처럼 chunk 병렬화 미적용 — 변경 위험 대비 가치 낮음).
 *   - 종료 시 logSyncTiming 으로 totalMs 출력 — 240s 초과 지속 발생 시
 *     ChangeBatch + Chunk Executor (SPEC 3.5) 이관 트리거.
 */
export async function syncAdExtensions(
  advertiserId: string,
  options: SyncAdExtensionsOptions = {},
): Promise<SyncExtensionsResult> {
  const { advertiser, user } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    return { ok: false, error: "API 키/시크릿 미입력" }
  }

  const { type, campaignIds } = options
  const hasCampaignFilter =
    Array.isArray(campaignIds) && campaignIds.length > 0

  const start = Date.now()

  // -- DB 광고그룹 매핑 테이블 (광고주 한정 + 선택한 캠페인 한정) -------------
  const adgroups = await prisma.adGroup.findMany({
    where: {
      campaign: {
        advertiserId,
        ...(hasCampaignFilter ? { id: { in: campaignIds } } : {}),
      },
      status: { not: "deleted" },
    },
    select: { id: true, nccAdgroupId: true },
  })

  if (adgroups.length === 0) {
    await logAudit({
      userId: user.id,
      action: "adext.sync",
      targetType: "Advertiser",
      targetId: advertiserId,
      before: null,
      after: {
        synced: 0,
        scannedAdgroups: 0,
        skipped: 0,
        unsupportedAdgroupTypes: 0,
        customerId: advertiser.customerId,
        type: type ?? "all",
        campaignIds: hasCampaignFilter ? campaignIds : undefined,
        note: "no-adgroups",
      },
    })
    // lastSyncAt 갱신 — 광고그룹 0개도 "동기화 시도 완료" 로 기록 (UI 표시 일관성).
    // 캠페인 필터로 부분 동기화한 경우에도 갱신 — "동기화했는데 표시 안 됨" 혼란 방지.
    await recordSyncAt(advertiserId, "extensions")
    revalidatePath(`/${advertiserId}/extensions`)
    return {
      ok: true,
      synced: 0,
      scannedAdgroups: 0,
      skipped: 0,
      unsupportedAdgroupTypes: 0,
      durationMs: Date.now() - start,
    }
  }

  const adgroupIdMap = new Map<string, string>(
    adgroups.map((g) => [g.nccAdgroupId, g.id]),
  )

  // 동기화 대상 type 목록: 입력 미지정 → 텍스트+이미지 모두, 지정 → 하나만.
  const targetTypes: InputType[] = type
    ? [type]
    : ["headline", "description", "image"]

  let synced = 0
  let skipped = 0
  let scannedAdgroups = 0
  let unsupportedAdgroupTypes = 0

  try {
    for (const ag of adgroups) {
      // 광고그룹 1개 = type 별 호출 합계 1번 ("scannedAdgroups" 의미는 "광고그룹 1개 단위로 진행됨").
      // 부분 실패 허용 (Promise.allSettled): 단일 광고그룹의 type 1개 실패해도 다른 type 차단 X.
      //
      // 성능: 광고그룹별 3 type (headline/description/image) 병렬 호출.
      //   - Rate Limit 토큰 버킷이 광고주별 큐잉(client.ts) → 200/분 burst 안에서 자동 wait.
      //   - 광고그룹 N=50 기준 기존 순차 N×3 = ~30초 → 병렬 N×1 ≈ 10초 수준 (약 3배 단축).
      // type 파라미터 미지정 — 그룹의 모든 확장소재를 1번 호출로 가져옴.
      // (이전: type 명시 3회 병렬 호출 시 그룹별로 모든 type 이 "Cannot handle the request"
      //  로 거절되어 synced=0 발생. 코드 주석 159 권장 패턴으로 변경.)
      let touched = false
      let remote: SaAdExtension[] = []
      try {
        remote = await listAdExtensions(advertiser.customerId, {
          nccAdgroupId: ag.nccAdgroupId,
        })
        touched = true
      } catch (err) {
        if (isUnsupportedExtensionTypeError(err)) {
          unsupportedAdgroupTypes++
          touched = true
        } else if (err instanceof NaverSaValidationError) {
          // 응답 형식 미스매치 — raw 응답을 1번 출력해 실제 필드 구조 확인.
          // 처음 1건만 출력 (반복 로그 폭주 방지).
          if (synced === 0 && skipped === 0) {
            console.warn(
              `[syncAdExtensions] zod validation failed nccAdgroupId=${ag.nccAdgroupId} raw=`,
              JSON.stringify(err.context.raw, null, 2)?.slice(0, 3000),
            )
          } else {
            console.warn(
              `[syncAdExtensions] zod validation failed nccAdgroupId=${ag.nccAdgroupId}: ${err.message}`,
            )
          }
        } else if (err instanceof NaverSaError) {
          console.warn(
            `[syncAdExtensions] listAdExtensions failed for nccAdgroupId=${ag.nccAdgroupId}: ${err.message}`,
          )
        } else {
          console.warn(
            `[syncAdExtensions] listAdExtensions unknown error for nccAdgroupId=${ag.nccAdgroupId}:`,
            err,
          )
        }
      }

      // 디버깅: 응답에 어떤 type 코드가 오는지 확인 (P1 화이트리스트 외 확인용).
      if (remote.length > 0) {
        const types = Array.from(new Set(remote.map((e) => e.type)))
        console.log(
          `[syncAdExtensions] nccAdgroupId=${ag.nccAdgroupId} count=${remote.length} types=${types.join(",")}`,
        )
      }

      {
        for (const e of remote) {
          // 응답 type → 앱 enum 매핑.
          //   HEADLINE          → headline
          //   DESCRIPTION       → description
          //   IMAGE / POWER_LINK_IMAGE → image
          // P1 화이트리스트 외(예: SUBLINK / LOCATION 등)는 skip.
          const rawType = e.type?.toString().toUpperCase()
          let t: InputType | null
          if (rawType === "HEADLINE") t = "headline"
          else if (rawType === "DESCRIPTION") t = "description"
          else if (rawType === "IMAGE" || rawType === "POWER_LINK_IMAGE")
            t = "image"
          else t = null

          if (!t) {
            skipped++
            console.warn(
              `[syncAdExtensions] skip nccExtId=${e.nccExtId}: unsupported type=${e.type}`,
            )
            continue
          }

          const dbAdgroupId = adgroupIdMap.get(e.ownerId)
          if (!dbAdgroupId) {
            skipped++
            console.warn(
              `[syncAdExtensions] skip nccExtId=${e.nccExtId}: parent ownerId=${e.ownerId} not found in DB`,
            )
            continue
          }

          const dbType: AdExtensionType = t // headline / description / image (소문자 그대로)
          const mappedStatus = mapExtensionStatus(e)
          const mappedInspect = mapInspectStatus(e)
          // type 별 페이로드 분기:
          //   - 텍스트(headline/description): { [t]: text } (string 추출)
          //   - 이미지(image): { image: { url, storagePath? } }
          //     storagePath는 sync 단계에서는 알 수 없음 (외부 등록분일 수 있음). 누락 OK.
          let payload: Record<string, unknown>
          if (t === "image") {
            const img = extractImage(e)
            payload = img ? { image: img } : {}
          } else {
            const text = extractText(e, t)
            payload = text ? { [t]: text } : {}
          }
          const inspectMemoVal =
            typeof e.inspectMemo === "string" && e.inspectMemo.length > 0
              ? e.inspectMemo
              : null
          const rawJson = e as unknown as Prisma.InputJsonValue

          const baseCreateData: {
            ownerId: string
            ownerType: string
            nccExtId: string
            type: AdExtensionType
            payload: Prisma.InputJsonValue
            inspectStatus: InspectStatus
            status: AdExtensionStatus
            raw: Prisma.InputJsonValue
            inspectMemo?: string
          } = {
            ownerId: dbAdgroupId,
            ownerType: "adgroup",
            nccExtId: e.nccExtId,
            type: dbType,
            payload: payload as Prisma.InputJsonValue,
            inspectStatus: mappedInspect,
            status: mappedStatus,
            raw: rawJson,
          }
          if (inspectMemoVal !== null) baseCreateData.inspectMemo = inspectMemoVal

          const baseUpdateData: {
            ownerId: string
            ownerType: string
            type: AdExtensionType
            payload: Prisma.InputJsonValue
            inspectStatus: InspectStatus
            status: AdExtensionStatus
            raw: Prisma.InputJsonValue
            inspectMemo?: string
          } = {
            ownerId: dbAdgroupId,
            ownerType: "adgroup",
            type: dbType,
            payload: payload as Prisma.InputJsonValue,
            inspectStatus: mappedInspect,
            status: mappedStatus,
            raw: rawJson,
          }
          if (inspectMemoVal !== null) baseUpdateData.inspectMemo = inspectMemoVal

          await prisma.adExtension.upsert({
            where: { nccExtId: e.nccExtId },
            create: baseCreateData,
            update: baseUpdateData,
          })
          synced++
        }
        touched = true
      }
      if (touched) scannedAdgroups++
    }
  } catch (e) {
    console.error("[syncAdExtensions] upsert failed:", e)
    return { ok: false, error: "DB 적재 중 오류" }
  }

  await logAudit({
    userId: user.id,
    action: "adext.sync",
    targetType: "Advertiser",
    targetId: advertiserId,
    before: null,
    after: {
      synced,
      scannedAdgroups,
      skipped,
      unsupportedAdgroupTypes,
      customerId: advertiser.customerId,
      type: type ?? "all",
      campaignIds: hasCampaignFilter ? campaignIds : undefined,
    },
  })

  // lastSyncAt 갱신 (UI 헤더 "마지막 동기화" 배지). 실패해도 sync 결과는 정상 반환.
  // 캠페인 필터로 부분 동기화한 경우에도 갱신 — "동기화했는데 표시 안 됨" 혼란 방지.
  await recordSyncAt(advertiserId, "extensions")

  revalidatePath(`/${advertiserId}/extensions`)

  const totalMs = Date.now() - start
  logSyncTiming({
    kind: "extensions",
    advertiserId,
    totalMs,
    scannedAdgroups,
    upserts: synced,
    maxDurationMs: 300_000,
  })

  return {
    ok: true,
    synced,
    scannedAdgroups,
    skipped,
    unsupportedAdgroupTypes,
    durationMs: totalMs,
  }
}

// =============================================================================
// helpers — SA AdExtension → 앱 enum / payload 매핑
// =============================================================================

/**
 * 네이버 SA AdExtension → 앱 AdExtensionStatus enum 매핑.
 *
 * 매핑 정책 (ads / keywords 동일):
 *   - status='DELETED' (또는 deleted=true) → 'deleted'
 *   - userLock=true                        → 'off'
 *   - status='PAUSED'                      → 'off'
 *   - 그 외                                → 'on'
 */
function mapExtensionStatus(e: SaAdExtension): AdExtensionStatus {
  const anyE = e as unknown as {
    userLock?: boolean
    status?: string
    deleted?: boolean
  }
  if (anyE.deleted === true) return "deleted"
  if (
    typeof anyE.status === "string" &&
    anyE.status.toUpperCase() === "DELETED"
  ) {
    return "deleted"
  }
  if (anyE.userLock === true) return "off"
  if (
    typeof anyE.status === "string" &&
    anyE.status.toUpperCase() === "PAUSED"
  ) {
    return "off"
  }
  return "on"
}

/**
 * 네이버 SA AdExtension.inspectStatus → 앱 InspectStatus enum 매핑.
 *
 * keywords/ads 패턴 동일:
 *   - APPROVED / PASSED / OK / ELIGIBLE  → approved
 *   - REJECTED / FAILED / DENIED         → rejected
 *   - 그 외 (UNDER_REVIEW / 누락)        → pending
 */
function mapInspectStatus(e: SaAdExtension): InspectStatus {
  const raw = (e.inspectStatus ?? "").toString().toUpperCase().trim()
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
 * 응답 페이로드에서 type 별 텍스트 추출.
 *
 * 네이버 SA 실제 응답 (확인됨):
 *   { type: "HEADLINE", adExtension: { headline: "..." } }
 *   { type: "DESCRIPTION", adExtension: { description: "..." } }
 *
 * 호환성: 일부 응답은 e.headline / e.description 으로 직접 노출되는 경우도 대비.
 * 누락 시 빈 문자열 반환 (호출부가 payload 비우기 처리).
 */
function extractText(e: SaAdExtension, t: TextInputType): string {
  const anyE = e as unknown as Record<string, unknown>
  const wrapper = anyE.adExtension as Record<string, unknown> | undefined
  const fromWrapper = wrapper?.[t]
  if (typeof fromWrapper === "string") return fromWrapper
  const direct = anyE[t]
  return typeof direct === "string" ? direct : ""
}

/**
 * 응답 페이로드에서 image 타입 정보 추출.
 *
 * 네이버 SA 실제 응답 (확인됨, type=POWER_LINK_IMAGE 또는 IMAGE):
 *   { adExtension: { imagePath: "/Mj.../...png", imageWidth: 640, imageHeight: 640 } }
 *
 * imagePath 는 절대 URL 이 아닌 path 형태. 그대로 url 필드에 저장 (후속 PR에서
 * 호스트 prefix 처리 가능). 누락 시 null.
 */
function extractImage(e: SaAdExtension): { url: string } | null {
  const anyE = e as unknown as Record<string, unknown>
  const wrapper = anyE.adExtension as Record<string, unknown> | undefined
  const path = wrapper?.imagePath
  if (typeof path === "string" && path.length > 0) {
    return { url: path }
  }
  // 호환성: 일부 응답은 e.image 직접 노출 가능 (구 sample shape 보존)
  const img = anyE.image
  if (typeof img === "string" && img.length > 0) return { url: img }
  if (img && typeof img === "object") {
    const url = (img as Record<string, unknown>).url
    if (typeof url === "string" && url.length > 0) return { url }
  }
  return null
}

// =============================================================================
// 2. bulkActionAdExtensions — 다중 선택 ON/OFF 일괄 (toggle)
// =============================================================================
//
// UI 흐름:
//   - 사용자가 확장소재 row 다중 선택 → 액션 모달(toggle ON/OFF) 선택
//   - RSC props 기반 미리보기로 충분 (확장소재는 입찰가 없음)
//   - 확정 시 본 액션 호출
//
// 액션 1종:
//   - toggle: userLock 일괄 적용 (true=OFF, false=ON)
//
// 광고주 한정 join: AdExtension(ownerType=adgroup) → AdGroup → Campaign → advertiserId
//   prisma 스키마 (AdExtension.adgroup 옵셔널 relation, ownerType=adgroup 가정).
//
// TODO(5천 건 한계): 본 PR 은 단일 PUT 시도. 운영 측정 후 batch-executor-job 패턴 이관.

const bulkActionExtensionsSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("toggle"),
    items: z
      .array(
        z.object({
          extensionId: z.string().min(1), // 앱 DB AdExtension.id
          userLock: z.boolean(), // true → OFF, false → ON
        }),
      )
      .min(1)
      .max(500),
  }),
])

export type BulkActionAdExtensionsInput = z.infer<
  typeof bulkActionExtensionsSchema
>

export type BulkActionAdExtensionItemResult = {
  extensionId: string
  ok: boolean
  error?: string
}

export type BulkActionAdExtensionsResult = {
  batchId: string
  total: number
  success: number
  failed: number
  items: BulkActionAdExtensionItemResult[]
}

/**
 * 확장소재 다중 선택 일괄 액션 확정.
 *
 *   1. getCurrentAdvertiser + hasKeys
 *   2. Zod 검증 + extensionId dedup (마지막 항목으로 대체 — idempotencyKey unique 충족)
 *   3. 광고주 한정 조회 (adgroup.campaign.advertiserId join, ownerType=adgroup 가정)
 *   4. ChangeBatch (status='running', action='adext.toggle')
 *   5. ChangeItem createMany — before/after 에 userLock 만
 *   6. updateAdExtensionsBulk(customerId, items, "userLock") — 단일 PUT
 *   7. 응답 매핑 — 성공 → DB update (status 재계산) + ChangeItem='done'
 *      누락 → 'failed' + "응답 누락"
 *   8. ChangeBatch finalize (success>0 → done, 0 → failed)
 *   9. AuditLog 1건
 *  10. revalidatePath
 */
export async function bulkActionAdExtensions(
  advertiserId: string,
  input: BulkActionAdExtensionsInput,
): Promise<BulkActionAdExtensionsResult> {
  const { advertiser, user } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    throw new Error("API 키/시크릿 미입력")
  }

  const parsed = bulkActionExtensionsSchema.parse(input)

  // -- 입력 정규화 + dedup ----------------------------------------------------
  const toggleByExtId = new Map<string, boolean>()
  for (const it of parsed.items) {
    toggleByExtId.set(it.extensionId, it.userLock)
  }
  const extIds = Array.from(toggleByExtId.keys())

  // -- 광고주 한정 조회 (adgroup → campaign → advertiserId join) -------------
  // ownerType=adgroup 가정. relation: AdExtension.adgroup (옵셔널)
  const dbExts = await prisma.adExtension.findMany({
    where: {
      ownerType: "adgroup",
      adgroup: { campaign: { advertiserId } },
      id: { in: extIds },
    },
    select: {
      id: true,
      nccExtId: true,
      status: true,
    },
  })

  if (dbExts.length !== extIds.length) {
    throw new Error("일부 확장소재가 광고주 소속이 아닙니다")
  }

  const rowById = new Map(dbExts.map((e) => [e.id, e]))

  // -- ChangeBatch 생성 -------------------------------------------------------
  const action = "adext.toggle"
  const total = extIds.length

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
  const itemsForApi: AdExtensionBulkUpdateItem[] = []
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

  for (const eid of extIds) {
    const r = rowById.get(eid)!
    const newLock = toggleByExtId.get(eid)!
    const beforeLock = r.status === "off"
    const before = { userLock: beforeLock } as Prisma.InputJsonValue
    const after = { userLock: newLock } as Prisma.InputJsonValue

    itemsForApi.push({
      nccExtId: r.nccExtId,
      userLock: newLock,
    })
    changeItemSeeds.push({
      batchId: batch.id,
      targetType: "AdExtension",
      targetId: r.nccExtId,
      before,
      after,
      idempotencyKey: `${batch.id}:${r.nccExtId}`,
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
  let success = 0
  let failed = 0
  const results: BulkActionAdExtensionItemResult[] = []

  try {
    const updated = await updateAdExtensionsBulk(
      advertiser.customerId,
      itemsForApi,
      "userLock",
    )
    const updatedMap = new Map(updated.map((u) => [u.nccExtId, u]))

    for (const eid of extIds) {
      const r = rowById.get(eid)!
      const u = updatedMap.get(r.nccExtId)

      if (u) {
        await prisma.adExtension.update({
          where: { id: r.id },
          data: {
            status: mapExtensionStatus(u),
            raw: u as unknown as Prisma.InputJsonValue,
          },
        })
        await prisma.changeItem.updateMany({
          where: { batchId: batch.id, targetId: r.nccExtId },
          data: { status: "done" },
        })
        success++
        results.push({ extensionId: eid, ok: true })
      } else {
        await prisma.changeItem.updateMany({
          where: { batchId: batch.id, targetId: r.nccExtId },
          data: { status: "failed", error: "응답에 누락" },
        })
        failed++
        results.push({ extensionId: eid, ok: false, error: "응답 누락" })
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const safeMsg = msg.slice(0, 500)
    await prisma.changeItem.updateMany({
      where: { batchId: batch.id, status: "pending" },
      data: { status: "failed", error: safeMsg },
    })
    success = 0
    failed = total
    results.length = 0
    for (const eid of extIds) {
      results.push({ extensionId: eid, ok: false, error: safeMsg })
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

  // -- AuditLog 1건 (시크릿 X) ------------------------------------------------
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

  revalidatePath(`/${advertiserId}/extensions`)

  return { batchId: batch.id, total, success, failed, items: results }
}

// =============================================================================
// 3. createAdExtensionsBatch — 광고그룹 N × 텍스트 M 일괄 생성 (F-5.4)
// =============================================================================
//
// UI 흐름 (F-5.4):
//   - 사용자가 type 선택 + 텍스트 1~M개 입력 + 적용할 광고그룹 1~N개 선택
//   - "추가하기" → 단일 Server Action 호출
//   - 광고그룹 N × 텍스트 M = 총 N×M 개의 AdExtension 생성
//
// 자연키 충돌 정책:
//   - 본 PR 은 자연키 사전 검사 X (동일 광고그룹에 같은 텍스트 중복 등록 가능 — 사용자 책임)
//   - 후속 PR: (ownerId, type, text) 자연키 룰 추가 가능
//
// 멱등성:
//   - externalId 자동 생성: `addext-${crypto.randomUUID()}` (사용자 부담 X)
//   - idempotencyKey: `${batchId}:create:${externalId}` (ChangeItem unique 충족)
//   - DB AdExtension 모델엔 externalId 컬럼 없음 → ChangeItem 단일 방어
//
// TODO(5천 건 한계): N=50 × M=20 = 최대 1000건. 단일 POST 호출 OK.
//   더 큰 규모(또는 다른 광고주별 호출 분산 필요) 시 batch-executor-job 패턴 이관.

/**
 * type 별 입력 shape 분기:
 *   - headline / description: texts 배열 필수 (길이 1~20, 텍스트 길이 type 별 상한)
 *   - image:                  imageUrls 배열 필수 (publicURL — uploadImage Server Action 결과)
 *
 * superRefine 로 type 별 필드 존재성 + 텍스트 길이 상한 검증.
 */
const createExtensionsSchema = z
  .object({
    type: InputTypeSchema,
    // 텍스트(headline/description) 입력. image type 인 경우 비어 있어야 함.
    // 1차 max 는 description 상한(45). type=headline 일 때 superRefine 에서 15자 추가 검증.
    texts: z.array(z.string().min(1).max(45)).max(20).optional(),
    // 이미지(image) 입력. text type 인 경우 비어 있어야 함.
    // 클라이언트가 uploadImage 로 미리 업로드한 publicURL 배열을 전달.
    imageUrls: z.array(z.string().url()).max(20).optional(),
    nccAdgroupIds: z.array(z.string().min(1)).min(1).max(50),
  })
  .superRefine((v, ctx) => {
    if (v.type === "headline" || v.type === "description") {
      if (!v.texts || v.texts.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["texts"],
          message: "텍스트가 필요합니다",
        })
        return
      }
      const limit = TYPE_MAX_LEN[v.type]
      v.texts.forEach((t, i) => {
        if (t.length > limit) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["texts", i],
            message: `${v.type} 텍스트는 ${limit}자 이내`,
          })
        }
      })
    } else if (v.type === "image") {
      if (!v.imageUrls || v.imageUrls.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["imageUrls"],
          message: "이미지가 필요합니다",
        })
      }
    }
  })

export type CreateAdExtensionsBatchInput = z.infer<
  typeof createExtensionsSchema
>

export type CreateAdExtensionsBatchItem = {
  index: number // 입력 평탄 배열 0-based 인덱스 (광고그룹×텍스트/이미지 — UI 결과 매핑용)
  ownerId: string // nccAdgroupId
  text?: string // 텍스트(headline/description) 입력 시
  imageUrl?: string // 이미지(image) 입력 시
  ok: boolean
  nccExtId?: string // 성공 시
  error?: string // 실패 시
}

export type CreateAdExtensionsBatchResult = {
  batchId: string
  total: number
  success: number
  failed: number
  items: CreateAdExtensionsBatchItem[]
}

/**
 * 확장소재 일괄 생성 (광고그룹 N × 텍스트 M).
 *
 *   1. getCurrentAdvertiser + hasKeys
 *   2. Zod 검증 (텍스트 길이 type 별 상한 superRefine)
 *   3. 광고그룹 광고주 한정 검증 (nccAdgroupIds 모두 광고주 소속인지)
 *   4. 평탄화: (광고그룹 × 텍스트) 조합 N×M 개 = createItems
 *      - externalId 자동: `addext-${crypto.randomUUID()}`
 *   5. ChangeBatch (action='adext.create')
 *   6. ChangeItem createMany — idempotencyKey unique
 *      - targetId: `pending:${externalId}` (응답 매핑 후 nccExtId 로 갱신)
 *   7. createAdExtensions(customerId, items) — 단일 POST 배열 호출
 *   8. 응답 매핑 (createKeywordsBatch 패턴):
 *      - 길이 일치 → 인덱스 매핑
 *      - 길이 불일치 → (ownerId, type, text) 정확 매칭 (응답 type 누락 시 입력 type 사용)
 *   9. DB upsert (nccExtId unique) + ChangeItem 'done'/'failed' 갱신
 *  10. ChangeBatch finalize
 *  11. AuditLog 1건
 *  12. revalidatePath
 */
export async function createAdExtensionsBatch(
  advertiserId: string,
  input: CreateAdExtensionsBatchInput,
): Promise<CreateAdExtensionsBatchResult> {
  const { advertiser, user } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    throw new Error("API 키/시크릿 미입력")
  }

  const parsed = createExtensionsSchema.parse(input)
  const sa = TYPE_TO_SA[parsed.type]
  const isImage = parsed.type === "image"

  // -- 광고그룹 광고주 한정 검증 ---------------------------------------------
  // 입력 nccAdgroupIds 가 모두 광고주 소속인지 확인 (campaign.advertiserId join).
  const uniqAdgroupIds = Array.from(new Set(parsed.nccAdgroupIds))
  const dbAdgroups = await prisma.adGroup.findMany({
    where: {
      nccAdgroupId: { in: uniqAdgroupIds },
      campaign: { advertiserId },
    },
    select: { id: true, nccAdgroupId: true },
  })
  if (dbAdgroups.length !== uniqAdgroupIds.length) {
    throw new Error("일부 광고그룹이 광고주 소속이 아닙니다")
  }
  const adgroupDbIdMap = new Map<string, string>(
    dbAdgroups.map((g) => [g.nccAdgroupId, g.id]),
  )

  // -- (광고그룹 × 입력값) 조합 평탄화 ---------------------------------------
  // 입력 순서 보존: 첫 광고그룹의 모든 입력값 → 두 번째 광고그룹의 모든 입력값 ...
  // type=headline/description 이면 input=text, type=image 이면 input=imageUrl.
  type FlatRow = {
    index: number // 평탄 0-based
    nccAdgroupId: string
    text?: string // headline/description 인 경우
    imageUrl?: string // image 인 경우
    externalId: string
  }
  const flat: FlatRow[] = []
  let flatIdx = 0
  // 입력값 배열 통일 (text 또는 imageUrl).
  const inputValues: string[] = isImage
    ? (parsed.imageUrls ?? [])
    : (parsed.texts ?? [])
  for (const agId of uniqAdgroupIds) {
    for (const v of inputValues) {
      flat.push({
        index: flatIdx++,
        nccAdgroupId: agId,
        text: isImage ? undefined : v,
        imageUrl: isImage ? v : undefined,
        externalId: `addext-${crypto.randomUUID()}`,
      })
    }
  }
  const total = flat.length

  // -- ChangeBatch 생성 -------------------------------------------------------
  const action = "adext.create"
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
        type: parsed.type,
        adgroups: uniqAdgroupIds.length,
        items: inputValues.length,
        total,
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
  const seeds: CreateItemSeed[] = flat.map((row) => {
    // type 별 after payload 분기 (sync / DB upsert 와 동일 shape):
    //   - 텍스트: { [type]: text }
    //   - 이미지: { image: { url } }
    const afterPayload: Record<string, unknown> = {
      ownerType: "adgroup",
      nccAdgroupId: row.nccAdgroupId,
      type: parsed.type,
    }
    if (isImage) {
      afterPayload.image = { url: row.imageUrl }
    } else {
      afterPayload[parsed.type] = row.text
    }
    return {
      batchId: batch.id,
      targetType: "AdExtension",
      targetId: `pending:${row.externalId}`,
      before: {} as Prisma.InputJsonValue,
      after: afterPayload as Prisma.InputJsonValue,
      idempotencyKey: `${batch.id}:create:${row.externalId}`,
      status: "pending" as const,
    }
  })
  await prisma.changeItem.createMany({ data: seeds })

  // -- SA createAdExtensions 호출 --------------------------------------------
  // 모든 항목 단일 POST. type 별 페이로드:
  //   - 텍스트(headline/description): { [type]: text }
  //   - 이미지(image): { image: { url } } — 네이버 SA passthrough (sample 기준)
  const items: AdExtensionCreateItem[] = flat.map((row) => {
    const base: AdExtensionCreateItem = {
      ownerId: row.nccAdgroupId,
      ownerType: "ADGROUP",
      type: sa,
      externalId: row.externalId,
    }
    if (isImage) {
      base.image = { url: row.imageUrl }
    } else {
      ;(base as Record<string, unknown>)[parsed.type] = row.text
    }
    return base
  })

  let successTotal = 0
  let failedTotal = 0
  const resultItems: CreateAdExtensionsBatchItem[] = []

  try {
    const created = await createAdExtensions(advertiser.customerId, items)

    // 응답 매핑 — 1차: 길이 일치 → 인덱스 매핑
    //              2차: 불일치 → (ownerId, type, 입력값) 정확 매칭
    //                   - 텍스트: 입력값=text
    //                   - 이미지: 입력값=imageUrl (응답 image.url)
    const indexMatch = created.length === items.length
    const respByExactKey = new Map<string, SaAdExtension>()
    if (!indexMatch) {
      for (const c of created) {
        const respTypeLc =
          typeof c.type === "string" && c.type.length > 0
            ? c.type.toLowerCase()
            : parsed.type
        if (isImage) {
          const img = extractImage(c)
          if (img?.url) {
            respByExactKey.set(`${c.ownerId}::${respTypeLc}::${img.url}`, c)
          }
        } else {
          const txt = extractText(c, parsed.type as TextInputType)
          if (txt) {
            respByExactKey.set(`${c.ownerId}::${respTypeLc}::${txt}`, c)
          }
        }
      }
    }

    for (const row of flat) {
      const inputVal = isImage ? (row.imageUrl ?? "") : (row.text ?? "")
      const key = `${row.nccAdgroupId}::${parsed.type}::${inputVal}`
      const u: SaAdExtension | undefined = indexMatch
        ? created[row.index]
        : respByExactKey.get(key)

      if (u) {
        await prisma.changeItem.updateMany({
          where: {
            batchId: batch.id,
            idempotencyKey: `${batch.id}:create:${row.externalId}`,
          },
          data: { targetId: u.nccExtId, status: "done" },
        })

        const dbAdgroupId = adgroupDbIdMap.get(row.nccAdgroupId)
        if (!dbAdgroupId) {
          // 사전 검증 통과했으므로 발생 불가. 방어적 폴백.
          await prisma.changeItem.updateMany({
            where: {
              batchId: batch.id,
              idempotencyKey: `${batch.id}:create:${row.externalId}`,
            },
            data: { status: "failed", error: "광고그룹 매핑 불가" },
          })
          resultItems.push({
            index: row.index,
            ownerId: row.nccAdgroupId,
            text: row.text,
            imageUrl: row.imageUrl,
            ok: false,
            error: "광고그룹 매핑 불가",
          })
          failedTotal++
          continue
        }

        const respTypeLc =
          typeof u.type === "string" && u.type.length > 0
            ? u.type.toLowerCase()
            : parsed.type
        const dbType: AdExtensionType =
          respTypeLc === "headline" ||
          respTypeLc === "description" ||
          respTypeLc === "image"
            ? respTypeLc
            : parsed.type
        // type 별 payload 분기:
        //   - 텍스트: { [type]: text } (응답 우선, 누락 시 입력 폴백)
        //   - 이미지: { image: { url, storagePath? } }
        //     storagePath 는 입력 imageUrl 이 Supabase Storage publicURL 인 경우 추출 가능 — 단순화: 미저장
        let payload: Prisma.InputJsonValue
        if (isImage) {
          const respImg = extractImage(u)
          const url = respImg?.url ?? row.imageUrl ?? ""
          payload = { image: { url } } as Prisma.InputJsonValue
        } else {
          const respText = extractText(u, parsed.type as TextInputType)
          const text = respText.length > 0 ? respText : (row.text ?? "")
          payload = { [parsed.type]: text } as Prisma.InputJsonValue
        }
        const inspectMemoVal =
          typeof u.inspectMemo === "string" && u.inspectMemo.length > 0
            ? u.inspectMemo
            : null
        const rawJson = u as unknown as Prisma.InputJsonValue

        const createData: {
          ownerId: string
          ownerType: string
          nccExtId: string
          type: AdExtensionType
          payload: Prisma.InputJsonValue
          inspectStatus: InspectStatus
          status: AdExtensionStatus
          raw: Prisma.InputJsonValue
          inspectMemo?: string
        } = {
          ownerId: dbAdgroupId,
          ownerType: "adgroup",
          nccExtId: u.nccExtId,
          type: dbType,
          payload,
          inspectStatus: mapInspectStatus(u),
          status: mapExtensionStatus(u),
          raw: rawJson,
        }
        if (inspectMemoVal !== null) createData.inspectMemo = inspectMemoVal

        const updateData: {
          ownerId: string
          ownerType: string
          type: AdExtensionType
          payload: Prisma.InputJsonValue
          inspectStatus: InspectStatus
          status: AdExtensionStatus
          raw: Prisma.InputJsonValue
          inspectMemo?: string
        } = {
          ownerId: dbAdgroupId,
          ownerType: "adgroup",
          type: dbType,
          payload,
          inspectStatus: mapInspectStatus(u),
          status: mapExtensionStatus(u),
          raw: rawJson,
        }
        if (inspectMemoVal !== null) updateData.inspectMemo = inspectMemoVal

        await prisma.adExtension.upsert({
          where: { nccExtId: u.nccExtId },
          create: createData,
          update: updateData,
        })

        resultItems.push({
          index: row.index,
          ownerId: row.nccAdgroupId,
          text: row.text,
          imageUrl: row.imageUrl,
          ok: true,
          nccExtId: u.nccExtId,
        })
        successTotal++
      } else {
        const errMsg = indexMatch
          ? "응답에 누락"
          : `응답 매핑 실패 (응답 길이=${created.length}, 입력=${items.length})`
        await prisma.changeItem.updateMany({
          where: {
            batchId: batch.id,
            idempotencyKey: `${batch.id}:create:${row.externalId}`,
          },
          data: { status: "failed", error: errMsg },
        })
        resultItems.push({
          index: row.index,
          ownerId: row.nccAdgroupId,
          text: row.text,
          imageUrl: row.imageUrl,
          ok: false,
          error: errMsg,
        })
        failedTotal++
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const safeMsg = msg.slice(0, 500)
    await prisma.changeItem.updateMany({
      where: { batchId: batch.id },
      data: { status: "failed", error: safeMsg },
    })
    successTotal = 0
    failedTotal = total
    resultItems.length = 0
    for (const row of flat) {
      resultItems.push({
        index: row.index,
        ownerId: row.nccAdgroupId,
        text: row.text,
        imageUrl: row.imageUrl,
        ok: false,
        error: safeMsg,
      })
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

  // -- AuditLog 1건 (시크릿 X) ------------------------------------------------
  await logAudit({
    userId: user.id,
    action,
    targetType: "ChangeBatch",
    targetId: batch.id,
    before: null,
    after: {
      advertiserId,
      type: parsed.type,
      adgroups: uniqAdgroupIds.length,
      items: inputValues.length,
      total,
      success: successTotal,
      failed: failedTotal,
    },
  })

  revalidatePath(`/${advertiserId}/extensions`)

  return {
    batchId: batch.id,
    total,
    success: successTotal,
    failed: failedTotal,
    items: resultItems,
  }
}

// =============================================================================
// 4. deleteAdExtensionSingle — 단건 삭제 (admin + 2차 확인)
// =============================================================================
//
// CLAUDE.md "비대상" 정책:
//   - 다중 선택 삭제는 P1 비대상 (OFF로 대체)
//   - 단건 삭제도 admin + 2차 확인 필수
//
// 흐름 (deleteAdSingle / deleteKeywordSingle 패턴 동일):
//   1. assertRole("admin")
//   2. getCurrentAdvertiser + hasKeys
//   3. Zod 검증
//   4. 광고주 한정 조회 (ownerType=adgroup → AdGroup → Campaign → advertiserId)
//   5. 2차 확인: confirmText.trim() === payload.headline 또는 payload.description 일치
//      (확장소재는 nccExtId 보다 텍스트가 사용자 친화 식별자 — 텍스트 재입력)
//   6. idempotent: 이미 status='deleted' → ChangeBatch 미생성, 정상 반환 + AuditLog
//   7. ChangeBatch (action='adext.delete', total=1)
//   8. ChangeItem 1건 (idempotencyKey: `${batchId}:delete:${nccExtId}`)
//   9. SA deleteAdExtension 호출
//      - 성공: DB AdExtension.status='deleted' (row 보존 — 감사 추적)
//      - 실패: ChangeItem failed + ChangeBatch failed
//  10. ChangeBatch finalize
//  11. AuditLog (targetType='AdExtension')
//  12. revalidatePath

const deleteExtensionSchema = z.object({
  extensionId: z.string().min(1),
  confirmText: z.string().min(1),
})

export type DeleteAdExtensionInput = z.infer<typeof deleteExtensionSchema>

export type DeleteAdExtensionResult =
  | { ok: true; batchId: string; nccExtId: string }
  | { ok: false; error: string }

/**
 * 확장소재 단건 삭제 (admin + 2차 확인).
 *
 * @throws AuthorizationError — admin 권한 부족 시 (UI 에서 catch)
 * @throws Error("확인 텍스트 불일치") — 2차 확인 실패 (UI 에서 catch)
 */
export async function deleteAdExtensionSingle(
  advertiserId: string,
  input: DeleteAdExtensionInput,
): Promise<DeleteAdExtensionResult> {
  // -- 1. admin 권한 강제 ----------------------------------------------------
  await assertRole("admin")

  // -- 2. 광고주 권한 + 객체 -------------------------------------------------
  const { advertiser, user } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    return { ok: false, error: "API 키/시크릿 미입력" }
  }

  // -- 3. Zod 검증 -----------------------------------------------------------
  const parsed = deleteExtensionSchema.parse(input)

  // -- 4. 광고주 한정 확장소재 조회 ------------------------------------------
  const dbExt = await prisma.adExtension.findFirst({
    where: {
      id: parsed.extensionId,
      ownerType: "adgroup",
      adgroup: { campaign: { advertiserId } },
    },
    select: {
      id: true,
      nccExtId: true,
      type: true,
      payload: true,
      status: true,
    },
  })
  if (!dbExt) {
    return { ok: false, error: "확장소재를 찾을 수 없거나 광고주 소속 아님" }
  }

  // -- 5. 2차 확인 검증 ------------------------------------------------------
  // payload 에서 type 별 식별자 추출. 사용자가 입력한 confirmText 와 정확 일치 (양 끝 trim).
  // - headline / description: payload.{type} (사용자 텍스트)
  // - image: payload.image.url 또는 nccExtId (이미지 URL 은 너무 길어 nccExtId 권장)
  //   본 PR 단순화: image 는 nccExtId 비교 (UI 측에서 nccExtId 표기 후 입력 받음)
  const payload = (dbExt.payload ?? {}) as Record<string, unknown>
  let storedText = ""
  if (dbExt.type === "headline") {
    storedText = typeof payload.headline === "string" ? payload.headline : ""
  } else if (dbExt.type === "description") {
    storedText =
      typeof payload.description === "string" ? payload.description : ""
  } else if (dbExt.type === "image") {
    // image 는 nccExtId 폴백 (URL 너무 길어 사용자 입력 부담).
    storedText = dbExt.nccExtId
  }
  if (storedText.length === 0) {
    // 텍스트 정보가 비어 있으면 안전망으로 nccExtId 비교.
    storedText = dbExt.nccExtId
  }
  if (parsed.confirmText.trim() !== storedText.trim()) {
    throw new Error("확인 텍스트 불일치")
  }

  // -- 6. idempotent (이미 deleted) ------------------------------------------
  if (dbExt.status === "deleted") {
    await logAudit({
      userId: user.id,
      action: "adext.delete",
      targetType: "AdExtension",
      targetId: dbExt.nccExtId,
      before: { status: dbExt.status, type: dbExt.type },
      after: { status: "deleted", note: "already-deleted (idempotent)" },
    })
    return { ok: true, batchId: "", nccExtId: dbExt.nccExtId }
  }

  // -- 7. ChangeBatch 생성 ---------------------------------------------------
  const action = "adext.delete"
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
        nccExtId: dbExt.nccExtId,
        type: dbExt.type,
      } as Prisma.InputJsonValue,
    },
  })

  // -- 8. ChangeItem (1건) ---------------------------------------------------
  const idempotencyKey = `${batch.id}:delete:${dbExt.nccExtId}`
  await prisma.changeItem.create({
    data: {
      batchId: batch.id,
      targetType: "AdExtension",
      targetId: dbExt.nccExtId,
      before: { status: dbExt.status } as Prisma.InputJsonValue,
      after: { status: "deleted" } as Prisma.InputJsonValue,
      idempotencyKey,
      status: "pending",
    },
  })

  // -- 9. SA deleteAdExtension ----------------------------------------------
  let success = false
  let errorMsg: string | null = null
  try {
    await deleteAdExtension(advertiser.customerId, dbExt.nccExtId)
    success = true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    errorMsg = msg.slice(0, 500)
  }

  if (success) {
    // row 보존 — status='deleted' (감사 추적).
    await prisma.adExtension.update({
      where: { id: dbExt.id },
      data: { status: "deleted" satisfies AdExtensionStatus },
    })
    await prisma.changeItem.updateMany({
      where: { batchId: batch.id, idempotencyKey },
      data: { status: "done" },
    })

    // -- image type Storage cleanup (best-effort) --------------------------
    // image 확장소재이고 payload.image.storagePath 가 있으면 Supabase Storage 파일도 삭제.
    // 실패해도 SA 삭제는 이미 성공이므로 console.warn 만 — 사용자 흐름 차단 X.
    if (dbExt.type === "image") {
      const imgPayload = (dbExt.payload ?? {}) as Record<string, unknown>
      const img = imgPayload.image as Record<string, unknown> | undefined
      const storagePath =
        img && typeof img.storagePath === "string" ? img.storagePath : null
      if (storagePath) {
        try {
          const { error: rmErr } = await getAdminSupabase()
            .storage.from("ad-extension-images")
            .remove([storagePath])
          if (rmErr) {
            console.warn(
              `[deleteAdExtensionSingle] storage cleanup failed nccExtId=${dbExt.nccExtId} path=${storagePath}: ${rmErr.message}`,
            )
          }
        } catch (e) {
          console.warn(
            `[deleteAdExtensionSingle] storage cleanup unknown error nccExtId=${dbExt.nccExtId}:`,
            e,
          )
        }
      }
    }
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

  // -- 11. AuditLog (targetType='AdExtension') -------------------------------
  await logAudit({
    userId: user.id,
    action,
    targetType: "AdExtension",
    targetId: dbExt.nccExtId,
    before: { status: dbExt.status, type: dbExt.type },
    after: success
      ? { status: "deleted", batchId: batch.id }
      : { status: dbExt.status, batchId: batch.id, error: errorMsg },
  })

  // -- 12. revalidatePath ----------------------------------------------------
  revalidatePath(`/${advertiserId}/extensions`)

  if (!success) {
    return { ok: false, error: errorMsg ?? "삭제 실패" }
  }
  return { ok: true, batchId: batch.id, nccExtId: dbExt.nccExtId }
}

// =============================================================================
// 5. uploadImage — Supabase Storage 업로드 (F-5.3)
// =============================================================================
//
// 흐름:
//   1. 클라이언트 file → base64 변환 후 Server Action 호출
//   2. 본 액션:
//      - getCurrentAdvertiser 권한
//      - MIME 화이트리스트 (PNG / JPEG / WebP)
//      - size 5MB 제한
//      - 광고주별 디렉토리 경로(`{advertiserId}/{cuid}.{ext}`) — 광고주 격리
//      - service_role 클라이언트(getAdminSupabase) 로 bucket 'ad-extension-images' 업로드
//      - publicURL 반환 (네이버 SA createAdExtensions 호출 시 image.url 로 사용)
//
// Storage bucket 운영 가이드:
//   - 본 PR 은 코드만 추가. bucket 자체는 Supabase 콘솔에서 미리 생성 필요:
//     - bucket name: ad-extension-images
//     - Public bucket: ON (publicURL 으로 네이버 SA 가 접근)
//     - File size limit: 5MB (코드와 동일)
//     - Allowed MIME types: image/png, image/jpeg, image/webp
//   - RLS 정책 별도 마이그레이션 X — 본 bucket 은 service_role 단독 사용.
//     클라이언트 직접 업로드는 차단(서버 액션 통과). 클라이언트가 publicURL 을 직접 GET 하는 건 OK.
//
// AuditLog: 업로드 자체는 변경 액션 아니므로 미기록 (createAdExtensionsBatch / deleteAdExtensionSingle 단계에서 기록).
//
// 본 PR 비대상:
//   - signedURL (publicURL 사용)
//   - 이미지 리사이즈/최적화 (네이버 SA 사양 따름)
//   - DB Asset 테이블 등록 (업로드 자체 추적 미수행)

const uploadImageSchema = z.object({
  /**
   * 이미지 데이터 base64 문자열 (data URL 접두 X — 순수 base64).
   * 클라이언트에서 File → ArrayBuffer → Uint8Array → btoa(...) 또는 Buffer.from().toString("base64").
   *
   * Server Action 페이로드 크기 한계(기본 1MB) 회피 위해 Next.js 의
   * `serverActions.bodySizeLimit` 설정을 늘리거나, 후속 PR 에서 multipart/route handler 로 이관 가능.
   */
  fileBase64: z.string().min(1),
  fileType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  /** UI 표시용 파일명. 실제 저장명은 cuid 사용. */
  originalName: z.string().optional(),
})

export type UploadImageInput = z.infer<typeof uploadImageSchema>

export type UploadImageResult =
  | { ok: true; storagePath: string; publicUrl: string; size: number }
  | { ok: false; error: string }

/** MIME → 확장자 매핑. */
const MIME_TO_EXT: Record<UploadImageInput["fileType"], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
}

/** 업로드 size 상한 (5MB). */
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024

/**
 * 이미지 업로드 (광고주 격리 + size/MIME 검증).
 *
 *   1. getCurrentAdvertiser 권한 (광고주 한정)
 *   2. Zod 검증 (MIME 화이트리스트)
 *   3. base64 디코드 → Buffer
 *   4. size 5MB 제한 검증
 *   5. 경로 산정: `{advertiserId}/{crypto.randomUUID()}.{ext}` — 다른 광고주 디렉토리 접근 차단
 *   6. getAdminSupabase().storage.upload(...) — upsert: false (UUID 충돌 사실상 불가)
 *   7. publicURL 반환
 *
 * 오류는 결과 객체로 반환 (UI 가 catch 부담 X).
 */
export async function uploadImage(
  advertiserId: string,
  input: UploadImageInput,
): Promise<UploadImageResult> {
  const { advertiser } = await getCurrentAdvertiser(advertiserId)

  const parsed = uploadImageSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: "입력 검증 실패" }
  }

  // -- base64 디코드 ---------------------------------------------------------
  // data URL prefix 가 섞여 있으면 제거 (클라이언트가 무심코 보낸 경우 방어).
  let b64 = parsed.data.fileBase64
  const commaIdx = b64.indexOf(",")
  if (b64.startsWith("data:") && commaIdx > 0) {
    b64 = b64.slice(commaIdx + 1)
  }

  let buffer: Buffer
  try {
    buffer = Buffer.from(b64, "base64")
  } catch {
    return { ok: false, error: "base64 디코드 실패" }
  }
  if (buffer.length === 0) {
    return { ok: false, error: "빈 파일" }
  }
  if (buffer.length > MAX_IMAGE_SIZE_BYTES) {
    return {
      ok: false,
      error: `파일 크기 한도(${MAX_IMAGE_SIZE_BYTES / 1024 / 1024}MB) 초과`,
    }
  }

  // -- 경로 산정 (광고주 격리) -----------------------------------------------
  // advertiserId 디렉토리 prefix 강제 — 다른 광고주 디렉토리 접근 차단 (코드상).
  const ext = MIME_TO_EXT[parsed.data.fileType]
  const fileName = `${crypto.randomUUID()}.${ext}`
  const storagePath = `${advertiser.id}/${fileName}`

  // -- Supabase Storage 업로드 -----------------------------------------------
  const supa = getAdminSupabase()
  const { error: upErr } = await supa.storage
    .from("ad-extension-images")
    .upload(storagePath, buffer, {
      contentType: parsed.data.fileType,
      upsert: false,
    })
  if (upErr) {
    console.warn(
      `[uploadImage] upload failed advertiserId=${advertiserId} path=${storagePath}: ${upErr.message}`,
    )
    return { ok: false, error: "업로드 실패" }
  }

  // -- publicURL ---------------------------------------------------------------
  const { data: pubData } = supa.storage
    .from("ad-extension-images")
    .getPublicUrl(storagePath)
  if (!pubData?.publicUrl) {
    // 업로드는 성공했으나 URL 추출 실패 (이론상 발생 X). cleanup 후 에러.
    await supa.storage.from("ad-extension-images").remove([storagePath])
    return { ok: false, error: "publicURL 추출 실패" }
  }

  return {
    ok: true,
    storagePath,
    publicUrl: pubData.publicUrl,
    size: buffer.length,
  }
}

// =============================================================================
// fetchExtensionsStats — client streaming (Suspense 대안)
// =============================================================================

/**
 * 확장소재별 stats 조회 (광고주 단위 batch).
 *
 * 주의: 네이버 SA Stats 가 nccExtId 단위 미지원일 가능성. 호출 자체는 통과해도
 *       응답 매칭 row 가 없어 모든 metrics 가 0 일 수 있음 (graceful).
 */
export type FetchExtensionsStatsResult =
  | { ok: true; metrics: Array<{ id: string } & AdMetrics> }
  | { ok: false; error: string }

export async function fetchExtensionsStats(
  advertiserId: string,
  period: AdsPeriod,
): Promise<FetchExtensionsStatsResult> {
  const { advertiser } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    return { ok: false, error: "API 키/시크릿 미입력" }
  }

  const extRows = await prisma.adExtension.findMany({
    where: {
      ownerType: "adgroup",
      adgroup: { campaign: { advertiserId } },
      type: { in: ["headline", "description", "image"] },
    },
    select: { nccExtId: true },
    take: 5000,
  })
  const ids = extRows.map((e) => e.nccExtId)
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
    console.warn("[fetchExtensionsStats] failed:", e)
    return { ok: false, error }
  }
}
