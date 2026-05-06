/**
 * 광고주 컨텍스트 라우트 공통 로딩 fallback (Suspense boundary)
 *
 * 트리거:
 *   - DashboardSectionNav 의 Link 클릭으로 라우트 이동 시 RSC 응답 도착 전 표시
 *   - router.refresh() / router.push() 시에도 자동 표시
 *
 * 적용 범위:
 *   - app/(dashboard)/[advertiserId]/{page,campaigns,adgroups,keywords,ads,extensions,...}/page.tsx
 *   - 자식 라우트가 자체 loading.tsx 를 두면 그게 우선 (override)
 *
 * 디자인:
 *   - PageHeader 모양 흉내 (제목 / 설명 / actions skeleton) — 레이아웃 점프 최소화
 *   - body 영역에 spinner + "불러오는 중..." — 사용자가 화면이 바뀌었음을 즉시 인지
 *
 * 의존성: shadcn Skeleton 미존재 → bg-muted + animate-pulse 직접 사용 (외부 컴포넌트 X)
 */

import { Loader2Icon } from "lucide-react"

export default function AdvertiserLoading() {
  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      {/* breadcrumb + PageHeader skeleton */}
      <div className="flex flex-col gap-3">
        <div className="h-3 w-40 animate-pulse rounded bg-muted" />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-2">
            <div className="h-7 w-36 animate-pulse rounded bg-muted" />
            <div className="h-3 w-72 animate-pulse rounded bg-muted" />
          </div>
          <div className="flex items-center gap-2">
            <div className="h-8 w-24 animate-pulse rounded bg-muted" />
            <div className="h-8 w-28 animate-pulse rounded bg-muted" />
          </div>
        </div>
      </div>

      {/* body — spinner + label */}
      <div
        role="status"
        aria-live="polite"
        className="flex h-64 flex-col items-center justify-center gap-3 rounded-lg border bg-muted/20 text-muted-foreground"
      >
        <Loader2Icon className="size-6 animate-spin" aria-hidden="true" />
        <span className="text-sm">불러오는 중...</span>
      </div>
    </div>
  )
}
