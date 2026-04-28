"use server"

/**
 * F-2.2 — 광고그룹 동기화 + 일괄 변경 (Server Actions)
 *
 * 책임 (SPEC 6.2 F-2.2):
 *   1. syncAdgroups       — NAVER SA listAdgroups → DB upsert (광고주 단위)
 *   2. bulkUpdateAdgroups — toggle / bid / budget / channel 일괄 변경
 *
 * 운영 정책 (CLAUDE.md / backend-engineer.md):
 *   - 진입부 getCurrentAdvertiser(advertiserId) 호출 (admin / 화이트리스트 검증 + 광고주 객체 반환)
 *   - prisma 쿼리는 항상 `where: { campaign: { advertiserId } }` 한정 (AdGroup→Campaign join 통한 광고주 횡단 차단)
 *   - 외부 SA API 변경은 ChangeBatch + ChangeItem 기록 의무
 *     · 광고그룹 수십~수백 row 동기 처리 — Chunk Executor 인프라 미사용 (status 즉시 done/failed)
 *     · idempotencyKey: `${batchId}:${nccAdgroupId}` (ChangeItem unique 제약 충족)
 *   - SA API 호출용 customerId 와 앱 내부 advertiserId 는 분리
 *   - AuditLog 기록 (시크릿 X — AdGroup 응답엔 키 없음)
 *   - revalidatePath(`/${advertiserId}/adgroups`)
 *
 * 스키마 매핑 메모 (F-2.1 캠페인과 동일 패턴):
 *   - 앱 DB AdGroup 모델은 `status` enum (on/off/deleted) 으로 ON/OFF 표현.
 *   - 네이버 SA 응답은 별도 `userLock`(true=OFF) + `status`(ELIGIBLE/PAUSED/DELETED).
 *   - 토글 액션은 SA 호출에 `userLock` 필드 사용, DB 업데이트는 `status` enum 으로 변환.
 *   - 원본 응답은 `AdGroup.raw` JSON 컬럼에 그대로 보존 (userLock / useDailyBudget / currentAvgRnk / 채널 키 등).
 *
 * F-2.1 캠페인 액션과의 차이:
 *   - 광고주 한정 join: AdGroup → Campaign.advertiserId (간접)
 *   - 액션 4종: toggle / bid / budget / channel
 *   - channel 액션은 SA 필드명(채널 키 ON/OFF 표현) 미확정 → 명시적 throw + ChangeItem failed (TODO)
 *   - syncAdgroups 는 응답 광고그룹의 nccCampaignId 를 DB Campaign.id 로 룩업해 매핑 (캠페인 사전 동기화 필요)
 */

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { prisma } from "@/lib/db/prisma"
import { getCurrentAdvertiser } from "@/lib/auth/access"
import { logAudit } from "@/lib/audit/log"
import {
  listAdgroups,
  updateAdgroupsBulk,
  type AdGroup as SaAdGroup,
  type AdgroupBulkUpdateItem,
} from "@/lib/naver-sa/adgroups"
import { NaverSaError } from "@/lib/naver-sa/errors"
import type { AdGroupStatus } from "@/lib/generated/prisma/client"
import type * as Prisma from "@/lib/generated/prisma/internal/prismaNamespace"

// =============================================================================
// 1. syncAdgroups — NAVER → DB upsert
// =============================================================================

export type SyncAdgroupsResult =
  | {
      ok: true
      synced: number
      skipped: number
      durationMs: number
    }
  | { ok: false; error: string }

/**
 * 광고그룹 동기화 (광고주 단위 1회 호출).
 *
 *   1. getCurrentAdvertiser — 권한 검증 + 광고주 객체
 *   2. hasKeys 확인 (시크릿 미입력이면 즉시 차단)
 *   3. listAdgroups(customerId) — SA 조회 (광고주 전체 광고그룹)
 *   4. DB Campaign 매핑 테이블 구성 (nccCampaignId → Campaign.id)
 *      - 응답의 광고그룹이 매핑에 없는 캠페인 소속이면 skip (캠페인 미동기화 상태)
 *   5. 각 row upsert (nccAdgroupId unique)
 *   6. AuditLog 1건 (요약만, 시크릿 X)
 *
 * 본 액션은 "조회 → 적재" 만 — 외부 변경 X → ChangeBatch 미사용 (정책상 OK).
 */
