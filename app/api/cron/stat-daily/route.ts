/**
 * Vercel Cron 핸들러 — 일별 적재 (F-9.1)
 *
 * 동작:
 *   1. CRON_SECRET 검증 (env 미설정 또는 헤더 불일치 시 401)
 *   2. 활성 광고주 조회 (status='active' AND apiKeyEnc / secretKeyEnc 둘 다 NOT NULL)
 *   3. statDt = previousDayKstAsUtc(now) — KST 어제 0시
 *   4. 광고주별 직렬 처리:
 *        ingestAdvertiserStatDaily({ advertiserId, customerId, statDt })
 *      try/catch 로 실패 격리 — 한 광고주 실패가 다음 광고주 차단 X
 *   5. 결과 응답 (advertisers* / rows* / errors[]) — 시크릿 평문 X
 *
 * Cron 등록 (vercel.json):
 *   { "path": "/api/cron/stat-daily", "schedule": "0 18 * * *" }
 *   - KST 03:00 = UTC 18:00 (전일자에 대한 적재)
 *   - Authorization: Bearer ${CRON_SECRET} 자동 부착됨 (Vercel Cron 규약)
 *
 * 안전장치:
 *   - CRON_SECRET 미설정 시 항상 401 (개발 로컬 의도치 않은 실행 차단)
 *   - 키 미등록 광고주 (apiKeyEnc IS NULL OR secretKeyEnc IS NULL) 사전 skip
 *   - 광고주 직렬 처리 — Rate Limit 토큰 버킷은 광고주별 분리되지만,
 *     downloadStatReport 외부 S3 fetch 는 토큰 버킷 외부라 한 광고주 동시 1보고서 보장
 *   - errors[].message 는 String(e) 길이 500 자 cap (시크릿 평문은 reports/* 가 미주입 가정)
 *
 * 비대상:
 *   - 사용자 인증 (Cron 전용)
 *   - assertRole / RLS (service_role 사용 — 본 cron 은 service_role 키 컨텍스트)
 *   - ChangeBatch (조회·적재만 — SA 변경 X)
 *   - AuditLog (운영 메트릭은 응답 + Sentry instrumentation 자동 — 본 PR 외)
 *   - parallel 광고주 처리 (직렬화로 단순화 + Rate Limit 안전)
 *
 * Vercel maxDuration:
 *   - Hobby 플랜 60s 한도 → 광고주 0~소수 가정 충분
 *   - Pro 플랜 900s 한도 → maxDuration 800 으로 보수 설정 (광고주 N x 5분 폴링 대비)
 */

import { NextRequest, NextResponse } from "next/server"

import { scrubString } from "@/lib/crypto/scrub-string"
import { prisma } from "@/lib/db/prisma"
import {
  ingestAdvertiserStatDaily,
  previousDayKstAsUtc,
} from "@/lib/stat-daily/ingest"

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
  rowsInserted: number
  rowsSkipped: number
  ts: string
  errors: IngestError[]
  error?: string
}

// =============================================================================
// 헬퍼
// =============================================================================

/**
 * 에러 메시지를 안전한 길이/형식으로 정규화.
 *
 * - reports.* / client.ts 는 시크릿 평문을 메시지에 주입하지 않음 (모듈 정책)
 * - 단 만약을 대비해 scrubString 으로 Bearer 토큰 / 32+ hex 패턴 마스킹 (2차 방어)
 * - 길이 500 자 cap + 비-string 도 String() 변환
 * - 객체 직렬화는 sanitize 적용 대상이 아니지만 (string only), 시크릿 키 값은
 *   상위 모듈이 message 에 넣지 않는 정책으로 1차 보장
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
        rowsInserted: 0,
        rowsSkipped: 0,
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

  // -- 3. statDt 계산 (KST 어제 0시) -----------------------------------------
  const statDt = previousDayKstAsUtc()

  // -- 4. 광고주별 직렬 처리 -------------------------------------------------
  let advertisersOk = 0
  let advertisersFailed = 0
  let rowsInserted = 0
  let rowsSkipped = 0
  const errors: IngestError[] = []

  for (const adv of advertisers) {
    try {
      const r = await ingestAdvertiserStatDaily({
        advertiserId: adv.id,
        customerId: adv.customerId,
        statDt,
      })
      rowsInserted += r.rowsInserted
      rowsSkipped += r.rowsSkipped
      advertisersOk++
    } catch (e) {
      advertisersFailed++
      const message = safeErrorMessage(e)
      errors.push({
        advertiserId: adv.id,
        customerId: adv.customerId,
        message,
      })
      // 광고주 1명 실패는 다음 광고주 진행. console.error 로 운영 로그 남김.
      // (Sentry instrumentation 이 throw 한 e 도 자동 capture — 본 PR 은 swallow)
      console.error(
        `[cron/stat-daily] advertiser=${adv.id} customer=${adv.customerId} failed: ${message}`,
      )
    }
  }

  return NextResponse.json({
    ok: true,
    advertisersTotal: advertisers.length,
    advertisersOk,
    advertisersFailed,
    rowsInserted,
    rowsSkipped,
    ts,
    errors,
  })
}
