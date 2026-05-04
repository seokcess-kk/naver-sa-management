/**
 * Vercel Cron 핸들러 — KeywordPerformanceProfile baseline 일 1회 갱신 (Phase A.2)
 *
 * 동작:
 *   1. CRON_SECRET 검증 (env 미설정 또는 헤더 불일치 시 401)
 *   2. 활성 광고주 조회 (status='active'). API 키 등록 여부 무관 — 본 cron 은 DB 집계만 (SA 호출 X)
 *   3. 광고주별 직렬 처리:
 *        calculateBaseline → upsertBaseline
 *      try/catch 로 실패 격리 — 한 광고주 실패가 다음 광고주 차단 X
 *   4. 결과 응답 (advertisersTotal / advertisersOk / advertisersFailed / errors[])
 *
 * Cron 등록 (vercel.json):
 *   { "path": "/api/cron/keyword-perf-profile", "schedule": "30 19 * * *" }
 *   - UTC 19:30 = KST 04:30 (전일자 StatDaily 적재 완료 후 — stat-daily UTC 18:00 + cleanup 18:30 후속)
 *
 * 안전장치:
 *   - CRON_SECRET 미설정 시 항상 401 (개발 로컬 의도치 않은 실행 차단)
 *   - SA 호출 0 — Rate Limit / Estimate 비용 영향 없음
 *   - errors[].message 길이 500 자 cap (calculate.ts 는 시크릿 평문 미주입 — 2차 방어로 scrubString)
 *
 * 비대상:
 *   - 사용자 인증 (Cron 전용)
 *   - assertRole / RLS (service_role 컨텍스트)
 *   - ChangeBatch (조회·집계만 — SA 변경 X)
 *   - AuditLog (운영 메트릭은 응답 + Sentry instrumentation 자동)
 *
 * Vercel maxDuration:
 *   - Pro 플랜 900s 한도 → maxDuration 600 (광고주당 ~1초 가정 충분)
 */

import { NextRequest, NextResponse } from "next/server"

import { scrubString } from "@/lib/crypto/scrub-string"
import { prisma } from "@/lib/db/prisma"
import {
  calculateBaseline,
  upsertBaseline,
} from "@/lib/keyword-perf-profile/calculate"

// Prisma 사용 → Edge 가 아닌 Node 런타임 강제.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 600

// =============================================================================
// 응답 타입
// =============================================================================

type BaselineError = {
  advertiserId: string
  customerId: string
  message: string
}

type CronResponse = {
  ok: boolean
  advertisersTotal: number
  advertisersOk: number
  advertisersFailed: number
  ts: string
  errors: BaselineError[]
  error?: string
}

// =============================================================================
// 헬퍼
// =============================================================================

function safeErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return scrubString(raw).slice(0, 500)
}

// =============================================================================
// 핵심 진입점
// =============================================================================

export async function GET(req: NextRequest): Promise<NextResponse<CronResponse>> {
  const ts = new Date().toISOString()

  // -- 1. CRON_SECRET 검증 ---------------------------------------------------
  const cronSecret = process.env.CRON_SECRET
  const auth = req.headers.get("authorization") ?? ""
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      {
        ok: false,
        advertisersTotal: 0,
        advertisersOk: 0,
        advertisersFailed: 0,
        ts,
        errors: [],
        error: "unauthorized",
      },
      { status: 401 },
    )
  }

  // -- 2. 활성 광고주 조회 (API 키 무관 — 본 cron 은 DB 집계만) -------------
  const advertisers = await prisma.advertiser.findMany({
    where: { status: "active" },
    select: {
      id: true,
      customerId: true,
    },
    orderBy: { id: "asc" },
  })

  // -- 3. 광고주별 직렬 처리 -------------------------------------------------
  let advertisersOk = 0
  let advertisersFailed = 0
  const errors: BaselineError[] = []

  for (const adv of advertisers) {
    try {
      const baseline = await calculateBaseline(adv.id)
      await upsertBaseline(baseline)
      advertisersOk++
    } catch (e) {
      advertisersFailed++
      const message = safeErrorMessage(e)
      errors.push({
        advertiserId: adv.id,
        customerId: adv.customerId,
        message,
      })
      console.error(
        `[cron/keyword-perf-profile] advertiser=${adv.id} customer=${adv.customerId} failed: ${message}`,
      )
    }
  }

  return NextResponse.json({
    ok: true,
    advertisersTotal: advertisers.length,
    advertisersOk,
    advertisersFailed,
    ts,
    errors,
  })
}
