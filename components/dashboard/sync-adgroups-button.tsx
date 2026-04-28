"use client"

/**
 * 광고그룹 동기화 버튼 (F-2.2)
 *
 * - 네이버 SA `/ncc/adgroups` 호출 → 광고주의 광고그룹 메타를 DB로 upsert
 * - server action `syncAdgroups(advertiserId)` 호출
 *   - 응답: { ok: true; synced: number; skipped: number; durationMs: number }
 *           | { ok: false; error: string }
 * - 키 미설정 (`hasKeys=false`)이면 비활성화 + 안내 tooltip
 * - pending 상태는 useTransition 으로 표시
 * - 결과 toast: "광고그룹 N개 동기화 완료 (M건 스킵, X.Xs)"
 *   · skipped 는 "캠페인 미동기화 등으로 매핑 실패한 광고그룹 수" — 사용자 인지 필요
 * - 성공 시 `router.refresh()` 로 RSC 재조회
 *
 * sync-campaigns-button.tsx 와 동일 패턴 (skipped 카운트만 추가).
 *
 * SPEC 6.2 F-2.2.
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { syncAdgroups } from "@/app/(dashboard)/[advertiserId]/adgroups/actions"

type Variant = "default" | "outline" | "secondary" | "ghost"
type Size = "default" | "sm" | "lg"

export function SyncAdgroupsButton({
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
        const res = await syncAdgroups(advertiserId)
        if (res.ok) {
          const seconds = (res.durationMs / 1000).toFixed(1)
          const skippedNote =
            res.skipped > 0
              ? ` (${res.skipped}건 스킵 — 캠페인 미동기화)`
              : ""
          toast.success(
            `광고그룹 ${res.synced}개 동기화 완료${skippedNote} (${seconds}s)`,
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
