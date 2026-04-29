/**
 * Vercel Cron 핸들러 — 이상 징후 알림 평가 + 발송 (F-8.x)
 *
 * 동작:
 *   1. CRON_SECRET 검증 (env 미설정 또는 헤더 불일치 시 401)
 *   2. 활성 AlertRule 전체 조회 — params.advertiserId 키 기반으로 광고주별 컨텍스트 캐싱
 *   3. rule.type 별 분기 평가기 호출 (lib/alerts/evaluators.ts)
 *   4. 후보별 음소거 검사 (1시간 내 같은 muteKey AlertEvent) → muted 적재 또는 dispatch
 *   5. dispatch 성공 시 sent, 실패 시 failed 적재 (시크릿은 dispatch payload 에 X — 호출부 책임)
 *
 * Cron 등록 (vercel.json — 본 PR 외):
 *   {
 *     "crons": [
 *       { "path": "/api/cron/alerts", "schedule": "*\/15 * * * *" }
 *     ]
 *   }
 *   Authorization: Bearer ${CRON_SECRET} 자동 부착됨 (Vercel Cron 규약).
 *
 * 정책:
 *   - CRON_SECRET 미설정 환경(개발 로컬)에서도 의도치 않은 실행 차단 — 항상 401
 *   - hasKeys=false 광고주는 skip (lib/naver-sa/credentials.ts 가 throw → 인증실패 후보로 변환되는 것
 *     까지는 막지 않으나, 본 PR 은 사전 skip 으로 단순화)
 *   - 평가기 throw → console.error + 다음 rule 계속 (개별 실패가 전체 막지 않음)
 *   - 권한: 본 라우트는 사용자 인증 X (Cron 전용). assertRole 호출하지 않음.
 *   - ChangeBatch 미사용 — 본 라우트는 외부 SA 변경 X (조회만).
 *
 * 시크릿 운영:
 *   - dispatch payload 에는 customerId 만 포함 (시크릿 키 평문 X)
 *   - AlertEvent.payload 적재 시 candidate 그대로 (sanitize 는 audit/log.ts 와 별도 — 본 모듈은
 *     평가기에서 시크릿 평문 미주입 가정).
 */

import { NextRequest, NextResponse } from "next/server"

import { prisma } from "@/lib/db/prisma"
import { dispatch, type NotificationPayload } from "@/lib/notifier"

// 자격증명 resolver 자동 등록 (SA 호출 가능하게)
import "@/lib/naver-sa/credentials"

import {
  evaluateBudgetBurn,
  evaluateBizmoneyLow,
  evaluateApiAuthError,
  evaluateInspectRejected,
  evaluateCpcSurge,
  evaluateImpressionsDrop,
  evaluateBudgetPace,
  type AlertCandidate,
  type EvalContext,
} from "@/lib/alerts/evaluators"
import type { Prisma } from "@/lib/generated/prisma/client"

// Prisma 사용 → Edge 가 아닌 Node 런타임 강제.
// dynamic="force-dynamic" 으로 라우트 캐시 비활성화 (Cron 매 호출마다 평가).
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// =============================================================================
// 응답 타입 (UI 디버깅 / 로그용)
// =============================================================================

type CronResponse = {
  ok: boolean
  rules: number
  rulesEvaluated: number
  rulesSkipped: number
  candidates: number
  sent: number
  muted: number
  failed: number
  ts: string
  error?: string
}

// =============================================================================
// 핵심 진입점
// =============================================================================

