"use server"

/**
 * 광고주 등록 / 수정 / 삭제 / 연결 테스트 — Server Actions (모델 2)
 *
 * 정책:
 *   - admin 권한 필수 (모든 액션 진입부 assertRole("admin"))
 *   - 시크릿(apiKey / secretKey)은 AES-256-GCM 암호화 후 Bytes 컬럼에 저장
 *   - AuditLog 기록 (before/after — 시크릿 평문 절대 X, logAudit 가 추가 마스킹도 수행)
 *   - 본 작업은 외부 API 변경 X → ChangeBatch 미사용
 *   - 응답 객체에 평문 시크릿 절대 포함 X
 *
 * UI는 `import { ... } from "@/app/admin/advertisers/actions"` 로 호출.
 */

import { revalidatePath } from "next/cache"
import { z } from "zod"

// 자격증명 resolver 자동 등록 (testConnection 시 SA API 호출 위해 필요)
import "@/lib/naver-sa/credentials"

import { prisma } from "@/lib/db/prisma"
import { encrypt } from "@/lib/crypto/secret"
import { assertRole } from "@/lib/auth/access"
import { logAudit } from "@/lib/audit/log"
import { getBizmoney } from "@/lib/naver-sa/billing"
import {
  NaverSaAuthError,
  NaverSaError,
  NaverSaRateLimitError,
} from "@/lib/naver-sa/errors"
import type { AdvertiserStatus } from "@/lib/generated/prisma/client"

// =============================================================================
// Zod 스키마
// =============================================================================

// customerId: 네이버 SA 는 숫자 문자열. 길이 제한은 보수적으로 4~20
const customerIdSchema = z
  .string()
  .trim()
  .regex(/^\d+$/u, "customerId는 숫자 문자열이어야 합니다")
  .min(4)
  .max(20)

const apiKeySchema = z.string().trim().min(20).max(512)
const secretKeySchema = z.string().trim().min(20).max(2048)

const nameSchema = z.string().trim().min(1).max(100)
const bizNoSchema = z.string().trim().max(20).optional()
const categorySchema = z.string().trim().max(100).optional()
const managerSchema = z.string().trim().max(100).optional()
const tagsSchema = z.array(z.string().trim().min(1).max(50)).max(50).optional()
const statusSchema = z.enum(["active", "paused", "archived"])

const registerSchema = z.object({
  name: nameSchema,
  customerId: customerIdSchema,
  apiKey: apiKeySchema,
  secretKey: secretKeySchema,
  bizNo: bizNoSchema,
  category: categorySchema,
  manager: managerSchema,
  tags: tagsSchema,
})

const updateSchema = z.object({
  name: nameSchema.optional(),
  apiKey: z.string().optional(),
  secretKey: z.string().optional(),
  bizNo: bizNoSchema,
  category: categorySchema,
  manager: managerSchema,
  tags: tagsSchema,
  status: statusSchema.optional(),
})

// =============================================================================
// 1. registerAdvertiser
// =============================================================================

export async function registerAdvertiser(input: {
  name: string
  customerId: string
  apiKey: string
  secretKey: string
  bizNo?: string
  category?: string
  manager?: string
  tags?: string[]
}): Promise<{ id: string }> {
  const me = await assertRole("admin")
  const parsed = registerSchema.parse(input)

  // 중복 customerId 사전 차단 (DB unique 제약과 이중 방어)
  const existing = await prisma.advertiser.findUnique({
    where: { customerId: parsed.customerId },
  })
  if (existing) {
    throw new Error(`이미 등록된 customerId 입니다: ${parsed.customerId}`)
  }

  const apiEnc = encrypt(parsed.apiKey)
  const secEnc = encrypt(parsed.secretKey)
  // Prisma 7의 Bytes 컬럼 타입은 Uint8Array<ArrayBuffer>.
  // Node Buffer는 Uint8Array<ArrayBufferLike> 이므로 (SharedArrayBuffer 가능)
  // Uint8Array.from() 으로 새 ArrayBuffer 백킹의 Uint8Array 를 만들어 전달.
  const apiKeyBytes = Uint8Array.from(apiEnc.enc)
  const secretKeyBytes = Uint8Array.from(secEnc.enc)

  const created = await prisma.advertiser.create({
    data: {
      name: parsed.name,
      customerId: parsed.customerId,
      apiKeyEnc: apiKeyBytes,
      apiKeyVersion: apiEnc.version,
      secretKeyEnc: secretKeyBytes,
      secretKeyVersion: secEnc.version,
      bizNo: parsed.bizNo ?? null,
      category: parsed.category ?? null,
      manager: parsed.manager ?? null,
      tags: parsed.tags ?? [],
      status: "active",
    },
    select: { id: true },
  })

  await logAudit({
    userId: me.id,
    action: "advertiser.register",
    targetType: "Advertiser",
    targetId: created.id,
    before: null,
    // 시크릿 평문은 절대 포함 X (logAudit 가 추가 마스킹도 수행하지만 사전 배제)
    after: {
      name: parsed.name,
      customerId: parsed.customerId,
      bizNo: parsed.bizNo ?? null,
      category: parsed.category ?? null,
      manager: parsed.manager ?? null,
      tags: parsed.tags ?? [],
    },
  })

  revalidatePath("/admin/advertisers")

  return { id: created.id }
}

// =============================================================================
// 2. updateAdvertiser
// =============================================================================

