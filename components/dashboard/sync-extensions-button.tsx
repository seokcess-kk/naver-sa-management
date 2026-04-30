"use client"

/**
 * 확장소재 동기화 버튼 (F-5.1 / F-5.2)
 *
 * - 광고주의 모든 광고그룹 × 텍스트 type 2종(headline/description) + image 호출
 *   → SA listAdExtensions → DB upsert
 * - server action `syncAdExtensions(advertiserId, options?)` 호출
 *   options: { type?: InputType; campaignIds?: string[] }
 *   응답: { ok: true; synced; scannedAdgroups; skipped; unsupportedAdgroupTypes; durationMs }
 *         | { ok: false; error: string }
 * - 옵션 미지정 → 모든 광고그룹 × 모든 type 동기화 (기본 동작)
 * - 키 미설정(`hasKeys=false`) → 비활성화 + 안내 tooltip
 * - **toast.promise**로 wrap → 페이지 이동해도 RootLayout의 `<Toaster />`가
 *   unmount되지 않으므로 promise resolve 시 백그라운드 완료 토스트 표시.
 * - 결과 toast: "확장소재 N개 동기화 완료 (M개 그룹 / S건 스킵 / U개 미지원 / X.Xs)"
 *   · skipped 는 "광고그룹 매핑 누락 + 응답 type 불일치" 합산
 *   · unsupportedAdgroupTypes 는 "Cannot handle the request" silent skip 카운트
 * - 성공 시 `router.refresh()` 로 RSC 재조회
 *
 * sync-ads-button / sync-keywords-button 동일 패턴.
 *
 * SPEC 6.2 F-5.1 / F-5.2.
 */

import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { syncAdExtensions } from "@/app/(dashboard)/[advertiserId]/extensions/actions"

type Variant = "default" | "outline" | "secondary" | "ghost"
type Size = "default" | "sm" | "lg"

export function SyncExtensionsButton({
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
        // options 미지정 → 모든 광고그룹 × 모든 type 동기화 (actions.ts 기본 동작).
        const res = await syncAdExtensions(advertiserId)
        if (!res.ok) throw new Error(res.error)
        return res
      })(),
      {
        loading: "확장소재 동기화 중...",
        success: (res) => {
          const seconds = (res.durationMs / 1000).toFixed(1)
          const skippedNote =
            res.skipped > 0
              ? ` / ${res.skipped}건 스킵 (광고그룹 매핑 누락)`
              : ""
          const unsupportedNote =
            res.unsupportedAdgroupTypes > 0
              ? ` / ${res.unsupportedAdgroupTypes}건 미지원 type 스킵`
              : ""
          router.refresh()
          return (
            `확장소재 ${res.synced}개 동기화 완료 ` +
            `(${res.scannedAdgroups}개 그룹${skippedNote}${unsupportedNote} / ${seconds}s)`
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
