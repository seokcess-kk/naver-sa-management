/**
 * 캠페인/광고그룹 scope 안내 + 해제 링크 (F-2.X / 6.2 / 11.2)
 *
 * 사용처: PageHeader.description 안에 끼워 넣어 사용.
 *   - 5개 페이지(campaigns / adgroups / keywords / ads / extensions) 공통.
 *   - URL `?campaignIds=...` 또는 `?adgroupIds=...` 가 있을 때만 렌더.
 *
 * 동작:
 *   - 칩 형태로 안내문 표시 (예: "선택한 광고그룹 3개에 속한 키워드만 표시 중")
 *   - "× 해제" 링크 클릭 → 해당 페이지의 query 없는 URL 로 이동 → scope 제거 + RSC 재실행
 *   - DashboardSectionNav 가 scope query 를 자동 부착하므로 nav 클릭으로는 해제 불가 → 본 컴포넌트가 유일한 해제 경로.
 *
 * 안전:
 *   - href 는 호출부가 광고주 한정 절대 경로(`/${advertiserId}/keywords`)로 전달.
 *   - 본 컴포넌트는 RSC 가 아닌 단순 Server-friendly element (Next Link). client island 불필요.
 */

import Link from "next/link"
import { XIcon } from "lucide-react"
import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

export type ScopeClearLinkProps = {
  /** scope 해제 후 이동할 URL — 통상 현재 섹션의 query 없는 절대 경로 */
  clearHref: string
  /** 칩 안에 표시할 안내문 (예: "선택한 캠페인 3개에 속한 광고그룹만 표시") */
  children: ReactNode
  className?: string
}

export function ScopeClearLink({
  clearHref,
  children,
  className,
}: ScopeClearLinkProps) {
  return (
    <span
      className={cn(
        "inline-flex flex-wrap items-center gap-2 rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200",
        className,
      )}
    >
      <span>{children}</span>
      <Link
        href={clearHref}
        aria-label="필터 해제"
        className="inline-flex items-center gap-0.5 rounded-full bg-amber-200/60 px-2 py-0.5 text-[11px] font-medium text-amber-900 transition hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-100 dark:hover:bg-amber-900/60"
      >
        <XIcon className="size-3" />
        필터 해제
      </Link>
    </span>
  )
}
