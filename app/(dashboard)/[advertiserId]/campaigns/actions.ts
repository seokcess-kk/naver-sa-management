"use server"

/**
 * F-2.1 — 캠페인 동기화 + 일괄 변경 (Server Actions)
 *
 * 책임 (SPEC 6.2 F-2.1):
 *   1. syncCampaigns       — NAVER SA listCampaigns → DB upsert
 *   2. bulkUpdateCampaigns — ON/OFF (userLock) / dailyBudget 일괄 변경
 *
 * 운영 정책 (CLAUDE.md / backend-engineer.md):
 *   - 진입부 getCurrentAdvertiser(advertiserId) 호출 (admin / 화이트리스트 검증 + 광고주 객체 반환)
 *   - prisma 쿼리에 항상 where: { advertiserId } 한정 (광고주 횡단 노출 차단)
 *   - 외부 SA API 변경은 ChangeBatch + ChangeItem 기록 의무
 *     · 본 액션은 캠페인 수십 row 동기 처리 — Chunk Executor 인프라 미사용 (status를 즉시 done/failed)
 *     · idempotencyKey: `${batchId}:${nccCampaignId}` (ChangeItem unique 제약 충족)
 *   - SA API 호출용 customerId 와 앱 내부 advertiserId 는 분리
 *   - AuditLog 기록 (시크릿 X — Campaign 응답엔 키 없음)
 *   - revalidatePath(`/${advertiserId}/campaigns`)
 *
 * 스키마 매핑 메모:
 *   - 앱 DB Campaign 모델은 `status` enum (on/off/deleted) 으로 ON/OFF 표현.
 *   - 네이버 SA 응답은 별도 `userLock`(true=OFF) + `status`(ELIGIBLE/PAUSED/DELETED).
 *   - 토글 액션은 SA 호출에 `userLock` 필드 사용, DB 업데이트는 `status` enum 으로 변환.
 *   - 원본 응답은 `Campaign.raw` JSON 컬럼에 그대로 보존 (userLock / useDailyBudget 등 기타 필드).
 */

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { prisma } from "@/lib/db/prisma"
import { getCurrentAdvertiser } from "@/lib/auth/access"
import { logAudit } from "@/lib/audit/log"
import { recordSyncAt } from "@/lib/sync/last-sync-at"
import {
  listCampaigns,
  updateCampaignsBulk,
  type Campaign as SaCampaign,
} from "@/lib/naver-sa/campaigns"
import { NaverSaError } from "@/lib/naver-sa/errors"
import type { CampaignStatus } from "@/lib/generated/prisma/client"
import type * as Prisma from "@/lib/generated/prisma/internal/prismaNamespace"

// =============================================================================
// 1. syncCampaigns — NAVER → DB upsert
// =============================================================================

export type SyncCampaignsResult =
  | { ok: true; synced: number; durationMs: number }
  | { ok: false; error: string }

/**
 * 캠페인 동기화.
 *
 *   1. getCurrentAdvertiser — 권한 검증 + 광고주 객체
 *   2. hasKeys 확인 (시크릿 미입력이면 즉시 차단)
 *   3. listCampaigns(customerId) — SA 조회
 *   4. 각 row upsert (advertiserId / nccCampaignId 한정)
 *   5. AuditLog 1건 (요약만, 시크릿 X)
 *
 * 본 액션은 "조회 → 적재" 만 — 외부 변경 X → ChangeBatch 미사용 (정책상 OK).
 */
