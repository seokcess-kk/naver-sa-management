/**
 * Vercel Cron 핸들러 — 자동 비딩 (F-11.2 + F-11.5 + F-11.6)
 *
 * 매시간 10분에 실행 (alerts 0분 / batch 매분 / stat-hourly 5분 / stat-daily 18시 / stat-cleanup
 * 18시 30분 과 분 차이로 토큰 버킷 / DB 부하 분산).
 *
 * 동작 흐름:
 *   1. CRON_SECRET 검증 (Bearer 헤더 불일치 시 401)
 *   2. 활성 광고주 조회 (status='active' AND apiKeyEnc/secretKeyEnc NOT NULL AND
 *      biddingKillSwitch=false)
 *   3. 광고주 직렬 순회:
 *      a. guardrailEnabled=false        → 광고주 전체 skip (OptimizationRun 미적재)
 *      b. checkAdvertiserGuardrail 초과 → 광고주 전체 skip (OR 미적재)
 *      c. BiddingPolicy.findMany(advertiserId, enabled=true) — 정책 직렬 순회
 *         - Keyword join load (recentAvgRnk / bidAmt / userLock / status / keyword)
 *         - userLock=true                  → OR.skipped_user_lock
 *         - status='deleted'               → OR.skipped_deleted
 *         - checkKeywordGuardrail 초과     → OR.skipped_guardrail
 *         - getCachedAveragePositionBid → throw → OR.failed
 *         - decideBidAdjustment skip       → OR.skipped_*
 *         - decideBidAdjustment 결정       → updateKeyword (lib/naver-sa/keywords)
 *           - 성공 → OR.success (before/after 스냅샷)
 *           - 실패 → OR.failed (errorMessage scrubString)
 *   4. JSON 응답 (advertisersTotal/Ok/Skipped + runsTotal/Success/Skipped/Failed + errors[])
 *
 * 안전장치:
 *   - CRON_SECRET 미설정 시 항상 401 (개발 로컬 의도치 않은 실행 차단)
 *   - biddingKillSwitch=true 광고주는 SQL 단계에서 사전 제외 (OR 적재 X — 폭주 방지)
 *   - guardrailEnabled=false 일 때만 OR 미적재 (긴급 운영 시 명시적 요청)
 *   - 외부 호출 실패 / decide skip / SA 실패 모두 try/catch — 다음 정책으로 격리
 *   - errors[].message / OR.errorMessage 모두 scrubString 통과 (시크릿 평문 차단)
 *
 * Vercel maxDuration:
 *   - Pro 플랜 한도 900s → 800 보수 설정
 *   - 광고주 N <= ~13 직렬 안전선 (광고주당 ~4분 가정 — _workspace/F-11/05_backend.md)
 *   - 광고주 수 증가 시 정책 단위 Job Table 분할 후속 PR
 *
 * 비대상:
 *   - ChangeBatch 흐름 (자동 시스템 작업 — OR 단일 적재로 대체)
 *   - staging 패턴 (자동 결정 + 즉시 SA 호출)
 *   - 사용자 인증 / assertRole (Cron 전용 — CRON_SECRET 만)
 *   - 외부 호출 재시도 (cron 매시간 자연 재시도)
 *
 * SPEC: SPEC v0.2.1 F-11.2 / F-11.5 / F-11.6
 */

import { NextRequest, NextResponse } from "next/server"

import { prisma } from "@/lib/db/prisma"
import { scrubString } from "@/lib/crypto/scrub-string"
import { updateKeyword } from "@/lib/naver-sa/keywords"
import { getCachedAveragePositionBid } from "@/lib/auto-bidding/estimate-cached"
import {
  decideBidAdjustment,
  skipReasonToRunResult,
} from "@/lib/auto-bidding/decide"
import {
  checkAdvertiserGuardrail,
  checkKeywordGuardrail,
} from "@/lib/auto-bidding/guardrail"
import {
  getTargetingWeight,
  type TargetingRuleSlice,
} from "@/lib/auto-bidding/targeting-weight"

// 자격증명 resolver 자동 등록 (SA 호출 가능하게)
import "@/lib/naver-sa/credentials"

// Prisma 사용 → Edge 가 아닌 Node 런타임 강제.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 800

// =============================================================================
// 응답 타입
// =============================================================================

type CronError = {
  advertiserId: string
  policyId?: string
  message: string
}

