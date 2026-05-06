"use server"

/**
 * 비딩 자동화 설정 admin — Server Actions (Phase B.4)
 *
 * 정책:
 *   - admin 권한 필수 (모든 액션 진입부 assertRole("admin"))
 *   - AuditLog 기록 — admin 액션 감사 (before/after)
 *   - 본 모듈은 외부 SA API 변경 X → ChangeBatch 미사용
 *   - delete 비대상 (mode='off' 로 대체 — 운영 의도와 일치)
 *
 * 의미:
 *   - mode = 'inbox'             : bid-suggest cron 이 BidSuggestion 적재. 운영자 승인 시 SA 적용.
 *   - mode = 'auto_policy_only'  : Inbox 비활성. BiddingPolicy 등록 키워드만 자동 비딩(F-11.2 기존 흐름).
 *   - mode = 'off'               : Inbox 비활성 + 자동 비딩 비활성 (안전 모드).
 *   - budgetPacingMode           : 광고주별 페이싱 전략.
 *   - targetCpc / maxCpc / minCtr: CPC 기반 검색광고 운영 기준.
 *   - targetAvgRank              : 평균 노출 순위 기반 정책 권고 기준.
 *   - targetCpa / targetRoas     : 전환·매출 데이터가 있을 때의 고급 의사결정 기준.
 */

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { prisma } from "@/lib/db/prisma"
import { assertRole } from "@/lib/auth/access"
import { logAudit } from "@/lib/audit/log"
import { Prisma } from "@/lib/generated/prisma/client"

// =============================================================================
// 타입
// =============================================================================

export type BidAutomationMode = "inbox" | "auto_policy_only" | "off"
export type BudgetPacingMode = "focus" | "explore" | "protect"

export type BidAutomationConfigRow = {
  advertiserId: string
  advertiserName: string
  customerId: string
  /** 등록된 config 가 없으면 null → UI 가 "미설정" 표기. */
  config: {
    mode: BidAutomationMode
    budgetPacingMode: BudgetPacingMode
    targetCpc: number | null
    maxCpc: number | null
    minCtr: string | null // Decimal 직렬화
    targetAvgRank: string | null // Decimal 직렬화
    targetCpa: number | null
    targetRoas: string | null // Decimal 직렬화
    updatedAt: string // ISO
  } | null
}

export type ActionResult<T = unknown> =
  | { ok: true; data?: T }
  | { ok: false; error: string }

// =============================================================================
// Zod 스키마
// =============================================================================

const advertiserIdSchema = z.string().trim().min(1).max(128)

const modeSchema = z.enum(["inbox", "auto_policy_only", "off"])
const pacingSchema = z.enum(["focus", "explore", "protect"])

const upsertSchema = z.object({
  advertiserId: advertiserIdSchema,
  mode: modeSchema,
  budgetPacingMode: pacingSchema,
  /** 원, 10~1,000,000. null = 미설정. */
  targetCpc: z
    .number()
    .int()
    .min(10)
    .max(1_000_000)
    .nullable()
    .optional(),
  /** 원, 10~1,000,000. null = 시스템 기본 상한. */
  maxCpc: z
    .number()
    .int()
    .min(10)
    .max(1_000_000)
    .nullable()
    .optional(),
  /** CTR 하한(%), 예: 0.3 = 0.30%. null = 미설정. */
  minCtr: z.number().min(0.01).max(100).nullable().optional(),
  /** 평균 노출 순위 목표, 1~50. null = 미설정. */
  targetAvgRank: z.number().min(1).max(50).nullable().optional(),
  /** 원, 100~1,000,000 (목표 CPA 운영 범위). null = 미설정. */
  targetCpa: z
    .number()
    .int()
    .min(100)
    .max(1_000_000)
    .nullable()
    .optional(),
  /** 비율 (예: 4.5 = 450%). 0.1 ~ 99.99. null = 미설정. */
  targetRoas: z
    .number()
    .min(0.1)
    .max(99.99)
    .nullable()
    .optional(),
})

// =============================================================================
// 1. listBidAutomationConfigs
// =============================================================================

/**
 * 광고주 전체 + 각 광고주의 현재 config 1행 join.
 *
 * status='archived' 광고주는 제외. 운영자는 archive 풀어야 설정 가능.
 */
export async function listBidAutomationConfigs(): Promise<
  BidAutomationConfigRow[]
