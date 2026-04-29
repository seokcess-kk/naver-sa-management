"use server"

/**
 * F-11.1 — BiddingPolicy CRUD (Server Actions)
 *
 * 책임:
 *   1. listBiddingPolicies         — 광고주 정책 전체 목록 (UI 테이블 / 셀렉터용)
 *   2. createBiddingPolicy         — 정책 신규 생성 (UNIQUE 충돌 사전 차단)
 *   3. updateBiddingPolicy         — 정책 부분 수정 (targetRank/maxBid/minBid/enabled)
 *   4. deleteBiddingPolicy         — 정책 단순 삭제 (Cascade 로 OptimizationRun.policyId SetNull)
 *   5. listKeywordsWithoutPolicy   — 모달 셀렉터: 본 device 정책이 없는 키워드 후보
 *
 * 본 PR 비대상 (별도 ID):
 *   - F-11.2 자동 조정 cron (OptimizationRun 적재 / SA bidAmt update)
 *   - F-11.5 Guardrail (maxBid/minBid 외 일 변경 한도)
 *   - F-11.6 Kill Switch toggle 은 본 모듈이 아니라 app/admin/advertisers/actions.ts 에 추가
 *
 * 운영 정책:
 *   - 진입부 getCurrentAdvertiser(advertiserId) — admin / 화이트리스트 검증
 *   - mutation 액션은 viewer 차단 (me.role === 'viewer' → ok:false). admin/advertisers 의
 *     `assertRole("admin")` 와 다른 패턴인 이유: 본 정책은 operator 도 등록 가능 (운영 일상).
 *     일관성: 이후 다른 (dashboard) mutation 액션 viewer 차단 시 동일 분기 사용 권고.
 *   - 광고주 횡단 차단:
 *      * Keyword 는 `adgroup.campaign.advertiserId` join 으로 한정
 *      * BiddingPolicy 는 `findFirst({ id, advertiserId })` 로 한정
 *   - 본 액션은 정책 자체 CRUD 만 — 외부 SA API 변경 X → ChangeBatch 미사용 (즉시 반영 OK)
 *   - AuditLog 적재 의무 (`bidding_policy.create / update / delete`)
 *   - revalidatePath(`/${advertiserId}/bidding-policies`)
 */

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { prisma } from "@/lib/db/prisma"
import { getCurrentAdvertiser } from "@/lib/auth/access"
import { logAudit } from "@/lib/audit/log"
import type { StatDevice } from "@/lib/generated/prisma/client"

// =============================================================================
// 공통 타입
// =============================================================================

export type ActionResult<T = void> =
  | ({ ok: true } & (T extends void ? Record<never, never> : { data: T }))
  | { ok: false; error: string }

export type BiddingPolicyRow = {
  id: string
  keywordId: string
  keyword: string
  nccKeywordId: string
  /** UI 표시용 — keyword.adgroup.name (광고주 한정 join 결과) */
  adgroupName: string
  /** UI 표시용 — keyword.adgroup.campaign.name */
  campaignName: string
  device: "PC" | "MOBILE"
  targetRank: number
  maxBid: number | null
  minBid: number | null
  enabled: boolean
  createdAt: string // ISO
  updatedAt: string // ISO
}

// =============================================================================
// Zod 스키마
// =============================================================================

const advertiserIdSchema = z.string().trim().min(1).max(128)
const idSchema = z.string().trim().min(1).max(128)
const keywordIdSchema = z.string().trim().min(1).max(128)

// 본 모델은 PC / MOBILE 만. ALL 비사용 (코드 정책 — DB enum 은 StatDevice 재사용).
const deviceSchema = z.enum(["PC", "MOBILE"])

const targetRankSchema = z.number().int().min(1).max(10)

// 입찰가 단위는 원. 100,000,000 (1억) 상한은 운영 안전선 — SA 실 상한과 별개로 보수적.
const bidSchema = z
  .number()
  .int()
  .positive()
  .max(100_000_000)
  .nullable()
  .optional()

const createPolicySchema = z
  .object({
    advertiserId: advertiserIdSchema,
    keywordId: keywordIdSchema,
    device: deviceSchema,
    targetRank: targetRankSchema,
    maxBid: bidSchema,
    minBid: bidSchema,
    enabled: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    if (
      typeof val.maxBid === "number" &&
      typeof val.minBid === "number" &&
      val.maxBid < val.minBid
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["maxBid"],
        message: "maxBid는 minBid 이상이어야 합니다",
      })
    }
  })

