/**
 * Vercel Cron 핸들러 — 매시간 광고주 5단계 sync (campaigns/adgroups/keywords/ads/extensions)
 *
 * 동작:
 *   1. CRON_SECRET 검증 (env 미설정 또는 헤더 불일치 시 401)
 *   2. 활성 광고주 조회 (status='active' AND apiKeyEnc / secretKeyEnc 둘 다 NOT NULL)
 *   3. 광고주별 직렬 처리:
 *        runAdvertiserSyncAll(advertiserId, customerId)
 *      try/catch 로 격리 — 한 광고주 실패가 다음 광고주 차단 X
 *   4. 응답: { ok, advertisersTotal, advertisersOk, advertisersFailed,
 *               totalCampaigns, totalAdgroups, totalKeywordsUpserted,
 *               totalAds, totalExtensions, errors[] }
 *
 * Cron 등록 (vercel.json):
 *   { "path": "/api/cron/sync-all", "schedule": "15 * * * *" }
 *   - 매시간 15분에 실행 (다른 cron 과 분 차이로 분산)
 *   - Authorization: Bearer ${CRON_SECRET} 자동 부착됨 (Vercel Cron 규약)
 *
 * 안전장치:
 *   - CRON_SECRET 미설정 시 항상 401 (개발 로컬 의도치 않은 실행 차단)
 *   - 키 미등록 광고주 (apiKeyEnc IS NULL OR secretKeyEnc IS NULL) 사전 skip
 *   - 광고주 직렬 처리 — Rate Limit 토큰 버킷이 광고주별 분리되지만 다단계 sync 가
 *     광고주당 ~30~60초 소요 → 광고주 N x ~1분 = maxDuration 800s 대비 N <= ~13 안전선
 *   - errors[].message 는 String(e) 길이 500 자 cap (시크릿 평문은 sync runner 미주입 가정)
 *
 * 비대상:
 *   - 사용자 인증 (Cron 전용 — getCurrentAdvertiser 미사용)
 *   - assertRole / RLS (cron route 는 prisma 직접 사용)
 *   - ChangeBatch (조회·적재만 — SA 변경 X)
 *   - AuditLog (운영 메트릭은 응답 + Sentry instrumentation)
 *   - parallel 광고주 처리 (직렬화로 단순화 + Rate Limit 안전)
 *
 * Vercel maxDuration:
 *   - Pro 플랜 한도 900s → maxDuration 800 으로 보수 설정
 *   - Hobby 60s 한도 → 광고주 1명도 어려움 (5단계 sync × 광고그룹 N) — 운영 권고는 Pro
 *
 * lastSyncAt 갱신:
 *   - lib/sync/runners.ts 의 각 단계가 끝나고 recordSyncAt(advertiserId, kind) 호출.
 *   - 단계별 부분 실패 (예: keywords 까지 끝나고 ads 단계에서 throw) 시에도 keywords
 *     까지의 lastSyncAt 은 갱신된 상태.
 */

import { NextRequest, NextResponse } from "next/server"

import { scrubString } from "@/lib/crypto/scrub-string"
import { prisma } from "@/lib/db/prisma"
import {
  runAdvertiserSyncAll,
  type AdvertiserSyncResult,
} from "@/lib/sync/runners"

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

type SyncError = {
  advertiserId: string
  customerId: string
  message: string
}

type CronResponse = {
  ok: boolean
  advertisersTotal: number
  advertisersOk: number
  advertisersFailed: number
  // 상세 누계 (운영 모니터링용)
  totalCampaigns: number
  totalAdgroups: number
  totalKeywordsUpserted: number
  totalAds: number
  totalExtensions: number
  ts: string
  errors: SyncError[]
  error?: string
}

// =============================================================================
// 헬퍼
// =============================================================================

/**
 * 에러 메시지를 안전한 길이/형식으로 정규화.
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
        totalCampaigns: 0,
        totalAdgroups: 0,
        totalKeywordsUpserted: 0,
        totalAds: 0,
        totalExtensions: 0,
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

  // -- 3. 광고주별 직렬 처리 -------------------------------------------------
  let advertisersOk = 0
  let advertisersFailed = 0
  let totalCampaigns = 0
  let totalAdgroups = 0
  let totalKeywordsUpserted = 0
  let totalAds = 0
  let totalExtensions = 0
  const errors: SyncError[] = []

  for (const adv of advertisers) {
    try {
      const r: AdvertiserSyncResult = await runAdvertiserSyncAll(
        adv.id,
        adv.customerId,
      )
      totalCampaigns += r.campaigns.synced
      totalAdgroups += r.adgroups.synced
      totalKeywordsUpserted += r.keywords.syncedKeywords
      totalAds += r.ads.syncedAds
      totalExtensions += r.extensions.synced
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
        `[cron/sync-all] advertiser=${adv.id} customer=${adv.customerId} failed: ${message}`,
      )
    }
  }

  return NextResponse.json({
    ok: true,
    advertisersTotal: advertisers.length,
    advertisersOk,
    advertisersFailed,
    totalCampaigns,
    totalAdgroups,
    totalKeywordsUpserted,
    totalAds,
    totalExtensions,
    ts,
    errors,
  })
}
