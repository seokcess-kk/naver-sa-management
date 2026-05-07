/**
 * batch.run cron — Event 2 (change_batch_failed) dispatch 검증.
 *
 * 외부 호출 0:
 *   - @/lib/db/prisma mock — $queryRaw / changeItem / changeBatch / advertiser / changeBatch.findUnique
 *   - applyChange mock (chunk 처리 자체는 본 테스트 범위 X)
 *   - dispatch / shouldThrottle mock — 페이로드 shape 검증만
 *
 * 검증 범위:
 *   - lease 획득 실패 (queryRaw 0건) → dispatch 미호출
 *   - finalize 분기 진입 + failedCount===0 → dispatch 미호출
 *   - finalize 분기 + failedCount>0 → dispatch 1회 (critical / topErrors / batchId)
 *   - dispatch payload 시크릿 평문 노출 X
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockQueryRaw = vi.fn()
const mockChangeItemFindMany = vi.fn()
const mockChangeItemUpdate = vi.fn()
const mockChangeItemCount = vi.fn()
const mockChangeBatchUpdate = vi.fn()
const mockChangeBatchFindUnique = vi.fn()
const mockAdvertiserFindUnique = vi.fn()
const mockApplyChange = vi.fn()

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
    changeItem: {
      findMany: (...args: unknown[]) => mockChangeItemFindMany(...args),
      update: (...args: unknown[]) => mockChangeItemUpdate(...args),
      count: (...args: unknown[]) => mockChangeItemCount(...args),
    },
    changeBatch: {
      update: (...args: unknown[]) => mockChangeBatchUpdate(...args),
      findUnique: (...args: unknown[]) => mockChangeBatchFindUnique(...args),
    },
    advertiser: {
      findUnique: (...args: unknown[]) => mockAdvertiserFindUnique(...args),
    },
  },
}))

vi.mock("@/lib/batch/apply", () => ({
  applyChange: (...args: unknown[]) => mockApplyChange(...args),
}))

const mockDispatch = vi.fn().mockResolvedValue({ ok: true, results: [] })
vi.mock("@/lib/notifier", () => ({
  dispatch: (...args: unknown[]) => mockDispatch(...args),
}))

vi.mock("@/lib/sync/last-sync-at", () => ({
  recordSyncAt: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}))

import { GET } from "@/app/api/batch/run/route"

function makeReq(authHeader: string | null): {
  headers: { get: (name: string) => string | null }
} {
  return {
    headers: {
      get: (name: string) => (name === "authorization" ? authHeader : null),
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = "test-secret"
})

afterEach(() => {
  delete process.env.CRON_SECRET
})

describe("batch.run — change_batch_failed dispatch", () => {
  it("lease 획득 실패 (queryRaw 0건) → dispatch 미호출", async () => {
    mockQueryRaw.mockResolvedValue([])
    const res = await GET(makeReq("Bearer test-secret") as never)
    expect(res.status).toBe(200)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it("finalize + failedCount===0 → dispatch 미호출 (성공 종료)", async () => {
    mockQueryRaw.mockResolvedValue([{ id: "batch_1" }])
    // 첫 chunk fetch → 빈 배열 (즉시 finalize 진입).
    mockChangeItemFindMany.mockResolvedValue([])
    // remaining = 0 / failed = 0
    mockChangeItemCount.mockImplementation(
      (args: { where: { status: string } }) => {
        if (args.where.status === "pending") return Promise.resolve(0)
        if (args.where.status === "failed") return Promise.resolve(0)
        return Promise.resolve(0)
      },
    )
    mockChangeBatchUpdate.mockResolvedValue({})
    // sync_keywords finalize hook 의 findUnique 응답 (action 다름 → no-op)
    mockChangeBatchFindUnique.mockResolvedValue({
      id: "batch_1",
      action: "keyword.csv",
      summary: null,
    })

    const res = await GET(makeReq("Bearer test-secret") as never)
    expect(res.status).toBe(200)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it("finalize + failedCount>0 → dispatch 1회 (critical / batchId / topErrors 그룹핑)", async () => {
    mockQueryRaw.mockResolvedValue([{ id: "batch_1" }])
    mockChangeItemFindMany.mockImplementation(
      (args: { where?: Record<string, unknown> }) => {
        // chunk loop 의 pending fetch — 빈 배열로 finalize 진입.
        if (args.where && (args.where as { status?: string }).status === "pending") {
          return Promise.resolve([])
        }
        // notifyChangeBatchFailed 의 failed 행 fetch — 에러 메시지 그룹핑용
        if (args.where && (args.where as { status?: string }).status === "failed") {
          return Promise.resolve([
            { error: "rate_limit" },
            { error: "rate_limit" },
            { error: "rate_limit" },
            { error: "validation_failed" },
            { error: null }, // → 'unknown_error'
          ])
        }
        return Promise.resolve([])
      },
    )
    mockChangeItemCount.mockImplementation(
      (args: { where: { status: string } }) => {
        if (args.where.status === "pending") return Promise.resolve(0)
        if (args.where.status === "failed") return Promise.resolve(5)
        return Promise.resolve(0)
      },
    )
    mockChangeBatchUpdate.mockResolvedValue({})
    // notifyChangeBatchFailed 가 batch.findUnique 1번 호출 (메타 로드)
    // + finalizeSyncKeywordsBatch 가 1번 호출 (action 다름 → no-op)
    mockChangeBatchFindUnique.mockResolvedValue({
      id: "batch_1",
      action: "keyword.csv",
      total: 100,
      attempt: 2,
      summary: { advertiserId: "adv_1" },
    })
    mockAdvertiserFindUnique.mockResolvedValue({ name: "광고주A" })

    const res = await GET(makeReq("Bearer test-secret") as never)
    expect(res.status).toBe(200)

    expect(mockDispatch).toHaveBeenCalledTimes(1)
    const payload = mockDispatch.mock.calls[0][0]
    expect(payload.ruleType).toBe("change_batch_failed")
    expect(payload.severity).toBe("critical")
    expect(payload.title).toContain("일괄 작업 실패")
    expect(payload.title).toContain("keyword.csv")
    expect(payload.title).toContain("5/100")
    expect(payload.body).toContain("batchId=batch_1")
    expect(payload.body).toContain("attempt=2")
    expect(payload.body).toContain("광고주A")

    expect(payload.meta.batchId).toBe("batch_1")
    expect(payload.meta.action).toBe("keyword.csv")
    expect(payload.meta.failedCount).toBe(5)
    expect(payload.meta.attempt).toBe(2)
    expect(payload.meta.advertiserId).toBe("adv_1")
    expect(payload.meta.topErrors).toEqual([
      "[3] rate_limit",
      expect.stringMatching(/\[1\] (validation_failed|unknown_error)/u),
      expect.stringMatching(/\[1\] (validation_failed|unknown_error)/u),
    ])
  })

  it("payload 에 시크릿 평문 노출 X (Bearer / 32+ hex / ENCRYPTION_KEY)", async () => {
    mockQueryRaw.mockResolvedValue([{ id: "batch_1" }])
    mockChangeItemFindMany.mockImplementation(
      (args: { where?: Record<string, unknown> }) => {
        if (args.where && (args.where as { status?: string }).status === "pending") {
          return Promise.resolve([])
        }
        if (args.where && (args.where as { status?: string }).status === "failed") {
          // 의도적으로 시크릿 패턴 포함 → scrubString 통과 확인
          return Promise.resolve([
            {
              error:
                "Authorization: Bearer abcdef1234567890ABCDEF, sig=" +
                "deadbeefcafebabe1234567890abcdef1234567890abcdef1234567890abcdef",
            },
          ])
        }
        return Promise.resolve([])
      },
    )
    mockChangeItemCount.mockImplementation(
      (args: { where: { status: string } }) => {
        if (args.where.status === "pending") return Promise.resolve(0)
        if (args.where.status === "failed") return Promise.resolve(1)
        return Promise.resolve(0)
      },
    )
    mockChangeBatchUpdate.mockResolvedValue({})
    mockChangeBatchFindUnique.mockResolvedValue({
      id: "batch_1",
      action: "keyword.csv",
      total: 1,
      attempt: 1,
      summary: null,
    })

    await GET(makeReq("Bearer test-secret") as never)
    expect(mockDispatch).toHaveBeenCalledTimes(1)
    const payload = mockDispatch.mock.calls[0][0]
    const all = JSON.stringify(payload)
    // scrubString 이 마스킹했어야 함
    expect(all).not.toMatch(/Bearer\s+[A-Za-z0-9._\-]{12,}/u)
    expect(all).not.toMatch(/[A-Fa-f0-9]{32,}/u)
    expect(all).toContain("[REDACTED]")
  })
})