export async function syncCampaigns(
  advertiserId: string,
): Promise<SyncCampaignsResult> {
  const { advertiser, user } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    return { ok: false, error: "API 키/시크릿 미입력" }
  }

  const start = Date.now()

  let remote: SaCampaign[]
  try {
    remote = await listCampaigns(advertiser.customerId)
  } catch (e) {
    if (e instanceof NaverSaError) {
      return { ok: false, error: `SA 호출 실패: ${e.message}` }
    }
    console.error("[syncCampaigns] listCampaigns failed:", e)
    return { ok: false, error: "동기화 중 알 수 없는 오류" }
  }

  try {
    // upsert 루프 — 수십 row 동기 처리 (Vercel 함수 시간 한계 내).
    // 광고주별 캠페인은 통상 100개 미만이므로 단일 호출 OK.
    for (const c of remote) {
      const mappedStatus = mapCampaignStatus(c)
      const dailyBudgetVal =
        typeof c.dailyBudget === "number" ? c.dailyBudget : null

      const rawJson = c as unknown as Prisma.InputJsonValue
      await prisma.campaign.upsert({
        where: { nccCampaignId: c.nccCampaignId },
        create: {
          advertiserId,
          nccCampaignId: c.nccCampaignId,
          name: c.name,
          campaignType: c.campaignTp ?? null,
          dailyBudget: dailyBudgetVal,
          status: mappedStatus,
          raw: rawJson,
        },
        update: {
          // advertiserId 변경은 X (생성 시점 그대로). nccCampaignId 도 unique 키.
          name: c.name,
          campaignType: c.campaignTp ?? null,
          dailyBudget: dailyBudgetVal,
          status: mappedStatus,
          raw: rawJson,
        },
      })
    }
  } catch (e) {
    console.error("[syncCampaigns] upsert failed:", e)
    return { ok: false, error: "DB 적재 중 오류" }
  }

  await logAudit({
    userId: user.id,
    action: "campaign.sync",
    targetType: "Advertiser",
    targetId: advertiserId,
    before: null,
    after: { synced: remote.length, customerId: advertiser.customerId },
  })

  // lastSyncAt 갱신 (UI 헤더 "마지막 동기화" 배지). 실패해도 sync 결과는 정상 반환.
  await recordSyncAt(advertiserId, "campaigns")

  revalidatePath(`/${advertiserId}/campaigns`)

  return { ok: true, synced: remote.length, durationMs: Date.now() - start }
}

// =============================================================================
// 2. bulkUpdateCampaigns — ON/OFF (userLock) / dailyBudget 일괄 변경
// =============================================================================

const bulkActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("toggle"),
    items: z
      .array(
        z.object({
          campaignId: z.string().min(1), // 앱 DB Campaign.id
          // userLock=true → OFF (lock), false → ON
          userLock: z.boolean(),
        }),
      )
      .min(1)
      .max(200),
  }),
  z.object({
    action: z.literal("budget"),
    items: z
      .array(
        z.object({
          campaignId: z.string().min(1),
          dailyBudget: z.number().int().min(0), // 원 단위
        }),
      )
      .min(1)
      .max(200),
  }),
])

export type BulkCampaignActionInput = z.infer<typeof bulkActionSchema>

export type BulkUpdateItemResult = {
  campaignId: string
  ok: boolean
  error?: string
}

export type BulkUpdateCampaignsResult = {
  batchId: string
  total: number
  success: number
  failed: number
  items: BulkUpdateItemResult[]
}

type DbCampaignSnapshot = {
  id: string
  nccCampaignId: string
  name: string
  dailyBudget: number | null
  status: CampaignStatus
}

/**
 * 캠페인 일괄 변경.
 *
 *   1. getCurrentAdvertiser — 권한 검증
 *   2. Zod 검증 (action / items)
 *   3. 대상 캠페인 광고주 한정 조회 (advertiserId 일치 검증)
 *   4. ChangeBatch (status='running') 생성 + ChangeItem 일괄 생성
 *   5. updateCampaignsBulk(customerId, items, fields) — 단일 PUT
 *   6. 응답 매핑: 성공 → DB update + ChangeItem='done'. 누락/예외 → 'failed'
 *   7. ChangeBatch finalize (done/failed) + finishedAt
 *   8. AuditLog 1건 (요약)
 */
