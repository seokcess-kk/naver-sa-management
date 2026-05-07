"use client"

/**
 * useSyncBatchPolling — 동기화 ChangeBatch 진행률 polling hook (F-3.1 / F-3.x sync)
 *
 * 배경:
 *   - 5분 동기 처리(maxDuration=300s)가 200 광고그룹 환경에서 timeout.
 *   - 백엔드는 광고그룹을 ChangeBatch 에 적재만 하고 batchId 즉시 반환.
 *   - Vercel Cron 이 매분 chunk 픽업 → SA listKeywords + DB upsert 처리 (SPEC 3.5 패턴).
 *   - UI 는 batchId 받은 직후 GET /api/batch/{id} 5초 간격 polling 으로 진행률 표시.
 *
 * 책임:
 *   - sync server action 결과(SyncBatchStartResult) 수신 후 분기:
 *       · ok=false              → toast.error
 *       · batchId=null,total=0  → toast.info ("동기화할 광고그룹이 없습니다")
 *       · batchId !== null      → toast.loading 시작 + polling 시작
 *   - polling 응답 받을 때마다 같은 toast id 로 in-place update (sonner 패턴)
 *   - 종료 상태(done/failed/canceled) 감지 시 결과 토스트로 교체 + onDone 콜백 호출
 *   - polling 중 페이지 이동 가능 — 본 hook 은 RootLayout 의 <Toaster /> 가 unmount 되지
 *     않는다는 전제 (sonner toast id 로 in-place update 자연 유지). hook unmount 시 timer
 *     cleanup + cancellation token 으로 stale polling 차단.
 *
 * sonner 사용 패턴:
 *   - `toast.loading(msg, { id: toastId })` 같은 id 재사용 → 진행률 텍스트만 갱신.
 *   - 종료 시 `toast.success(msg, { id: toastId })` 로 같은 토스트를 success 로 변환.
 *
 * 사용:
 *   ```tsx
 *   const { start, running } = useSyncBatchPolling({
 *     kind: "키워드",
 *     onDone: () => router.refresh(),
 *   })
 *
 *   const handleClick = async () => {
 *     const r = await syncKeywords(advertiserId)
 *     start(r)  // server action 반환 타입(SyncBatchStartResult)과 구조 호환
 *   }
 *   ```
 *
 * 광고그룹 / 소재 / 확장소재 sync 도 동일 패턴으로 이관 가능 — kind 라벨만 다름.
 * 다른 sync 의 result 타입은 `SyncBatchStartResult` 와 구조 호환되어야 함.
 *
 * SPEC v0.2.1 6.2 F-3.1 / 3.5 (Job Table + Chunk Executor).
 */

import * as React from "react"
import { toast } from "sonner"

// =============================================================================
// 타입
// =============================================================================

/**
 * 동기화 시작 결과 contract — server action 이 반환하는 형태.
 *
 * - `batchId === null && total === 0` : 동기화할 대상 없음 → 즉시 안내 + polling 생략.
 * - `batchId !== null`                 : ChangeBatch 적재 완료 → polling 시작.
 *
 * server action(syncKeywords 등) 의 반환 타입과 구조 호환 — 직접 전달 가능.
 */
export type SyncBatchStartResult =
  | {
      ok: true
      batchId: string | null
      total: number
      scope: "all" | "campaigns"
    }
  | { ok: false; error: string }

/** GET /api/batch/{id} 응답. summary 는 sync_keywords 의 경우 동기화 카운트 포함. */
type BatchProgressResponse = {
  batch: {
    id: string
    action: string
    status: string // "pending" | "running" | "done" | "failed" | "canceled"
    total: number
    processed: number
    attempt: number
    createdAt: string
    finishedAt: string | null
  }
  counts: Record<string, number>
  /**
   * sync_keywords action 의 finalize hook 이 채우는 요약.
   * 예) { advertiserId, syncedKeywords, scannedAdgroups, skipped }
   * 백엔드 PR 에서 추가됨 — 미존재 시 null 안전 처리.
   */
  summary?: Record<string, unknown> | null
}

type Kind = "키워드" | "광고그룹" | "광고" | "소재" | "확장소재" | "캠페인"

export type UseSyncBatchPollingOptions = {
  /** 토스트 메시지에 들어갈 라벨 (예: "키워드 동기화 진행 중..."). */
  kind: Kind
  /** 종료 토스트 후 호출. 보통 router.refresh — 실패/취소 케이스에도 호출. */
  onDone?: () => void
  /** 첫 polling 호출 지연 (ms). 기본 1500 — race condition 회피 (CSV 모달 패턴 참고). */
  initialDelayMs?: number
  /** polling 인터벌 (ms). 기본 5000. */
  intervalMs?: number
}

const DEFAULT_INITIAL_DELAY_MS = 1500
const DEFAULT_INTERVAL_MS = 5000

// =============================================================================
// 본체
// =============================================================================