type CronResponse = {
  ok: boolean
  advertisersTotal: number
  advertisersOk: number
  advertisersSkipped: number
  runsTotal: number
  runsSuccess: number
  runsSkipped: number
  runsFailed: number
  ts: string
  errors: CronError[]
  error?: string
}

// =============================================================================
// 헬퍼
// =============================================================================

function safeMessage(e: unknown, max = 500): string {
  const raw = e instanceof Error ? e.message : String(e)
  return scrubString(raw).slice(0, max)
}

/** OptimizationRun.errorMessage 컬럼 (VARCHAR(500)) 안전 절단 + 마스킹. */
function safeErrorForOR(e: unknown): string {
  return safeMessage(e, 480)
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
        runsTotal: 0,
        runsSuccess: 0,
        runsSkipped: 0,
        runsFailed: 0,
        ts,
        errors: [],
        error: "unauthorized",
      },
      { status: 401 },
    )
  }

  // -- 2. 활성 광고주 조회 (Kill Switch=false 사전 제외) -----------------------
  const advertisers = await prisma.advertiser.findMany({
    where: {
      status: "active",
      apiKeyEnc: { not: null },
      secretKeyEnc: { not: null },
      biddingKillSwitch: false,
    },
    select: {
      id: true,
      customerId: true,
      guardrailEnabled: true,
      guardrailMaxBidChangePct: true,
      guardrailMaxChangesPerKeyword: true,
      guardrailMaxChangesPerDay: true,
    },
    orderBy: { id: "asc" },
  })

  let advertisersOk = 0
  let advertisersSkipped = 0
  let runsTotal = 0
  let runsSuccess = 0
  let runsSkipped = 0
  let runsFailed = 0
  const errors: CronError[] = []

  for (const adv of advertisers) {
    // -- 광고주 단위 Guardrail / Enabled 검사 -------------------------------
    if (!adv.guardrailEnabled) {
      advertisersSkipped++
      // OR 미적재 (db_guardrail.md 규약 — guardrailEnabled=false 는 운영 명시 요청)
      continue
    }

    try {
      const advCheck = await checkAdvertiserGuardrail({
        advertiserId: adv.id,
        maxChangesPerDay: adv.guardrailMaxChangesPerDay,
      })
      if (!advCheck.ok) {
        // 광고주 단위 한도 초과 — 정책 진입 X. OR 미적재 (광고주 단위 skip 은 폭주 방지).
        advertisersSkipped++
        continue
      }
    } catch (e) {
      advertisersSkipped++
      errors.push({
        advertiserId: adv.id,
        message: `advertiser_guardrail_check_failed: ${safeMessage(e)}`,
      })
      continue
    }

    // -- TargetingRule 로드 (F-11.4) — 광고주 1:1, 없으면 null (default 1.0 적용) -
    //    failed 시에도 진행 (rule 미적용 = 안전 default 1.0).
    let targetingRule: TargetingRuleSlice | null = null
    try {
      const row = await prisma.targetingRule.findUnique({
        where: { advertiserId: adv.id },
        select: {
          enabled: true,
          defaultWeight: true,
          hourWeights: true,
          deviceWeights: true,
        },
      })
      if (row) {
        targetingRule = {
          enabled: row.enabled,
          defaultWeight: decimalToNumber(row.defaultWeight),
          hourWeights: jsonToRecord(row.hourWeights),
          deviceWeights: jsonToRecord(row.deviceWeights),
        }
      }
    } catch (e) {
      // 적재 실패는 cron 전체를 막지 않음. errors 에 기록 후 default 1.0 로 진행.
      errors.push({
        advertiserId: adv.id,
        message: `targeting_rule_load_failed: ${safeMessage(e)}`,
      })
      targetingRule = null
    }

    // -- 정책 조회 + 직렬 처리 ---------------------------------------------
    const policies = await prisma.biddingPolicy.findMany({
      where: { advertiserId: adv.id, enabled: true },
      select: {
        id: true,
        advertiserId: true,
        keywordId: true,
        device: true,
        targetRank: true,
        maxBid: true,
        minBid: true,
        keyword: {
          select: {
            id: true,
            nccKeywordId: true,
            keyword: true,
            bidAmt: true,
            recentAvgRnk: true,
            userLock: true,
            status: true,
            adgroup: { select: { campaign: { select: { advertiserId: true } } } },
          },
        },
      },
      orderBy: { id: "asc" },
    })

    let advertiserHadError = false

    for (const policy of policies) {
      runsTotal++
      const k = policy.keyword

      // 광고주 횡단 방어선 (정책 적재 시 보장되지만 cron 에서도 한 번 더 검사)
      if (k.adgroup.campaign.advertiserId !== adv.id) {
        runsSkipped++
        continue
      }

      // device — Prisma StatDevice ALL 비사용 정책. Estimate / decide 는 PC|MOBILE 만.
      if (policy.device !== "PC" && policy.device !== "MOBILE") {
        runsSkipped++
        continue
      }
      const device: "PC" | "MOBILE" = policy.device

      // userLock=true → OFF 의미 (CSV 컬럼 컨벤션). 자동 비딩 대상 제외.
      if (k.userLock) {
        await prisma.optimizationRun.create({
          data: {
            advertiserId: adv.id,
            policyId: policy.id,
            trigger: "auto",
            before: { bidAmt: k.bidAmt, recentAvgRnk: rnkToNumber(k.recentAvgRnk) },
            after: undefined,
            result: "skipped_user_lock",
          },
        })
        runsSkipped++
        continue
      }

      // status='deleted' — 키워드 삭제됨. 자동 비딩 대상 제외.
      if (k.status === "deleted") {
        await prisma.optimizationRun.create({
          data: {
            advertiserId: adv.id,
            policyId: policy.id,
            trigger: "auto",
            before: { bidAmt: k.bidAmt, recentAvgRnk: rnkToNumber(k.recentAvgRnk) },
            after: undefined,
            result: "skipped_deleted",
          },
        })
        runsSkipped++
        continue
      }

      // 키워드 단위 Guardrail
      try {
        const kwCheck = await checkKeywordGuardrail({
          advertiserId: adv.id,
          policyId: policy.id,
          maxChangesPerKeyword: adv.guardrailMaxChangesPerKeyword,
        })
        if (!kwCheck.ok) {
          await prisma.optimizationRun.create({
            data: {
              advertiserId: adv.id,
              policyId: policy.id,
              trigger: "auto",
              before: { bidAmt: k.bidAmt, recentAvgRnk: rnkToNumber(k.recentAvgRnk) },
              after: undefined,
              result: "skipped_guardrail",
              errorMessage: `keyword_limit:${kwCheck.count}/${adv.guardrailMaxChangesPerKeyword}`,
            },
          })
          runsSkipped++
          continue
        }
      } catch (e) {
        runsFailed++
        advertiserHadError = true
        errors.push({
          advertiserId: adv.id,
          policyId: policy.id,
          message: `keyword_guardrail_check_failed: ${safeMessage(e)}`,
        })
        await tryCreateRun({
          advertiserId: adv.id,
          policyId: policy.id,
          before: { bidAmt: k.bidAmt, recentAvgRnk: rnkToNumber(k.recentAvgRnk) },
          result: "failed",
          errorMessage: safeErrorForOR(e),
        })
        continue
      }

      // Estimate (캐시 우선)
      let estimateRows
      try {
        const r = await getCachedAveragePositionBid({
          advertiserId: adv.id,
          customerId: adv.customerId,
          keywordId: k.id,
          keywordText: k.keyword,
          device,
        })
        estimateRows = r.data
      } catch (e) {
        runsFailed++
        advertiserHadError = true
        errors.push({
          advertiserId: adv.id,
          policyId: policy.id,
          message: `estimate_failed: ${safeMessage(e)}`,
        })
        await tryCreateRun({
          advertiserId: adv.id,
          policyId: policy.id,
          before: { bidAmt: k.bidAmt, recentAvgRnk: rnkToNumber(k.recentAvgRnk) },
          result: "failed",
          errorMessage: safeErrorForOR(e),
        })
        continue
      }

      // F-11.4 Targeting weight (KST 기준 dayKey-hour + device).
      //   rule null → 1.0, enabled=false → 1.0 (모듈 내부 처리).
      const targetingWeight = getTargetingWeight(targetingRule, {
        now: new Date(),
        device,
      })

      // 결정 로직
      const decision = decideBidAdjustment({
        policy: {
          id: policy.id,
          advertiserId: policy.advertiserId,
          keywordId: policy.keywordId,
          device,
          targetRank: policy.targetRank,
          maxBid: policy.maxBid,
          minBid: policy.minBid,
        },
        keyword: {
          id: k.id,
          nccKeywordId: k.nccKeywordId,
          bidAmt: k.bidAmt,
          recentAvgRnk: rnkToNumber(k.recentAvgRnk),
        },
        estimateBids: estimateRows,
        guardrail: { maxBidChangePct: adv.guardrailMaxBidChangePct },
        targetingWeight,
      })

      if (decision.skip) {
        await prisma.optimizationRun.create({
          data: {
            advertiserId: adv.id,
            policyId: policy.id,
            trigger: "auto",
            before: { bidAmt: k.bidAmt, recentAvgRnk: rnkToNumber(k.recentAvgRnk) },
            after: undefined,
            result: skipReasonToRunResult(decision.reason),
          },
        })
        runsSkipped++
        continue
      }

      // SA bidAmt update
      try {
        await updateKeyword(
          adv.customerId,
          k.nccKeywordId,
          { bidAmt: decision.newBidAmt, useGroupBidAmt: false },
          "bidAmt,useGroupBidAmt",
        )
        await prisma.optimizationRun.create({
          data: {
            advertiserId: adv.id,
            policyId: policy.id,
            trigger: "auto",
            before: {
              bidAmt: k.bidAmt,
              recentAvgRnk: rnkToNumber(k.recentAvgRnk),
            },
            after: {
              bidAmt: decision.newBidAmt,
              targetRank: policy.targetRank,
              reason: decision.reason,
            },
            result: "success",
          },
        })
        runsSuccess++
      } catch (e) {
        runsFailed++
        advertiserHadError = true
        errors.push({
          advertiserId: adv.id,
          policyId: policy.id,
          message: `sa_update_failed: ${safeMessage(e)}`,
        })
        await tryCreateRun({
          advertiserId: adv.id,
          policyId: policy.id,
          before: { bidAmt: k.bidAmt, recentAvgRnk: rnkToNumber(k.recentAvgRnk) },
          after: { bidAmt: decision.newBidAmt },
          result: "failed",
          errorMessage: safeErrorForOR(e),
        })
      }
    }

    if (advertiserHadError) {
      advertisersOk++ // 부분 실패도 진행됨 (정책별 격리). advertisersFailed 와 분리하지 않음.
    } else {
      advertisersOk++
    }
  }

  return NextResponse.json({
    ok: true,
    advertisersTotal: advertisers.length,
    advertisersOk,
    advertisersSkipped,
    runsTotal,
    runsSuccess,
    runsSkipped,
    runsFailed,
    ts,
    errors,
  })
}