const updatePolicySchema = z
  .object({
    id: idSchema,
    advertiserId: advertiserIdSchema,
    targetRank: targetRankSchema.optional(),
    maxBid: bidSchema,
    minBid: bidSchema,
    enabled: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    if (
      typeof val.maxBid === "number" &&
      typeof val.minBid === "number" &&
      val.maxBid < val.minBid
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["maxBid"],
        message: "maxBid는 minBid 이상이어야 합니다",
      })
    }
  })

const deletePolicySchema = z.object({
  id: idSchema,
  advertiserId: advertiserIdSchema,
})

const listKeywordsWithoutPolicySchema = z.object({
  advertiserId: advertiserIdSchema,
  device: deviceSchema,
})

// =============================================================================
// 입력 형 export (UI 호출 시그니처)
// =============================================================================

export type CreateBiddingPolicyInput = {
  advertiserId: string
  keywordId: string
  device: "PC" | "MOBILE"
  targetRank: number
  maxBid?: number | null
  minBid?: number | null
  enabled?: boolean
}

export type UpdateBiddingPolicyInput = {
  id: string
  advertiserId: string
  targetRank?: number
  maxBid?: number | null
  minBid?: number | null
  enabled?: boolean
}

export type DeleteBiddingPolicyInput = {
  id: string
  advertiserId: string
}

// =============================================================================
// 1. listBiddingPolicies — 광고주 정책 전체 목록 (viewer 가능)
// =============================================================================

/**
 * 광고주 단위 BiddingPolicy 전체 조회.
 *
 *   1. getCurrentAdvertiser — admin / 화이트리스트 검증
 *   2. prisma.biddingPolicy.findMany — Keyword 텍스트/nccKeywordId join
 *   3. createdAt desc 정렬
 *
 * viewer 도 호출 가능 (read 성격). hasKeys 검사 X — 정책은 SA 호출 동반 X.
 */
