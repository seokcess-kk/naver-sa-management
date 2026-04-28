/**
 * 캠페인 상태 배지 (F-2.1)
 *
 * 표시 규칙:
 *   - userLock=true                 → "OFF"      (회색)  — 사용자가 명시적으로 OFF
 *   - userLock=false + status=on    → "ON"       (emerald)
 *   - status=off                    → "일시중지"  (amber)
 *   - status=deleted                → "삭제됨"   (destructive — 보통 표시 안 함)
 *
 * 순수 표현 컴포넌트. RSC / 클라이언트 양쪽에서 사용 가능.
 *
 * SPEC 6.2 F-2.1.
 */

import type { CampaignStatus } from "@/lib/generated/prisma/client"

export function CampaignStatusBadge({
  status,
  userLock,
}: {
  status: CampaignStatus
  userLock: boolean
}) {
  if (status === "deleted") {
    return (
      <span className="inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
        삭제됨
      </span>
    )
  }
  if (userLock) {
    return (
      <span className="inline-flex items-center rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
        OFF
      </span>
    )
  }
  if (status === "off") {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
        일시중지
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
      ON
    </span>
  )
}
