/**
 * 광고그룹 상태 배지 (F-2.2)
 *
 * 표시 규칙 (campaign-status-badge.tsx 동일 패턴):
 *   - status='deleted'  → "삭제됨"   (destructive — 보통 표시 안 함)
 *   - status='off'      → "OFF"      (zinc 회색) — userLock 또는 SA 일시중지 모두 흡수
 *   - status='on'       → "ON"       (emerald)
 *
 * AdGroup 모델은 캠페인과 달리 `userLock` 컬럼을 별도로 두지 않고 status enum 으로 통합.
 * (SA 응답의 userLock=true / status=PAUSED 둘 다 actions.ts mapAdGroupStatus 에서 'off' 로 매핑)
 *
 * 추가:
 *   - statusReason — 네이버 SA API 응답의 OFF 사유 ("캠페인 OFF", "캠페인 예산 도달" 등).
 *     ON 외 + 사유 존재 시 배지 옆 muted 인라인 텍스트로 표시.
 *
 * 순수 표현 컴포넌트. RSC / 클라이언트 양쪽에서 사용 가능.
 *
 * SPEC 6.2 F-2.2.
 */

import type { AdGroupStatus } from "@/lib/generated/prisma/client"
import { formatStatusReason } from "@/lib/dashboard/status-reason-labels"

export function AdgroupStatusBadge({
  status,
  statusReason,
}: {
  status: AdGroupStatus
  statusReason?: string | null
}) {
  let badge: React.ReactNode
  if (status === "deleted") {
    badge = (
      <span className="inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
        삭제됨
      </span>
    )
  } else if (status === "off") {
    badge = (
      <span className="inline-flex items-center rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
        OFF
      </span>
    )
  } else {
    badge = (
      <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
        ON
      </span>
    )
  }

  // OFF 계열 + 사유 존재 시 한글 라벨로 인라인 표시 (영문 코드 → 한글 매핑).
  const reasonLabel = formatStatusReason(statusReason)
  const showReason = !!reasonLabel && status !== "on"
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
