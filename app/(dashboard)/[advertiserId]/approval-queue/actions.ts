"use server"

/**
 * F-D.4 ApprovalQueue Server Actions
 *
 * 책임:
 *   1. approveQueue(advertiserId, ids[])
 *      - 권한 + 광고주 검증 (operator+)
 *      - ApprovalQueue.status='pending' + advertiserId 한정 행 로드
 *      - kind='search_term_promote' 만 본 PR 처리 (search_term_exclude 는 후속 PR)
 *      - 광고그룹 batch 조회 (활성 / 광고주 한정 / status != 'deleted')
 *      - ChangeBatch 생성 (action='approval_queue.apply')
 *      - ChangeItem.createMany — 각 row 에 대해 keyword CREATE seed
 *      - ApprovalQueue.updateMany → status='approved', appliedBatchId, decidedBy, decidedAt
 *      - AuditLog action='approval_queue.approve'
 *      - revalidatePath
 *
 *   2. rejectQueue(advertiserId, ids[])
 *      - 권한 검증 (operator+)
 *      - updateMany status='rejected', decidedBy, decidedAt
 *      - AuditLog action='approval_queue.reject'
 *
 * 운영 정책 (CLAUDE.md / 안전장치):
 *   - "staging → 미리보기 → 확정" 모델: 본 액션은 "확정" 시점만 — 즉시 SA 호출 X
 *   - /api/batch/run cron 이 'approval_queue.apply' 화이트리스트로 픽업
 *   - apply.ts 는 이미 keyword CREATE 분기 보유 (F-3.4) — 그대로 재사용
 *
 * 데이터 정합성 (사전 실패 처리):
 *   - 광고그룹 미존재 / status='deleted' → ChangeItem.status='failed' / error="invalid_adgroup_state"
 *   - keyword 텍스트 길이 > 50 → ChangeItem.status='failed' / error="keyword_too_long"
 *   - 동일 (nccAdgroupId, keyword, EXACT) 키워드 이미 존재 시점 차단은 apply.ts 의 멱등 처리에 위임
 *
 * SPEC v0.2.1 F-12 + plan(graceful-sparking-graham) Phase D.4
 */

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { prisma } from "@/lib/db/prisma"
import { getCurrentAdvertiser } from "@/lib/auth/access"
import { logAudit } from "@/lib/audit/log"
import type { Prisma as PrismaTypes } from "@/lib/generated/prisma/client"

// =============================================================================
// 공통
// =============================================================================

export type ActionResult<T = void> =
  | ({ ok: true } & (T extends void ? Record<never, never> : { data: T }))
  | { ok: false; error: string }

const advertiserIdSchema = z.string().trim().min(1).max(128)
const idsSchema = z.array(z.string().trim().min(1).max(128)).min(1).max(500)

// =============================================================================
// 1. approveQueue — search_term_promote 만 처리
// =============================================================================

export type ApproveQueueResult = {
  /** 생성된 ChangeBatch.id (있을 때). search_term_promote 1건도 없으면 undefined. */
  batchId?: string
  /** 입력 큐 항목 개수. */
  count: number
  /** kind 필터 (search_term_promote) 미해당으로 제외된 수. */
  skippedKindCount: number
  /** kind=search_term_promote 였으나 사전 실패 (광고그룹 미존재 / 키워드 길이 초과 등) 수. */
  preFailed: number
  /** 정상 ChangeItem 으로 적재된 수 (= cron 처리 대기). */
  enqueued: number
}

