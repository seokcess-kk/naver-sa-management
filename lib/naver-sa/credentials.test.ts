/**
 * lib/naver-sa/credentials.ts — Event 4 (api_auth_failed) dispatch 검증.
 *
 * 외부 호출 0:
 *   - prisma.advertiser.findUnique mock
 *   - decrypt mock — throw 분기 시뮬레이션
 *   - dispatch / shouldThrottle mock
 *
 * 검증 범위:
 *   - decrypt throw → notifyApiAuthFailed 1회 호출 + throw 그대로 전파
 *   - throttle=true (이미 발송) → dispatch 미호출
 *   - decrypt 성공 시 dispatch 미호출 (정상 흐름)
 *   - dispatch payload 시크릿 평문 X (advertiserName / customerId 만)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockAdvertiserFindUnique = vi.fn()
vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    advertiser: {
      findUnique: (...args: unknown[]) => mockAdvertiserFindUnique(...args),
    },
  },
}))

const mockDecrypt = vi.fn()
vi.mock("@/lib/crypto/secret", () => ({
  decrypt: (...args: unknown[]) => mockDecrypt(...args),
}))

const mockDispatch = vi.fn().mockResolvedValue({ ok: true, results: [] })
vi.mock("@/lib/notifier", () => ({
  dispatch: (...args: unknown[]) => mockDispatch(...args),
}))

const mockShouldThrottle = vi.fn().mockResolvedValue(false)
vi.mock("@/lib/notifier/throttle", () => ({
  shouldThrottle: (...args: unknown[]) => mockShouldThrottle(...args),
}))

// client.ts setCredentialsResolver 는 side-effect 등록만. 본 테스트에서는 resolver 자체를
// 직접 호출하지 않고, side-effect 통해 등록된 resolver 를 testable하게 가져오기 위해
// setCredentialsResolver 를 mock 으로 캡처. vi.mock 은 hoist 되므로 holder 도 hoisted.
const holder = vi.hoisted(() => ({
  resolver: null as
    | ((customerId: string) => Promise<{ apiKey: string; secretKey: string }>)
    | null,
}))
vi.mock("@/lib/naver-sa/client", () => ({
  setCredentialsResolver: vi.fn(
    (fn: (c: string) => Promise<{ apiKey: string; secretKey: string }>) => {
      holder.resolver = fn
    },
  ),
}))

// import 시 setCredentialsResolver 호출 → holder.resolver 채워짐
import "@/lib/naver-sa/credentials"

const ADV = {
  id: "adv_1",
  name: "광고주1",
  customerId: "1234567",
  status: "active",
  apiKeyEnc: new Uint8Array([1, 2, 3]),
  apiKeyVersion: 1,
  secretKeyEnc: new Uint8Array([4, 5, 6]),
  secretKeyVersion: 1,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockShouldThrottle.mockResolvedValue(false)
  mockAdvertiserFindUnique.mockResolvedValue(ADV)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("credentials resolve — api_auth_failed dispatch", () => {
  it("decrypt 성공 → dispatch 미호출 (정상 흐름)", async () => {
    mockDecrypt.mockReturnValue("plaintext")
    expect(holder.resolver).not.toBeNull()
    const r = await holder.resolver!("1234567")
    expect(r).toEqual({ apiKey: "plaintext", secretKey: "plaintext" })
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it("decrypt throw → dispatch 1회 (critical / api_auth_failed) + throw 전파", async () => {
    mockDecrypt.mockImplementation(() => {
      throw new Error("decrypt: authentication failed")
    })
    await expect(holder.resolver!("1234567")).rejects.toThrow(
      /decrypt: authentication failed/u,
    )

    expect(mockShouldThrottle).toHaveBeenCalledWith(
      "nsa:notify:api_auth:1234567",
      60 * 60,
    )
    expect(mockDispatch).toHaveBeenCalledTimes(1)
    const payload = mockDispatch.mock.calls[0][0]
    expect(payload.ruleType).toBe("api_auth_failed")
    expect(payload.severity).toBe("critical")
    expect(payload.title).toContain("인증 실패")
    expect(payload.title).toContain("광고주1")
    expect(payload.title).toContain("1234567")
    expect(payload.body).toContain("ENCRYPTION_KEY 미스매치")
    expect(payload.meta.advertiserId).toBe("adv_1")
    expect(payload.meta.customerId).toBe("1234567")
    expect(payload.meta.advertiserName).toBe("광고주1")
    expect(payload.meta.failureType).toBe("decrypt")
  })

  it("throttle=true (이미 발송) → dispatch 미호출 + throw 는 전파", async () => {
    mockDecrypt.mockImplementation(() => {
      throw new Error("decrypt: authentication failed")
    })
    mockShouldThrottle.mockResolvedValue(true)
    await expect(holder.resolver!("1234567")).rejects.toThrow(
      /decrypt: authentication failed/u,
    )
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it("dispatch throw → resolve 자체는 원래 decrypt throw 만 전파 (알림 실패 격리)", async () => {
    mockDecrypt.mockImplementation(() => {
      throw new Error("decrypt: authentication failed")
    })
    mockDispatch.mockRejectedValueOnce(new Error("Telegram down"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(holder.resolver!("1234567")).rejects.toThrow(
      /decrypt: authentication failed/u,
    )
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("payload 시크릿 평문 노출 X", async () => {
    mockDecrypt.mockImplementation(() => {
      throw new Error("decrypt: authentication failed")
    })
    await expect(holder.resolver!("1234567")).rejects.toThrow()
    const payload = mockDispatch.mock.calls[0][0]
    const all = JSON.stringify(payload)
    expect(all).not.toMatch(/Bearer\s+[A-Za-z0-9._\-]{12,}/u)
    expect(all).not.toMatch(/[A-Fa-f0-9]{32,}/u)
    expect(all).not.toContain("ENCRYPTION_KEY=") // env=value 형태 X
    expect(all).not.toContain("apiKeyEnc")
    expect(all).not.toContain("secretKeyEnc")
  })
})