export async function syncAdgroups(
  advertiserId: string,
): Promise<SyncAdgroupsResult> {
  const { advertiser, user } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    return { ok: false, error: "API 키/시크릿 미입력" }
  }

  const start = Date.now()

  // -- DB 캠페인 매핑 테이블 (광고주 한정) ---------------------------------------
  // 응답의 nccCampaignId → DB Campaign.id 룩업용. 응답에는 SA 의 nccCampaignId 만 있고
  // 앱 DB 의 AdGroup.campaignId 는 Campaign.id (cuid) 이므로 변환 필수.
  const campaigns = await prisma.campaign.findMany({
    where: { advertiserId },
    select: { id: true, nccCampaignId: true },
  })
  const campaignIdByNcc = new Map<string, string>(
    campaigns.map((c) => [c.nccCampaignId, c.id]),
  )

  // -- SA 호출 ----------------------------------------------------------------
  // campaigns.ts 패턴과 동일: 광고주 단위 listAdgroups 1회 호출 (opts 미사용).
  let remote: SaAdGroup[]
  try {
    remote = await listAdgroups(advertiser.customerId)
  } catch (e) {
    if (e instanceof NaverSaError) {
      return { ok: false, error: `SA 호출 실패: ${e.message}` }
    }
    console.error("[syncAdgroups] listAdgroups failed:", e)
    return { ok: false, error: "동기화 중 알 수 없는 오류" }
  }

  let synced = 0
  let skipped = 0

  try {
    // upsert 루프 — 광고주별 광고그룹은 통상 수십~수백개 (Vercel 함수 시간 한계 내).
    for (const g of remote) {
      const dbCampaignId = campaignIdByNcc.get(g.nccCampaignId)
      if (!dbCampaignId) {
        // 캠페인이 DB 에 없음 (캠페인 미동기화 또는 삭제됨) → skip + 카운트.
        skipped++
        console.warn(
          `[syncAdgroups] skip nccAdgroupId=${g.nccAdgroupId}: ` +
            `parent nccCampaignId=${g.nccCampaignId} not found in DB`,
        )
        continue
      }

      const mappedStatus = mapAdGroupStatus(g)
      const bidAmtVal = typeof g.bidAmt === "number" ? g.bidAmt : null
      const dailyBudgetVal =
        typeof g.dailyBudget === "number" ? g.dailyBudget : null
      // 매체 ON/OFF 컬럼은 현재 DB 정의상 boolean (default true).
      // SA 응답의 채널 키 표현이 sample 마다 차이 있어, 응답에 채널 키가 비어 있으면 OFF 로 간주.
      // 명시 boolean 필드(예: pcChannelOn)가 응답에 있다면 그대로 사용.
      const anyG = g as unknown as {
        pcChannelKey?: string
        mobileChannelKey?: string
        pcChannelOn?: boolean
        mblChannelOn?: boolean
      }
      const pcChannelOn =
        typeof anyG.pcChannelOn === "boolean"
          ? anyG.pcChannelOn
          : typeof anyG.pcChannelKey === "string"
            ? anyG.pcChannelKey.length > 0
            : true
      const mblChannelOn =
        typeof anyG.mblChannelOn === "boolean"
          ? anyG.mblChannelOn
          : typeof anyG.mobileChannelKey === "string"
            ? anyG.mobileChannelKey.length > 0
            : true

      const rawJson = g as unknown as Prisma.InputJsonValue
      await prisma.adGroup.upsert({
        where: { nccAdgroupId: g.nccAdgroupId },
        create: {
          campaignId: dbCampaignId,
          nccAdgroupId: g.nccAdgroupId,
          name: g.name,
          bidAmt: bidAmtVal,
          dailyBudget: dailyBudgetVal,
          pcChannelOn,
          mblChannelOn,
          status: mappedStatus,
          raw: rawJson,
        },
        update: {
          // campaignId 변경은 통상 X — 광고그룹 이동이 발생하면 응답에 반영되므로 동기화.
          campaignId: dbCampaignId,
          name: g.name,
          bidAmt: bidAmtVal,
          dailyBudget: dailyBudgetVal,
          pcChannelOn,
          mblChannelOn,
          status: mappedStatus,
          raw: rawJson,
        },
      })
      synced++
    }
  } catch (e) {
    console.error("[syncAdgroups] upsert failed:", e)
    return { ok: false, error: "DB 적재 중 오류" }
  }

  await logAudit({
    userId: user.id,
    action: "adgroup.sync",
    targetType: "Advertiser",
    targetId: advertiserId,
    before: null,
    after: {
      synced,
      skipped,
      customerId: advertiser.customerId,
    },
  })

  revalidatePath(`/${advertiserId}/adgroups`)

  return {
    ok: true,
    synced,
    skipped,
    durationMs: Date.now() - start,
  }
}

