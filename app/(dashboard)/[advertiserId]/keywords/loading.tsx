/**
 * 키워드 페이지 전용 로딩 fallback — CLS 개선 목적.
 *
 * 배경:
 *   - 공통 `app/(dashboard)/[advertiserId]/loading.tsx` 의 body 영역은 h-64 (256px) 고정.
 *   - 실제 키워드 페이지는 toolbar 2~3줄 + 액션바 + max-h-[calc(100dvh-280px)] 테이블.
 *   - loading → page swap 시 body 영역이 256px → 800px+ 로 확장 → 큰 layout shift.
 *
 * 해결:
 *   - 본 loading 의 body 높이를 실제 페이지 테이블 컨테이너와 동일한
 *     `max-h-[calc(100dvh-280px)] min-h-[320px]` 로 맞춤 → swap 시 시프트 최소화.
 *   - toolbar / 액션바 자리도 실제 페이지 구조와 비슷한 골격으로 예약.
 *
 * BACKLOG: CLS 0.216 → ≤ 0.1 목표 (2026-05-04 측정).
 */

import { Loader2Icon } from "lucide-react"

export default function KeywordsLoading() {
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

      {/* 1차 toolbar skeleton — 검색 + 광고그룹 + 필터 + 초기화 + 우측 기간/카운터 */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/10 px-3 py-2">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="h-8 w-56 animate-pulse rounded bg-muted" />
        <div className="h-8 w-20 animate-pulse rounded bg-muted" />
        <div className="h-8 w-16 animate-pulse rounded bg-muted" />
        <div className="ml-auto flex items-center gap-2">
          <div className="h-8 w-32 animate-pulse rounded bg-muted" />
          <div className="h-3 w-20 animate-pulse rounded bg-muted" />
        </div>
      </div>

      {/*
       * staging / selection 바는 활성 시에만 노출 — skeleton 도 자리 예약 X.
       * (이전: 84px 빈 자리 영구. 변경 후 0건 진입 시 해당 영역 사라짐.)
       */}

      {/* 가상 스크롤 테이블 자리 — 실제 페이지와 동일한 max/min 높이. swap 시 시프트 최소. */}
      <div
        role="status"
        aria-live="polite"
        className="relative flex max-h-[calc(100dvh-280px)] min-h-[320px] flex-col items-center justify-center gap-3 rounded-lg border bg-muted/20 text-muted-foreground"
      >
        <Loader2Icon className="size-6 animate-spin" aria-hidden="true" />
        <span className="text-sm">키워드 불러오는 중...</span>
      </div>
    </div>
  )
}