export function useSyncBatchPolling(opts: UseSyncBatchPollingOptions) {
  const { kind, onDone } = opts
  const initialDelayMs = opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS

  const [running, setRunning] = React.useState(false)

  // cancellation token + timer 핸들 — polling 중 hook unmount 시 cleanup.
  // 컴포넌트 unmount 후 toast 만 유지(같은 id 로 다른 컴포넌트에서 update 가능)되도록
  // toast 자체는 dismiss 하지 않음 — 페이지 이동해도 토스트 유지가 UX 핵심.
  const cancelRef = React.useRef<{ cancelled: boolean } | null>(null)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const cleanup = React.useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (cancelRef.current) {
      cancelRef.current.cancelled = true
      cancelRef.current = null
    }
  }, [])

  React.useEffect(() => {
    return cleanup
  }, [cleanup])

  // -- 토스트 메시지 포맷 ----------------------------------------------------
  const fmtLoading = React.useCallback(
    (processed: number, total: number) => {
      // total 0 케이스는 분기 진입 전에 차단되지만 안전망 (NaN 회피).
      const denom = total > 0 ? total : 0
      return `${kind} 동기화 진행 중... (${processed}/${denom} 광고그룹)`
    },
    [kind],
  )

  const fmtDone = React.useCallback(
    (summary: Record<string, unknown> | null | undefined) => {
      const synced = pickNumber(summary, "syncedKeywords")
      const scanned = pickNumber(summary, "scannedAdgroups")
      const skipped = pickNumber(summary, "skipped")
      const skippedNote =
        skipped !== null && skipped > 0 ? ` / ${skipped}건 스킵` : ""
      // synced/scanned 둘 다 알 수 있는 경우만 상세 — 없으면 일반 완료 메시지.
      if (synced !== null && scanned !== null) {
        return (
          `${kind} ${synced}개 동기화 완료 ` +
          `(${scanned}개 그룹${skippedNote})`
        )
      }
      return `${kind} 동기화 완료`
    },
    [kind],
  )

  const fmtFailed = React.useCallback(
    (failedCount: number) => {
      if (failedCount > 0) {
        return `${kind} 동기화 실패: 광고그룹 ${failedCount}개 처리 실패`
      }
      return `${kind} 동기화 실패`
    },
    [kind],
  )

  // -- start: server action 결과 수신 → 분기 -------------------------------
  const start = React.useCallback(
    (result: SyncBatchStartResult) => {
      // 기존 polling 이 있으면 cleanup (사용자 더블 클릭 등).
      cleanup()

      if (!result.ok) {
        toast.error(`${kind} 동기화 실패: ${result.error}`)
        return
      }

      // 케이스 1: 동기화 대상 없음 — 안내 후 종료.
      // contract 상 batchId===null 은 total===0 케이스만 — 안전망으로 batchId===null
      // 전체를 "대상 없음" 으로 처리.
      if (result.batchId === null) {
        toast.info(
          `동기화할 ${kind === "키워드" ? "광고그룹" : "대상"}이 없습니다`,
        )
        return
      }

      // 케이스 2: ChangeBatch 적재 완료 — polling 시작.
      const batchId = result.batchId
      const total = result.total
      const toastId = `sync-batch-${batchId}` as const

      setRunning(true)
      toast.loading(fmtLoading(0, total), { id: toastId })

      const cancelToken = { cancelled: false }
      cancelRef.current = cancelToken

      const finishToast = (
        kindFn: "success" | "error" | "warning",
        msg: string,
      ) => {
        // sonner 의 toast.success/error/warning 은 같은 id 의 loading 토스트를 교체.
        if (kindFn === "success") toast.success(msg, { id: toastId })
        else if (kindFn === "error") toast.error(msg, { id: toastId })
        else toast.warning(msg, { id: toastId })
      }

      const poll = async () => {
        if (cancelToken.cancelled) return
        try {
          const res = await fetch(`/api/batch/${batchId}`, {
            credentials: "include",
            cache: "no-store",
          })
          if (cancelToken.cancelled) return

          // 401/403 — 재시도 무의미. 토스트 종료.
          if (res.status === 401 || res.status === 403) {
            finishToast(
              "error",
              `${kind} 동기화 진행률 조회 권한 없음 (HTTP ${res.status})`,
            )
            setRunning(false)
            return
          }
          // 그 외 4xx/5xx — 일시 오류로 간주, 다음 polling 으로 재시도.
          if (!res.ok) {
            timerRef.current = setTimeout(poll, intervalMs)
            return
          }

          const data = (await res.json()) as BatchProgressResponse
          if (cancelToken.cancelled) return

          const counts = data.counts ?? {}
          const done = counts.done ?? 0
          const failed = counts.failed ?? 0
          const processed = done + failed
          const status = data.batch.status

          // in-place update — 진행률 갱신.
          toast.loading(fmtLoading(processed, total), { id: toastId })

          if (status === "done") {
            finishToast("success", fmtDone(data.summary ?? null))
            setRunning(false)
            onDone?.()
            return
          }
          if (status === "failed") {
            finishToast("error", fmtFailed(failed))
            setRunning(false)
            // 실패도 상태 RSC 재조회는 가치 있음 (부분 적재).
            onDone?.()
            return
          }
          if (status === "canceled") {
            finishToast("warning", `${kind} 동기화 취소됨`)
            setRunning(false)
            onDone?.()
            return
          }

          // 진행 중 — 다음 polling 예약.
          timerRef.current = setTimeout(poll, intervalMs)
        } catch (e) {
          if (cancelToken.cancelled) return
          // 네트워크 일시 오류 — 다음 polling 으로 재시도. 콘솔 로그만.
          console.warn(`[useSyncBatchPolling] poll error:`, e)
          timerRef.current = setTimeout(poll, intervalMs)
        }
      }

      // 첫 호출은 짧은 지연 (백엔드 적재 직후 race condition 회피).
      timerRef.current = setTimeout(poll, initialDelayMs)
    },
    [cleanup, kind, onDone, fmtLoading, fmtDone, fmtFailed, initialDelayMs, intervalMs],
  )

  return { start, running }
}

// =============================================================================
// 보조
// =============================================================================

function pickNumber(
  summary: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  if (!summary) return null
  const v = summary[key]
  if (typeof v === "number" && Number.isFinite(v)) return v
  return null
}
