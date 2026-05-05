/**
 * lib/naver-sa/adgroups.ts 의 Targets API 단위 테스트.
 *
 * 검증 범위 (F-2.2 PC/모바일 매체 ON/OFF):
 *   - listAdgroupTargets: GET /ncc/adgroups/{id}/targets — happy / Zod 실패
 *   - updateAdgroupTargets: PUT /ncc/adgroups/{id}?fields=... — happy / fields 기본값 / body shape
 *
 * 외부 호출 0:
 *   - naverSaClient.request mock — 호출 인자 기록 + 시퀀스 응답
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// =============================================================================
// naverSaClient mock
// =============================================================================

type ClientCall = {
  customerId: string
  method: string
  path: string
  body?: unknown
}
const clientCalls: ClientCall[] = []
let clientResponses: Array<unknown> = []
let clientCallIndex = 0

vi.mock("@/lib/naver-sa/client", () => ({
  naverSaClient: {
    request: vi.fn(
      async (args: {
        customerId: string
        method: string
        path: string
        body?: unknown
      }) => {
        clientCalls.push({
          customerId: args.customerId,
          method: args.method,
          path: args.path,
          body: args.body,
        })
        const r =
          clientResponses[Math.min(clientCallIndex, clientResponses.length - 1)]
        clientCallIndex++
        return r
      },
    ),
  },
}))

import {
  listAdgroupTargets,
  updateAdgroupTargets,
  type AdgroupTarget,
} from "./adgroups"
import { NaverSaValidationError } from "./errors"

beforeEach(() => {
  clientCalls.length = 0
  clientResponses = []
  clientCallIndex = 0
})

afterEach(() => {
  vi.clearAllMocks()
})

// =============================================================================
// 샘플 응답 (java sample 기준)
// =============================================================================

const SAMPLE_TARGETS: AdgroupTarget[] = [
  {
    targetTp: "PC_MOBILE_TARGET",
    target: { pc: true, mobile: true },
  },
  {
    targetTp: "TIME_WEEKLY_TARGET",
    target: { weeklySchedule: [] },
  },
  {
    targetTp: "REGIONAL_TARGET",
    target: { location: { KR: ["09"] } },
  },
]

// =============================================================================
// listAdgroupTargets
// =============================================================================

describe("listAdgroupTargets", () => {
  it("GET /ncc/adgroups/{id}/targets 호출 + 응답 파싱", async () => {
    clientResponses = [SAMPLE_TARGETS]
    const out = await listAdgroupTargets("12345", "grp-abc")
    expect(out).toEqual(SAMPLE_TARGETS)
    expect(clientCalls).toHaveLength(1)
    expect(clientCalls[0].method).toBe("GET")
    expect(clientCalls[0].path).toBe("/ncc/adgroups/grp-abc/targets")
    expect(clientCalls[0].customerId).toBe("12345")
  })

  it("nccAdgroupId URL 인코딩 (특수문자)", async () => {
    clientResponses = [[]]
    await listAdgroupTargets("c1", "grp/with space")
    expect(clientCalls[0].path).toBe("/ncc/adgroups/grp%2Fwith%20space/targets")
  })

  it("응답이 배열이 아니면 NaverSaValidationError", async () => {
    clientResponses = [{ not: "an array" }]
    await expect(listAdgroupTargets("c1", "grp-1")).rejects.toBeInstanceOf(
      NaverSaValidationError,
    )
  })

  it("element 에 targetTp 누락 → NaverSaValidationError", async () => {
    clientResponses = [[{ target: { pc: true } }]]
    await expect(listAdgroupTargets("c1", "grp-1")).rejects.toBeInstanceOf(
      NaverSaValidationError,
    )
  })

  it("passthrough — 정의 외 필드 보존", async () => {
    clientResponses = [
      [
        {
          targetTp: "PC_MOBILE_TARGET",
          target: { pc: true, mobile: false },
          nccTargetId: "tgt-9",
          regTm: "2026-01-01T00:00:00",
        },
      ],
    ]
    const out = await listAdgroupTargets("c1", "grp-1")
    expect(out[0].targetTp).toBe("PC_MOBILE_TARGET")
    expect((out[0] as { nccTargetId?: string }).nccTargetId).toBe("tgt-9")
  })
})

// =============================================================================
// updateAdgroupTargets
// =============================================================================

describe("updateAdgroupTargets", () => {
  it("PUT /ncc/adgroups/{id} body 에 nccAdgroupId + targets, fields 기본값 적용", async () => {
    // SA 응답 — 단건 광고그룹 (parseAdgroup 통과 위해 필수 필드 포함)
    clientResponses = [
      {
        nccAdgroupId: "grp-abc",
        nccCampaignId: "cmp-1",
        customerId: "12345",
        name: "Test",
      },
    ]
    const newTargets: AdgroupTarget[] = [
      {
        targetTp: "PC_MOBILE_TARGET",
        target: { pc: false, mobile: true },
      },
    ]
    await updateAdgroupTargets("12345", "grp-abc", newTargets)
    expect(clientCalls).toHaveLength(1)
    const c = clientCalls[0]
    expect(c.method).toBe("PUT")
    expect(c.path).toContain("/ncc/adgroups/grp-abc")
    expect(c.path).toContain("fields=targetLocation%2CtargetMedia%2CtargetTime")
    const body = c.body as { nccAdgroupId: string; targets: AdgroupTarget[] }
    expect(body.nccAdgroupId).toBe("grp-abc")
    expect(body.targets).toEqual(newTargets)
  })

  it("fields 인자 override 가능", async () => {
    clientResponses = [
      {
        nccAdgroupId: "g1",
        nccCampaignId: "c1",
        customerId: "1",
        name: "x",
      },
    ]
    await updateAdgroupTargets("1", "g1", [], "targetMedia")
    expect(clientCalls[0].path).toContain("fields=targetMedia")
  })

  it("응답 파싱 실패 → NaverSaValidationError (parseAdgroup)", async () => {
    clientResponses = [{ wrong: "shape" }]
    await expect(
      updateAdgroupTargets("1", "g1", []),
    ).rejects.toBeInstanceOf(NaverSaValidationError)
  })
})
