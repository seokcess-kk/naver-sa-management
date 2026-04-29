"use server"

/**
 * 광고주 등록 / 수정 / 삭제 / 연결 테스트 / CSV 일괄 등록 — Server Actions (모델 2)
 *
 * 정책:
 *   - admin 권한 필수 (모든 액션 진입부 assertRole("admin"))
 *   - 시크릿(apiKey / secretKey)은 AES-256-GCM 암호화 후 Bytes 컬럼에 저장
 *   - F-1.2: 시크릿은 CSV 일괄 등록에 포함 X. 메타만 등록하고 시크릿은 별도 입력.
 *     → registerAdvertiser 단건도 일관성 위해 키 optional. 단 apiKey ↔ secretKey 페어 검증.
 *   - 키 미입력 광고주는 SA API 호출 차단 (credentials.ts에서 "Credentials not set" throw)
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
const memoSchema = z.string().trim().max(500).optional()
const tagsSchema = z.array(z.string().trim().min(1).max(50)).max(50).optional()
const statusSchema = z.enum(["active", "paused", "archived"])

/**
 * 키 페어 검증 — apiKey ↔ secretKey 는 항상 함께. 한쪽만 있으면 검증 실패.
 * 빈 문자열은 "미입력" 으로 간주 (UI form 에서 빈 input 으로 들어올 수 있음).
 */
function isProvided(v: string | undefined | null): v is string {
  return typeof v === "string" && v.trim().length > 0
}

const registerSchema = z
  .object({
    name: nameSchema,
    customerId: customerIdSchema,
    apiKey: apiKeySchema.optional(),
    secretKey: secretKeySchema.optional(),
    bizNo: bizNoSchema,
    category: categorySchema,
    manager: managerSchema,
    memo: memoSchema,
    tags: tagsSchema,
  })
  .superRefine((val, ctx) => {
    const hasApi = isProvided(val.apiKey)
    const hasSec = isProvided(val.secretKey)
    if (hasApi !== hasSec) {
      ctx.addIssue({
        code: "custom",
        path: ["apiKey"],
        message: "apiKey와 secretKey는 함께 입력해야 합니다",
      })
    }
  })

// F-11.5 Guardrail 범위 (db_guardrail.md 와 일치):
//   - guardrailMaxBidChangePct       1..100  (1회 자동 조정 ±N%)
//   - guardrailMaxChangesPerKeyword  1..20   (키워드별 24h 한도)
//   - guardrailMaxChangesPerDay      1..1000 (광고주별 24h 한도)
// DB 측 default 만 강제 — 호출부 Zod 가 운영 상한을 강제.
const guardrailMaxBidChangePctSchema = z.number().int().min(1).max(100)
const guardrailMaxChangesPerKeywordSchema = z.number().int().min(1).max(20)
const guardrailMaxChangesPerDaySchema = z.number().int().min(1).max(1000)

const updateSchema = z
  .object({
    name: nameSchema.optional(),
    apiKey: z.string().optional(),
    secretKey: z.string().optional(),
    bizNo: bizNoSchema,
    category: categorySchema,
    manager: managerSchema,
    memo: memoSchema,
    tags: tagsSchema,
    status: statusSchema.optional(),
    // F-11.5 Guardrail — 모두 optional. 미전달 시 변경 안 함.
    guardrailEnabled: z.boolean().optional(),
    guardrailMaxBidChangePct: guardrailMaxBidChangePctSchema.optional(),
    guardrailMaxChangesPerKeyword: guardrailMaxChangesPerKeywordSchema.optional(),
    guardrailMaxChangesPerDay: guardrailMaxChangesPerDaySchema.optional(),
  })
  .superRefine((val, ctx) => {
    // 시크릿 둘 다 함께 변경. 한쪽만 있으면 거부.
    const hasApi = isProvided(val.apiKey)
    const hasSec = isProvided(val.secretKey)
    if (hasApi !== hasSec) {
      ctx.addIssue({
        code: "custom",
        path: ["apiKey"],
        message: "apiKey와 secretKey는 함께 입력해야 합니다",
      })
    }
  })

// CSV 일괄 등록은 메타만. 시크릿 컬럼 일체 X.
const bulkRowSchema = z.object({
  name: nameSchema,
  customerId: customerIdSchema,
  bizNo: bizNoSchema,
  category: categorySchema,
  manager: managerSchema,
  memo: memoSchema,
  tags: tagsSchema,
})

// =============================================================================
// 1. registerAdvertiser (단건)
// =============================================================================