// =============================================================================
// 내부 헬퍼
// =============================================================================

/**
 * Prisma Decimal → number (recentAvgRnk 5자리 정밀도. NaN → null).
 *
 * Prisma 7 Decimal 은 객체. toNumber() 로 변환. null 그대로 통과.
 */
function rnkToNumber(
  v: { toNumber(): number } | null | undefined,
): number | null {
  if (v == null) return null
  const n = v.toNumber()
  return Number.isFinite(n) ? n : null
}

/**
 * Prisma Decimal → number (TargetingRule.defaultWeight 0..9.99).
 * 변환 실패 시 1.0 (안전 default).
 */
function decimalToNumber(v: unknown): number {
  if (v == null) return 1.0
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (
    typeof v === "object" &&
    v !== null &&
    "toNumber" in v &&
    typeof (v as { toNumber: () => number }).toNumber === "function"
  ) {
    const n = (v as { toNumber: () => number }).toNumber()
    return Number.isFinite(n) ? n : 1.0
  }
  return 1.0
}

/**
 * Prisma JsonValue → Record<string, unknown> (key/value 검증은 weight parser 가 담당).
 * null / 비-object → 빈 객체.
 */
function jsonToRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>
  }
  return {}
}

/**
 * OptimizationRun.create 의 try-wrapper — DB 적재 실패가 cron 전체를 막지 않게.
 */
async function tryCreateRun(args: {
  advertiserId: string
  policyId: string | null
  before?: unknown
  after?: unknown
  result: string
  errorMessage?: string
}): Promise<void> {
  try {
    await prisma.optimizationRun.create({
      data: {
        advertiserId: args.advertiserId,
        policyId: args.policyId,
        trigger: "auto",
        before:
          args.before === undefined
            ? undefined
            : (args.before as Parameters<
                typeof prisma.optimizationRun.create
              >[0]["data"]["before"]),
        after:
          args.after === undefined
            ? undefined
            : (args.after as Parameters<
                typeof prisma.optimizationRun.create
              >[0]["data"]["after"]),
        result: args.result,
        errorMessage: args.errorMessage,
      },
    })
  } catch (e) {
    console.error("[cron/auto-bidding] OptimizationRun.create failed:", scrubString(String(e)))
  }
}
