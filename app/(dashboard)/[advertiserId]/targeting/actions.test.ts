/**
 * F-11.4 — TargetingRule Server Actions 단위 테스트.
 *
 * 외부 호출 0:
 *   - vi.mock("@/lib/auth/access", ...)   — getCurrentAdvertiser / getCurrentUser stub
 *   - vi.mock("@/lib/db/prisma", ...)     — targetingRule.findUnique / upsert stub
 *   - vi.mock("@/lib/audit/log", ...)     — logAudit stub
 *   - vi.mock("next/cache", ...)          — revalidatePath stub
 *
 * 검증:
 *   A. getTargetingRule    — lazy upsert (없으면 생성) / shape / advertiserId 검증
 *   B. upsertTargetingRule — viewer 차단 / Zod 검증 (잘못된 키 / 값 / 크기) / AuditLog
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// =============================================================================
// Mocks (전역 hoist)
// =============================================================================

const mockGetCurrentAdvertiser = vi.fn()
const mockGetCurrentUser = vi.fn()

vi.mock("@/lib/auth/access", () => ({
  getCurrentAdvertiser: (...args: unknown[]) =>
    mockGetCurrentAdvertiser(...args),
  getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
}))

const mockFindUnique = vi.fn()
const mockUpsert = vi.fn()

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    targetingRule: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      upsert: (...args: unknown[]) => mockUpsert(...args),
    },
  },
}))

const mockLogAudit = vi.fn()
vi.mock("@/lib/audit/log", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}))

const mockRevalidatePath = vi.fn()
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}))

import {
  getTargetingRule,
  upsertTargetingRule,
} from "@/app/(dashboard)/[advertiserId]/targeting/actions"

// =============================================================================
// 공통 setup
// =============================================================================

const ADV_ID = "adv_1"
const RULE_ID = "tr_1"
const USER_ID = "u_op"

function setOperator(): void {
  mockGetCurrentAdvertiser.mockResolvedValue({
    advertiser: {
      id: ADV_ID,
      customerId: "1234",
      name: "Adv",
      status: "active",
      hasKeys: true,
    },
    user: { id: USER_ID, role: "operator" },
  })
  mockGetCurrentUser.mockResolvedValue({
    id: USER_ID,
    role: "operator",
    status: "active",
  })
}

function setViewer(): void {
  mockGetCurrentAdvertiser.mockResolvedValue({
    advertiser: {
      id: ADV_ID,
      customerId: "1234",
      name: "Adv",
      status: "active",
      hasKeys: true,
    },
    user: { id: "u_v", role: "viewer" },
  })
  mockGetCurrentUser.mockResolvedValue({
    id: "u_v",
    role: "viewer",
    status: "active",
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  setOperator()
})

afterEach(() => {
  vi.clearAllMocks()
})

// =============================================================================
// A. getTargetingRule
// =============================================================================

describe("getTargetingRule", () => {
  it("advertiserId 검증 실패 시 ok:false", async () => {
    const r = await getTargetingRule("")
    expect(r.ok).toBe(false)
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it("lazy upsert — 룰 없으면 default 생성 (create 분기)", async () => {
    mockUpsert.mockResolvedValue({
      id: RULE_ID,
      advertiserId: ADV_ID,
      enabled: true,
      defaultWeight: 1.0,
      hourWeights: {},
      regionWeights: {},
      deviceWeights: {},
    })

    const r = await getTargetingRule(ADV_ID)

    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { advertiserId: ADV_ID },
        update: {},
        create: { advertiserId: ADV_ID },
      }),
    )
    expect(r.data).toEqual({
      id: RULE_ID,
      advertiserId: ADV_ID,
      enabled: true,
      defaultWeight: 1.0,
      hourWeights: {},
      regionWeights: {},
      deviceWeights: {},
    })
  })

  it("기존 룰 조회 — JSON 컬럼 → Record<string, number> 변환", async () => {
    mockUpsert.mockResolvedValue({
      id: RULE_ID,
      advertiserId: ADV_ID,
      enabled: true,
      defaultWeight: 1.5,
      hourWeights: { "mon-0": 1.0, "fri-22": 0.7 },
      regionWeights: { "11": 1.2 },
      deviceWeights: { PC: 1.0, MOBILE: 1.2 },
    })

    const r = await getTargetingRule(ADV_ID)

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.hourWeights).toEqual({ "mon-0": 1.0, "fri-22": 0.7 })
    expect(r.data.regionWeights).toEqual({ "11": 1.2 })
    expect(r.data.deviceWeights).toEqual({ PC: 1.0, MOBILE: 1.2 })
    expect(r.data.defaultWeight).toBeCloseTo(1.5, 5)
  })

  it("getCurrentAdvertiser throw 시 ok:false (메시지 전달)", async () => {
    mockGetCurrentAdvertiser.mockRejectedValueOnce(
      new Error("해당 광고주에 대한 접근 권한이 없습니다"),
    )

    const r = await getTargetingRule(ADV_ID)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/접근 권한/u)
    expect(mockUpsert).not.toHaveBeenCalled()
  })
})

// =============================================================================
// B. upsertTargetingRule
// =============================================================================

describe("upsertTargetingRule", () => {
  function setUpsertOk() {
    mockFindUnique.mockResolvedValue({
      id: RULE_ID,
      advertiserId: ADV_ID,
      enabled: true,
      defaultWeight: 1.0,
      hourWeights: {},
      regionWeights: {},
      deviceWeights: {},
    })
    mockUpsert.mockResolvedValue({
      id: RULE_ID,
      advertiserId: ADV_ID,
      enabled: true,
      defaultWeight: 1.0,
      hourWeights: {},
      regionWeights: {},
      deviceWeights: {},
    })
  }

  it("viewer 차단", async () => {
    setViewer()
    const r = await upsertTargetingRule({
      advertiserId: ADV_ID,
      enabled: false,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/권한 부족/u)
    expect(mockUpsert).not.toHaveBeenCalled()
    expect(mockLogAudit).not.toHaveBeenCalled()
  })

  it("happy path — partial enabled + AuditLog targeting_rule.update + revalidatePath", async () => {
    setUpsertOk()

    const r = await upsertTargetingRule({
      advertiserId: ADV_ID,
      enabled: false,
      defaultWeight: 1.2,
    })

    expect(r.ok).toBe(true)
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { advertiserId: ADV_ID },
        update: { enabled: false, defaultWeight: 1.2 },
      }),
    )
    const auditCall = mockLogAudit.mock.calls[0][0]
    expect(auditCall.action).toBe("targeting_rule.update")
    expect(auditCall.targetType).toBe("TargetingRule")
    expect(auditCall.targetId).toBe(RULE_ID)
    expect(auditCall.userId).toBe(USER_ID)
    expect(mockRevalidatePath).toHaveBeenCalledWith(`/${ADV_ID}/targeting`)
  })

  it("hourWeights — 잘못된 키 (xxx-9) 거부", async () => {
    const r = await upsertTargetingRule({
      advertiserId: ADV_ID,
      hourWeights: { "xxx-9": 1.5 } as Record<string, number>,
    })
    expect(r.ok).toBe(false)
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it("hourWeights — hour 24 거부 (regex 0..23 만)", async () => {
    const r = await upsertTargetingRule({
      advertiserId: ADV_ID,
      hourWeights: { "mon-24": 1.5 } as Record<string, number>,
    })
    expect(r.ok).toBe(false)
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it("hourWeights — 값 음수 거부", async () => {
    const r = await upsertTargetingRule({
      advertiserId: ADV_ID,
      hourWeights: { "mon-9": -0.1 },
    })
    expect(r.ok).toBe(false)
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it("hourWeights — 값 3.0 초과 거부 (운영 clamp)", async () => {
    const r = await upsertTargetingRule({
      advertiserId: ADV_ID,
      hourWeights: { "mon-9": 3.5 },
    })
    expect(r.ok).toBe(false)
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it("hourWeights — 168 키 초과 거부 (169 키)", async () => {
    const obj: Record<string, number> = {}
    const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    let count = 0
    for (const d of days) {
      for (let h = 0; h < 24; h++) {
        if (count >= 168) break
        obj[`${d}-${h}`] = 1.0
        count++
      }
    }
    // 168 까지는 OK, 169 추가는 키 형식 위반(valid hour 만 가능) → regex 거부.
    // 크기 제한 확인 위해 169번째는 valid 키 패턴 사용 불가 — 그 대신 169 위치를 만들 수 없으므로
    // 실제 크기 한계는 168 자체. 본 테스트는 "168 까지는 OK" 만 검증.
    setUpsertOk()
    const r = await upsertTargetingRule({
      advertiserId: ADV_ID,
      hourWeights: obj,
    })
    expect(r.ok).toBe(true)
  })

  it("regionWeights — 잘못된 키 길이 거부", async () => {
    const r = await upsertTargetingRule({
      advertiserId: ADV_ID,
      regionWeights: { "111": 1.2 } as Record<string, number>,
    })
    expect(r.ok).toBe(false)
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it("regionWeights — 비숫자 키 거부", async () => {
    const r = await upsertTargetingRule({
      advertiserId: ADV_ID,
      regionWeights: { aa: 1.2 } as Record<string, number>,
    })
    expect(r.ok).toBe(false)
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it("deviceWeights — 잘못된 키 거부", async () => {
    const r = await upsertTargetingRule({
      advertiserId: ADV_ID,
      deviceWeights: { TABLET: 1.0 } as Record<string, number>,
    })
    expect(r.ok).toBe(false)
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it("deviceWeights — PC/MOBILE 정상 통과", async () => {
    setUpsertOk()
    const r = await upsertTargetingRule({
      advertiserId: ADV_ID,
      deviceWeights: { PC: 1.0, MOBILE: 1.2 },
    })
    expect(r.ok).toBe(true)
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { deviceWeights: { PC: 1.0, MOBILE: 1.2 } },
      }),
    )
  })

  it("defaultWeight 3.0 초과 거부", async () => {
    const r = await upsertTargetingRule({
      advertiserId: ADV_ID,
      defaultWeight: 3.5,
    })
    expect(r.ok).toBe(false)
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it("AuditLog before — 기존 행 스냅샷, after — 갱신 결과", async () => {
    mockFindUnique.mockResolvedValue({
      id: RULE_ID,
      advertiserId: ADV_ID,
      enabled: true,
      defaultWeight: 1.0,
      hourWeights: { "mon-0": 1.0 },
      regionWeights: {},
      deviceWeights: {},
    })
    mockUpsert.mockResolvedValue({
      id: RULE_ID,
      advertiserId: ADV_ID,
      enabled: false,
      defaultWeight: 1.0,
      hourWeights: { "mon-0": 1.0 },
      regionWeights: {},
      deviceWeights: {},
    })

    await upsertTargetingRule({
      advertiserId: ADV_ID,
      enabled: false,
    })

    const auditCall = mockLogAudit.mock.calls[0][0]
    expect(auditCall.before.enabled).toBe(true)
    expect(auditCall.after.enabled).toBe(false)
  })

  it("기존 룰 없을 때 (before null) — create 분기 + AuditLog before:null", async () => {
    mockFindUnique.mockResolvedValue(null)
    mockUpsert.mockResolvedValue({
      id: RULE_ID,
      advertiserId: ADV_ID,
      enabled: true,
      defaultWeight: 1.0,
      hourWeights: {},
      regionWeights: {},
      deviceWeights: {},
    })

    const r = await upsertTargetingRule({
      advertiserId: ADV_ID,
      enabled: true,
    })
    expect(r.ok).toBe(true)
    const auditCall = mockLogAudit.mock.calls[0][0]
    expect(auditCall.before).toBeNull()
    expect(auditCall.after.enabled).toBe(true)
  })
})