export async function registerAdvertiser(input: {
  name: string
  customerId: string
  apiKey?: string // optional. 둘 다 있거나 둘 다 없거나
  secretKey?: string
  bizNo?: string
  category?: string
  manager?: string
  memo?: string
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

  const hasCredentials = isProvided(parsed.apiKey) && isProvided(parsed.secretKey)

  // Prisma 7의 Bytes 컬럼 타입은 Uint8Array<ArrayBuffer>.
  // Node Buffer는 Uint8Array<ArrayBufferLike> 이므로 (SharedArrayBuffer 가능)
  // Uint8Array.from() 으로 새 ArrayBuffer 백킹의 Uint8Array 를 만들어 전달.
  // 키 미입력(null) 분기와 함께 처리하기 위해 data 객체를 단계적으로 구성.
  const data: {
    name: string
    customerId: string
    apiKeyEnc?: Uint8Array<ArrayBuffer>
    apiKeyVersion?: number
    secretKeyEnc?: Uint8Array<ArrayBuffer>
    secretKeyVersion?: number
    bizNo: string | null
    category: string | null
    manager: string | null
    memo: string | null
    tags: string[]
    status: "active"
  } = {
    name: parsed.name,
    customerId: parsed.customerId,
    bizNo: parsed.bizNo ?? null,
    category: parsed.category ?? null,
    manager: parsed.manager ?? null,
    memo: parsed.memo ?? null,
    tags: parsed.tags ?? [],
    status: "active",
  }
  if (hasCredentials) {
    const apiEnc = encrypt(parsed.apiKey as string)
    const secEnc = encrypt(parsed.secretKey as string)
    data.apiKeyEnc = Uint8Array.from(apiEnc.enc)
    data.apiKeyVersion = apiEnc.version
    data.secretKeyEnc = Uint8Array.from(secEnc.enc)
    data.secretKeyVersion = secEnc.version
  }

  const created = await prisma.advertiser.create({
    data,
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
      memo: parsed.memo ?? null,
      tags: parsed.tags ?? [],
      hasCredentials,
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
    apiKey?: string // 빈 문자열이면 변경 안 함. apiKey ↔ secretKey 페어 검증
    secretKey?: string
    bizNo?: string
    category?: string
    manager?: string
    memo?: string
    tags?: string[]
    status?: AdvertiserStatus
    // F-11.5 Guardrail (자동 비딩 폭주 방지)
    guardrailEnabled?: boolean
    guardrailMaxBidChangePct?: number // 1..100
    guardrailMaxChangesPerKeyword?: number // 1..20
    guardrailMaxChangesPerDay?: number // 1..1000
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
      memo: true,
      tags: true,
      status: true,
      guardrailEnabled: true,
      guardrailMaxBidChangePct: true,
      guardrailMaxChangesPerKeyword: true,
      guardrailMaxChangesPerDay: true,
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
  if (parsed.memo !== undefined) data.memo = parsed.memo || null
  if (parsed.tags !== undefined) data.tags = parsed.tags
  if (parsed.status !== undefined) data.status = parsed.status
  // F-11.5 Guardrail
  if (parsed.guardrailEnabled !== undefined)
    data.guardrailEnabled = parsed.guardrailEnabled
  if (parsed.guardrailMaxBidChangePct !== undefined)
    data.guardrailMaxBidChangePct = parsed.guardrailMaxBidChangePct
  if (parsed.guardrailMaxChangesPerKeyword !== undefined)
    data.guardrailMaxChangesPerKeyword = parsed.guardrailMaxChangesPerKeyword
  if (parsed.guardrailMaxChangesPerDay !== undefined)
    data.guardrailMaxChangesPerDay = parsed.guardrailMaxChangesPerDay

  let apiKeyChanged = false
  let secretKeyChanged = false

  // superRefine 으로 페어 검증은 통과한 상태. 둘 다 있는 경우에만 갱신.
  if (isProvided(parsed.apiKey) && isProvided(parsed.secretKey)) {
    const validatedApi = apiKeySchema.parse(parsed.apiKey)
    const validatedSec = secretKeySchema.parse(parsed.secretKey)
    const apiEnc = encrypt(validatedApi)
    const secEnc = encrypt(validatedSec)
    data.apiKeyEnc = Uint8Array.from(apiEnc.enc)
    data.apiKeyVersion = apiEnc.version
    data.secretKeyEnc = Uint8Array.from(secEnc.enc)
    data.secretKeyVersion = secEnc.version
    apiKeyChanged = true
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
      memo: before.memo,
      tags: before.tags,
      status: before.status,
      // F-11.5 Guardrail before
      guardrailEnabled: before.guardrailEnabled,
      guardrailMaxBidChangePct: before.guardrailMaxBidChangePct,
      guardrailMaxChangesPerKeyword: before.guardrailMaxChangesPerKeyword,
      guardrailMaxChangesPerDay: before.guardrailMaxChangesPerDay,
    },
    // 시크릿은 평문 절대 X. 변경 여부만 boolean 으로 기록.
    after: {
      name: parsed.name ?? before.name,
      bizNo: parsed.bizNo !== undefined ? parsed.bizNo || null : before.bizNo,
      category:
        parsed.category !== undefined ? parsed.category || null : before.category,
      manager: parsed.manager !== undefined ? parsed.manager || null : before.manager,
      memo: parsed.memo !== undefined ? parsed.memo || null : before.memo,
      tags: parsed.tags ?? before.tags,
      status: parsed.status ?? before.status,
      apiKeyChanged,
      secretKeyChanged,
      // F-11.5 Guardrail after
      guardrailEnabled:
        parsed.guardrailEnabled ?? before.guardrailEnabled,
      guardrailMaxBidChangePct:
        parsed.guardrailMaxBidChangePct ?? before.guardrailMaxBidChangePct,
      guardrailMaxChangesPerKeyword:
        parsed.guardrailMaxChangesPerKeyword ?? before.guardrailMaxChangesPerKeyword,
      guardrailMaxChangesPerDay:
        parsed.guardrailMaxChangesPerDay ?? before.guardrailMaxChangesPerDay,
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
    select: {
      id: true,
      customerId: true,
      status: true,
      apiKeyEnc: true,
      secretKeyEnc: true,
    },
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
  // F-1.2: 메타만 등록되고 시크릿 입력 전 상태에서는 SA 호출 불가.
  if (advertiser.apiKeyEnc === null || advertiser.secretKeyEnc === null) {
    return { ok: false, error: "API 키/시크릿 미입력" }
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

// =============================================================================
// 5. registerAdvertisersBulk — F-1.2 CSV 일괄 등록
// =============================================================================

export type BulkAdvertiserInput = {
  name: string
  customerId: string
  bizNo?: string
  category?: string
  manager?: string
  memo?: string
  tags?: string[]
}

export type BulkRegisterRow =
  | { ok: true; row: number; id: string; customerId: string; action: "created" | "skipped" }
  | { ok: false; row: number; customerId?: string; error: string }

export type BulkRegisterResult = {
  created: number
  skipped: number // 이미 존재 (customerId 중복)
  failed: number // 검증 또는 INSERT 실패
  rows: BulkRegisterRow[]
}

/**
 * CSV 행 목록을 받아 광고주를 일괄 등록.
 *
 * 동작:
 *   1. assertRole('admin')
 *   2. 각 행 Zod 검증 (실패 → failed)
 *   3. 입력 안 customerId 중복: 마지막 행만 적용 (이전 행은 경고로 skipped 보고)
 *   4. DB 기존 customerId 충돌:
 *      - duplicatePolicy='skip'  → skipped
 *      - duplicatePolicy='error' → failed
 *   5. 통과 행을 createMany 로 INSERT (시크릿 컬럼 X — 메타만)
 *   6. AuditLog 1건 기록 (요약만; 행별 세부는 본 액션 반환값으로 UI에 표시)
 *
 * 본 액션은 외부 API 변경이 아니므로 ChangeBatch 패턴 미사용 (단일 트랜잭션).
 * UI 는 PapaParse 로 CSV 파싱 후 정상 행만 인자로 전달한다.
 */
export async function registerAdvertisersBulk(input: {
  rows: BulkAdvertiserInput[]
  duplicatePolicy?: "skip" | "error" // 기본 skip
}): Promise<BulkRegisterResult> {
  const me = await assertRole("admin")
  const policy = input.duplicatePolicy ?? "skip"
  const rows = input.rows ?? []

  // 1) Zod 검증 + 입력 내부 customerId 중복 처리 (마지막 행만 적용)
  type ValidRow = z.infer<typeof bulkRowSchema> & { row: number }
  const validRows: ValidRow[] = []
  const reports: BulkRegisterRow[] = []
  // customerId → validRows 인덱스
  const seen = new Map<string, number>()

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 1 // CSV 행 번호(1-based, 헤더 제외 가정)
    const raw = rows[i]
    const parsed = bulkRowSchema.safeParse(raw)
    if (!parsed.success) {
      const msg = parsed.error.issues
        .map((iss) => `${iss.path.join(".") || "row"}: ${iss.message}`)
        .join("; ")
      reports.push({
        ok: false,
        row: rowNumber,
        customerId: typeof raw?.customerId === "string" ? raw.customerId : undefined,
        error: msg,
      })
      continue
    }

    const data = parsed.data
    const prevIdx = seen.get(data.customerId)
    if (prevIdx !== undefined) {
      // 입력 내 중복 — 이전 등록을 경고로 skipped 보고하고, 새 행으로 교체
      const prev = validRows[prevIdx]
      reports.push({
        ok: false,
        row: prev.row,
        customerId: prev.customerId,
        error: `입력 내 customerId 중복 — 이후 행으로 대체됨 (row=${rowNumber})`,
      })
      validRows[prevIdx] = { ...data, row: rowNumber }
      seen.set(data.customerId, prevIdx)
    } else {
      seen.set(data.customerId, validRows.length)
      validRows.push({ ...data, row: rowNumber })
    }
  }

  // 2) DB 에 기존에 존재하는 customerId 조회 (한 번에)
  const candidateIds = validRows.map((r) => r.customerId)
  const existing =
    candidateIds.length > 0
      ? await prisma.advertiser.findMany({
          where: { customerId: { in: candidateIds } },
          select: { id: true, customerId: true },
        })
      : []
  const existingMap = new Map(existing.map((e) => [e.customerId, e.id]))

  // 3) 정책에 따라 기존 customerId 행 분리
  const toInsert: ValidRow[] = []
  for (const r of validRows) {
    const exId = existingMap.get(r.customerId)
    if (exId !== undefined) {
      if (policy === "skip") {
        reports.push({
          ok: true,
          row: r.row,
          id: exId,
          customerId: r.customerId,
          action: "skipped",
        })
      } else {
        reports.push({
          ok: false,
          row: r.row,
          customerId: r.customerId,
          error: "이미 등록된 customerId 입니다",
        })
      }
    } else {
      toInsert.push(r)
    }
  }

  // 4) 일괄 INSERT (createMany — 시크릿 컬럼 누락 = nullable 이라 NULL).
  // createMany 는 반환 row 가 없으므로, 삽입 후 customerId 로 재조회해 id 매핑.
  if (toInsert.length > 0) {
    try {
      await prisma.advertiser.createMany({
        data: toInsert.map((r) => ({
          name: r.name,
          customerId: r.customerId,
          bizNo: r.bizNo ?? null,
          category: r.category ?? null,
          manager: r.manager ?? null,
          memo: r.memo ?? null,
          tags: r.tags ?? [],
          status: "active" as const,
          // apiKeyEnc / secretKeyEnc 는 누락 = null (nullable 컬럼)
        })),
        skipDuplicates: false,
      })

      const insertedIds = await prisma.advertiser.findMany({
        where: { customerId: { in: toInsert.map((r) => r.customerId) } },
        select: { id: true, customerId: true },
      })
      const idMap = new Map(insertedIds.map((e) => [e.customerId, e.id]))

      for (const r of toInsert) {
        const id = idMap.get(r.customerId)
        if (id) {
          reports.push({
            ok: true,
            row: r.row,
            id,
            customerId: r.customerId,
            action: "created",
          })
        } else {
          // 이론상 도달 불가 (방금 INSERT 했음). 방어 코드.
          reports.push({
            ok: false,
            row: r.row,
            customerId: r.customerId,
            error: "INSERT 직후 id 조회 실패",
          })
        }
      }
    } catch (e) {
      // createMany 실패 시 — 모든 toInsert 행을 failed 로 보고
      const errMsg = e instanceof Error ? e.message : String(e)
      for (const r of toInsert) {
        reports.push({
          ok: false,
          row: r.row,
          customerId: r.customerId,
          error: `INSERT 실패: ${errMsg}`,
        })
      }
    }
  }

  // 5) 집계
  let createdCount = 0
  let skippedCount = 0
  let failedCount = 0
  // 행 번호 오름차순 정렬 (UI 표시 가독성)
  reports.sort((a, b) => a.row - b.row)
  for (const r of reports) {
    if (r.ok) {
      if (r.action === "created") createdCount++
      else skippedCount++
    } else {
      failedCount++
    }
  }

  // 6) AuditLog 1건 — 요약만 (시크릿 평문 X, 행별 세부는 미저장)
  await logAudit({
    userId: me.id,
    action: "advertiser.bulk_register",
    targetType: "Advertiser",
    targetId: null,
    before: null,
    after: {
      total: rows.length,
      created: createdCount,
      skipped: skippedCount,
      failed: failedCount,
      duplicatePolicy: policy,
    },
  })

  revalidatePath("/admin/advertisers")

  return {
    created: createdCount,
    skipped: skippedCount,
    failed: failedCount,
    rows: reports,
  }
}

// =============================================================================
// 6. toggleBiddingKillSwitch — F-11.6 자동 비딩 Kill Switch 토글
// =============================================================================
//
// 정책:
//   - admin 전용 (assertRole("admin")) — 운영 사고 격리 권한이라 보수적
//   - 광고주 단위 (전역 X — F-11.6 결정 사항)
//   - biddingKillSwitchAt / biddingKillSwitchBy 는 정지·재개 둘 다 갱신 (마지막 1건 보존)
//   - AuditLog `advertiser.kill_switch_toggle` 적재 (감사 이중 안전망)
//   - revalidatePath:
//       /admin/advertisers/{id}        — admin 상세 페이지
//       /[advertiserId]                — 광고주 컨텍스트 (대시보드 헤더 배너 등)
//       /[advertiserId]/bidding-policies  — 정책 페이지 상태 표시
//
// 본 PR 비대상:
//   - 자동 비딩 cron 측 Kill Switch 검사 (F-11.2 후속) — 본 액션은 컬럼 토글만.

const killSwitchSchema = z.object({
  advertiserId: z.string().trim().min(1).max(128),
  enabled: z.boolean(),
})

export type ToggleKillSwitchInput = z.infer<typeof killSwitchSchema>

export type ToggleKillSwitchResult =
  | { ok: true; enabled: boolean; at: string; by: string }
  | { ok: false; error: string }

/**
 * 광고주의 자동 비딩 Kill Switch 토글.
 *
 *   1. assertRole("admin") — operator/viewer 차단 (AuthorizationError throw)
 *   2. Zod 검증
 *   3. 광고주 존재 확인 (없으면 ok:false). status 'archived' 도 차단.
 *   4. update biddingKillSwitch / biddingKillSwitchAt / biddingKillSwitchBy
 *   5. AuditLog 적재 — before/after 에 enabled / at / by
 *   6. revalidatePath (admin + 광고주 컨텍스트 + 정책 페이지)
 */
export async function toggleBiddingKillSwitch(
  input: ToggleKillSwitchInput,
): Promise<ToggleKillSwitchResult> {
  const me = await assertRole("admin")
  const parsed = killSwitchSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: `입력 검증 실패: ${parsed.error.issues
        .map((i) => i.message)
        .join(", ")}`,
    }
  }
  const { advertiserId, enabled } = parsed.data

  const before = await prisma.advertiser.findUnique({
    where: { id: advertiserId },
    select: {
      id: true,
      status: true,
      biddingKillSwitch: true,
      biddingKillSwitchAt: true,
      biddingKillSwitchBy: true,
    },
  })
  if (!before) {
    return { ok: false, error: "존재하지 않는 광고주입니다" }
  }
  if (before.status === "archived") {
    return { ok: false, error: "아카이브된 광고주는 토글할 수 없습니다" }
  }

  const at = new Date()

  await prisma.advertiser.update({
    where: { id: advertiserId },
    data: {
      biddingKillSwitch: enabled,
      // 정지·재개 둘 다 갱신 (마지막 1건 보존)
      biddingKillSwitchAt: at,
      biddingKillSwitchBy: me.id,
    },
  })

  await logAudit({
    userId: me.id,
    action: "advertiser.kill_switch_toggle",
    targetType: "Advertiser",
    targetId: advertiserId,
    before: {
      enabled: before.biddingKillSwitch,
      at:
        before.biddingKillSwitchAt === null
          ? null
          : before.biddingKillSwitchAt.toISOString(),
      by: before.biddingKillSwitchBy,
    },
    after: {
      enabled,
      at: at.toISOString(),
      by: me.id,
    },
  })

  revalidatePath(`/admin/advertisers/${advertiserId}`)
  revalidatePath(`/${advertiserId}`)
  revalidatePath(`/${advertiserId}/bidding-policies`)

  return { ok: true, enabled, at: at.toISOString(), by: me.id }
}
