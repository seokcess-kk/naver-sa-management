"use server"

/**
 * F-5.x — 확장소재 관리 (Server Actions, P1 텍스트 2종)
 *
 * 본 PR 범위:
 *   1. syncAdExtensions          — 광고그룹 순회 → listAdExtensions(type 별) → DB upsert (F-5.1/F-5.2)
 *   2. bulkActionAdExtensions    — 다중 선택 ON/OFF (toggle, userLock) 일괄
 *   3. createAdExtensionsBatch   — 광고그룹 N × 텍스트 M 일괄 생성 (F-5.4)
 *   4. deleteAdExtensionSingle   — 단건 삭제 (admin + 2차 확인)
 *
 * 본 PR 비대상 (후속 PR):
 *   - F-5.3 이미지(IMAGE)        — Supabase Storage 별도 셋업 필요
 *   - 인라인 편집(text 변경)     — type 별 fields 다양해 별도 PR
 *   - 다중 선택 삭제             — P1 비대상 (CLAUDE.md "비대상")
 *   - 9종 모든 type              — P1 화이트리스트는 headline / description (CLAUDE.md "비대상: P1 9종 확장소재")
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
import { NaverSaError } from "@/lib/naver-sa/errors"
import type {
  AdExtensionStatus,
  AdExtensionType,
  InspectStatus,
} from "@/lib/generated/prisma/client"
import type * as Prisma from "@/lib/generated/prisma/internal/prismaNamespace"

// =============================================================================
// 입력 type 화이트리스트 (P1: 텍스트 2종)
// =============================================================================
//
// CLAUDE.md "비대상: P1 9종 확장소재(P1은 3종만)".
// 본 PR(텍스트 2종)은 더 좁은 화이트리스트. 이미지는 후속 PR.
//
// 백엔드 ↔ SA 사이 type 변환:
//   - 입력(소문자): "headline" / "description"          (Prisma AdExtensionType enum 과 동일)
//   - SA 호출(대문자): "HEADLINE" / "DESCRIPTION"        (lib/naver-sa/ad-extensions SaAdExtensionType)
//   - 응답 매핑(소문자): SA 응답 type 문자열 → 소문자 enum

const InputTypeSchema = z.enum(["headline", "description"])
type InputType = z.infer<typeof InputTypeSchema>

const TYPE_TO_SA: Record<InputType, SaAdExtensionType> = {
  headline: "HEADLINE",
  description: "DESCRIPTION",
}

/** type 별 텍스트 길이 상한 (네이버 SA 가이드 기준 — P1 호출부 검증). */
const TYPE_MAX_LEN: Record<InputType, number> = {
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
      durationMs: number
    }
  | { ok: false; error: string }

/**
 * 확장소재 동기화 (광고주 단위 — 모든 광고그룹 순회).
 *
 *   1. getCurrentAdvertiser — 권한 검증 + advertiser
 *   2. hasKeys 확인 (시크릿 미입력이면 즉시 차단)
 *   3. DB AdGroup 매핑 테이블 (광고주 한정)
 *   4. 각 광고그룹 × 각 type(headline/description) 마다 listAdExtensions 호출
 *      - type 미지정 시 둘 다 동기화
 *      - 단일 광고그룹 / type 호출 실패는 부분 실패 (다른 호출은 계속)
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
 * TODO: 광고그룹 200개 + type 2종 동기화 시 Vercel 함수 시간 한계 부딪힐 수 있음.
 *       현 시점은 단순 동기 처리. 측정 후 ChangeBatch + Chunk Executor (SPEC 3.5) 이관.
 */