export async function bulkUpdateCampaigns(
  advertiserId: string,
  input: BulkCampaignActionInput,
): Promise<BulkUpdateCampaignsResult> {
  const { advertiser, user } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    throw new Error("API 키/시크릿 미입력")
  }

  const parsed = bulkActionSchema.parse(input)

  // -- 대상 캠페인 광고주 한정 조회 --------------------------------------------
  // 입력 안 campaignId 중복은 마지막 항목으로 대체 (idempotencyKey unique 충돌 방지).
  const itemsByCampaignId = new Map<
    string,
    { userLock?: boolean; dailyBudget?: number }
  >()
  if (parsed.action === "toggle") {
    for (const it of parsed.items) {
      itemsByCampaignId.set(it.campaignId, { userLock: it.userLock })
    }
  } else {
    for (const it of parsed.items) {
      itemsByCampaignId.set(it.campaignId, { dailyBudget: it.dailyBudget })
    }
  }
  const campaignIds = Array.from(itemsByCampaignId.keys())

  const dbCampaigns = await prisma.campaign.findMany({
    where: {
      advertiserId, // 핵심: 광고주 한정 (횡단 노출 차단)
      id: { in: campaignIds },
    },
    select: {
      id: true,
      nccCampaignId: true,
      name: true,
      dailyBudget: true,
      status: true,
    },
  })

  if (dbCampaigns.length !== campaignIds.length) {
    throw new Error("일부 캠페인이 광고주 소속이 아닙니다")
  }

  const beforeMap = new Map<string, DbCampaignSnapshot>(
    dbCampaigns.map((c) => [
      c.id,
      {
        id: c.id,
        nccCampaignId: c.nccCampaignId,
        name: c.name,
        dailyBudget: c.dailyBudget === null ? null : Number(c.dailyBudget),
        status: c.status,
      },
    ]),
  )

  // -- ChangeBatch + ChangeItem 생성 -------------------------------------------
  const action =
    parsed.action === "toggle" ? "campaign.toggle" : "campaign.budget"
  const total = campaignIds.length

  const batch = await prisma.changeBatch.create({
    data: {
      userId: user.id,
      action,
      status: "running",
      total,
      processed: 0,
      attempt: 1,
      summary: { advertiserId, action: parsed.action, total },
    },
  })

  // SA API 호출용 payload + ChangeItem before/after
  type SaItem = {
    nccCampaignId: string
    userLock?: boolean
    dailyBudget?: number
  }
  const itemsForApi: SaItem[] = []
  const changeItemData = campaignIds.map((cid) => {
    const dbC = beforeMap.get(cid)!
    const change = itemsByCampaignId.get(cid)!

    let beforeData: Prisma.InputJsonValue
    let afterData: Prisma.InputJsonValue
    if (parsed.action === "toggle") {
      // DB 의 status (on/off) → userLock 으로 환산하여 before 표시
      beforeData = { userLock: dbC.status === "off" } as Prisma.InputJsonValue
      afterData = { userLock: change.userLock } as Prisma.InputJsonValue
      itemsForApi.push({
        nccCampaignId: dbC.nccCampaignId,
        userLock: change.userLock,
      })
    } else {
      beforeData = { dailyBudget: dbC.dailyBudget } as Prisma.InputJsonValue
      afterData = { dailyBudget: change.dailyBudget } as Prisma.InputJsonValue
      itemsForApi.push({
        nccCampaignId: dbC.nccCampaignId,
        dailyBudget: change.dailyBudget,
      })
    }

    return {
      batchId: batch.id,
      targetType: "Campaign",
      targetId: dbC.nccCampaignId,
      before: beforeData,
      after: afterData,
      idempotencyKey: `${batch.id}:${dbC.nccCampaignId}`,
      status: "pending" as const,
    }
  })

  await prisma.changeItem.createMany({ data: changeItemData })

  // -- SA API 호출 -------------------------------------------------------------
  const fields = parsed.action === "toggle" ? "userLock" : "dailyBudget"
  let success = 0
  let failed = 0
  const results: BulkUpdateItemResult[] = []

  try {
    const updated = await updateCampaignsBulk(
      advertiser.customerId,
      itemsForApi,
      fields,
    )
    const updatedMap = new Map(updated.map((c) => [c.nccCampaignId, c]))

    for (const cid of campaignIds) {
      const dbC = beforeMap.get(cid)!
      const u = updatedMap.get(dbC.nccCampaignId)
      if (u) {
        const rawJson = u as unknown as Prisma.InputJsonValue
        // DB 반영
        if (parsed.action === "toggle") {
          const newStatus = mapCampaignStatus(u)
          await prisma.campaign.update({
            where: { id: dbC.id },
            data: {
              status: newStatus,
              raw: rawJson,
            },
          })
        } else {
          const newBudget =
            typeof u.dailyBudget === "number" ? u.dailyBudget : null
          await prisma.campaign.update({
            where: { id: dbC.id },
            data: {
              dailyBudget: newBudget,
              raw: rawJson,
            },
          })
        }
        await prisma.changeItem.updateMany({
          where: { batchId: batch.id, targetId: dbC.nccCampaignId },
          data: { status: "done" },
        })
        success++
        results.push({ campaignId: cid, ok: true })
      } else {
        await prisma.changeItem.updateMany({
          where: { batchId: batch.id, targetId: dbC.nccCampaignId },
          data: { status: "failed", error: "응답에 누락" },
        })
        failed++
        results.push({ campaignId: cid, ok: false, error: "응답 누락" })
      }
    }
  } catch (e) {
    // 일괄 실패 — 모든 ChangeItem failed
    const msg = e instanceof Error ? e.message : String(e)
    await prisma.changeItem.updateMany({
      where: { batchId: batch.id },
      data: { status: "failed", error: msg.slice(0, 500) },
    })
    failed = total
    success = 0
    results.length = 0
    for (const cid of campaignIds) {
      results.push({ campaignId: cid, ok: false, error: msg })
    }
  }

  // -- ChangeBatch finalize ---------------------------------------------------
  // success > 0 이면 done (부분 성공도 done 으로 처리, 실패 항목은 ChangeItem 에 기록).
  // 전부 실패면 failed.
  const finalStatus: "done" | "failed" = success === 0 ? "failed" : "done"

  await prisma.changeBatch.update({
    where: { id: batch.id },
    data: {
      status: finalStatus,
      processed: total,
      finishedAt: new Date(),
    },
  })

  // -- AuditLog 1건 (요약) ----------------------------------------------------
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

  revalidatePath(`/${advertiserId}/campaigns`)

  return { batchId: batch.id, total, success, failed, items: results }
}

