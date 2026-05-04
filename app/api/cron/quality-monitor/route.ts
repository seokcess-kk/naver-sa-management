/**
 * Vercel Cron 핸들러 — 품질 OFF 후보 일 1회 스캔 (Phase E.1)
 *
 * 매일 UTC 20:00 (KST 05:00) 실행. cron 등록 (vercel.json):
 *   { "path": "/api/cron/quality-monitor", "schedule": "0 20 * * *" }
 *
 * 동작:
 *   1. CRON_SECRET 검증 (불일치 시 401)
 *   2. 활성 광고주 (BidAutomationConfig.mode != 'off' 만)
 *   3. 광고주 직렬:
 *      a. scanQualityCandidates(advertiserId)
 *      b. 각 candidate 마다 BidSuggestion(engineSource='quality') upsert (pending 1개 보장)
 *      c. candidates 에 없는 기존 quality pending 은 dismissed 로 정리
 *
 * 정책:
 *   - SA 호출 0 (DB read-only)
 *   - BiddingPolicy 등록 키워드도 후보로 포함 (정책 키워드도 OFF 권고는 의미 있음 — 운영자 선택)
 *   - userLock=true / status='deleted' 키워드는 사전 제외 (scanQualityCandidates 가 처리)
 *   - 자동 OFF X — BidSuggestion 으로 권고만
 *   - expiresAt = +14일 (14일 윈도와 일치)
 *
 * Vercel maxDuration: 800. 광고주 N <= ~13 가정 + 광고주당 ~1초 (DB 집계 only).
 *
 * SPEC: SPEC v0.2.1 F-12.6 / plan(graceful-sparking-graham) Phase E.1
 */

import { NextRequest, NextResponse } from "next/server"

import { prisma } from "@/lib/db/prisma"
import { scrubString } from "@/lib/crypto/scrub-string"
import {
  scanQualityCandidates,
  type QualityCandidate,
} from "@/lib/quality-improver/scan"
import type * as Prisma from "@/lib/generated/prisma/internal/prismaNamespace"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 800

// =============================================================================
// 응답 / 헬퍼
// =============================================================================

const SUGGESTION_TTL_DAYS = 14

type CronError = {
  advertiserId: string
  message: string
}

type CronResponse = {
  ok: boolean
  advertisersTotal: number
  advertisersOk: number
  advertisersSkipped: number
  candidatesTotal: number
  suggestionsCreated: number
  suggestionsUpdated: number
  suggestionsDismissed: number
  ts: string
  errors: CronError[]
  error?: string
}

function safeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return scrubString(raw).slice(0, 500)
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base)
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

function reasonText(c: QualityCandidate): string {
  if (c.reasonCode === "no_clicks_14d") {
    return `14일 노출 ${c.metrics.impressions14d.toLocaleString()}회 / 클릭 0회 — OFF 권고`
  }
  return `14일 CTR ${c.metrics.ctr14d}% (임계 0.3% 미만) — OFF 권고`
}

// =============================================================================
// 광고주 1명 처리
// =============================================================================

type Stats = {
  candidates: number
  created: number
  updated: number
  dismissed: number
}

async function processAdvertiser(advertiserId: string): Promise<Stats> {
  const stats: Stats = { candidates: 0, created: 0, updated: 0, dismissed: 0 }

  const candidates = await scanQualityCandidates(advertiserId)
  stats.candidates = candidates.length

  const candidateKeywordIds = new Set(candidates.map((c) => c.keywordId))
  const expiresAt = addDays(new Date(), SUGGESTION_TTL_DAYS)

  // 기존 quality pending 모두 조회 → candidates 와 비교 후 dismiss
  const existing = await prisma.bidSuggestion.findMany({
    where: {
      advertiserId,
      engineSource: "quality",
      status: "pending",
    },
    select: { id: true, keywordId: true },
  })

  // candidates 에 없는 기존 pending → dismiss
  const toDismiss = existing
    .filter((p) => p.keywordId && !candidateKeywordIds.has(p.keywordId))
    .map((p) => p.id)
  if (toDismiss.length > 0) {
    const r = await prisma.bidSuggestion.updateMany({
      where: { id: { in: toDismiss } },
      data: { status: "dismissed" },
    })
    stats.dismissed += r.count
  }

  // candidates 별 upsert
  const existingMap = new Map(
    existing
      .filter((p) => p.keywordId)
      .map((p) => [p.keywordId as string, p.id]),
  )

  for (const c of candidates) {
    const action = {
      kind: "off",
      reasonCode: c.reasonCode,
      metrics: c.metrics,
    } as unknown as Prisma.InputJsonValue
    const reason = reasonText(c)
    const severity = "warn" as const

    const existingId = existingMap.get(c.keywordId)
    if (existingId) {
      await prisma.bidSuggestion.update({
        where: { id: existingId },
        data: { action, reason, severity, expiresAt },
      })
      stats.updated++
    } else {
      await prisma.bidSuggestion.create({
        data: {
          advertiserId,
          keywordId: c.keywordId,
          adgroupId: c.adgroupId,
          engineSource: "quality",
          action,
          reason,
          severity,
          status: "pending",
          expiresAt,
        },
      })
      stats.created++
    }
  }

  return stats
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
        advertisersSkipped: 0,
        candidatesTotal: 0,
        suggestionsCreated: 0,
        suggestionsUpdated: 0,
        suggestionsDismissed: 0,
        ts,
        errors: [],
        error: "unauthorized",
      },
      { status: 401 },
    )
  }

  // -- 2. 활성 광고주 (mode != 'off' / config 등록만) -----------------------
  const advertisers = await prisma.advertiser.findMany({
    where: { status: "active" },
    select: {
      id: true,
      bidAutomationConfig: { select: { mode: true } },
    },
    orderBy: { id: "asc" },
  })
  const eligible = advertisers.filter(
    (a) =>
      a.bidAutomationConfig != null &&
      a.bidAutomationConfig.mode !== "off",
  )

  // -- 3. 광고주 직렬 처리 ---------------------------------------------------
  let advertisersOk = 0
  let advertisersSkipped = 0
  let candidatesTotal = 0
  let suggestionsCreated = 0
  let suggestionsUpdated = 0
  let suggestionsDismissed = 0
  const errors: CronError[] = []

  for (const adv of eligible) {
    try {
      const r = await processAdvertiser(adv.id)
      candidatesTotal += r.candidates
      suggestionsCreated += r.created
      suggestionsUpdated += r.updated
      suggestionsDismissed += r.dismissed
      if (r.candidates > 0 || r.dismissed > 0) advertisersOk++
      else advertisersSkipped++
    } catch (e) {
      const message = safeError(e)
      errors.push({ advertiserId: adv.id, message })
      console.error(
        `[cron/quality-monitor] advertiser=${adv.id} failed: ${message}`,
      )
    }
  }

  return NextResponse.json({
    ok: true,
    advertisersTotal: eligible.length,
    advertisersOk,
    advertisersSkipped,
    candidatesTotal,
    suggestionsCreated,
    suggestionsUpdated,
    suggestionsDismissed,
    ts,
    errors,
  })
}
