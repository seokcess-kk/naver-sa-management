/**
 * F-11.6 Kill Switch toggle Server Action 단위 테스트
 *
 * 검증 범위 (toggleBiddingKillSwitch 만 — 본 PR 범위):
 *   - admin 만 토글 가능 (assertRole("admin") throw → 본 액션은 throw 그대로 전파)
 *   - 존재하지 않는 광고주: ok:false
 *   - status='archived' 광고주: ok:false
 *   - 정상 토글 ON  : biddingKillSwitch=true / At=now / By=user.id 갱신
 *   - 정상 토글 OFF : biddingKillSwitch=false / At=now (재개도 At 갱신) / By=user.id 갱신
 *   - AuditLog: action='advertiser.kill_switch_toggle' / before/after enabled / at / by
 *   - revalidatePath: admin + 광고주 컨텍스트 + 정책 페이지
 *
 * 외부 호출 0:
 *   - vi.mock("@/lib/auth/access", ...) — assertRole stub (UserProfile 형 반환)
 *   - vi.mock("@/lib/db/prisma", ...)   — advertiser.findUnique / update stub
 *   - vi.mock("@/lib/audit/log", ...)   — logAudit stub
 *   - vi.mock("next/cache", ...)        — revalidatePath stub
 *   - vi.mock("@/lib/naver-sa/credentials", ...) — side-effect import 차단 (모듈 import 시점)
 *   - vi.mock("@/lib/naver-sa/billing", ...)     — getBizmoney 호출 X (testConnection 비대상)
 *
 * 본 PR 비대상: registerAdvertiser / updateAdvertiser / deleteAdvertiser /
 *               testConnection / registerAdvertisersBulk — 별도 테스트로 분리.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// =============================================================================
// Mocks (전역 — import 전에 hoist 됨)
// =============================================================================

const mockAssertRole = vi.fn()

vi.mock("@/lib/auth/access", () => ({
  assertRole: (...args: unknown[]) => mockAssertRole(...args),
}))

const mockAdvertiserFindUnique = vi.fn()
const mockAdvertiserUpdate = vi.fn()
// 다른 액션들이 import 시점에 의존할 수 있는 prisma 메서드들 stub (호출 X)
const mockAdvertiserCreate = vi.fn()
const mockAdvertiserFindMany = vi.fn()
const mockAdvertiserCreateMany = vi.fn()

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    advertiser: {
      findUnique: (...args: unknown[]) => mockAdvertiserFindUnique(...args),
      update: (...args: unknown[]) => mockAdvertiserUpdate(...args),
      create: (...args: unknown[]) => mockAdvertiserCreate(...args),
      findMany: (...args: unknown[]) => mockAdvertiserFindMany(...args),
      createMany: (...args: unknown[]) => mockAdvertiserCreateMany(...args),
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

// credentials side-effect import 차단 (no-op 모듈로 대체)
vi.mock("@/lib/naver-sa/credentials", () => ({}))

// billing 은 testConnection 만 사용. 본 테스트 비대상이지만 import 시점 의존 회피.
vi.mock("@/lib/naver-sa/billing", () => ({
  getBizmoney: vi.fn(),
}))

// crypto encrypt 도 다른 액션 import 시 의존 — toggleBiddingKillSwitch 비호출이지만 안전 stub
vi.mock("@/lib/crypto/secret", () => ({
  encrypt: vi.fn(() => ({ enc: new Uint8Array([1, 2, 3]), version: 1 })),
}))

// import 본체 — mock 등록 이후
import { toggleBiddingKillSwitch } from "@/app/admin/advertisers/actions"

// =============================================================================
// 공통 setup
// =============================================================================

const ADV_ID = "adv_1"
const ADMIN_ID = "u_admin"

beforeEach(() => {
  vi.clearAllMocks()
  // 기본: admin 권한
  mockAssertRole.mockResolvedValue({
    id: ADMIN_ID,
    role: "admin",
    status: "active",
    displayName: "Admin",
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

// =============================================================================
// toggleBiddingKillSwitch
// =============================================================================

describe("toggleBiddingKillSwitch", () => {
  it("admin 외 권한은 assertRole 이 throw — 그대로 전파", async () => {
    mockAssertRole.mockRejectedValueOnce(new Error("권한 부족"))
    await expect(
      toggleBiddingKillSwitch({ advertiserId: ADV_ID, enabled: true }),
    ).rejects.toThrow(/권한 부족/u)
    expect(mockAdvertiserUpdate).not.toHaveBeenCalled()
  })

  it("입력 검증 실패 (빈 advertiserId)", async () => {
    const r = await toggleBiddingKillSwitch({ advertiserId: "", enabled: true })
    expect(r.ok).toBe(false)
    expect(mockAdvertiserUpdate).not.toHaveBeenCalled()
  })

  it("존재하지 않는 광고주 — ok:false", async () => {
    mockAdvertiserFindUnique.mockResolvedValue(null)
    const r = await toggleBiddingKillSwitch({
      advertiserId: ADV_ID,
      enabled: true,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/존재하지 않는/u)
    expect(mockAdvertiserUpdate).not.toHaveBeenCalled()
  })

  it("archived 광고주 — ok:false", async () => {
    mockAdvertiserFindUnique.mockResolvedValue({
      id: ADV_ID,
      status: "archived",
      biddingKillSwitch: false,
      biddingKillSwitchAt: null,
      biddingKillSwitchBy: null,
    })
    const r = await toggleBiddingKillSwitch({
      advertiserId: ADV_ID,
      enabled: true,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/아카이브/u)
    expect(mockAdvertiserUpdate).not.toHaveBeenCalled()
  })

  it("정지 (enabled=true) — At/By 갱신 + AuditLog before=false / after=true", async () => {
    mockAdvertiserFindUnique.mockResolvedValue({
      id: ADV_ID,
      status: "active",
      biddingKillSwitch: false,
      biddingKillSwitchAt: null,
      biddingKillSwitchBy: null,
    })
    mockAdvertiserUpdate.mockResolvedValue({})

    const r = await toggleBiddingKillSwitch({
      advertiserId: ADV_ID,
      enabled: true,
    })

    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.enabled).toBe(true)
      expect(r.by).toBe(ADMIN_ID)
      // ISO timestamp string
      expect(typeof r.at).toBe("string")
      expect(() => new Date(r.at)).not.toThrow()
    }

    expect(mockAdvertiserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ADV_ID },
        data: expect.objectContaining({
          biddingKillSwitch: true,
          biddingKillSwitchBy: ADMIN_ID,
        }),
      }),
    )
    // At 가 Date 인지 확인
    const updateData = mockAdvertiserUpdate.mock.calls[0][0].data
    expect(updateData.biddingKillSwitchAt).toBeInstanceOf(Date)

    const auditCall = mockLogAudit.mock.calls[0][0]
    expect(auditCall.action).toBe("advertiser.kill_switch_toggle")
    expect(auditCall.targetType).toBe("Advertiser")
    expect(auditCall.targetId).toBe(ADV_ID)
    expect(auditCall.before).toEqual({
      enabled: false,
      at: null,
      by: null,
    })
    expect(auditCall.after.enabled).toBe(true)
    expect(auditCall.after.by).toBe(ADMIN_ID)
    expect(typeof auditCall.after.at).toBe("string")
  })

  it("재개 (enabled=false) — At 도 갱신 (마지막 토글 시각) + before 이전값 정확", async () => {
    const prevAt = new Date("2026-04-29T01:00:00.000Z")
    mockAdvertiserFindUnique.mockResolvedValue({
      id: ADV_ID,
      status: "active",
      biddingKillSwitch: true,
      biddingKillSwitchAt: prevAt,
      biddingKillSwitchBy: "u_prev",
    })
    mockAdvertiserUpdate.mockResolvedValue({})

    const r = await toggleBiddingKillSwitch({
      advertiserId: ADV_ID,
      enabled: false,
    })

    expect(r.ok).toBe(true)

    expect(mockAdvertiserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          biddingKillSwitch: false,
          biddingKillSwitchBy: ADMIN_ID,
        }),
      }),
    )
    // 재개도 At 갱신
    const updateData = mockAdvertiserUpdate.mock.calls[0][0].data
    expect(updateData.biddingKillSwitchAt).toBeInstanceOf(Date)
    expect(updateData.biddingKillSwitchAt.getTime()).toBeGreaterThan(
      prevAt.getTime(),
    )

    const auditCall = mockLogAudit.mock.calls[0][0]
    expect(auditCall.before).toEqual({
      enabled: true,
      at: prevAt.toISOString(),
      by: "u_prev",
    })
    expect(auditCall.after.enabled).toBe(false)
    expect(auditCall.after.by).toBe(ADMIN_ID)
  })

  it("revalidatePath: admin 상세 + 광고주 컨텍스트 + 정책 페이지", async () => {
    mockAdvertiserFindUnique.mockResolvedValue({
      id: ADV_ID,
      status: "active",
      biddingKillSwitch: false,
      biddingKillSwitchAt: null,
      biddingKillSwitchBy: null,
    })
    mockAdvertiserUpdate.mockResolvedValue({})

    await toggleBiddingKillSwitch({
      advertiserId: ADV_ID,
      enabled: true,
    })

    const calls = mockRevalidatePath.mock.calls.map((c) => c[0])
    expect(calls).toContain(`/admin/advertisers/${ADV_ID}`)
    expect(calls).toContain(`/${ADV_ID}`)
    expect(calls).toContain(`/${ADV_ID}/bidding-policies`)
  })
})
