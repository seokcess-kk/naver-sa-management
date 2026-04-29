/**
 * Vercel Cron 핸들러 — 성과 데이터 retention cleanup (F-9.x 후속)
 *
 * 동작:
 *   1. CRON_SECRET 검증 (env 미설정 또는 헤더 불일치 시 401)
 *   2. retentionDays = STAT_RETENTION_DAYS env (default 90, 30~365 범위 검증)
 *   3. cutoff = now - retentionDays * 24h
 *   4. prisma.statDaily.deleteMany({ where: { date: { lt: cutoff } } })
 *   5. prisma.statHourly.deleteMany({ where: { date: { lt: cutoff } } })
 *   6. 결과 응답 — count 합산 + cutoff timestamp
 *
 * Cron 등록 (vercel.json):
 *   { "path": "/api/cron/stat-cleanup", "schedule": "30 18 * * *" }
 *   - UTC 18:30 = KST 03:30 (stat-daily 18:00 의 30 분 후행)
 *   - Authorization: Bearer ${CRON_SECRET} 자동 부착됨 (Vercel Cron 규약)
 *
 * 안전장치:
 *   - CRON_SECRET 미설정 시 항상 401 (개발 로컬 의도치 않은 실행 차단)
 *   - retentionDays 범위 [30, 365] — 너무 짧으면 운영 분석 차단, 너무 길면 무의미
 *   - 외부 호출 0 (DB 작업만) — Rate Limit / HMAC 무관
 *   - ChangeBatch / AuditLog 미사용 (자동 시스템 cleanup, 사용자 변경 X)
 *
 * 비대상:
 *   - 사용자 인증 (Cron 전용)
 *   - assertRole / RLS (service_role 사용 — 본 cron 은 service_role 키 컨텍스트)
 *   - 외부 SA API 호출 (DB-only)
 *   - 부분 광고주 cleanup (전 광고주 일괄 — retention 정책은 글로벌)
 *
 * Vercel maxDuration:
 *   - deleteMany 는 Postgres index 활용 시 빠르지만, 90 일 누적량 + index 락 시간
 *     보호 차원에서 maxDuration=120 (2 분) 보수 설정
 *   - Hobby 플랜 60 s 한도 → 무시될 수 있음. 운영 권고는 Pro
 */

import { NextRequest, NextResponse } from "next/server"

import { scrubString } from "@/lib/crypto/scrub-string"
import { prisma } from "@/lib/db/prisma"

// Prisma 사용 → Edge 가 아닌 Node 런타임 강제.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// deleteMany 는 빠르지만 인덱스 락 시간 보호 + Hobby 60s 한도 대비 보수 설정.
export const maxDuration = 120

// =============================================================================
// 응답 타입
// =============================================================================

type CronResponse = {
  ok: boolean
  retentionDays: number
  statDailyDeleted: number
  statHourlyDeleted: number
  cutoff: string
  ts: string
  error?: string
}

// =============================================================================
// 헬퍼
// =============================================================================

const DEFAULT_RETENTION_DAYS = 90
const MIN_RETENTION_DAYS = 30
const MAX_RETENTION_DAYS = 365

/**
 * STAT_RETENTION_DAYS env 파싱.
 *
 * - 미설정 → DEFAULT_RETENTION_DAYS (90)
 * - 정수 아님 / 범위 밖 → DEFAULT_RETENTION_DAYS (warning 로그)
 *
 * 운영자가 .env 로 retention 조정 가능하나 [30, 365] 범위 내에서만.
 */
export function resolveRetentionDays(envValue: string | undefined): number {
  if (!envValue) return DEFAULT_RETENTION_DAYS
  const n = Number(envValue)
  if (!Number.isInteger(n)) {
    console.warn(
      `[cron/stat-cleanup] STAT_RETENTION_DAYS=${envValue} is not an integer, using default ${DEFAULT_RETENTION_DAYS}`,
    )
    return DEFAULT_RETENTION_DAYS
  }
  if (n < MIN_RETENTION_DAYS || n > MAX_RETENTION_DAYS) {
    console.warn(
      `[cron/stat-cleanup] STAT_RETENTION_DAYS=${n} out of range [${MIN_RETENTION_DAYS}, ${MAX_RETENTION_DAYS}], using default ${DEFAULT_RETENTION_DAYS}`,
    )
    return DEFAULT_RETENTION_DAYS
  }
  return n
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
        retentionDays: 0,
        statDailyDeleted: 0,
        statHourlyDeleted: 0,
        cutoff: "",
        ts,
        error: "unauthorized",
      },
      { status: 401 },
    )
  }

  // -- 2. retentionDays 결정 -------------------------------------------------
  const retentionDays = resolveRetentionDays(process.env.STAT_RETENTION_DAYS)

  // -- 3. cutoff 계산 (UTC) --------------------------------------------------
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)

  // -- 4. deleteMany 두 테이블 -----------------------------------------------
  // 외부 호출 0. DB 인덱스 활용 (date 컬럼 BTree). 트랜잭션 미사용 — 두 테이블
  // 독립적이므로 부분 실패도 다음 cron 이 정합성 회복.
  let statDailyDeleted = 0
  let statHourlyDeleted = 0
  try {
    const dResult = await prisma.statDaily.deleteMany({
      where: { date: { lt: cutoff } },
    })
    statDailyDeleted = dResult.count

    const hResult = await prisma.statHourly.deleteMany({
      where: { date: { lt: cutoff } },
    })
    statHourlyDeleted = hResult.count
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    const message = scrubString(raw).slice(0, 500)
    console.error(`[cron/stat-cleanup] cleanup failed: ${message}`)
    return NextResponse.json(
      {
        ok: false,
        retentionDays,
        statDailyDeleted,
        statHourlyDeleted,
        cutoff: cutoff.toISOString(),
        ts,
        error: message,
      },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    retentionDays,
    statDailyDeleted,
    statHourlyDeleted,
    cutoff: cutoff.toISOString(),
    ts,
  })
}
