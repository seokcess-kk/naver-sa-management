"use client"

/**
 * 캠페인 동기화 버튼 (F-2.1)
 *
 * - 네이버 SA `/ncc/campaigns` 호출 → 광고주의 캠페인 메타를 DB로 upsert
 * - server action `syncCampaigns(advertiserId)` 호출
 *   - 응답: { ok: true; synced: number; durationMs: number }
 *           | { ok: false; error: string }
 * - 키 미설정 (`hasKeys=false`)이면 비활성화 + 안내 tooltip
 * - **toast.promise**로 wrap → 페이지 이동해도 RootLayout의 `<Toaster />`가
 *   unmount되지 않으므로 promise resolve 시 백그라운드 완료 토스트 표시.
 *   pending state는 보유하지 않음 (사용자가 다른 페이지로 이동하면 컴포넌트
 *   자체가 unmount → 굳이 unmount-after-setState 경고 회피 코드 불필요).
 * - 결과 toast: "캠페인 N개 동기화 완료 (X.Xs)"
 * - 성공 시 `router.refresh()` 로 RSC 재조회
 *
 * 재사용: 캠페인 목록 / 광고그룹 / 키워드 상세 등에서 호출 가능.
 *
 * SPEC 6.2 F-2.1.
 */

import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { syncCampaigns } from "@/app/(dashboard)/[advertiserId]/campaigns/actions"

type Variant = "default" | "outline" | "secondary" | "ghost"
type Size = "default" | "sm" | "lg"

export function SyncCampaignsButton({
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
    // toast.promise — Toaster는 RootLayout에 mount되어 있어 페이지 이동해도
    // promise resolve 시 토스트가 표시된다. router.refresh는 success 콜백
    // 안에서 실행 (실패 시 무의미한 재조회 방지).
    toast.promise(
      (async () => {
        const res = await syncCampaigns(advertiserId)
        if (!res.ok) throw new Error(res.error)
        return res
      })(),
      {
        loading: "캠페인 동기화 중...",
        success: (res) => {
          const seconds = (res.durationMs / 1000).toFixed(1)
          router.refresh()
          return `캠페인 ${res.synced}개 동기화 완료 (${seconds}s)`
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
