/**
 * Vercel Cron 핸들러 — ChangeBatch Chunk Executor (F-3.4 / SPEC v0.2.1 3.5)
 *
 * 동작:
 *   1. CRON_SECRET 검증 (env 미설정 또는 헤더 불일치 시 401)
 *   2. lease 획득 — UPDATE ... WHERE id = (SELECT FOR UPDATE SKIP LOCKED ...)
 *      - status IN ('pending','running')
 *      - leaseExpiresAt IS NULL OR < now()  ← IS NULL 조건 필수 (신규 pending 픽업)
 *      - action IN ('keyword.csv','bid_inbox.apply','approval_queue.apply')  ← 화이트리스트
 *      - ORDER BY createdAt ASC LIMIT 1
 *   3. ChangeItem.status='pending' 100건씩 픽업 (cursor 아닌 status 정렬)
 *   4. 각 item → applyChange (lib/batch/apply.ts) → done / failed 적재
 *      + item 마다 heartbeat(lease 갱신) — 활성 워커는 lease 를 계속 살려 재획득 차단
 *   5. 시간 예산(TIME_BUDGET_MS) 도달 또는 pending 소진 시 lease 해제 → 다음 Cron 이어 처리 (self-invoke X)
 *   6. 모든 pending 처리 완료 시 ChangeBatch.status = done(failed=0) 또는 failed
 *
 * Cron 등록 (vercel.json):
 *   { "path": "/api/batch/run", "schedule": "* * * * *" }
 *   Authorization: Bearer ${CRON_SECRET} 자동 부착됨 (Vercel Cron 규약).
 *
 * 안전장치:
 *   - CRON_SECRET 미설정 시 항상 401 (개발 로컬 의도치 않은 실행 차단)
 *   - lease IS NULL 조건 + FOR UPDATE SKIP LOCKED — 동시 워커 race 방지
 *   - item 단위 heartbeat(lease 갱신) — 활성 워커가 TIME_BUDGET_MS(250s) 처리 중에도 lease(90s)를
 *     계속 살려두어, 다음 cron(매 분)이 같은 batch 를 재획득(leaseExpiresAt<now())하지 못하게 함.
 *     → 두 워커가 동일 pending ChangeItem 을 동시 처리(자연키 TOCTOU → 이중 생성)하는 것을 원천 차단.
 *     워커가 죽으면 heartbeat 중단 → 최대 90s 후 자연 만료 → 다음 cron 회수(빠른 회복 유지).
 *   - status='pending' 정렬 픽업 — 부분 실패 재시도 단순 (cursor 되돌림 X)
 *   - idempotencyKey unique (스키마) — 멱등성 1차 방어
 *   - applyChange 내부 자연키 사전 검사 — 멱등성 2차 방어 (시간차 외부 변경)
 *   - 외부 API 호출은 모두 lib/naver-sa 통과 (Rate Limit / HMAC / X-Customer)
 *
 * 비대상:
 *   - self-invoke (다음 chunk 를 별도 fetch 로 호출)
 *   - cursor 기반 처리
 *   - worker 다중화 (단일 worker 가정 — Cron 매 분 1회)
 *   - 다른 액션(bulkActionKeywords 등) 픽업 — action='keyword.csv' 한정
 */

import { revalidatePath } from "next/cache"
import { NextRequest, NextResponse } from "next/server"

import { applyChange } from "@/lib/batch/apply"
import { scrubString } from "@/lib/crypto/scrub-string"
import { prisma } from "@/lib/db/prisma"
import { dispatch } from "@/lib/notifier"
import { recordSyncAt } from "@/lib/sync/last-sync-at"
import type * as Prisma from "@/lib/generated/prisma/internal/prismaNamespace"

// Prisma 사용 → Edge 가 아닌 Node 런타임 강제.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// Vercel 함수 기본값(Pro 15s)에 끊기면 TIME_BUDGET_MS 가정과 미스매치되어 chunk
// 중간에 종료 → lease 5분 미해제로 다음 cron 픽업 차단. 300s 로 확장 (Pro 최대치).
// 보강: vercel.json `functions` 블록에도 동일 값 명시 — Next.js export 만으로
// 적용되지 않는 환경(빌드 캐시 등) 방어.
export const maxDuration = 300

