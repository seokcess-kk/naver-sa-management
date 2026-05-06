/**
 * 테이블 / 리스트 빈 상태 공통 컴포넌트.
 *
 * 사용처:
 *   - campaigns / adgroups / keywords / ads / extensions / approval-queue 테이블의 빈 상태
 *   - 두 가지 케이스를 같은 톤으로 표시:
 *     1. 데이터 자체 0건 — 다음 액션 (동기화 / 페이지 이동) 유도
 *     2. 필터 후 0건 — 단순 안내 (action 미지정)
 *
 * 의존성: 없음. 표현 전용 (cn 만 사용).
 *
 * 호출 예:
 *   <EmptyState title="표시할 키워드가 없습니다." description="우측 상단 동기화 버튼을 눌러 SA 에서 가져오세요." />
 *   <EmptyState title="현재 필터에 일치하는 키워드가 없습니다." />
 *   <EmptyState
 *     title="표시할 소재가 없습니다."
 *     description="소재는 광고그룹에 속합니다. 광고그룹을 먼저 동기화하세요."
 *     action={<Button render={<Link href={`/${advertiserId}/adgroups`} />}>광고그룹 페이지로 이동</Button>}
 *   />
 */

import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

export type EmptyStateProps = {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}

export function EmptyState({
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex h-40 flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground",
        className,
      )}
    >
      <p className="font-medium text-foreground">{title}</p>
      {description ? <p className="text-xs">{description}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}