// =============================================================================
// helpers
// =============================================================================

/**
 * 네이버 SA Campaign → 앱 CampaignStatus enum 매핑.
 *
 * 매핑 정책:
 *   - userLock=true                               → 'off' (사용자가 OFF)
 *   - status='DELETED' (또는 deleted=true)        → 'deleted'
 *   - status='PAUSED'                             → 'off'
 *   - 그 외 (ELIGIBLE / PENDING_REVIEW / 그 외)   → 'on'
 *
 * 참고: SA 응답엔 `userLock`(boolean) 과 `status`(string) 가 모두 존재.
 *       ON/OFF 토글은 일반적으로 userLock 으로 다룸 → userLock=true 는 즉시 'off'.
 *       삭제는 일반적으로 status 의 'DELETED' 또는 별도 deleted boolean.
 */
function mapCampaignStatus(c: SaCampaign): CampaignStatus {
  // SA 응답 형태가 모듈마다 다를 수 있으므로 안전하게 union 검사.
  const anyC = c as unknown as {
    userLock?: boolean
    status?: string
    deleted?: boolean
  }
  if (anyC.deleted === true) return "deleted"
  if (typeof anyC.status === "string" && anyC.status.toUpperCase() === "DELETED") {
    return "deleted"
  }
  if (anyC.userLock === true) return "off"
  if (typeof anyC.status === "string" && anyC.status.toUpperCase() === "PAUSED") {
    return "off"
  }
  return "on"
}
