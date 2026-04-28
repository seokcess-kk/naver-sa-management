/**
 * 검수 상태 배지 (F-3.1, F-4.x 재사용 예정)
 *
 * Keyword / Ad / AdExtension 공통 InspectStatus enum 표시.
 *
 * 표시 규칙 (prisma enum: pending / approved / rejected):
 *   - approved → "승인" (emerald)
 *   - rejected → "거절" (destructive)
 *   - pending  → "검수중" (amber)
 *
 * 순수 표현 컴포넌트. RSC / 클라이언트 양쪽에서 사용 가능.
 *
 * SPEC 6.2 F-3.1.
 */

import type { InspectStatus } from "@/lib/generated/prisma/client"

export function InspectStatusBadge({ status }: { status: InspectStatus }) {
  if (status === "approved") {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
        승인
      </span>
    )
  }
  if (status === "rejected") {
    return (
      <span className="inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
        거절
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
      검수중
    </span>
  )
}
