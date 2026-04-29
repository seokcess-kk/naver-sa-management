/**
 * ChangeBatch 진행률 조회 (F-3.4 polling 엔드포인트).
 *
 * GET /api/batch/{id}
 *   → { batch: { id, action, status, total, processed, attempt, createdAt, finishedAt },
 *       counts: { pending?: N, done?: N, failed?: N, ... } }
 *
 * 인증·권한 (3단 체크):
 *   1. getCurrentUser() — 미인증 throw (UnauthenticatedError) → 401
 *   2. ChangeBatch 조회 (없으면 404)
 *   3. 다음 중 하나라도 만족하면 통과, 셋 다 실패하면 403:
 *      a. me.role === "admin"               (admin은 전체 접근)
 *      b. batch.userId === me.id            (소유자)
 *      c. summary.advertiserId 가 string 이고 사용자가 그 광고주에 화이트리스트 접근
 *
 *   이유: ChangeBatch 는 광고주 컨텍스트(summary.advertiserId)와 약결합. cuid 추측은
 *   어렵지만 UI 에 batch ID 가 노출되므로 viewer 가 ID 만 알면 polling 가능한 구조 차단.
 *
 * 응답 shape:
 *   - userId / summary 컬럼은 권한 체크용으로만 select. 응답 BatchProgressResponse 에 미포함.
 *
 * UI 사용:
 *   - 5초 간격 polling
 *   - status === 'done' 또는 'failed' 면 polling 종료 → result 화면 전환
 */

import { NextRequest, NextResponse } from "next/server"

import { prisma } from "@/lib/db/prisma"
import {
  getCurrentUser,
  UnauthenticatedError,
  assertAdvertiserAccess,
  AuthorizationError,
} from "@/lib/auth/access"

// Prisma 사용 → Node 런타임 강제.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// =============================================================================
// 응답 타입
// =============================================================================

export type BatchProgressResponse = {
  batch: {
    id: string
    action: string
    status: string
    total: number
    processed: number
    attempt: number
    createdAt: string
    finishedAt: string | null
  }
  counts: Record<string, number>
}

type ErrorResponse = { error: string }

// =============================================================================
// 핵심 진입점
// =============================================================================

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse<BatchProgressResponse | ErrorResponse>> {
  // -- 1. 인증 ---------------------------------------------------------------
  let me
  try {
    me = await getCurrentUser()
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 })
    }
    throw e
  }

  const { id } = await params

  // -- 2. ChangeBatch 조회 (권한 체크용 userId / summary 포함) ---------------
  const batch = await prisma.changeBatch.findUnique({
    where: { id },
    select: {
      id: true,
      action: true,
      status: true,
      total: true,
      processed: true,
      attempt: true,
      createdAt: true,
      finishedAt: true,
      // 응답엔 미포함 — 권한 체크 전용
      userId: true,
      summary: true,
    },
  })
  if (!batch) {
    return NextResponse.json({ error: "not found" }, { status: 404 })
  }

  // -- 3. 권한 체크 ----------------------------------------------------------
  // 통과 조건 (OR): admin | 소유자 | summary.advertiserId 화이트리스트
  let allowed = me.role === "admin" || batch.userId === me.id
  if (!allowed) {
    const summary = batch.summary as Record<string, unknown> | null
    const advertiserId =
      summary && typeof summary.advertiserId === "string"
        ? summary.advertiserId
        : null
    if (advertiserId) {
      try {
        await assertAdvertiserAccess(me.id, advertiserId)
        allowed = true
      } catch (e) {
        // 화이트리스트 미존재 → fall through to 403
        if (
          !(e instanceof AuthorizationError) &&
          !(e instanceof UnauthenticatedError)
        ) {
          throw e
        }
      }
    }
  }
  if (!allowed) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 })
  }

  // -- 4. ChangeItem 상태별 카운트 ------------------------------------------
  const counts = await prisma.changeItem.groupBy({
    by: ["status"],
    where: { batchId: id },
    _count: true,
  })

  return NextResponse.json({
    batch: {
      id: batch.id,
      action: batch.action,
      status: batch.status,
      total: batch.total,
      processed: batch.processed,
      attempt: batch.attempt,
      createdAt: batch.createdAt.toISOString(),
      finishedAt: batch.finishedAt ? batch.finishedAt.toISOString() : null,
    },
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
  })
}