// =============================================================================
// 응답 타입
// =============================================================================

type RunResponse = {
  ok: boolean
  picked: number
  batchId?: string
  processed?: number
  remaining?: number
  /** heartbeat 가 0행 → lease 를 다른 워커에게 상실. 정리 없이 조기 종료했음을 표시. */
  leaseLost?: boolean
  error?: string
}

// =============================================================================
// 핵심 진입점
// =============================================================================

export async function GET(req: NextRequest): Promise<NextResponse<RunResponse>> {
  // -- 1. CRON_SECRET 검증 ---------------------------------------------------
  const cronSecret = process.env.CRON_SECRET
  const auth = req.headers.get("authorization") ?? ""
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { ok: false, picked: 0, error: "unauthorized" },
      { status: 401 },
    )
  }

  const workerId = crypto.randomUUID()

  // -- 2. lease 획득 ---------------------------------------------------------
  // SPEC 3.5 패턴: UPDATE 의 WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)
  // - IS NULL 조건 필수 (신규 pending 행 픽업)
  // - action 화이트리스트:
  //     · 'keyword.csv'         — F-3.4 CSV 일괄 가져오기
  //     · 'bid_inbox.apply'     — F-11.4 Phase B.3 Inbox 일괄 적용 (Keyword UPDATE 만)
  //     · 'approval_queue.apply' — F-12 D.4 ApprovalQueue 승인 (Keyword CREATE — search_term_promote)
  //     · 'sync_keywords'       — F-3.1 키워드 동기화 (광고그룹별 listKeywords + Keyword upsert)
  //   다른 액션은 동기 처리(Server Action 안에서 SA 호출) 그대로 두어 보호.
  // lease 90s — 죽은 워커가 heartbeat 를 멈춘 뒤 최대 90s 후 만료 → 다음 cron(매 분)이
  // 빠르게 회수. 활성 워커는 아래 while 루프에서 item 마다 heartbeat 로 lease 를 갱신하므로
  // TIME_BUDGET_MS(250s) 처리 중에도 만료되지 않는다(재획득·이중 처리 차단). 기존 5분은
  // maxDuration 미적용 환경에서 73분 동안 14 attempt 누적 사례 발생 → 90s 로 단축.
  // ※ 아래 heartbeat UPDATE 의 interval 과 반드시 동일(90 seconds)하게 유지.
  const acquired = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "ChangeBatch"
       SET "leaseOwner" = ${workerId},
           "leaseExpiresAt" = now() + interval '90 seconds',
           "status" = 'running',
           "attempt" = "attempt" + 1
     WHERE "id" = (
       SELECT "id" FROM "ChangeBatch"
        WHERE "status" IN ('pending','running')
          AND "action" IN ('keyword.csv','bid_inbox.apply','approval_queue.apply','sync_keywords')
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now())
        ORDER BY "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     RETURNING "id"
  `

  if (acquired.length === 0) {
    return NextResponse.json({ ok: true, picked: 0 })
  }
  const batchId = acquired[0].id

  // -- 3. chunk 처리 ---------------------------------------------------------
  // Vercel 함수 한계 300s 가정 (maxDuration export). 250s 안전 마진. 도달 시 즉시 종료
  // + lease 해제. 처리 중에는 item 마다 heartbeat 로 lease(90s)를 갱신하므로 활성 워커가
  // 250s 도는 동안 다음 cron 이 재획득할 수 없다. maxDuration 미적용 환경(빌드 캐시 등)에서
  // 워커가 죽으면 heartbeat 중단 → 90s 만료 → 다음 cron 회수.
  const startedAt = Date.now()
  const TIME_BUDGET_MS = 250_000
  const CHUNK_SIZE = 100

  let processedThisRun = 0
  // heartbeat UPDATE 가 0행 → lease 를 다른 워커에게 상실. 즉시 중단 후 조기 종료.
  let leaseLost = false

  while (Date.now() - startedAt < TIME_BUDGET_MS) {
    const items = await prisma.changeItem.findMany({
      where: { batchId, status: "pending" },
      orderBy: { id: "asc" },
      take: CHUNK_SIZE,
    })
    if (items.length === 0) break

    for (const item of items) {
      try {
        const result = await applyChange(item)
        // sync_keywords 분기 — syncSummary 를 기존 after JSON 에 머지(보존 + 합산값 추가).
        // 다른 분기(Keyword CREATE/UPDATE/OFF)는 result.syncSummary 미반환 → after 변경 X.
        const itemAfter = (item.after ?? {}) as Record<string, unknown>
        const mergedAfter = result.syncSummary
          ? { ...itemAfter, ...result.syncSummary }
          : itemAfter
        await prisma.changeItem.update({
          where: { id: item.id },
          data: {
            status: "done",
            // CREATE 성공 시 nccKeywordId 갱신 (UPDATE/OFF 는 미반환 → 기존 targetId 유지)
            targetId: result.nccKeywordId ?? item.targetId,
            // syncSummary 가 있을 때만 after 갱신 (없으면 기존 JSON 보존)
            ...(result.syncSummary
              ? { after: mergedAfter as Prisma.InputJsonValue }
              : {}),
          },
        })
      } catch (e) {
        // scrubString 으로 Bearer 토큰 / 32+ hex 패턴 마스킹 (applyChange 가 시크릿
        // 평문을 메시지에 주입하지 않는다는 1차 보장의 2차 방어)
        const raw = e instanceof Error ? e.message : String(e)
        const msg = scrubString(raw).slice(0, 500)
        await prisma.changeItem.update({
          where: { id: item.id },
          data: {
            status: "failed",
            error: msg,
            attempt: { increment: 1 },
          },
        })
      }
      processedThisRun++
      // 항목 단위 heartbeat + progress 증분 (원자적 1쿼리):
      //   · leaseExpiresAt 갱신 → 활성 워커는 lease(90s)를 계속 살려 재획득 불가 (안전장치 #2).
      //     heartbeat 를 item 마다 두는 이유: 청크(최대 100건) 단위로만 갱신하면 1건이 최대
      //     ~30s(sync_keywords 대형 광고그룹) 걸릴 수 있어 청크가 lease 를 초과 → mid-chunk
      //     만료 위험. item 단위(≤~30s < 90s)면 heartbeat 사이 만료가 발생하지 않는다.
      //   · WHERE leaseOwner=workerId — 우리가 소유한 동안만 갱신/증분. 만료돼 다른 워커가
      //     회수했다면 0행 → leaseLost 로 즉시 중단(동일 ChangeItem 이중 처리 방지).
      //   · progress 증분도 여기서 — chunk 단위 일괄 증분은 중복 카운트 위험.
      //   · interval '90 seconds' 는 위 lease 획득 쿼리와 동일하게 유지할 것.
      const beat = await prisma.$executeRaw`
        UPDATE "ChangeBatch"
           SET "processed" = "processed" + 1,
               "leaseExpiresAt" = now() + interval '90 seconds'
         WHERE "id" = ${batchId}
           AND "leaseOwner" = ${workerId}
      `
      if (beat === 0) {
        // lease 상실 — 새 소유자가 이어서 처리·finalize 한다. 우리가 lease/status 를
        // 건드리면 새 소유자와 충돌하므로 정리 없이 즉시 중단.
        leaseLost = true
        break
      }
    }
    if (leaseLost) break
  }

  // -- 4. 종료 처리 ----------------------------------------------------------
  if (leaseLost) {
    // heartbeat 0행 → 이미 다른 워커가 lease 를 소유. lease/status 를 건드리지 않고 조기
    // 종료 (remaining 처리·finalize 는 새 소유자 책임). 이중 처리·이중 finalize 방지.
    return NextResponse.json({
      ok: true,
      picked: 1,
      batchId,
      processed: processedThisRun,
      leaseLost: true,
    })
  }

  const remaining = await prisma.changeItem.count({
    where: { batchId, status: "pending" },
  })

  if (remaining === 0) {
    // 모든 처리 완료 — failed > 0 면 status=failed, 아니면 done.
    const failedCount = await prisma.changeItem.count({
      where: { batchId, status: "failed" },
    })
    await prisma.changeBatch.update({
      where: { id: batchId },
      data: {
        status: failedCount > 0 ? "failed" : "done",
        finishedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    })

    // -- change_batch_failed 알림 (Event 2) ---------------------------------
    // failedCount > 0 일 때만 dispatch. finalize 분기는 batch 당 자연 1회 호출 — 별도
    // throttle 불필요 (재시도로 다시 finalize 진입 시에도 batch 1건당 1번 알림이 정상).
    if (failedCount > 0) {
      await notifyChangeBatchFailed(batchId, failedCount)
    }

    // -- sync_keywords 전용 finalize hook -----------------------------------
    // - 모든 done ChangeItem.after 의 syncedKeywords / skipped 합산
    // - ChangeBatch.summary 갱신 (scannedAdgroups = done 카운트)
    // - recordSyncAt(advertiserId, 'keywords') — UI 헤더 "마지막 동기화" 배지
    // - revalidatePath — 키워드 목록 갱신 (Cron context 에서 호출 가능 — Next 16 OK)
    await finalizeSyncKeywordsBatch(batchId)
  } else {
    // 시간 한계 도달 — lease 해제하여 다음 Cron 이 이어 처리.
    // status 는 "running" 유지 (lease 쿼리가 IS NULL OR < now() 로 픽업).
    await prisma.changeBatch.update({
      where: { id: batchId },
      data: {
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    })
  }

  return NextResponse.json({
    ok: true,
    picked: 1,
    batchId,
    processed: processedThisRun,
    remaining,
  })
}

// =============================================================================
// finalizeSyncKeywordsBatch — sync_keywords 종료 hook
// =============================================================================
//
// 호출 시점: ChangeBatch 가 done/failed 로 갱신된 직후 (remaining===0).
// - batch.action !== 'sync_keywords' 면 즉시 return (no-op)
// - 모든 done ChangeItem.after 에서 syncedKeywords / skipped 합산
// - summary 갱신 (scannedAdgroups = done 카운트)
// - recordSyncAt(advertiserId, 'keywords') — UI "마지막 동기화" 배지
// - revalidatePath(`/${advertiserId}/keywords`) — Next 16 cron context 호출 가능
//
// 시크릿 X — summary.advertiserId / customerId 만 (키 없음).

async function finalizeSyncKeywordsBatch(batchId: string): Promise<void> {
  const batch = await prisma.changeBatch.findUnique({
    where: { id: batchId },
    select: { id: true, action: true, summary: true },
  })
  if (!batch) return
  if (batch.action !== "sync_keywords") return

  const summary =
    batch.summary && typeof batch.summary === "object" && !Array.isArray(batch.summary)
      ? (batch.summary as Record<string, unknown>)
      : {}
  const advertiserId =
    typeof summary.advertiserId === "string" ? summary.advertiserId : null

  // -- done ChangeItem 의 syncedKeywords / skipped 합산 -----------------------
  // sync_keywords 광고그룹 단위라 batch.total = adgroups.length (수백 단위) → findMany 안전.
  const doneItems = await prisma.changeItem.findMany({
    where: { batchId, status: "done" },
    select: { after: true },
  })

  let syncedKeywords = 0
  let skipped = 0
  for (const it of doneItems) {
    const after =
      it.after && typeof it.after === "object" && !Array.isArray(it.after)
        ? (it.after as Record<string, unknown>)
        : {}
    if (typeof after.syncedKeywords === "number") {
      syncedKeywords += after.syncedKeywords
    }
    if (typeof after.skipped === "number") {
      skipped += after.skipped
    }
  }

  const updatedSummary: Record<string, unknown> = {
    ...summary,
    scannedAdgroups: doneItems.length,
    syncedKeywords,
    skipped,
  }

  await prisma.changeBatch.update({
    where: { id: batchId },
    data: { summary: updatedSummary as Prisma.InputJsonValue },
  })

  if (advertiserId) {
    // lastSyncAt 갱신 (실패 무관 — 동기화 시도 완료 표시)
    try {
      await recordSyncAt(advertiserId, "keywords")
    } catch (e) {
      console.warn("[batch.run] recordSyncAt failed:", e)
    }
    // UI 갱신 — Next 16 은 cron/route handler context 에서도 revalidatePath 호출 가능.
    try {
      revalidatePath(`/${advertiserId}/keywords`)
    } catch (e) {
      console.warn("[batch.run] revalidatePath failed:", e)
    }
  }
}

// =============================================================================
// notifyChangeBatchFailed — Event 2: ChangeBatch 실패 알림
// =============================================================================
//
// 호출 시점: finalize 분기에서 failedCount > 0 일 때.
//
// 동작:
//   - ChangeBatch 메타 + summary.advertiserId 로드
//   - advertiserId 가 summary 에 있으면 광고주명 추가 조회 (옵셔널)
//   - failed ChangeItem.error 메시지를 그룹핑 → top 3 (scrubString 통과)
//   - dispatch payload: 시크릿 평문 X (batchId, action, failedCount, attempt, advertiserId, topErrors)
//
// 시크릿 정책:
//   - ChangeItem.error 는 applyChange catch 단계에서 이미 scrubString 적용 — 본 함수에서도
//     2차 scrubString (방어).
//
// 실패 격리:
//   - dispatch throw 는 try/catch 흡수. cron 다른 batch 진행 막지 않음.

async function notifyChangeBatchFailed(
  batchId: string,
  failedCount: number,
): Promise<void> {
  try {
    const batch = await prisma.changeBatch.findUnique({
      where: { id: batchId },
      select: {
        id: true,
        action: true,
        total: true,
        attempt: true,
        summary: true,
      },
    })
    if (!batch) return

    const summary =
      batch.summary &&
      typeof batch.summary === "object" &&
      !Array.isArray(batch.summary)
        ? (batch.summary as Record<string, unknown>)
        : {}
    const advertiserId =
      typeof summary.advertiserId === "string" ? summary.advertiserId : null

    let advertiserName: string | null = null
    if (advertiserId) {
      const adv = await prisma.advertiser.findUnique({
        where: { id: advertiserId },
        select: { name: true },
      })
      advertiserName = adv?.name ?? null
    }

    // -- 에러 메시지 그룹핑 — 상위 3 ----------------------------------------
    // ChangeItem.error 는 NULL 가능. failed 인데 NULL 인 행은 'unknown' 으로 분류.
    const failedItems = await prisma.changeItem.findMany({
      where: { batchId, status: "failed" },
      select: { error: true },
      take: 1000, // 알림 메시지 그룹핑 입력 캡 — 전체 카운트는 failedCount 인자 기준
    })
    const errorCounts = new Map<string, number>()
    for (const it of failedItems) {
      const raw = it.error ?? "unknown_error"
      // 2차 scrubString (Bearer / 32+ hex 마스킹). slice 200 — 알림 메시지 길이 보호.
      const key = scrubString(raw).slice(0, 200)
      errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1)
    }
    const topErrors = [...errorCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([msg, n]) => `[${n}] ${msg}`)

    console.info(
      `[batch.run] notify change_batch_failed batchId=${batchId} action=${batch.action} failedCount=${failedCount}/${batch.total} attempt=${batch.attempt}`,
    )

    await dispatch({
      ruleType: "change_batch_failed",
      severity: "critical",
      title: `[일괄 작업 실패] ${batch.action} (${failedCount}/${batch.total})`,
      body:
        `batchId=${batch.id} attempt=${batch.attempt} ` +
        `광고주=${advertiserName ?? advertiserId ?? "(unknown)"}`,
      meta: {
        batchId: batch.id,
        action: batch.action,
        total: batch.total,
        failedCount,
        attempt: batch.attempt,
        advertiserId,
        topErrors,
      },
    })
  } catch (e) {
    // 알림 실패가 batch finalize 를 막지 않게.
    console.warn(
      "[batch.run] notifyChangeBatchFailed failed:",
      e instanceof Error ? e.message : String(e),
    )
  }
}
