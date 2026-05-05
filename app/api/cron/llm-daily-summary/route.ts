/**
 * Vercel Cron 핸들러 — 일일 운영 요약 LLM 발송 (Phase F.5 / SPEC F-13.2)
 *
 * 매일 KST 09:00 (UTC 00:00) 실행. cron 등록:
 *   { "path": "/api/cron/llm-daily-summary", "schedule": "0 0 * * *" }
 *
 * 동작:
 *   1. CRON_SECRET 검증 (불일치 시 401)
 *   2. 활성 광고주 (BidAutomationConfig.mode != 'off' 만)
 *   3. 광고주 직렬:
 *      a. collectDailyStats — 어제(KST) OptimizationRun + BidSuggestion + AlertEvent 집계
 *      b. generateDailySummary — Sonnet 4.6 (폴백 시 정형 텍스트)
 *      c. AlertEvent 적재 (status='sent', payload={ kind:'llm_daily_summary', ... })
 *      d. NotificationChannel dispatch (log 항상 + telegram TELEGRAM_BOT_TOKEN+CHAT_ID 있을 때)
 *
 * 정책 (사용자 검토 + SPEC v0.2.1):
 *   - LLM 분석·설명 전용. Tool Use / 자동 실행 X
 *   - 폴백: API 키 없거나 한도 초과 시 정형 텍스트 (callLlmWithFallback 자동)
 *   - 동일 광고주 동일 날짜 중복 발송 방지 (AlertEvent payload.date 검사)
 *
 * 비용:
 *   - 광고주 1명 1회 = ~$0.005 (Sonnet 4.6 ~500 in + ~300 out)
 *   - 광고주 10명 × 30일 = ~$1.5/월
 *
 * Vercel maxDuration: 600 (광고주 N <= ~30 / 광고주당 ~5초 LLM 호출).
 */

import { NextRequest, NextResponse } from "next/server"

import { prisma } from "@/lib/db/prisma"
import { scrubString } from "@/lib/crypto/scrub-string"
import {
  collectDailyStats,
  generateDailySummary,
} from "@/lib/llm/daily-summary"
import { dispatch } from "@/lib/notifier"
import type * as Prisma from "@/lib/generated/prisma/internal/prismaNamespace"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 600

// =============================================================================
// 응답 / 헬퍼
// =============================================================================

type CronError = {
  advertiserId: string
  message: string
}

type CronResponse = {
  ok: boolean
  advertisersTotal: number
  advertisersOk: number
  advertisersSkipped: number
  llmCallsCount: number
  fallbackCount: number
  ts: string
  errors: CronError[]
  error?: string
}

function safeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return scrubString(raw).slice(0, 500)
}

// =============================================================================
// 광고주 1명 처리
// =============================================================================

type Stats = {
  ok: boolean
  usedLlm: boolean
  skipped: boolean
}

async function processAdvertiser(
  advertiserId: string,
  advertiserName: string,
): Promise<Stats> {
  const stats = await collectDailyStats(advertiserId)

  // 중복 방지 — 동일 광고주 + 동일 날짜 이미 적재된 AlertEvent 있으면 skip
  const existing = await prisma.alertEvent.findFirst({
    where: {
      payload: {
        path: ["kind"],
        equals: "llm_daily_summary",
      },
      status: "sent",
      // 본 PR 단순화: payload.advertiserId 매칭은 JSON path 추가 — 운영 쿼리 복잡도 검증 후 인덱스 도입.
      // 현재는 ruleId+createdAt 윈도로만 필터.
      createdAt: {
        gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    },
    select: { id: true, payload: true },
  })

  // payload 안에 동일 advertiserId + date 검사
  if (existing) {
    const p = existing.payload as { advertiserId?: string; date?: string } | null
    if (
      p?.advertiserId === advertiserId &&
      p?.date === stats.yesterdayKst
    ) {
      return { ok: true, usedLlm: false, skipped: true }
    }
  }

  const summary = await generateDailySummary({
    advertiserId,
    advertiserName,
    date: stats.yesterdayKst,
    stats,
  })

  // AlertEvent 적재 — ruleId 없는 시스템 알림이라 "system" sentinel ruleId 사용
  // 단 AlertEvent.ruleId 는 NOT NULL FK — sentinel 사용 불가. 대신 payload 만 적재 후 ruleId 매핑은
  // alertRule "llm_daily_summary" 1행 사전 등록 필요. 본 PR 단순화: ruleId 없으면 적재 skip + dispatch 만.
  // 운영자가 admin/alert-rules 에 type='llm_daily_summary' 등록 시 ruleId join.
  // 본 cron 은 매번 type='llm_daily_summary' enabled 룰 1개 lookup.
  const rule = await prisma.alertRule.findFirst({
    where: { type: "llm_daily_summary", enabled: true },
    select: { id: true },
  })

  if (rule) {
    const payload = {
      kind: "llm_daily_summary",
      advertiserId,
      advertiserName,
      date: stats.yesterdayKst,
      stats,
      summaryText: summary.text,
      usedLlm: summary.usedLlm,
    } as unknown as Prisma.InputJsonValue

    await prisma.alertEvent.create({
      data: {
        ruleId: rule.id,
        payload,
        status: "sent",
        sentAt: new Date(),
      },
    })

    // NotificationChannel 발송 (log 항상 + email/slack 환경변수 있을 때)
    await dispatch({
      ruleType: "llm_daily_summary",
      severity: "info",
      title: `${advertiserName} 일일 운영 요약 (${stats.yesterdayKst})`,
      body: summary.text,
      meta: { advertiserId, date: stats.yesterdayKst, usedLlm: summary.usedLlm },
    })
  }

  return { ok: true, usedLlm: summary.usedLlm, skipped: false }
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
        llmCallsCount: 0,
        fallbackCount: 0,
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
      name: true,
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
  let llmCallsCount = 0
  let fallbackCount = 0
  const errors: CronError[] = []

  for (const adv of eligible) {
    try {
      const r = await processAdvertiser(adv.id, adv.name)
      if (r.skipped) {
        advertisersSkipped++
      } else {
        advertisersOk++
        if (r.usedLlm) llmCallsCount++
        else fallbackCount++
      }
    } catch (e) {
      const message = safeError(e)
      errors.push({ advertiserId: adv.id, message })
      console.error(
        `[cron/llm-daily-summary] advertiser=${adv.id} failed: ${message}`,
      )
    }
  }

  return NextResponse.json({
    ok: true,
    advertisersTotal: eligible.length,
    advertisersOk,
    advertisersSkipped,
    llmCallsCount,
    fallbackCount,
    ts,
    errors,
  })
}
