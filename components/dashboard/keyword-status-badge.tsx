/**
 * 키워드 상태 배지 (F-3.1)
 *
 * 표시 규칙 (adgroup-status-badge.tsx 동일 패턴):
 *   - status='deleted' → "삭제됨" (destructive — 보통 표시 안 함)
 *   - status='off'     → "OFF"   (zinc 회색) — userLock 또는 SA PAUSED 모두 흡수
 *   - status='on'      → "ON"    (emerald)
 *
 * Keyword 모델은 별도 userLock 컬럼이 있지만, 표시는 status enum 만 참고.
 * (backend actions.ts mapKeywordStatus 가 userLock=true / status=PAUSED → 'off' 통합)
 *
 * 순수 표현 컴포넌트. RSC / 클라이언트 양쪽에서 사용 가능.
 *
 * SPEC 6.2 F-3.1.
 */

import type { KeywordStatus } from "@/lib/generated/prisma/client"

export function KeywordStatusBadge({ status }: { status: KeywordStatus }) {
  if (status === "deleted") {
    return (
      <span className="inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
        삭제됨
      </span>
    )
  }
  if (status === "off") {
    return (
      <span className="inline-flex items-center rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
        OFF
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
      ON
    </span>
  )
}
