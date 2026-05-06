/**
 * Vercel Cron 핸들러 — 시간별 적재 + 노출 순위 갱신 (F-9.2 / F-9.4)
 *
 * 동작:
 *   1. CRON_SECRET 검증 (env 미설정 또는 헤더 불일치 시 401)
 *   2. 활성 광고주 조회 (status='active' AND apiKeyEnc / secretKeyEnc 둘 다 NOT NULL)
 *   3. (date, hour) = previousHourKstAsUtc(now) — KST 직전 정시 (1시간 후행 기록)
 *   4. 광고주별 직렬 처리:
 *        ingestAdvertiserStatHourly({ advertiserId, customerId, date, hour })
 *      try/catch 로 실패 격리 — 한 광고주 실패가 다음 광고주 차단 X
 *   5. 결과 응답 (advertisers* / statHourlyInserted / keywordsRanked / errors[]) — 시크릿 평문 X
 *
 * Cron 등록 (vercel.json):
 *   { "path": "/api/cron/stat-hourly", "schedule": "5 * * * *" }
 *   - 매시간 5분에 실행 (alerts cron 0분 / batch run 매분 / stat-daily 18시 와 분 차이)
 *   - Authorization: Bearer ${CRON_SECRET} 자동 부착됨 (Vercel Cron 규약)
 *
 * 안전장치:
 *   - CRON_SECRET 미설정 시 항상 401 (개발 로컬 의도치 않은 실행 차단)
 *   - 키 미등록 광고주 (apiKeyEnc IS NULL OR secretKeyEnc IS NULL) 사전 skip
 *   - 광고주 직렬 처리 — Rate Limit 토큰 버킷이 광고주별 분리되지만 chunk 직렬 호출이
 *     이미 ~1분 소요 → 광고주 N x 1분 = maxDuration 800s 대비 N <= ~13 안전선
 *   - errors[].message 는 String(e) 길이 500 자 cap (시크릿 평문은 stats/* 가 미주입 가정)
 *
 * 비대상:
 *   - 사용자 인증 (Cron 전용)
 *   - assertRole / RLS (service_role 사용 — 본 cron 은 service_role 키 컨텍스트)
 *   - ChangeBatch (조회·적재만 — SA 변경 X)
 *   - AuditLog (운영 메트릭은 응답 + Sentry instrumentation)
 *   - parallel 광고주 처리 (직렬화로 단순화 + Rate Limit 안전)
 *
 * Vercel maxDuration:
 *   - Pro 플랜 한도 900s → maxDuration 800 으로 보수 설정
 *   - Hobby 60s 한도 → 광고주 1명도 어려움 (chunk 50 × 1.2s = 1분) — 운영 권고는 Pro
 */

import { NextRequest, NextResponse } from "next/server"

import { scrubString } from "@/lib/crypto/scrub-string"
import { prisma } from "@/lib/db/prisma"
import {
  ingestAdvertiserStatHourly,
  previousHourKstAsUtc,
} from "@/lib/stat-hourly/ingest"

// 자격증명 resolver 자동 등록 (SA 호출 가능하게)
import "@/lib/naver-sa/credentials"

// Prisma 사용 → Edge 가 아닌 Node 런타임 강제.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// Pro 플랜 한도 900s. Hobby 는 무시 (60s 강제).
export const maxDuration = 800

// =============================================================================
// 응답 타입
// =============================================================================

type IngestError = {
  advertiserId: string
  customerId: string
  message: string
}

type CronResponse = {
  ok: boolean
  advertisersTotal: number
  advertisersOk: number
  advertisersFailed: number
  statHourlyInserted: number
  statHourlySkipped: number
  keywordsRanked: number
  ts: string
  /** KST 기준 적재 일자/시간 (디버깅용) */
  date?: string
  hour?: number
  errors: IngestError[]
  error?: string
}

// =============================================================================
// 헬퍼
// =============================================================================

/** 에러 메시지를 안전한 길이/형식으로 정규화 (F-9.1 stat-daily 와 동일).
 *
 * scrubString 으로 Bearer 토큰 / 32+ hex 패턴 마스킹 적용 (시크릿 평문 2차 방어).
 */
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
        statHourlyInserted: 0,
        statHourlySkipped: 0,
        keywordsRanked: 0,
        ts,
        errors: [],
        error: "unauthorized",
      },
      { status: 401 },
    )
  }

  // -- 2. 활성 광고주 조회 (키 모두 등록된 광고주만) ----------------------------
  const advertisers = await prisma.advertiser.findMany({
    where: {
      status: "active",
      apiKeyEnc: { not: null },
      secretKeyEnc: { not: null },
    },
    select: {
      id: true,
      customerId: true,
    },
    orderBy: { id: "asc" },
  })

  // -- 3. (date, hour) 계산 — KST 직전 정시 (1시간 후행) ----------------------
  const { date, hour } = previousHourKstAsUtc()

  // -- 4. 광고주별 직렬 처리 -------------------------------------------------
  let advertisersOk = 0
  let advertisersFailed = 0
  let statHourlyInserted = 0
  let statHourlySkipped = 0
  let keywordsRanked = 0
  const errors: IngestError[] = []

  for (const adv of advertisers) {
    try {
      const r = await ingestAdvertiserStatHourly({
        advertiserId: adv.id,
        customerId: adv.customerId,
        date,
        hour,
      })
      statHourlyInserted += r.rowsInserted
      statHourlySkipped += r.rowsSkipped
      keywordsRanked += r.keywordsRanked
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
        `[cron/stat-hourly] advertiser=${adv.id} customer=${adv.customerId} hour=${hour} failed: ${message}`,
      )
    }
  }

  const result = {
    ok: true,
    advertisersTotal: advertisers.length,
    advertisersOk,
    advertisersFailed,
    statHourlyInserted,
    statHourlySkipped,
    keywordsRanked,
    date: date.toISOString(),
    hour,
    ts,
    errors,
  }

  // Vercel Logs 의 GET 응답 body 가 표시 안 되는 경우 대비 — 결과를 명시적으로 출력 (TEMP).
  console.log(
    `[cron/stat-hourly] result advertisers=${advertisers.length} ok=${advertisersOk} failed=${advertisersFailed} statHourlyInserted=${statHourlyInserted} statHourlySkipped=${statHourlySkipped} keywordsRanked=${keywordsRanked} date=${result.date} hour=${hour} errors=${errors.length}`,
  )

  return NextResponse.json(result)
}