export async function syncAdExtensions(
  advertiserId: string,
  type?: InputType,
): Promise<SyncExtensionsResult> {
  const { advertiser, user } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    return { ok: false, error: "API 키/시크릿 미입력" }
  }

  const start = Date.now()

  // -- DB 광고그룹 매핑 테이블 (광고주 한정) -----------------------------------
  const adgroups = await prisma.adGroup.findMany({
    where: { campaign: { advertiserId } },
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
        customerId: advertiser.customerId,
        type: type ?? "all",
        note: "no-adgroups",
      },
    })
    revalidatePath(`/${advertiserId}/extensions`)
    return {
      ok: true,
      synced: 0,
      scannedAdgroups: 0,
      skipped: 0,
      durationMs: Date.now() - start,
    }
  }

  const adgroupIdMap = new Map<string, string>(
    adgroups.map((g) => [g.nccAdgroupId, g.id]),
  )

  // 동기화 대상 type 목록: 입력 미지정 → 둘 다, 지정 → 하나만.
  const targetTypes: InputType[] = type ? [type] : ["headline", "description"]

  let synced = 0
  let skipped = 0
  let scannedAdgroups = 0

  try {
    for (const ag of adgroups) {
      // 광고그룹 1개 = type 별 호출 합계 1번 ("scannedAdgroups" 의미는 "광고그룹 1개 단위로 진행됨").
      // 부분 실패 허용: 단일 광고그룹의 type 1개 실패해도 다른 type / 광고그룹은 계속.
      let touched = false
      for (const t of targetTypes) {
        const sa = TYPE_TO_SA[t]
        let remote: SaAdExtension[]
        try {
          remote = await listAdExtensions(advertiser.customerId, {
            nccAdgroupId: ag.nccAdgroupId,
            type: sa,
          })
        } catch (e) {
          if (e instanceof NaverSaError) {
            console.warn(
              `[syncAdExtensions] listAdExtensions failed for nccAdgroupId=${ag.nccAdgroupId} type=${sa}: ${e.message}`,
            )
          } else {
            console.warn(
              `[syncAdExtensions] listAdExtensions unknown error for nccAdgroupId=${ag.nccAdgroupId} type=${sa}:`,
              e,
            )
          }
          continue
        }

        for (const e of remote) {
          // 응답 type 검증 (응답에 다른 type 이 섞여 오는 경우 화이트리스트 외는 skip).
          const respTypeLc = e.type?.toString().toLowerCase()
          if (respTypeLc !== t) {
            skipped++
            console.warn(
              `[syncAdExtensions] skip nccExtId=${e.nccExtId}: response.type=${e.type} != requested=${sa}`,
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

          const dbType: AdExtensionType = t // headline / description (소문자 그대로)
          const mappedStatus = mapExtensionStatus(e)
          const mappedInspect = mapInspectStatus(e)
          const text = extractText(e, t)
          const payload: Record<string, string> = text
            ? { [t]: text }
            : {}
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
      customerId: advertiser.customerId,
      type: type ?? "all",
    },
  })

  revalidatePath(`/${advertiserId}/extensions`)

  return {
    ok: true,
    synced,
    scannedAdgroups,
    skipped,
    durationMs: Date.now() - start,
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
 * 네이버 SA 응답은 type 별 다른 필드를 가진다 (passthrough 보존):
 *   - HEADLINE    → e.headline (string)
 *   - DESCRIPTION → e.description (string)
 *
 * 누락 시 빈 문자열 반환 (호출부가 payload 비우기 처리).
 */
function extractText(e: SaAdExtension, t: InputType): string {
  const anyE = e as unknown as Record<string, unknown>
  const v = anyE[t]
  return typeof v === "string" ? v : ""
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

const createExtensionsSchema = z
  .object({
    type: InputTypeSchema,
    // 텍스트는 type 별 길이 상한 검증을 .superRefine 단계에서 수행.
    // 1차 max 는 description 상한(45) 으로 두고, headline 입력 시 추가 검증.
    texts: z.array(z.string().min(1).max(45)).min(1).max(20),
    nccAdgroupIds: z.array(z.string().min(1)).min(1).max(50),
  })
  .superRefine((v, ctx) => {
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
  })

export type CreateAdExtensionsBatchInput = z.infer<
  typeof createExtensionsSchema
>

export type CreateAdExtensionsBatchItem = {
  index: number // 입력 평탄 배열 0-based 인덱스 (광고그룹×텍스트 — UI 결과 매핑용)
  ownerId: string // nccAdgroupId
  text: string // 입력 텍스트
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

  // -- (광고그룹 × 텍스트) 조합 평탄화 ----------------------------------------
  // 입력 순서 보존: 첫 광고그룹의 모든 텍스트 → 두 번째 광고그룹의 모든 텍스트 ...
  type FlatRow = {
    index: number // 평탄 0-based
    nccAdgroupId: string
    text: string
    externalId: string
  }
  const flat: FlatRow[] = []
  let flatIdx = 0
  for (const agId of uniqAdgroupIds) {
    for (const text of parsed.texts) {
      flat.push({
        index: flatIdx++,
        nccAdgroupId: agId,
        text,
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
        texts: parsed.texts.length,
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
  const seeds: CreateItemSeed[] = flat.map((row) => ({
    batchId: batch.id,
    targetType: "AdExtension",
    targetId: `pending:${row.externalId}`,
    before: {} as Prisma.InputJsonValue,
    after: {
      ownerType: "adgroup",
      nccAdgroupId: row.nccAdgroupId,
      type: parsed.type,
      [parsed.type]: row.text,
    } as Prisma.InputJsonValue,
    idempotencyKey: `${batch.id}:create:${row.externalId}`,
    status: "pending" as const,
  }))
  await prisma.changeItem.createMany({ data: seeds })

  // -- SA createAdExtensions 호출 --------------------------------------------
  // 모든 항목 단일 POST. type 별 텍스트 필드(headline / description) 부착.
  const items: AdExtensionCreateItem[] = flat.map((row) => ({
    ownerId: row.nccAdgroupId,
    ownerType: "ADGROUP",
    type: sa,
    [parsed.type]: row.text,
    externalId: row.externalId,
  }))

  let successTotal = 0
  let failedTotal = 0
  const resultItems: CreateAdExtensionsBatchItem[] = []

  try {
    const created = await createAdExtensions(advertiser.customerId, items)

    // 응답 매핑 — 1차: 길이 일치 → 인덱스 매핑
    //              2차: 불일치 → (ownerId, type, text) 정확 매칭 (응답 type 소문자 정규화)
    const indexMatch = created.length === items.length
    const respByExactKey = new Map<string, SaAdExtension>()
    if (!indexMatch) {
      for (const c of created) {
        const respTypeLc =
          typeof c.type === "string" && c.type.length > 0
            ? c.type.toLowerCase()
            : parsed.type
        const txt = extractText(c, parsed.type) // type 일치 가정 — 다르면 빈 문자열
        if (txt) {
          respByExactKey.set(`${c.ownerId}::${respTypeLc}::${txt}`, c)
        }
      }
    }

    for (const row of flat) {
      const key = `${row.nccAdgroupId}::${parsed.type}::${row.text}`
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
          respTypeLc === "headline" || respTypeLc === "description"
            ? respTypeLc
            : parsed.type
        const respText = extractText(u, parsed.type)
        const text = respText.length > 0 ? respText : row.text
        const payload = { [parsed.type]: text } as Prisma.InputJsonValue
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
      texts: parsed.texts.length,
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
  // payload 에서 type 별 텍스트 추출. 사용자가 입력한 confirmText 와 정확 일치 (양 끝 trim).
  // type 이 P1 외(image/sublink 등 — 후속 PR 진입로 확장 시) 면 nccExtId 폴백.
  const payload = (dbExt.payload ?? {}) as Record<string, unknown>
  let storedText = ""
  if (dbExt.type === "headline") {
    storedText = typeof payload.headline === "string" ? payload.headline : ""
  } else if (dbExt.type === "description") {
    storedText =
      typeof payload.description === "string" ? payload.description : ""
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
