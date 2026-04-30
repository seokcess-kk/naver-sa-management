"use client"

/**
 * 키워드 동기화 버튼 (F-3.1)
 *
 * - 광고주의 모든 광고그룹을 순회하며 SA listKeywords → DB upsert
 * - server action `syncKeywords(advertiserId)` 호출
 *   응답: { ok: true; syncedKeywords; scannedAdgroups; skipped; durationMs }
 *         | { ok: false; error: string }
 * - 키 미설정 (`hasKeys=false`)이면 비활성화 + 안내 tooltip
 * - **toast.promise**로 wrap → 페이지 이동해도 RootLayout의 `<Toaster />`가
 *   unmount되지 않으므로 promise resolve 시 백그라운드 완료 토스트 표시.
 * - 결과 toast: "키워드 N개 동기화 완료 (M개 그룹 / S건 스킵 / X.Xs)"
 *   · skipped 는 "광고그룹 매핑 누락 등으로 적재되지 않은 키워드 수" — 사용자 인지 필요
 * - 성공 시 `router.refresh()` 로 RSC 재조회
 *
 * sync-adgroups-button.tsx 와 동일 패턴.
 *
 * SPEC 6.2 F-3.1.
 */

import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { syncKeywords } from "@/app/(dashboard)/[advertiserId]/keywords/actions"

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

  function handleClick() {
    if (!hasKeys) {
      toast.error("키 미설정 — API 키 / Secret 키를 먼저 입력하세요")
      return
    }
    toast.promise(
      (async () => {
        const res = await syncKeywords(advertiserId)
        if (!res.ok) throw new Error(res.error)
        return res
      })(),
      {
        loading: "키워드 동기화 중...",
        success: (res) => {
          const seconds = (res.durationMs / 1000).toFixed(1)
          const skippedNote =
            res.skipped > 0
              ? ` / ${res.skipped}건 스킵 (광고그룹 매핑 누락)`
              : ""
          router.refresh()
          return (
            `키워드 ${res.syncedKeywords}개 동기화 완료 ` +
            `(${res.scannedAdgroups}개 그룹${skippedNote} / ${seconds}s)`
          )
        },
        error: (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err)
          return `동기화 실패: ${msg}`
        },
      },
    )
  }

  return (
    <Button
      variant={variant}
      size={size}
      onClick={handleClick}
      disabled={!hasKeys}
      title={!hasKeys ? "키 미설정 — 먼저 API 키 / Secret 키 입력" : undefined}
    >
      <RefreshCwIcon />
      동기화
    </Button>
  )
}
