/**
 * ChangeBatch 진행률 조회 (F-3.4 polling 엔드포인트).
 *
 * GET /api/batch/{id}
 *   → { batch: { id, action, status, total, processed, attempt, createdAt, finishedAt },
 *       counts: { pending?: N, done?: N, failed?: N, ... } }
 *
 * 인증:
 *   - getCurrentUser() — 미인증 throw (UnauthenticatedError) → 401
 *   - 본 PR 은 batch 소유자 / 광고주 권한 미세 검증은 생략 (소유자 userId 로 접근 제한은 후속).
 *     이유: ChangeBatch 가 광고주 컨텍스트(summary.advertiserId) 와 약결합 — 본 PR 단순화.
 *
 * UI 사용:
 *   - 5초 간격 polling
 *   - status === 'done' 또는 'failed' 면 polling 종료 → result 화면 전환
 */

import { NextRequest, NextResponse } from "next/server"

import { prisma } from "@/lib/db/prisma"
import { getCurrentUser, UnauthenticatedError } from "@/lib/auth/access"

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
  try {
    await getCurrentUser()
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 })
    }
    throw e
  }

  const { id } = await params

  // -- 2. ChangeBatch 조회 ---------------------------------------------------
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
    },
  })
  if (!batch) {
    return NextResponse.json({ error: "not found" }, { status: 404 })
  }

  // -- 3. ChangeItem 상태별 카운트 ------------------------------------------
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
