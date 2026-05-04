/**
 * Vercel Cron 핸들러 — 디바이스/시간대 가중 추천 주 1회 (Phase E.3)
 *
 * 매주 월요일 UTC 18:30 (KST 화요일 03:30) 실행. cron 등록 (vercel.json):
 *   { "path": "/api/cron/targeting-tuner", "schedule": "30 18 * * 1" }
 *
 * 동작:
 *   1. CRON_SECRET 검증 (불일치 시 401)
 *   2. 활성 광고주 (BidAutomationConfig.mode != 'off' 만)
 *   3. 광고주 직렬:
 *      a. recommendTargetingWeights(advertiserId)
 *      b. 묶음 4개 중 hasSignal=true 가 1개 이상이면 → BidSuggestion(engineSource='targeting') 1건 upsert
 *      c. 묶음 모두 hasSignal=false → 기존 pending dismiss
 *
 * 정책:
 *   - SA 호출 0
 *   - 광고주 단위 1건 (keywordId / adgroupId 모두 null — 광고주 전체 권고)
 *   - expiresAt = +14일
 *   - active pending engineSource='targeting' 1개 보장 (있으면 update, 없으면 create)
 *
 * Vercel maxDuration: 600 — 광고주당 ~1초.
 */

import { NextRequest, NextResponse } from "next/server"

import { prisma } from "@/lib/db/prisma"
import { scrubString } from "@/lib/crypto/scrub-string"
import {
  recommendTargetingWeights,
  type TargetingRecommendation,
} from "@/lib/targeting-tuner/recommend"
import type * as Prisma from "@/lib/generated/prisma/internal/prismaNamespace"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 600

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

const BUCKET_LABEL: Record<string, string> = {
  weekday_morning: "평일 오전",
  weekday_afternoon: "평일 오후",
  evening: "저녁",
  off_peak: "그 외",
}

function reasonText(rec: TargetingRecommendation): string {
  const parts: string[] = []
  for (const [k, b] of Object.entries(rec.buckets)) {
    if (!b.hasSignal) continue
    const label = BUCKET_LABEL[k] ?? k
    parts.push(`${label} ${b.recommendedWeight.toFixed(2)}x`)
  }
  return `28일 CTR 비교 — 권장 가중치: ${parts.length > 0 ? parts.join(" / ") : "신호 없음"}`
}

// =============================================================================
// 광고주 1명 처리
// =============================================================================

type Stats = {
  created: number
  updated: number
  dismissed: number
}

async function processAdvertiser(advertiserId: string): Promise<Stats> {
  const stats: Stats = { created: 0, updated: 0, dismissed: 0 }
  const rec = await recommendTargetingWeights(advertiserId)
  const hasAnySignal = Object.values(rec.buckets).some((b) => b.hasSignal)

  // 기존 active targeting pending 1건 조회 (광고주 단위라 keyword/adgroup null)
  const existing = await prisma.bidSuggestion.findFirst({
    where: {
      advertiserId,
      engineSource: "targeting",
      status: "pending",
      keywordId: null,
      adgroupId: null,
    },
    select: { id: true },
  })

  if (!hasAnySignal) {
    // 신호 없음 — 기존 pending 정리
    if (existing) {
      await prisma.bidSuggestion.update({
        where: { id: existing.id },
        data: { status: "dismissed" },
      })
      stats.dismissed++
    }
    return stats
  }

  const action = {
    kind: "hour_weights_recommendation",
    buckets: Object.fromEntries(
      Object.entries(rec.buckets).map(([k, b]) => [
        k,
        {
          recommendedWeight: b.recommendedWeight,
          hasSignal: b.hasSignal,
          ctr: b.metrics.ctr,
          impressions: b.metrics.impressions,
          clicks: b.metrics.clicks,
        },
      ]),
    ),
    baseline: rec.baseline,
  } as unknown as Prisma.InputJsonValue

  const reason = reasonText(rec)
  const expiresAt = addDays(new Date(), SUGGESTION_TTL_DAYS)
  const severity = "info" as const

  if (existing) {
    await prisma.bidSuggestion.update({
      where: { id: existing.id },
      data: { action, reason, severity, expiresAt },
    })
    stats.updated++
  } else {
    await prisma.bidSuggestion.create({
      data: {
        advertiserId,
        keywordId: null,
        adgroupId: null,
        engineSource: "targeting",
        action,
        reason,
        severity,
        status: "pending",
        expiresAt,
      },
    })
    stats.created++
  }

  return stats
}

// =============================================================================
// 핵심 진입점
// =============================================================================

export async function GET(req: NextRequest): Promise<NextResponse<CronResponse>> {
  const ts = new Date().toISOString()

  const cronSecret = process.env.CRON_SECRET
  const auth = req.headers.get("authorization") ?? ""
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      {
        ok: false,
        advertisersTotal: 0,
        advertisersOk: 0,
        advertisersSkipped: 0,
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

  let advertisersOk = 0
  let advertisersSkipped = 0
  let suggestionsCreated = 0
  let suggestionsUpdated = 0
  let suggestionsDismissed = 0
  const errors: CronError[] = []

  for (const adv of eligible) {
    try {
      const r = await processAdvertiser(adv.id)
      suggestionsCreated += r.created
      suggestionsUpdated += r.updated
      suggestionsDismissed += r.dismissed
      if (r.created > 0 || r.updated > 0 || r.dismissed > 0) advertisersOk++
      else advertisersSkipped++
    } catch (e) {
      const message = safeError(e)
      errors.push({ advertiserId: adv.id, message })
      console.error(
        `[cron/targeting-tuner] advertiser=${adv.id} failed: ${message}`,
      )
    }
  }

  return NextResponse.json({
    ok: true,
    advertisersTotal: eligible.length,
    advertisersOk,
    advertisersSkipped,
    suggestionsCreated,
    suggestionsUpdated,
    suggestionsDismissed,
    ts,
    errors,
  })
}