// =============================================================================
// 2. bulkUpdateAdgroups — toggle / bid / budget / channel 일괄 변경
// =============================================================================

const bulkActionSchema = z.discriminatedUnion("action", [
  // ON/OFF 토글 (userLock)
  z.object({
    action: z.literal("toggle"),
    items: z
      .array(
        z.object({
          adgroupId: z.string().min(1), // 앱 DB AdGroup.id
          // userLock=true → OFF (lock), false → ON
          userLock: z.boolean(),
        }),
      )
      .min(1)
      .max(200),
  }),
  // 그룹 기본 입찰가
  z.object({
    action: z.literal("bid"),
    items: z
      .array(
        z.object({
          adgroupId: z.string().min(1),
          bidAmt: z.number().int().min(0), // 원 단위
        }),
      )
      .min(1)
      .max(200),
  }),
  // 일 예산
  z.object({
    action: z.literal("budget"),
    items: z
      .array(
        z.object({
          adgroupId: z.string().min(1),
          dailyBudget: z.number().int().min(0), // 원 단위
        }),
      )
      .min(1)
      .max(200),
  }),
  // 기본 매체 (PC/모바일) ON/OFF
  z.object({
    action: z.literal("channel"),
    items: z
      .array(
        z
          .object({
            adgroupId: z.string().min(1),
            pcChannelOn: z.boolean().optional(),
            mblChannelOn: z.boolean().optional(),
          })
          // 둘 중 하나 이상 필수 — 빈 변경 항목 차단
          .refine(
            (v) =>
              typeof v.pcChannelOn === "boolean" ||
              typeof v.mblChannelOn === "boolean",
            { message: "pcChannelOn 또는 mblChannelOn 중 최소 하나 필요" },
          ),
      )
      .min(1)
      .max(200),
  }),
])

export type BulkAdgroupActionInput = z.infer<typeof bulkActionSchema>

export type BulkUpdateAdgroupItemResult = {
  adgroupId: string
  ok: boolean
  error?: string
}

export type BulkUpdateAdgroupsResult = {
  batchId: string
  total: number
  success: number
  failed: number
  items: BulkUpdateAdgroupItemResult[]
}

type DbAdGroupSnapshot = {
  id: string
  nccAdgroupId: string
  name: string
  bidAmt: number | null
  dailyBudget: number | null
  pcChannelOn: boolean
  mblChannelOn: boolean
  status: AdGroupStatus
}

/**
 * 광고그룹 일괄 변경.
 *
 *   1. getCurrentAdvertiser — 권한 검증
 *   2. Zod 검증 (action / items)
 *   3. 대상 광고그룹 광고주 한정 조회 (campaign.advertiserId join)
 *   4. ChangeBatch (status='running') 생성 + ChangeItem 일괄 생성
 *   5. updateAdgroupsBulk(customerId, items, fields) — 단일 PUT
 *      ※ channel 액션은 SA 필드 미확정 → throw + 모두 failed (TODO)
 *   6. 응답 매핑: 성공 → DB update + ChangeItem='done'. 누락/예외 → 'failed'
 *   7. ChangeBatch finalize (done/failed) + finishedAt
 *   8. AuditLog 1건 (요약)
 */