> {
  await assertRole("admin")

  const advertisers = await prisma.advertiser.findMany({
    where: { status: { not: "archived" } },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      customerId: true,
      bidAutomationConfig: {
        select: {
          mode: true,
          budgetPacingMode: true,
          targetCpc: true,
          maxCpc: true,
          minCtr: true,
          targetAvgRank: true,
          targetCpa: true,
          targetRoas: true,
          updatedAt: true,
        },
      },
    },
  })

  return advertisers.map((a) => ({
    advertiserId: a.id,
    advertiserName: a.name,
    customerId: a.customerId,
    config: a.bidAutomationConfig
      ? {
          mode: a.bidAutomationConfig.mode as BidAutomationMode,
          budgetPacingMode: a.bidAutomationConfig
            .budgetPacingMode as BudgetPacingMode,
          targetCpc: a.bidAutomationConfig.targetCpc,
          maxCpc: a.bidAutomationConfig.maxCpc,
          minCtr:
            a.bidAutomationConfig.minCtr != null
              ? a.bidAutomationConfig.minCtr.toString()
              : null,
          targetAvgRank:
            a.bidAutomationConfig.targetAvgRank != null
              ? a.bidAutomationConfig.targetAvgRank.toString()
              : null,
          targetCpa: a.bidAutomationConfig.targetCpa,
          targetRoas:
            a.bidAutomationConfig.targetRoas != null
              ? a.bidAutomationConfig.targetRoas.toString()
              : null,
          updatedAt: a.bidAutomationConfig.updatedAt.toISOString(),
        }
      : null,
  }))
}

// =============================================================================
// 2. upsertBidAutomationConfig
// =============================================================================

/**
 * admin: 광고주 자동화 설정 upsert (광고주 1:1).
 *
 * - delete 없음 — mode='off' 로 비활성화
 * - 목표값은 모두 null 허용 (목표 미설정 → marginal-score 가 baseline 폴백)
 * - AuditLog 기록 — before(기존 config) / after(신규 config)
 */
export async function upsertBidAutomationConfig(
  input: unknown,
): Promise<ActionResult<{ advertiserId: string }>> {
  const me = await assertRole("admin")

  const parsed = upsertSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "유효하지 않은 입력",
    }
  }
  const {
    advertiserId,
    mode,
    budgetPacingMode,
    targetCpc,
    maxCpc,
    minCtr,
    targetAvgRank,
    targetCpa,
    targetRoas,
  } = parsed.data

  // 광고주 존재성 + status 검증
  const advertiser = await prisma.advertiser.findUnique({
    where: { id: advertiserId },
    select: { id: true, status: true },
  })
  if (!advertiser) {
    return { ok: false, error: "존재하지 않는 광고주입니다" }
  }
  if (advertiser.status === "archived") {
    return { ok: false, error: "아카이브된 광고주에는 설정할 수 없습니다" }
  }

  // 기존 config (before)
  const before = await prisma.bidAutomationConfig.findUnique({
    where: { advertiserId },
    select: {
      mode: true,
      budgetPacingMode: true,
      targetCpc: true,
      maxCpc: true,
      minCtr: true,
      targetAvgRank: true,
      targetCpa: true,
      targetRoas: true,
    },
  })

  const targetRoasDecimal =
    targetRoas != null ? new Prisma.Decimal(targetRoas) : null
  const minCtrDecimal = minCtr != null ? new Prisma.Decimal(minCtr) : null
  const targetAvgRankDecimal =
    targetAvgRank != null ? new Prisma.Decimal(targetAvgRank) : null

  await prisma.bidAutomationConfig.upsert({
    where: { advertiserId },
    create: {
      advertiserId,
      mode,
      budgetPacingMode,
      targetCpc: targetCpc ?? null,
      maxCpc: maxCpc ?? null,
      minCtr: minCtrDecimal,
      targetAvgRank: targetAvgRankDecimal,
      targetCpa: targetCpa ?? null,
      targetRoas: targetRoasDecimal,
    },
    update: {
      mode,
      budgetPacingMode,
      targetCpc: targetCpc ?? null,
      maxCpc: maxCpc ?? null,
      minCtr: minCtrDecimal,
      targetAvgRank: targetAvgRankDecimal,
      targetCpa: targetCpa ?? null,
      targetRoas: targetRoasDecimal,
    },
  })

  await logAudit({
    userId: me.id,
    action: "bid_automation_config.upsert",
    targetType: "Advertiser",
    targetId: advertiserId,
    before: before
      ? {
          mode: before.mode,
          budgetPacingMode: before.budgetPacingMode,
          targetCpc: before.targetCpc,
          maxCpc: before.maxCpc,
          minCtr: before.minCtr?.toString() ?? null,
          targetAvgRank: before.targetAvgRank?.toString() ?? null,
          targetCpa: before.targetCpa,
          targetRoas: before.targetRoas?.toString() ?? null,
        }
      : null,
    after: {
      mode,
      budgetPacingMode,
      targetCpc: targetCpc ?? null,
      maxCpc: maxCpc ?? null,
      minCtr: minCtr ?? null,
      targetAvgRank: targetAvgRank ?? null,
      targetCpa: targetCpa ?? null,
      targetRoas: targetRoas ?? null,
    },
  })

  revalidatePath("/admin/bidding/automation-config")

  return { ok: true, data: { advertiserId } }
}
