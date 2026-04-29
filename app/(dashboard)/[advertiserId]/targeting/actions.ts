"use server"

/**
 * F-11.4 — TargetingRule Server Actions
 *
 * 책임:
 *   1. getTargetingRule    — 광고주 1:1 룰 조회 (없으면 lazy upsert default)
 *   2. upsertTargetingRule — 룰 enabled / defaultWeight / *Weights 부분 갱신
 *
 * 정책:
 *   - 진입부 getCurrentAdvertiser(advertiserId) — admin / 화이트리스트 검증
 *   - mutation 은 viewer 차단 (admin / operator 만)
 *   - hasKeys 검사 X (룰은 SA 호출 미동반 — 자동 비딩 cron 이 사용)
 *   - JSON 컬럼 부분 갱신은 frontend 가 전체 객체 전달 (간단)
 *   - AuditLog 적재 (`targeting_rule.upsert`)
 *   - revalidatePath(`/${advertiserId}/targeting`)
 *
 * 본 PR 비대상 (auto-bidding cron 통합):
 *   - F-11.2 자동 조정 cron 안에서 getOrCreateTargetingRule + weight 곱
 *   - 후속 PR 에서 `lib/optimization/cron-runner.ts` 등에 통합
 *
 * SPEC: SPEC v0.2.1 F-11.4
 */

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { prisma } from "@/lib/db/prisma"
import { getCurrentAdvertiser, getCurrentUser } from "@/lib/auth/access"
import { logAudit } from "@/lib/audit/log"

// =============================================================================
// 공통 타입
// =============================================================================

export type ActionResult<T = void> =
  | ({ ok: true } & (T extends void ? Record<never, never> : { data: T }))
  | { ok: false; error: string }

export type TargetingRuleData = {
  id: string
  advertiserId: string
  enabled: boolean
  defaultWeight: number
  /** { "{day}-{hour}": weight } — 168 키 max (mon..sun × 0..23) */
  hourWeights: Record<string, number>
  /** { "{시도코드 2자리}": weight } — 본 PR 자동 비딩 미적용 (모델만) */
  regionWeights: Record<string, number>
  /** { PC | MOBILE: weight } */
  deviceWeights: Record<string, number>
}

// =============================================================================
// Zod 스키마 — 호출부 검증
// =============================================================================

const HourKeyRegex = /^(mon|tue|wed|thu|fri|sat|sun)-(\d|1\d|2[0-3])$/
// 운영 권장 clamp: 0.1 .. 3.0. 0 은 입찰 정지 의미로 별도 허용 (>=0).
// DB 컬럼은 Decimal(4,2) 0..9.99 까지 허용하지만 운영 입력은 0..3.0 강제.
const RuleWeight = z.number().min(0).max(3.0)

const advertiserIdSchema = z.string().trim().min(1).max(128)

// 객체 크기 제한 — JSON 컬럼 폭주 방지.
//   hourWeights   ≤ 168 (7 day × 24 hour)
//   regionWeights ≤ 17  (시·도 행정구역 17개)
//   deviceWeights ≤ 2   (PC, MOBILE)
const HOUR_WEIGHTS_MAX = 168
const REGION_WEIGHTS_MAX = 17
const DEVICE_WEIGHTS_MAX = 2

const HourWeightsSchema = z
  .record(z.string().regex(HourKeyRegex), RuleWeight)
  .refine(
    (v) => Object.keys(v).length <= HOUR_WEIGHTS_MAX,
    `hourWeights 키 수가 ${HOUR_WEIGHTS_MAX} 을 초과했습니다`,
  )

const RegionWeightsSchema = z
  .record(z.string().length(2).regex(/^\d{2}$/), RuleWeight)
  .refine(
    (v) => Object.keys(v).length <= REGION_WEIGHTS_MAX,
    `regionWeights 키 수가 ${REGION_WEIGHTS_MAX} 을 초과했습니다`,
  )

const DeviceWeightsSchema = z
  .record(z.enum(["PC", "MOBILE"]), RuleWeight)
  .refine(
    (v) => Object.keys(v).length <= DEVICE_WEIGHTS_MAX,
    `deviceWeights 키 수가 ${DEVICE_WEIGHTS_MAX} 을 초과했습니다`,
  )

const upsertSchema = z.object({
  advertiserId: advertiserIdSchema,
  enabled: z.boolean().optional(),
  defaultWeight: RuleWeight.optional(),
  hourWeights: HourWeightsSchema.optional(),
  regionWeights: RegionWeightsSchema.optional(),
  deviceWeights: DeviceWeightsSchema.optional(),
})