export async function approveQueue(
  advertiserId: string,
  ids: string[],
): Promise<ActionResult<ApproveQueueResult>> {
  // -- 입력 검증 ------------------------------------------------------------
  let parsedIds: string[]
  try {
    advertiserIdSchema.parse(advertiserId)
    parsedIds = idsSchema.parse(ids)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `잘못된 입력: ${msg}` }
  }
  parsedIds = Array.from(new Set(parsedIds))

  // -- 권한 + 광고주 컨텍스트 ----------------------------------------------
  const { advertiser, user } = await getCurrentAdvertiser(advertiserId)
  if (user.role === "viewer") {
    return { ok: false, error: "권한 부족 (viewer)" }
  }
  if (!advertiser.hasKeys) {
    return {
      ok: false,
      error: "API 키/시크릿 미입력 — 적용 시 SA 호출 불가",
    }
  }

  // -- ApprovalQueue 행 로드 ------------------------------------------------
  const queueRows = await prisma.approvalQueue.findMany({
    where: {
      id: { in: parsedIds },
      advertiserId,
      status: "pending",
    },
    select: {
      id: true,
      kind: true,
      payload: true,
    },
  })

  if (queueRows.length === 0) {
    return {
      ok: false,
      error: "유효한 pending 항목이 없습니다 (이미 처리되었거나 존재하지 않음)",
    }
  }

  // -- kind 분기 — search_term_promote 만 처리 ------------------------------
  type PromoteRow = {
    queueId: string
    searchTerm: string
    adgroupId: string
  }
  const promoteRows: PromoteRow[] = []
  let skippedKindCount = 0

  for (const r of queueRows) {
    if (r.kind !== "search_term_promote") {
      // 본 PR 비대상 (search_term_exclude 는 후속) — pending 유지하고 skip 카운트만 노출
      skippedKindCount++
      continue
    }
    const p = r.payload as
      | { searchTerm?: unknown; adgroupId?: unknown }
      | null
    const searchTerm =
      p && typeof p.searchTerm === "string" ? p.searchTerm.trim() : ""
    const adgroupId =
      p && typeof p.adgroupId === "string" ? p.adgroupId.trim() : ""
    if (!searchTerm || !adgroupId) {
      // payload 손상 — pending 유지 (수동 정리 권고)
      continue
    }
    promoteRows.push({ queueId: r.id, searchTerm, adgroupId })
  }

  if (promoteRows.length === 0) {
    return {
      ok: false,
      error: `처리 가능한 search_term_promote 항목이 없습니다 (skipped kind ${skippedKindCount}건)`,
    }
  }

  // -- 광고그룹 batch 조회 (광고주 한정) ------------------------------------
  const adgroupIds = Array.from(new Set(promoteRows.map((r) => r.adgroupId)))
  const adgroups = await prisma.adGroup.findMany({
    where: {
      id: { in: adgroupIds },
      campaign: { advertiserId },
    },
    select: {
      id: true,
      nccAdgroupId: true,
      status: true,
    },
  })
  const adgroupById = new Map(adgroups.map((g) => [g.id, g]))

  // -- ChangeBatch 생성 -----------------------------------------------------
  const batch = await prisma.changeBatch.create({
    data: {
      userId: user.id,
      action: "approval_queue.apply",
      status: "pending",
      total: promoteRows.length,
      processed: 0,
      attempt: 0,
      summary: {
        advertiserId,
        kind: "search_term_promote",
        count: promoteRows.length,
        skippedKindCount,
      },
    },
  })

  // -- ChangeItem seed 산출 ------------------------------------------------
  type Seed = {
    targetType: string
    targetId: string
    before: PrismaTypes.InputJsonValue
    after: PrismaTypes.InputJsonValue
    idempotencyKey: string
    status: "pending" | "failed"
    error?: string
  }
  const seeds: Seed[] = []
  let preFailed = 0

  for (const r of promoteRows) {
    const adgroup = adgroupById.get(r.adgroupId)
    const isInvalidAdgroup = !adgroup || adgroup.status === "deleted"
    const isTooLong = r.searchTerm.length > 50

    if (isInvalidAdgroup) {
      preFailed++
      seeds.push({
        targetType: "Keyword",
        targetId: `pending:${r.queueId}`,
        before: {},
        after: {
          queueId: r.queueId,
          searchTerm: r.searchTerm,
          adgroupId: r.adgroupId,
        },
        idempotencyKey: `${batch.id}:${r.queueId}`,
        status: "failed",
        error: "invalid_adgroup_state",
      })
      continue
    }
    if (isTooLong) {
      preFailed++
      seeds.push({
        targetType: "Keyword",
        targetId: `pending:${r.queueId}`,
        before: {},
        after: {
          queueId: r.queueId,
          searchTerm: r.searchTerm,
          adgroupId: r.adgroupId,
        },
        idempotencyKey: `${batch.id}:${r.queueId}`,
        status: "failed",
        error: "keyword_too_long",
      })
      continue
    }

    // 정상 — apply.ts CREATE 호환 shape:
    //   operation=CREATE / customerId / nccAdgroupId / keyword / matchType / externalId
    //   bidAmt=null + useGroupBidAmt=true (그룹 입찰가 사용 — 안전한 기본값)
    //   matchType=EXACT (검색어 → 신규 키워드 등록 시 운영 정책 합의 — 정확 매칭이 안전)
    //   externalId 는 멱등키 (apply.ts 가 사용). queueId 사용 — 같은 큐 행 중복 적용 방지.
    const externalId = `approval_queue:${r.queueId}`
    seeds.push({
      targetType: "Keyword",
      targetId: `pending:${r.queueId}`,
      before: {},
      after: {
        operation: "CREATE",
        customerId: advertiser.customerId,
        nccAdgroupId: adgroup.nccAdgroupId,
        keyword: r.searchTerm,
        matchType: "EXACT",
        bidAmt: null,
        useGroupBidAmt: true,
        userLock: false,
        externalId,
        // 디버그 / 감사용
        queueId: r.queueId,
        source: "search_term_promote",
      },
      idempotencyKey: `${batch.id}:${r.queueId}`,
      status: "pending",
    })
  }

  // -- ChangeItem.createMany ------------------------------------------------
  await prisma.changeItem.createMany({
    data: seeds.map((s) => ({
      batchId: batch.id,
      targetType: s.targetType,
      targetId: s.targetId,
      before: s.before,
      after: s.after,
      idempotencyKey: s.idempotencyKey,
      status: s.status,
      error: s.error,
    })),
  })

  // -- ApprovalQueue.updateMany — 처리 대상만 approved 마킹 ----------------
  const decidedAt = new Date()
  await prisma.approvalQueue.updateMany({
    where: {
      id: { in: promoteRows.map((r) => r.queueId) },
      advertiserId,
      status: "pending",
    },
    data: {
      status: "approved",
      appliedBatchId: batch.id,
      decidedBy: user.id,
      decidedAt,
    },
  })

  const enqueued = promoteRows.length - preFailed

  // 사전 실패가 전부면 batch 즉시 failed 마킹 (cron 깨우는 비용 절감)
  if (enqueued === 0) {
    await prisma.changeBatch.update({
      where: { id: batch.id },
      data: {
        status: "failed",
        processed: promoteRows.length,
        finishedAt: new Date(),
      },
    })
  }

  // -- AuditLog -------------------------------------------------------------
  await logAudit({
    userId: user.id,
    action: "approval_queue.approve",
    targetType: "ChangeBatch",
    targetId: batch.id,
    before: null,
    after: {
      advertiserId,
      batchId: batch.id,
      queueIds: promoteRows.map((r) => r.queueId),
      kind: "search_term_promote",
      total: promoteRows.length,
      preFailed,
      enqueued,
      skippedKindCount,
    },
  })

  revalidatePath(`/${advertiserId}/approval-queue`)

  return {
    ok: true,
    data: {
      batchId: batch.id,
      count: queueRows.length,
      skippedKindCount,
      preFailed,
      enqueued,
    },
  }
}