export async function updateAdvertiser(
  id: string,
  input: {
    name?: string
    apiKey?: string // 빈 문자열이면 변경 안 함
    secretKey?: string
    bizNo?: string
    category?: string
    manager?: string
    tags?: string[]
    status?: AdvertiserStatus
  },
): Promise<void> {
  const me = await assertRole("admin")
  const parsed = updateSchema.parse(input)

  const before = await prisma.advertiser.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      customerId: true,
      bizNo: true,
      category: true,
      manager: true,
      tags: true,
      status: true,
    },
  })
  if (!before) {
    throw new Error("존재하지 않는 광고주입니다")
  }

  // 변경분 누적 (시크릿은 비어있지 않을 때만 재암호화·갱신)
  const data: Record<string, unknown> = {}
  if (parsed.name !== undefined) data.name = parsed.name
  if (parsed.bizNo !== undefined) data.bizNo = parsed.bizNo || null
  if (parsed.category !== undefined) data.category = parsed.category || null
  if (parsed.manager !== undefined) data.manager = parsed.manager || null
  if (parsed.tags !== undefined) data.tags = parsed.tags
  if (parsed.status !== undefined) data.status = parsed.status

  let apiKeyChanged = false
  let secretKeyChanged = false

  if (parsed.apiKey && parsed.apiKey.trim().length > 0) {
    const validated = apiKeySchema.parse(parsed.apiKey)
    const enc = encrypt(validated)
    data.apiKeyEnc = Uint8Array.from(enc.enc)
    data.apiKeyVersion = enc.version
    apiKeyChanged = true
  }

  if (parsed.secretKey && parsed.secretKey.trim().length > 0) {
    const validated = secretKeySchema.parse(parsed.secretKey)
    const enc = encrypt(validated)
    data.secretKeyEnc = Uint8Array.from(enc.enc)
    data.secretKeyVersion = enc.version
    secretKeyChanged = true
  }

  if (Object.keys(data).length === 0) {
    return // 변경 사항 없음
  }

  await prisma.advertiser.update({ where: { id }, data })

  await logAudit({
    userId: me.id,
    action: "advertiser.update",
    targetType: "Advertiser",
    targetId: id,
    before: {
      name: before.name,
      bizNo: before.bizNo,
      category: before.category,
      manager: before.manager,
      tags: before.tags,
      status: before.status,
    },
    // 시크릿은 평문 절대 X. 변경 여부만 boolean 으로 기록.
    after: {
      name: parsed.name ?? before.name,
      bizNo: parsed.bizNo !== undefined ? parsed.bizNo || null : before.bizNo,
      category:
        parsed.category !== undefined ? parsed.category || null : before.category,
      manager: parsed.manager !== undefined ? parsed.manager || null : before.manager,
      tags: parsed.tags ?? before.tags,
      status: parsed.status ?? before.status,
      apiKeyChanged,
      secretKeyChanged,
    },
  })

  revalidatePath("/admin/advertisers")
  revalidatePath(`/admin/advertisers/${id}`)
}

// =============================================================================
// 3. deleteAdvertiser (soft delete)
// =============================================================================

export async function deleteAdvertiser(id: string): Promise<void> {
  const me = await assertRole("admin")

  const before = await prisma.advertiser.findUnique({
    where: { id },
    select: { id: true, name: true, customerId: true, status: true },
  })
  if (!before) {
    throw new Error("존재하지 않는 광고주입니다")
  }
  if (before.status === "archived") {
    return // 이미 아카이브됨
  }

  await prisma.advertiser.update({
    where: { id },
    data: { status: "archived" },
  })

  await logAudit({
    userId: me.id,
    action: "advertiser.delete",
    targetType: "Advertiser",
    targetId: id,
    before: {
      status: before.status,
      name: before.name,
      customerId: before.customerId,
    },
    after: { status: "archived" },
  })

  revalidatePath("/admin/advertisers")
}

// =============================================================================
// 4. testConnection
// =============================================================================

export type TestConnectionResult =
  | { ok: true; bizmoney: number; customerId: string }
  | { ok: false; error: string }

export async function testConnection(id: string): Promise<TestConnectionResult> {
  await assertRole("admin")

  const advertiser = await prisma.advertiser.findUnique({
    where: { id },
    select: { id: true, customerId: true, status: true },
  })
  if (!advertiser) {
    return { ok: false, error: "존재하지 않는 광고주입니다" }
  }
  if (advertiser.status !== "active") {
    const reason =
      advertiser.status === "paused"
        ? "일시중지된 광고주입니다"
        : "아카이브된 광고주입니다"
    return { ok: false, error: reason }
  }

  try {
    const res = await getBizmoney(advertiser.customerId)
    // 외부 API customerId 는 number 일 수 있음 → String 변환 (컨벤션 #3).
    return {
      ok: true,
      bizmoney: res.bizmoney,
      customerId: String(res.customerId),
    }
  } catch (e) {
    if (e instanceof NaverSaAuthError) {
      return { ok: false, error: "API 키/시크릿 검증 실패" }
    }
    if (e instanceof NaverSaRateLimitError) {
      return { ok: false, error: "Rate Limit. 잠시 후 재시도" }
    }
    if (e instanceof NaverSaError) {
      return { ok: false, error: `네이버 SA 호출 실패: ${e.message}` }
    }
    // 알 수 없는 에러 — 시크릿 누출 우려가 있으므로 사용자에게는 일반화된 메시지만.
    // 단, 진단을 위해 서버 로그에는 stack 출력 (시크릿 평문은 NaverSAClient 내부에서 처리되어 e에 포함되지 않음).
    console.error("[testConnection] unexpected error:", e)
    return { ok: false, error: "연결 테스트 중 알 수 없는 오류" }
  }
}
