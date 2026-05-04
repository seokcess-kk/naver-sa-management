/**
 * Vercel Cron 핸들러 — ChangeBatch Chunk Executor (F-3.4 / SPEC v0.2.1 3.5)
 *
 * 동작:
 *   1. CRON_SECRET 검증 (env 미설정 또는 헤더 불일치 시 401)
 *   2. lease 획득 — UPDATE ... WHERE id = (SELECT FOR UPDATE SKIP LOCKED ...)
 *      - status IN ('pending','running')
 *      - leaseExpiresAt IS NULL OR < now()  ← IS NULL 조건 필수 (신규 pending 픽업)
 *      - action IN ('keyword.csv','bid_inbox.apply')  ← 화이트리스트 (다른 액션은 동기 처리 그대로)
 *      - ORDER BY createdAt ASC LIMIT 1
 *   3. ChangeItem.status='pending' 100건씩 픽업 (cursor 아닌 status 정렬)
 *   4. 각 item → applyChange (lib/batch/apply.ts) → done / failed 적재
 *   5. 시간 한계(50s) 도달 시 lease 해제 → 다음 Cron 이 이어 처리 (self-invoke X)
 *   6. 모든 pending 처리 완료 시 ChangeBatch.status = done(failed=0) 또는 failed
 *
 * Cron 등록 (vercel.json):
 *   { "path": "/api/batch/run", "schedule": "* * * * *" }
 *   Authorization: Bearer ${CRON_SECRET} 자동 부착됨 (Vercel Cron 규약).
 *
 * 안전장치:
 *   - CRON_SECRET 미설정 시 항상 401 (개발 로컬 의도치 않은 실행 차단)
 *   - lease IS NULL 조건 + FOR UPDATE SKIP LOCKED — 동시 워커 race 방지
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

import { NextRequest, NextResponse } from "next/server"

import { applyChange } from "@/lib/batch/apply"
import { scrubString } from "@/lib/crypto/scrub-string"
import { prisma } from "@/lib/db/prisma"

// Prisma 사용 → Edge 가 아닌 Node 런타임 강제.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// =============================================================================
// 응답 타입
// =============================================================================

type RunResponse = {
  ok: boolean
  picked: number
  batchId?: string
  processed?: number
  remaining?: number
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
  //     · 'keyword.csv'     — F-3.4 CSV 일괄 가져오기
  //     · 'bid_inbox.apply' — F-11.4 Phase B.3 Inbox 일괄 적용 (Keyword UPDATE 만)
  //   다른 액션은 동기 처리(Server Action 안에서 SA 호출) 그대로 두어 보호.
  const acquired = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "ChangeBatch"
       SET "leaseOwner" = ${workerId},
           "leaseExpiresAt" = now() + interval '5 minutes',
           "status" = 'running',
           "attempt" = "attempt" + 1
     WHERE "id" = (
       SELECT "id" FROM "ChangeBatch"
        WHERE "status" IN ('pending','running')
          AND "action" IN ('keyword.csv','bid_inbox.apply')
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
  // Vercel 함수 한계 60s 가정 → 50s 안전 마진. 도달 시 즉시 종료 + lease 해제.
  const startedAt = Date.now()
  const TIME_BUDGET_MS = 50_000
  const CHUNK_SIZE = 100

  let processedThisRun = 0

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
        await prisma.changeItem.update({
          where: { id: item.id },
          data: {
            status: "done",
            // CREATE 성공 시 nccKeywordId 갱신 (UPDATE/OFF 는 미반환 → 기존 targetId 유지)
            targetId: result.nccKeywordId ?? item.targetId,
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
    }

    // ChangeBatch.processed 진행률 갱신 (정상 + 실패 모두 계산)
    await prisma.changeBatch.update({
      where: { id: batchId },
      data: { processed: { increment: items.length } },
    })
  }

  // -- 4. 종료 처리 ----------------------------------------------------------
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
