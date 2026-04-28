"use client"

/**
 * 키워드 동기화 버튼 (F-3.1)
 *
 * - 광고주의 모든 광고그룹을 순회하며 SA listKeywords → DB upsert
 * - server action `syncKeywords(advertiserId)` 호출
 *   응답: { ok: true; syncedKeywords; scannedAdgroups; skipped; durationMs }
 *         | { ok: false; error: string }
 * - 키 미설정 (`hasKeys=false`)이면 비활성화 + 안내 tooltip
 * - pending 상태는 useTransition 으로 표시
 * - 결과 toast: "키워드 N개 동기화 완료 (M개 그룹 / S건 스킵 / X.Xs)"
 *   · skipped 는 "광고그룹 매핑 누락 등으로 적재되지 않은 키워드 수" — 사용자 인지 필요
 * - 성공 시 `router.refresh()` 로 RSC 재조회
 *
 * sync-adgroups-button.tsx 와 동일 패턴.
 *
 * SPEC 6.2 F-3.1.
 */

import * as React from "react"
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
  const [pending, startTransition] = React.useTransition()

  function handleClick() {
    if (!hasKeys) {
      toast.error("키 미설정 — API 키 / Secret 키를 먼저 입력하세요")
      return
    }
    startTransition(async () => {
      try {
        const res = await syncKeywords(advertiserId)
        if (res.ok) {
          const seconds = (res.durationMs / 1000).toFixed(1)
          const skippedNote =
            res.skipped > 0
              ? ` / ${res.skipped}건 스킵 (광고그룹 매핑 누락)`
              : ""
          toast.success(
            `키워드 ${res.syncedKeywords}개 동기화 완료 ` +
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