export async function GET(req: NextRequest): Promise<NextResponse<CronResponse>> {
  // -- 1. CRON_SECRET 검증 ---------------------------------------------------
  const cronSecret = process.env.CRON_SECRET
  const auth = req.headers.get("authorization") ?? ""
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      {
        ok: false,
        rules: 0,
        rulesEvaluated: 0,
        rulesSkipped: 0,
        candidates: 0,
        sent: 0,
        muted: 0,
        failed: 0,
        ts: new Date().toISOString(),
        error: "unauthorized",
      },
      { status: 401 },
    )
  }

  // -- 2. 활성 rule 조회 -----------------------------------------------------
  const rules = await prisma.alertRule.findMany({
    where: { enabled: true },
    select: {
      id: true,
      type: true,
      params: true,
    },
  })

  // 광고주 컨텍스트 캐싱 (한 Cron 호출 동안 동일 광고주 N번 조회 방지)
  const advertiserCtxMap = new Map<string, EvalContext | null>()

  let rulesEvaluated = 0
  let rulesSkipped = 0
  let totalCandidates = 0
  let totalSent = 0
  let totalMuted = 0
  let totalFailed = 0

  for (const rule of rules) {
    // -- params.advertiserId 추출 -------------------------------------------
    const params = (rule.params ?? {}) as Record<string, unknown>
    const advertiserId =
      typeof params.advertiserId === "string" && params.advertiserId.length > 0
        ? params.advertiserId
        : null
    if (!advertiserId) {
      rulesSkipped++
      continue
    }

    // -- 광고주 컨텍스트 ---------------------------------------------------
    let ctx = advertiserCtxMap.get(advertiserId)
    if (ctx === undefined) {
      const advertiser = await prisma.advertiser.findUnique({
        where: { id: advertiserId },
        select: {
          id: true,
          customerId: true,
          status: true,
          apiKeyEnc: true,
          secretKeyEnc: true,
        },
      })
      if (!advertiser || advertiser.status !== "active") {
        ctx = null
      } else {
        const hasKeys = advertiser.apiKeyEnc !== null && advertiser.secretKeyEnc !== null
        ctx = hasKeys
          ? {
              advertiserId,
              customerId: advertiser.customerId,
              hasKeys: true,
            }
          : null
      }
      advertiserCtxMap.set(advertiserId, ctx)
    }
    if (ctx === null) {
      rulesSkipped++
      continue
    }

    // -- rule.type 별 평가기 ------------------------------------------------
    let candidates: AlertCandidate[] = []
    try {
      switch (rule.type) {
        case "budget_burn":
          candidates = await evaluateBudgetBurn(ctx, {
            id: rule.id,
            type: rule.type,
            params: params as { thresholds?: number[] },
          })
          break
        case "bizmoney_low":
          candidates = await evaluateBizmoneyLow(ctx, {
            id: rule.id,
            type: rule.type,
            params: params as { days?: number },
          })
          break
        case "api_auth_error":
          candidates = await evaluateApiAuthError(ctx)
          break
        case "inspect_rejected":
          candidates = await evaluateInspectRejected(ctx, {
            id: rule.id,
            type: rule.type,
            params: params as {
              withinMinutes?: number
              maxCandidates?: number
            },
          })
          break
        case "cpc_surge":
          candidates = await evaluateCpcSurge(ctx, {
            id: rule.id,
            type: rule.type,
            params: params as { thresholdPct?: number; minClicks?: number },
          })
          break
        case "impressions_drop":
          candidates = await evaluateImpressionsDrop(ctx, {
            id: rule.id,
            type: rule.type,
            params: params as { thresholdPct?: number; minImpressions?: number },
          })
          break
        case "budget_pace":
          candidates = await evaluateBudgetPace(ctx, {
            id: rule.id,
            type: rule.type,
            params: params as { deviationPct?: number; minHour?: number },
          })
          break
        default:
          rulesSkipped++
          continue
      }
    } catch (e) {
      // 평가기 throw — 다음 rule 계속. AlertEvent 적재 X (운영 노이즈 방지).
      console.error(
        `[cron/alerts] rule=${rule.id} type=${rule.type} eval failed:`,
        e instanceof Error ? e.message : String(e),
      )
      rulesSkipped++
      continue
    }
    rulesEvaluated++

    // -- 후보별 음소거 검사 + dispatch + 적재 -------------------------------
    for (const c of candidates) {
      totalCandidates++

      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
      // 같은 ruleId + muteKey 가 1시간 내 어떤 status 든 적재됐으면 muted.
      // (sent 는 명시적 차단, muted/failed 도 차단 — 후속 PR 에서 failed 는 재시도 허용 검토)
      const recent = await prisma.alertEvent.findFirst({
        where: {
          ruleId: rule.id,
          createdAt: { gte: oneHourAgo },
          // payload 는 JSON 컬럼. path filter 로 muteKey 비교.
          payload: { path: ["muteKey"], equals: c.muteKey },
        },
        select: { id: true },
      })

      if (recent) {
        totalMuted++
        await prisma.alertEvent.create({
          data: {
            ruleId: rule.id,
            payload: {
              ...c,
              mutedReason: "duplicate within 1h",
              originalEventId: recent.id,
            } as Prisma.InputJsonValue,
            status: "muted",
          },
        })
        continue
      }

      // dispatch — 채널별 결과 results 에 기록.
      const np: NotificationPayload = {
        ruleType: c.ruleType,
        severity: c.severity,
        title: c.title,
        body: c.body,
        meta: c.meta,
      }
      const dispatchResult = await dispatch(np)

      await prisma.alertEvent.create({
        data: {
          ruleId: rule.id,
          payload: {
            ...c,
            dispatchResults: dispatchResult.results,
          } as Prisma.InputJsonValue,
          status: dispatchResult.ok ? "sent" : "failed",
          sentAt: dispatchResult.ok ? new Date() : null,
        },
      })

      if (dispatchResult.ok) {
        totalSent++
      } else {
        totalFailed++
      }
    }
  }

  return NextResponse.json({
    ok: true,
    rules: rules.length,
    rulesEvaluated,
    rulesSkipped,
    candidates: totalCandidates,
    sent: totalSent,
    muted: totalMuted,
    failed: totalFailed,
    ts: new Date().toISOString(),
  })
}
