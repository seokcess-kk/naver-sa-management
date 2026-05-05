/**
 * Sync 단계 공통 동시성 / 측정 헬퍼.
 *
 * 책임:
 *   - 광고그룹 chunk 크기를 env 로 운영 튜닝 (기본 5)
 *   - chunk 내부 DB upsert 병렬화 한도 상수 (UPSERT_CONCURRENCY)
 *   - 측정 가능한 mapWithConcurrency 헬퍼 — Promise.all 동시 실행 한도
 *
 * 배경 (BACKLOG: 동기화 시간 한계):
 *   - keywords / ads / extensions sync 모두 광고그룹 N개를 chunk 5 병렬 list API + sequential upsert.
 *   - 진짜 병목은 5천 row sequential upsert (~150초 추정).
 *   - 1차 개선: chunk 내부 upsert 도 병렬화 (connection pool 보호 한도 내).
 *   - 2차 개선: 운영 측정 후 ChangeBatch + Chunk Executor (SPEC 3.5) 이관 (운영 측정값이
 *     maxDuration 80% 초과 시 트리거).
 *
 * Connection pool 안전선:
 *   - Supabase Postgres Pooler 기본 15 conn / 광고주.
 *   - UPSERT_CONCURRENCY=10 + 광고주 1 sync 가 prisma 자체 connection limit (10) 내.
 *   - 동시 광고주 sync 는 cron 컨텍스트라 직렬 — pool 압박 X.
 */

/** 광고그룹 chunk 크기 — list API 병렬 호출 단위. env 우선, fallback 5. clamp [1, 20]. */
export function getAdgroupChunkSize(): number {
  const raw = process.env.SYNC_ADGROUP_CHUNK_SIZE
  if (!raw) return 5
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return 5
  return Math.min(20, Math.max(1, n))
}

/**
 * Chunk 내부 DB upsert 병렬화 한도.
 *
 * 5천 행 sequential upsert(~150s) → UPSERT_CONCURRENCY=10 병렬(~15s) 약 10배 단축.
 * 더 큰 값은 Supabase pool exhaust 위험 — 측정 후 조정.
 */
export const UPSERT_CONCURRENCY = 10

/**
 * Promise.all 동시 실행 한도 헬퍼 — `limit` 만큼 worker 가 큐에서 꺼내 실행.
 *
 * Promise.allSettled 의 simple chunked 변형 — 결과 순서는 입력 순서 유지.
 * 단일 fn 실패가 전체를 멈추지 않도록 호출부가 try/catch 내부 처리하거나,
 * 본 헬퍼가 결과 객체에 ok/error 환원.
 *
 * 사용:
 *   const results = await mapWithConcurrency(items, 10, async (item) => {
 *     try { await prisma.x.upsert(...); return { ok: true } }
 *     catch (e) { return { ok: false, error: ... } }
 *   })
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const safeLimit = Math.max(1, Math.min(limit, items.length))
  const results: R[] = new Array(items.length)
  let cursor = 0

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }

  await Promise.all(Array.from({ length: safeLimit }, () => worker()))
  return results
}

/** Sync 종료 시점 1줄 측정 로그 — 운영 추세 파악용. */
export function logSyncTiming(args: {
  kind: "keywords" | "ads" | "extensions" | "all"
  advertiserId: string
  totalMs: number
  scannedAdgroups: number
  upserts: number
  /** maxDuration 80% 초과 → trigger. cron 환경별 다름 (Server Action 300s / Cron 900s 등). */
  maxDurationMs?: number
}): void {
  const { kind, advertiserId, totalMs, scannedAdgroups, upserts, maxDurationMs } =
    args
  const triggerStr =
    maxDurationMs !== undefined && totalMs > maxDurationMs * 0.8
      ? ` ⚠ approaching maxDuration (${Math.round((totalMs / maxDurationMs) * 100)}%)`
      : ""
  console.info(
    `[sync.${kind}] advertiserId=${advertiserId} adgroups=${scannedAdgroups} upserts=${upserts} totalMs=${totalMs}${triggerStr}`,
  )
}