export async function listBiddingPolicies(
  advertiserId: string,
): Promise<BiddingPolicyRow[]> {
  await getCurrentAdvertiser(advertiserId)

  const rows = await prisma.biddingPolicy.findMany({
    where: { advertiserId },
    select: {
      id: true,
      keywordId: true,
      device: true,
      targetRank: true,
      maxBid: true,
      minBid: true,
      enabled: true,
      createdAt: true,
      updatedAt: true,
      keyword: {
        select: {
          keyword: true,
          nccKeywordId: true,
          adgroup: {
            select: {
              name: true,
              campaign: { select: { name: true } },
            },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  })

  return rows.map((r) => ({
    id: r.id,
    keywordId: r.keywordId,
    keyword: r.keyword.keyword,
    nccKeywordId: r.keyword.nccKeywordId,
    adgroupName: r.keyword.adgroup.name,
    campaignName: r.keyword.adgroup.campaign.name,
    device: r.device as "PC" | "MOBILE",
    targetRank: r.targetRank,
    maxBid: r.maxBid,
    minBid: r.minBid,
    enabled: r.enabled,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }))
}

// =============================================================================
// 2. createBiddingPolicy — 정책 신규 생성
// =============================================================================

/**
 * BiddingPolicy 신규 생성.
 *
 *   1. getCurrentAdvertiser
 *   2. viewer 차단 (me.role === 'viewer' → ok:false)
 *   3. Zod 검증 (device PC/MOBILE / targetRank 1..10 / maxBid >= minBid)
 *   4. 광고주 횡단 차단: Keyword.findFirst({ id, adgroup.campaign.advertiserId })
 *   5. UNIQUE [keywordId, device] 사전 차단 (DB unique 제약과 이중 방어)
 *   6. prisma.biddingPolicy.create
 *   7. AuditLog `bidding_policy.create`
 *   8. revalidatePath(`/${advertiserId}/bidding-policies`)
 */
export async function createBiddingPolicy(
  input: CreateBiddingPolicyInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = createPolicySchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: `입력 검증 실패: ${parsed.error.issues
        .map((i) => i.message)
        .join(", ")}`,
    }
  }
  const data = parsed.data

  const { user } = await getCurrentAdvertiser(data.advertiserId)
  if (user.role === "viewer") {
    return { ok: false, error: "권한 부족" }
  }

  // 광고주 횡단 차단 — Keyword 가 본 광고주 소속인지 확인
  const kw = await prisma.keyword.findFirst({
    where: {
      id: data.keywordId,
      adgroup: { campaign: { advertiserId: data.advertiserId } },
    },
    select: { id: true, keyword: true, nccKeywordId: true },
  })
  if (!kw) {
    return {
      ok: false,
      error: "해당 광고주의 키워드가 아닙니다",
    }
  }

  // UNIQUE [keywordId, device] 사전 차단
  const dup = await prisma.biddingPolicy.findUnique({
    where: {
      keywordId_device: {
        keywordId: data.keywordId,
        device: data.device as StatDevice,
      },
    },
    select: { id: true },
  })
  if (dup) {
    return {
      ok: false,
      error: "이미 정책이 존재합니다 (편집 사용)",
    }
  }

  const created = await prisma.biddingPolicy.create({
    data: {
      advertiserId: data.advertiserId,
      keywordId: data.keywordId,
      device: data.device as StatDevice,
      targetRank: data.targetRank,
      maxBid: data.maxBid ?? null,
      minBid: data.minBid ?? null,
      enabled: data.enabled ?? true,
    },
    select: { id: true },
  })

  await logAudit({
    userId: user.id,
    action: "bidding_policy.create",
    targetType: "BiddingPolicy",
    targetId: created.id,
    before: null,
    after: {
      advertiserId: data.advertiserId,
      keywordId: data.keywordId,
      keyword: kw.keyword,
      device: data.device,
      targetRank: data.targetRank,
      maxBid: data.maxBid ?? null,
      minBid: data.minBid ?? null,
      enabled: data.enabled ?? true,
    },
  })

  revalidatePath(`/${data.advertiserId}/bidding-policies`)

  return { ok: true, data: { id: created.id } }
}

// =============================================================================
// 3. updateBiddingPolicy — 정책 부분 수정
// =============================================================================

/**
 * BiddingPolicy 부분 업데이트. targetRank / maxBid / minBid / enabled 만 변경 대상.
 *
 *   1. getCurrentAdvertiser
 *   2. viewer 차단
 *   3. Zod (maxBid >= minBid 둘 다 있을 때)
 *   4. 광고주 격리: prisma.biddingPolicy.findFirst({ id, advertiserId })
 *   5. patch 산출 (입력에 등장한 필드만)
 *   6. update + AuditLog (before/after 동일 필드만)
 *   7. revalidatePath
 */
export async function updateBiddingPolicy(
  input: UpdateBiddingPolicyInput,
): Promise<ActionResult> {
  const parsed = updatePolicySchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: `입력 검증 실패: ${parsed.error.issues
        .map((i) => i.message)
        .join(", ")}`,
    }
  }
  const data = parsed.data

  const { user } = await getCurrentAdvertiser(data.advertiserId)
  if (user.role === "viewer") {
    return { ok: false, error: "권한 부족" }
  }

  const existing = await prisma.biddingPolicy.findFirst({
    where: { id: data.id, advertiserId: data.advertiserId },
    select: {
      id: true,
      keywordId: true,
      device: true,
      targetRank: true,
      maxBid: true,
      minBid: true,
      enabled: true,
    },
  })
  if (!existing) {
    return { ok: false, error: "정책을 찾을 수 없습니다" }
  }

  // patch 산출
  const patch: {
    targetRank?: number
    maxBid?: number | null
    minBid?: number | null
    enabled?: boolean
  } = {}
  const beforeObj: Record<string, unknown> = {}
  const afterObj: Record<string, unknown> = {}

  if (data.targetRank !== undefined) {
    patch.targetRank = data.targetRank
    beforeObj.targetRank = existing.targetRank
    afterObj.targetRank = data.targetRank
  }
  if (data.maxBid !== undefined) {
    patch.maxBid = data.maxBid ?? null
    beforeObj.maxBid = existing.maxBid
    afterObj.maxBid = data.maxBid ?? null
  }
  if (data.minBid !== undefined) {
    patch.minBid = data.minBid ?? null
    beforeObj.minBid = existing.minBid
    afterObj.minBid = data.minBid ?? null
  }
  if (data.enabled !== undefined) {
    patch.enabled = data.enabled
    beforeObj.enabled = existing.enabled
    afterObj.enabled = data.enabled
  }

  if (Object.keys(patch).length === 0) {
    // 변경 사항 없음 — 멱등 OK 반환
    return { ok: true }
  }

  // 사전 검증: 결과 maxBid/minBid 가 모두 number 일 때 maxBid >= minBid 보장.
  const finalMax =
    "maxBid" in patch ? (patch.maxBid as number | null) : existing.maxBid
  const finalMin =
    "minBid" in patch ? (patch.minBid as number | null) : existing.minBid
  if (
    typeof finalMax === "number" &&
    typeof finalMin === "number" &&
    finalMax < finalMin
  ) {
    return {
      ok: false,
      error: "maxBid는 minBid 이상이어야 합니다",
    }
  }

  await prisma.biddingPolicy.update({
    where: { id: data.id },
    data: patch,
  })

  await logAudit({
    userId: user.id,
    action: "bidding_policy.update",
    targetType: "BiddingPolicy",
    targetId: data.id,
    before: beforeObj,
    after: afterObj,
  })

  revalidatePath(`/${data.advertiserId}/bidding-policies`)

  return { ok: true }
}

