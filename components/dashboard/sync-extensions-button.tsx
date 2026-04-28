"use client"

/**
 * 확장소재 동기화 버튼 (F-5.1 / F-5.2)
 *
 * - 광고주의 모든 광고그룹 × 텍스트 type 2종(headline/description) 호출
 *   → SA listAdExtensions → DB upsert
 * - server action `syncAdExtensions(advertiserId, type?)` 호출
 *   응답: { ok: true; synced; scannedAdgroups; skipped; durationMs }
 *         | { ok: false; error: string }
 * - type 인자 없음 → 두 type 모두 동기화 (기본 동작)
 * - 키 미설정(`hasKeys=false`) → 비활성화 + 안내 tooltip
 * - pending 상태는 useTransition 으로 표시
 * - 결과 toast: "확장소재 N개 동기화 완료 (M개 그룹 / S건 스킵 / X.Xs)"
 *   · skipped 는 "광고그룹 매핑 누락 + 응답 type 불일치" 합산
 * - 성공 시 `router.refresh()` 로 RSC 재조회
 *
 * sync-ads-button / sync-keywords-button 동일 패턴.
 *
 * SPEC 6.2 F-5.1 / F-5.2.
 */

import * as React from "react"
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
  const [pending, startTransition] = React.useTransition()

  function handleClick() {
    if (!hasKeys) {
      toast.error("키 미설정 — API 키 / Secret 키를 먼저 입력하세요")
      return
    }
    startTransition(async () => {
      try {
        // type 인자 없이 호출 → headline + description 둘 다 동기화 (actions.ts 기본 동작).
        const res = await syncAdExtensions(advertiserId)
        if (res.ok) {
          const seconds = (res.durationMs / 1000).toFixed(1)
          const skippedNote =
            res.skipped > 0
              ? ` / ${res.skipped}건 스킵 (광고그룹 매핑 누락)`
              : ""
          toast.success(
            `확장소재 ${res.synced}개 동기화 완료 ` +
              `(${res.scannedAdgroups}개 그룹${skippedNote} / ${seconds}s)`,
          )
          router.refresh()
        } else {
          toast.error(`동기화 실패: ${res.error}`)
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        toast.error(`동기화 오류: ${msg}`)
      }
    })
  }

  return (
    <Button
      variant={variant}
      size={size}
      onClick={handleClick}
      disabled={pending || !hasKeys}
      title={!hasKeys ? "키 미설정 — 먼저 API 키 / Secret 키 입력" : undefined}
    >
      <RefreshCwIcon className={pending ? "animate-spin" : undefined} />
      {pending ? "동기화 중..." : "광고주에서 동기화"}
    </Button>
  )
}