export async function bulkUpdateAdgroups(
  advertiserId: string,
  input: BulkAdgroupActionInput,
): Promise<BulkUpdateAdgroupsResult> {
  const { advertiser, user } = await getCurrentAdvertiser(advertiserId)
  if (!advertiser.hasKeys) {
    throw new Error("API 키/시크릿 미입력")
  }

  const parsed = bulkActionSchema.parse(input)

  // -- 입력 정규화: adgroupId 중복은 마지막 항목으로 대체 ----------------------
  // (idempotencyKey unique 제약 충돌 방지)
  type ChangePayload = {
    userLock?: boolean
    bidAmt?: number
    dailyBudget?: number
    pcChannelOn?: boolean
    mblChannelOn?: boolean
  }
  const itemsByAdgroupId = new Map<string, ChangePayload>()
  switch (parsed.action) {
    case "toggle":
      for (const it of parsed.items) {
        itemsByAdgroupId.set(it.adgroupId, { userLock: it.userLock })
      }
      break
    case "bid":
      for (const it of parsed.items) {
        itemsByAdgroupId.set(it.adgroupId, { bidAmt: it.bidAmt })
      }
      break
    case "budget":
      for (const it of parsed.items) {
        itemsByAdgroupId.set(it.adgroupId, { dailyBudget: it.dailyBudget })
      }
      break
    case "channel":
      for (const it of parsed.items) {
        itemsByAdgroupId.set(it.adgroupId, {
          pcChannelOn: it.pcChannelOn,
          mblChannelOn: it.mblChannelOn,
        })
      }
      break
  }
  const adgroupIds = Array.from(itemsByAdgroupId.keys())

  // -- 대상 광고그룹 광고주 한정 조회 (campaign join) --------------------------
  const dbAdgroups = await prisma.adGroup.findMany({
    where: {
      campaign: { advertiserId }, // 핵심: 광고주 한정 (횡단 노출 차단)
      id: { in: adgroupIds },
    },
    select: {
      id: true,
      nccAdgroupId: true,
      name: true,
      bidAmt: true,
      dailyBudget: true,
      pcChannelOn: true,
      mblChannelOn: true,
      status: true,
    },
  })

  if (dbAdgroups.length !== adgroupIds.length) {
    throw new Error("일부 광고그룹이 광고주 소속이 아닙니다")
  }

  const beforeMap = new Map<string, DbAdGroupSnapshot>(
    dbAdgroups.map((g) => [
      g.id,
      {
        id: g.id,
        nccAdgroupId: g.nccAdgroupId,
        name: g.name,
        bidAmt: g.bidAmt === null ? null : Number(g.bidAmt),
        dailyBudget: g.dailyBudget === null ? null : Number(g.dailyBudget),
        pcChannelOn: g.pcChannelOn,
        mblChannelOn: g.mblChannelOn,
        status: g.status,
      },
    ]),
  )

  // -- ChangeBatch + ChangeItem 생성 -------------------------------------------
  const action = `adgroup.${parsed.action}` as const
  const total = adgroupIds.length

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
  const itemsForApi: AdgroupBulkUpdateItem[] = []
  const changeItemData = adgroupIds.map((aid) => {
    const dbG = beforeMap.get(aid)!
    const change = itemsByAdgroupId.get(aid)!

    let beforeData: Prisma.InputJsonValue
    let afterData: Prisma.InputJsonValue

    switch (parsed.action) {
      case "toggle":
        // TODO(F-6.4 롤백 정확도): status='off' 는 userLock=true 외에 SA 'PAUSED' 도 흡수.
        //   PAUSED 광고그룹의 toggle before 가 실제 userLock=false 인데 true 로 기록될 수 있음.
        //   F-6.4 롤백 도입 시 raw.userLock 또는 별도 컬럼으로 전환 (현재는 단순 표현식 유지).
        beforeData = { userLock: dbG.status === "off" } as Prisma.InputJsonValue
        afterData = { userLock: change.userLock } as Prisma.InputJsonValue
        itemsForApi.push({
          nccAdgroupId: dbG.nccAdgroupId,
          userLock: change.userLock,
        })
        break
      case "bid":
        beforeData = { bidAmt: dbG.bidAmt } as Prisma.InputJsonValue
        afterData = { bidAmt: change.bidAmt } as Prisma.InputJsonValue
        itemsForApi.push({
          nccAdgroupId: dbG.nccAdgroupId,
          bidAmt: change.bidAmt,
        })
        break
      case "budget":
        // useDailyBudget 은 dailyBudget != null 로 파생 (CLAUDE.md 규약).
        beforeData = {
          dailyBudget: dbG.dailyBudget,
        } as Prisma.InputJsonValue
        afterData = {
          dailyBudget: change.dailyBudget,
        } as Prisma.InputJsonValue
        itemsForApi.push({
          nccAdgroupId: dbG.nccAdgroupId,
          dailyBudget: change.dailyBudget,
          useDailyBudget:
            typeof change.dailyBudget === "number" && change.dailyBudget > 0,
        })
        break
      case "channel":
        beforeData = {
          pcChannelOn: dbG.pcChannelOn,
          mblChannelOn: dbG.mblChannelOn,
        } as Prisma.InputJsonValue
        afterData = {
          pcChannelOn: change.pcChannelOn ?? dbG.pcChannelOn,
          mblChannelOn: change.mblChannelOn ?? dbG.mblChannelOn,
        } as Prisma.InputJsonValue
        // channel 액션은 itemsForApi 에 push 하지 않는다 — 아래에서 명시적 throw.
        // (SA 채널 키 ON/OFF 표현이 미확정. 본 PR에서는 호출 자체를 막아 사용자에 명시.)
        break
    }

    return {
      batchId: batch.id,
      targetType: "AdGroup",
      targetId: dbG.nccAdgroupId,
      before: beforeData,
      after: afterData,
      idempotencyKey: `${batch.id}:${dbG.nccAdgroupId}`,
      status: "pending" as const,
    }
  })

  await prisma.changeItem.createMany({ data: changeItemData })

  // -- SA API 호출 -------------------------------------------------------------
  // fields 매핑:
  //   toggle  → "userLock"
  //   bid     → "bidAmt"
  //   budget  → "dailyBudget,useDailyBudget"
  //   channel → SA 필드명 미확정 (TODO) → 본 PR 에서 명시적 throw
  let success = 0
  let failed = 0
  const results: BulkUpdateAdgroupItemResult[] = []

  // ---------------------------------------------------------------------------
  // TODO(F-2.2 channel): 네이버 SA 의 PC/모바일 매체 ON/OFF 표현 확정 필요.
  //   현재 lib/naver-sa/adgroups.ts AdGroupSchema 는 pcChannelKey / mobileChannelKey
  //   문자열로 passthrough 만 두고 있음. 빈 문자열 = OFF 인지, 별도 boolean 필드인지
  //   샘플 응답 확인 후 다음 사항 확정:
  //     1) DB 의 pcChannelOn / mblChannelOn 을 SA 필드명으로 어떻게 환산할지
  //     2) fields 쿼리 파라미터 정확한 값
  //   본 PR 에서는 의도된 실패로 처리하여 운영 시점에 즉시 발견되도록 한다.
  // ---------------------------------------------------------------------------
  if (parsed.action === "channel") {
    const msg =
      "SA channel 필드 미확정 — 운영 검증 필요 (TODO: lib/naver-sa/adgroups.ts 채널 필드 확정 후 본 액션 재구현)"
    await prisma.changeItem.updateMany({
      where: { batchId: batch.id },
      data: { status: "failed", error: msg.slice(0, 500) },
    })
    failed = total
    for (const aid of adgroupIds) {
      results.push({ adgroupId: aid, ok: false, error: msg })
    }

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
        note: "channel-field-undecided",
      },
    })

    revalidatePath(`/${advertiserId}/adgroups`)

    return {
      batchId: batch.id,
      total,
      success: 0,
      failed,
      items: results,
    }
  }

  // toggle / bid / budget — 정상 흐름
  let fields: string
  switch (parsed.action) {
    case "toggle":
      fields = "userLock"
      break
    case "bid":
      fields = "bidAmt"
      break
    case "budget":
      fields = "dailyBudget,useDailyBudget"
      break
  }

  try {
    const updated = await updateAdgroupsBulk(
      advertiser.customerId,
      itemsForApi,
      fields,
    )
    const updatedMap = new Map(updated.map((g) => [g.nccAdgroupId, g]))

    for (const aid of adgroupIds) {
      const dbG = beforeMap.get(aid)!
      const u = updatedMap.get(dbG.nccAdgroupId)
      if (u) {
        const rawJson = u as unknown as Prisma.InputJsonValue
        // DB 반영 — 액션별로 다르게 update
        switch (parsed.action) {
          case "toggle": {
            const newStatus = mapAdGroupStatus(u)
            await prisma.adGroup.update({
              where: { id: dbG.id },
              data: {
                status: newStatus,
                raw: rawJson,
              },
            })
            break
          }
          case "bid": {
            const newBid = typeof u.bidAmt === "number" ? u.bidAmt : null
            await prisma.adGroup.update({
              where: { id: dbG.id },
              data: {
                bidAmt: newBid,
                raw: rawJson,
              },
            })
            break
          }
          case "budget": {
            const newBudget =
              typeof u.dailyBudget === "number" ? u.dailyBudget : null
            await prisma.adGroup.update({
              where: { id: dbG.id },
              data: {
                dailyBudget: newBudget,
                raw: rawJson,
              },
            })
            break
          }
        }
        await prisma.changeItem.updateMany({
          where: { batchId: batch.id, targetId: dbG.nccAdgroupId },
          data: { status: "done" },
        })
        success++
        results.push({ adgroupId: aid, ok: true })
      } else {
        await prisma.changeItem.updateMany({
          where: { batchId: batch.id, targetId: dbG.nccAdgroupId },
          data: { status: "failed", error: "응답에 누락" },
        })
        failed++
        results.push({ adgroupId: aid, ok: false, error: "응답 누락" })
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
    for (const aid of adgroupIds) {
      results.push({ adgroupId: aid, ok: false, error: msg })
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

  revalidatePath(`/${advertiserId}/adgroups`)

  return { batchId: batch.id, total, success, failed, items: results }
}

// =============================================================================
// helpers
// =============================================================================

/**
 * 네이버 SA AdGroup → 앱 AdGroupStatus enum 매핑.
 *
 * 매핑 정책 (campaigns/actions.ts mapCampaignStatus 와 동일 패턴):
 *   - userLock=true                               → 'off' (사용자가 OFF)
 *   - status='DELETED' (또는 deleted=true)        → 'deleted'
 *   - status='PAUSED'                             → 'off'
 *   - 그 외 (ELIGIBLE / PENDING_REVIEW / 그 외)   → 'on'
 *
 * 참고: SA 응답엔 `userLock`(boolean) 과 `status`(string) 가 모두 존재.
 *       ON/OFF 토글은 일반적으로 userLock 으로 다룸 → userLock=true 는 즉시 'off'.
 *       삭제는 일반적으로 status 의 'DELETED' 또는 별도 deleted boolean.
 */
function mapAdGroupStatus(g: SaAdGroup): AdGroupStatus {
  // SA 응답 형태가 모듈마다 다를 수 있으므로 안전하게 union 검사.
  const anyG = g as unknown as {
    userLock?: boolean
    status?: string
    deleted?: boolean
  }
  if (anyG.deleted === true) return "deleted"
  if (
    typeof anyG.status === "string" &&
    anyG.status.toUpperCase() === "DELETED"
  ) {
    return "deleted"
  }
  if (anyG.userLock === true) return "off"
  if (
    typeof anyG.status === "string" &&
    anyG.status.toUpperCase() === "PAUSED"
  ) {
    return "off"
  }
  return "on"
}
