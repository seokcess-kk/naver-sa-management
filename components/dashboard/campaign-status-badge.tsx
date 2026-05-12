/**
 * 캠페인 상태 배지 (F-2.1)
 *
 * 표시 규칙:
 *   - userLock=true                 → "OFF"      (회색)  — 사용자가 명시적으로 OFF
 *   - userLock=false + status=on    → "ON"       (emerald)
 *   - status=off                    → "일시중지"  (amber)
 *   - status=deleted                → "삭제됨"   (destructive — 보통 표시 안 함)
 *
 * 추가:
 *   - statusReason — 네이버 SA API 응답의 OFF 사유 ("그룹 OFF", "캠페인 예산 도달" 등).
 *     ON 상태 외 + 사유 존재 시 배지 옆 muted 인라인 텍스트로 표시.
 *
 * 순수 표현 컴포넌트. RSC / 클라이언트 양쪽에서 사용 가능.
 *
 * SPEC 6.2 F-2.1.
 */

import type { CampaignStatus } from "@/lib/generated/prisma/client"
import { formatStatusReason } from "@/lib/dashboard/status-reason-labels"

export function CampaignStatusBadge({
  status,
  userLock,
  statusReason,
}: {
  status: CampaignStatus
  userLock: boolean
  statusReason?: string | null
}) {
  let badge: React.ReactNode
  if (status === "deleted") {
    badge = (
      <span className="inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
        삭제됨
      </span>
    )
  } else if (userLock) {
    badge = (
      <span className="inline-flex items-center rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
        OFF
      </span>
    )
  } else if (status === "off") {
    badge = (
      <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
        일시중지
      </span>
    )
  } else {
    badge = (
      <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
        ON
      </span>
    )
  }

  // OFF 계열 + 사유 존재 시 배지 옆 muted 텍스트 (영문 코드 → 한글 라벨 변환).
  // ON / 사유 없음 → 배지만 단독 표시.
  const reasonLabel = formatStatusReason(statusReason)
  const showReason =
    !!reasonLabel && (status === "off" || userLock || status === "deleted")

  if (!showReason) return badge

  return (
    <span className="inline-flex items-center gap-1.5">
      {badge}
      <span
        className="truncate text-[11px] text-muted-foreground"
        title={statusReason ?? undefined}
      >
        {reasonLabel}
      </span>
    </span>
  )
}