// =============================================================================
// 4. deleteBiddingPolicy — 정책 삭제 (Cascade SetNull on OptimizationRun)
// =============================================================================

/**
 * BiddingPolicy 단순 삭제. Prisma onDelete: SetNull (OptimizationRun.policyId) 로 로그는 유지.
 *
 *   1. getCurrentAdvertiser
 *   2. viewer 차단
 *   3. 광고주 격리 findFirst — 미존재(이미 삭제) 시 멱등 OK 반환 (race / 더블클릭 안전)
 *   4. delete + AuditLog
 *   5. revalidatePath
 */
export async function deleteBiddingPolicy(
  input: DeleteBiddingPolicyInput,
): Promise<ActionResult> {
  const parsed = deletePolicySchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: `입력 검증 실패: ${parsed.error.issues
        .map((i) => i.message)
        .join(", ")}`,
    }
  }
  const data = parsed.data

  const { user } = await getCurrentAdvertiser(data.advertiserId)
  if (user.role === "viewer") {
    return { ok: false, error: "권한 부족" }
  }

  const existing = await prisma.biddingPolicy.findFirst({
    where: { id: data.id, advertiserId: data.advertiserId },
    select: {
      id: true,
      keywordId: true,
      device: true,
      targetRank: true,
      maxBid: true,
      minBid: true,
      enabled: true,
    },
  })
  if (!existing) {
    // 이미 삭제됨 — 멱등 OK (UI 더블 클릭 / 동시 작업 안전)
    return { ok: true }
  }

  await prisma.biddingPolicy.delete({
    where: { id: data.id },
  })

  await logAudit({
    userId: user.id,
    action: "bidding_policy.delete",
    targetType: "BiddingPolicy",
    targetId: data.id,
    before: {
      keywordId: existing.keywordId,
      device: existing.device,
      targetRank: existing.targetRank,
      maxBid: existing.maxBid,
      minBid: existing.minBid,
      enabled: existing.enabled,
    },
    after: null,
  })

  revalidatePath(`/${data.advertiserId}/bidding-policies`)

  return { ok: true }
}

// =============================================================================
// 5. listKeywordsWithoutPolicy — 모달 셀렉터: 본 device 정책이 없는 키워드 후보
// =============================================================================

export type KeywordOption = {
  id: string
  keyword: string
  nccKeywordId: string
  /** Combobox 부제 표시용 (광고그룹 이름) */
  adgroupName: string
}

/**
 * 신규 정책 모달의 키워드 셀렉터용. 해당 device 정책이 없는 키워드만.
 *
 * Combobox 한도: 500. 광고주 키워드가 5천이어도 드롭다운에 그대로 5천을 띄우지 않음.
 * UI 가 입력 필터(검색) 사용 시 별도 액션(search 인자) 추가 가능. 본 PR 은 단순 limit.
 *
 * viewer 도 가능 (셀렉터 read 성격이지만, 모달은 mutation 진입점이라 사실상 operator+ 호출).
 */
export async function listKeywordsWithoutPolicy(
  advertiserId: string,
  device: "PC" | "MOBILE",
): Promise<KeywordOption[]> {
  const parsed = listKeywordsWithoutPolicySchema.safeParse({
    advertiserId,
    device,
  })
  if (!parsed.success) {
    // 입력 검증 실패 — 빈 배열 반환 (UI 셀렉터는 throw 처리 부담)
    return []
  }

  await getCurrentAdvertiser(advertiserId)

  const rows = await prisma.keyword.findMany({
    where: {
      adgroup: { campaign: { advertiserId } },
      biddingPolicies: {
        none: { device: device as StatDevice },
      },
    },
    select: {
      id: true,
      keyword: true,
      nccKeywordId: true,
      adgroup: { select: { name: true } },
    },
    orderBy: { keyword: "asc" },
    take: 500,
  })

  return rows.map((k) => ({
    id: k.id,
    keyword: k.keyword,
    nccKeywordId: k.nccKeywordId,
    adgroupName: k.adgroup.name,
  }))
}
