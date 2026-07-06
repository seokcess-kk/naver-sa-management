/**
 * lib/naver-sa/credentials.ts — resolve() 동작 + 인증 실패 알림 비발생 검증.
 *
 * 정책(단일 소스): 인증 실패 알림은 cron 프로브(evaluateApiAuthError)가 유일 소스.
 *   프로브가 getBizmoney 를 실호출하므로 decrypt 실패 + 라이브 401 을 모두 감지한다.
 *   credentials resolver 는 decrypt 실패를 그대로 throw 만 하고 자체 dispatch/적재를 하지
 *   않는다(이중 발생 방지). 본 테스트는 그 "비발생"을 회귀 가드로 고정한다.
 *
 * 외부 호출 0:
 *   - prisma.advertiser.findUnique / alertRule.findFirst / alertEvent.create mock
 *   - decrypt mock — throw 분기 시뮬레이션
 *   - dispatch / shouldThrottle mock (비호출 assert 용)
 *
 * 검증 범위:
 *   - decrypt 성공 → { apiKey, secretKey } 반환, dispatch/적재 미호출
 *   - decrypt throw → 그대로 전파, dispatch/적재 미호출 (프로브가 단일 소스)
 *   - advertiser 미존재 / 비활성 / 키 미입력 → 각각 throw
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockAdvertiserFindUnique = vi.fn()
const mockAlertRuleFindFirst = vi.fn()
const mockAlertEventCreate = vi.fn()
vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    advertiser: {
      findUnique: (...args: unknown[]) => mockAdvertiserFindUnique(...args),
    },
    alertRule: {
      findFirst: (...args: unknown[]) => mockAlertRuleFindFirst(...args),
    },
    alertEvent: {
      create: (...args: unknown[]) => mockAlertEventCreate(...args),
    },
  },
}))

const mockDecrypt = vi.fn()
vi.mock("@/lib/crypto/secret", () => ({
  decrypt: (...args: unknown[]) => mockDecrypt(...args),
}))

const mockDispatch = vi
  .fn()
  .mockResolvedValue({ ok: true, results: [{ channel: "log", ok: true }] })
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
  mockDispatch.mockResolvedValue({
    ok: true,
    results: [{ channel: "log", ok: true }],
  })
  // 기본: 광고주 매칭 api_auth_error 룰 없음 → AlertEvent 적재 skip (dispatch 만)
  mockAlertRuleFindFirst.mockResolvedValue(null)
  mockAlertEventCreate.mockResolvedValue({ id: "evt_1" })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("credentials resolve — 인증 실패 알림은 cron 프로브 단일 소스", () => {
  it("decrypt 성공 → creds 반환, dispatch/적재 미호출", async () => {
    mockDecrypt.mockReturnValue("plaintext")
    expect(holder.resolver).not.toBeNull()
    const r = await holder.resolver!("1234567")
    expect(r).toEqual({ apiKey: "plaintext", secretKey: "plaintext" })
    expect(mockDispatch).not.toHaveBeenCalled()
    expect(mockAlertEventCreate).not.toHaveBeenCalled()
  })

  it("decrypt throw → 그대로 전파, dispatch/적재 미호출 (이중 발생 방지)", async () => {
    mockDecrypt.mockImplementation(() => {
      throw new Error("decrypt: authentication failed")
    })
    await expect(holder.resolver!("1234567")).rejects.toThrow(
      /decrypt: authentication failed/u,
    )
    // credentials 는 알림을 발생시키지 않음 — 인증 실패 감지는 cron 프로브가 단일 소스.
    expect(mockDispatch).not.toHaveBeenCalled()
    expect(mockShouldThrottle).not.toHaveBeenCalled()
    expect(mockAlertRuleFindFirst).not.toHaveBeenCalled()
    expect(mockAlertEventCreate).not.toHaveBeenCalled()
  })

  it("advertiser 미존재 → throw, 알림 미발생", async () => {
    mockAdvertiserFindUnique.mockResolvedValue(null)
    await expect(holder.resolver!("1234567")).rejects.toThrow(
      /Advertiser not found/u,
    )
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it("advertiser 비활성 → throw", async () => {
    mockAdvertiserFindUnique.mockResolvedValue({ ...ADV, status: "paused" })
    await expect(holder.resolver!("1234567")).rejects.toThrow(/status=paused/u)
    expect(mockDecrypt).not.toHaveBeenCalled()
  })

  it("키 미입력(apiKeyEnc null) → throw, decrypt 미호출", async () => {
    mockAdvertiserFindUnique.mockResolvedValue({ ...ADV, apiKeyEnc: null })
    await expect(holder.resolver!("1234567")).rejects.toThrow(
      /Credentials not set/u,
    )
    expect(mockDecrypt).not.toHaveBeenCalled()
  })
})