// =============================================================================
// 2. rejectQueue
// =============================================================================

export type RejectQueueResult = {
  count: number
}

export async function rejectQueue(
  advertiserId: string,
  ids: string[],
): Promise<ActionResult<RejectQueueResult>> {
  let parsedIds: string[]
  try {
    advertiserIdSchema.parse(advertiserId)
    parsedIds = idsSchema.parse(ids)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `잘못된 입력: ${msg}` }
  }
  parsedIds = Array.from(new Set(parsedIds))

  const { user } = await getCurrentAdvertiser(advertiserId)
  if (user.role === "viewer") {
    return { ok: false, error: "권한 부족 (viewer)" }
  }

  const decidedAt = new Date()
  const r = await prisma.approvalQueue.updateMany({
    where: {
      id: { in: parsedIds },
      advertiserId,
      status: "pending",
    },
    data: {
      status: "rejected",
      decidedBy: user.id,
      decidedAt,
    },
  })

  await logAudit({
    userId: user.id,
    action: "approval_queue.reject",
    targetType: "Advertiser",
    targetId: advertiserId,
    before: null,
    after: {
      advertiserId,
      queueIds: parsedIds,
      rejectedCount: r.count,
    },
  })

  revalidatePath(`/${advertiserId}/approval-queue`)

  return { ok: true, data: { count: r.count } }
}
