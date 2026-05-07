"use client"

/**
 * 키워드 동기화 버튼 (F-3.1) — ChangeBatch 진행률 polling 패턴
 *
 * 흐름:
 *   1. 클릭 → `syncKeywords(advertiserId)` server action 호출
 *   2. 결과를 `useSyncBatchPolling.start(result)` 에 전달:
 *        - ok=false              → toast.error
 *        - batchId=null,total=0  → toast.info ("동기화할 광고그룹이 없습니다")
 *        - batchId !== null      → toast.loading + GET /api/batch/{id} 5초 polling 시작
 *   3. polling 응답 받을 때마다 같은 toast id 로 in-place update
 *   4. 종료 시 결과 토스트 + router.refresh
 *
 * 페이지 이동해도 RootLayout `<Toaster />` 가 unmount 되지 않으므로 polling 진행 중에도
 * toast 가 유지됨 — hook 이 cleanup 처리.
 *
 * polling 로직은 `useSyncBatchPolling` 으로 추출 — sync-keywords-with-filter.tsx 와 공유.
 * 광고그룹 / 소재 / 확장소재 sync 도 동일 hook 으로 이관 가능 (kind 라벨만 다름).
 *
 * SPEC v0.2.1 6.2 F-3.1 / 3.5 (Job Table + Chunk Executor).
 */

import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { syncKeywords } from "@/app/(dashboard)/[advertiserId]/keywords/actions"
import { useSyncBatchPolling } from "@/lib/sync/use-batch-polling"

type Variant = "default" | "outline" | "secondary" | "ghost"
type Size = "default" | "sm" | "lg"

export function SyncKeywordsButton({
  advertiserId,
  hasKeys,
  variant = "outline",
  size = "sm",
}: {
  advertiserId: string
  hasKeys: boolean
  variant?: Variant
  size?: Size
}) {
  const router = useRouter()
  const { start, running } = useSyncBatchPolling({
    kind: "키워드",
    onDone: () => router.refresh(),
  })

  async function handleClick() {
    if (!hasKeys) {
      toast.error("키 미설정 — API 키 / Secret 키를 먼저 입력하세요")
      return
    }
    if (running) return

    try {
      const res = await syncKeywords(advertiserId)
      start(res)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`키워드 동기화 실패: ${msg}`)
    }
  }

  return (
    <Button
      variant={variant}
      size={size}
      onClick={handleClick}
      disabled={!hasKeys || running}
      title={!hasKeys ? "키 미설정 — 먼저 API 키 / Secret 키 입력" : undefined}
    >
      <RefreshCwIcon />
      동기화
    </Button>
  )
}