export type UpsertTargetingRuleInput = z.input<typeof upsertSchema>

// =============================================================================
// JSON → Record<string, number> 변환
// =============================================================================

function jsonToWeights(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const n = typeof v === "number" ? v : Number(v)
    if (Number.isFinite(n)) out[k] = n
  }
  return out
}

// =============================================================================
// 1. getTargetingRule — lazy upsert
// =============================================================================

/**
 * 광고주 TargetingRule 조회. 없으면 default 행 생성 후 반환.
 *
 * viewer 도 호출 가능 (read 성격). 페이지 진입 prefill 용.
 */
export async function getTargetingRule(
  advertiserId: string,
): Promise<ActionResult<TargetingRuleData>> {
  try {
    const parsed = advertiserIdSchema.safeParse(advertiserId)
    if (!parsed.success) {
      return { ok: false, error: "advertiserId 형식 오류" }
    }

    await getCurrentAdvertiser(parsed.data)

    const rule = await prisma.targetingRule.upsert({
      where: { advertiserId: parsed.data },
      update: {},
      create: { advertiserId: parsed.data },
    })

    return {
      ok: true,
      data: {
        id: rule.id,
        advertiserId: rule.advertiserId,
        enabled: rule.enabled,
        defaultWeight: Number(rule.defaultWeight),
        hourWeights: jsonToWeights(rule.hourWeights),
        regionWeights: jsonToWeights(rule.regionWeights),
        deviceWeights: jsonToWeights(rule.deviceWeights),
      },
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
}

// =============================================================================
// 2. upsertTargetingRule — 룰 갱신 (admin / operator)
// =============================================================================

/**
 * 룰 부분 갱신. 미지정 필드는 기존 값 유지.
 *
 * 정책:
 *   - viewer 차단 (admin / operator)
 *   - JSON 컬럼은 frontend 가 "전체 객체" 전달 (덮어쓰기) — 부분 merge 책임 frontend
 *   - AuditLog (before / after) 자동 마스킹
 *   - revalidatePath
 */
export async function upsertTargetingRule(
  input: UpsertTargetingRuleInput,
): Promise<ActionResult> {
  try {
    const parsed = upsertSchema.safeParse(input)
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues.map((i) => i.message).join(", "),
      }
    }
    const data = parsed.data

    await getCurrentAdvertiser(data.advertiserId)
    const me = await getCurrentUser()
    if (me.role === "viewer") {
      return { ok: false, error: "권한 부족: viewer 는 룰을 수정할 수 없습니다" }
    }

    // before 스냅샷 (AuditLog)
    const before = await prisma.targetingRule.findUnique({
      where: { advertiserId: data.advertiserId },
    })

    const updateData: Record<string, unknown> = {}
    if (data.enabled !== undefined) updateData.enabled = data.enabled
    if (data.defaultWeight !== undefined)
      updateData.defaultWeight = data.defaultWeight
    if (data.hourWeights !== undefined) updateData.hourWeights = data.hourWeights
    if (data.regionWeights !== undefined)
      updateData.regionWeights = data.regionWeights
    if (data.deviceWeights !== undefined)
      updateData.deviceWeights = data.deviceWeights

    const after = await prisma.targetingRule.upsert({
      where: { advertiserId: data.advertiserId },
      update: updateData,
      create: {
        advertiserId: data.advertiserId,
        enabled: data.enabled ?? true,
        defaultWeight: data.defaultWeight ?? 1.0,
        hourWeights: data.hourWeights ?? {},
        regionWeights: data.regionWeights ?? {},
        deviceWeights: data.deviceWeights ?? {},
      },
    })

    await logAudit({
      userId: me.id,
      action: "targeting_rule.update",
      targetType: "TargetingRule",
      targetId: after.id,
      before: before
        ? {
            enabled: before.enabled,
            defaultWeight: Number(before.defaultWeight),
            hourWeights: before.hourWeights,
            regionWeights: before.regionWeights,
            deviceWeights: before.deviceWeights,
          }
        : null,
      after: {
        enabled: after.enabled,
        defaultWeight: Number(after.defaultWeight),
        hourWeights: after.hourWeights,
        regionWeights: after.regionWeights,
        deviceWeights: after.deviceWeights,
      },
    })

    revalidatePath(`/${data.advertiserId}/targeting`)
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
}
