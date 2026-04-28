"use client"

/**
 * 키워드 목록 (F-3.1) — TanStack Table v8 + TanStack Virtual
 *
 * 본 PR 범위 (목록 + 필터·정렬·검색 + 동기화):
 *   - 5천 행 가상 스크롤 (TanStack Virtual: estimateSize 48 / overscan 10)
 *   - 컬럼: 체크박스 / 키워드 / 광고그룹(+캠페인) / 매치타입 / 입찰가 /
 *           그룹입찰가 사용 / 상태 / 검수 / 평균 노출 순위 / 최근 수정
 *   - 정렬: 헤더 클릭 → asc / desc / 없음 순환 (TanStack getSortedRowModel)
 *   - 클라이언트 측 필터: 키워드 검색(debounce 200ms) / 매치타입 / 상태 / 검수 / 광고그룹
 *   - 동기화 버튼 (광고주 단위)
 *
 * 본 PR 범위 X (후속 작업):
 *   - F-3.2 인라인 편집 (staging 누적 → 미리보기 → 확정)
 *   - F-3.3 일괄 액션 (toggle / bid / useGroupBidAmt)
 *     체크박스 컬럼은 노출하되 액션 버튼은 비활성 + tooltip
 *   - F-3.4 / F-3.5 CSV 내보내기 / 가져오기
 *   - F-3.6 키워드 추가
 *   - F-3.7 단건 삭제
 *
 * 광고주 횡단 차단:
 *   - props.keywords 는 RSC 에서 `where: { adgroup: { campaign: { advertiserId } } }`
 *     로 한정된 결과만. UI 레벨에서 별도 advertiserId 검사는 없음.
 *
 * 가상화 메모:
 *   - shadcn `<Table>` 은 자체적으로 `<table>` 을 렌더하므로 `getTotalSize` 와 transform
 *     으로 가상 행을 만들기 위해 raw `<table>` + tailwind 클래스 사용 (shadcn Table 의
 *     Tailwind 스타일을 모사. 헤더 sticky, 행 absolute 위치).
 *   - estimateSize: 48px (행 높이는 행마다 약간 다를 수 있어 measureElement 사용 X —
 *     단순 고정 높이로 5천 행 부드러운 스크롤 우선)
 *   - overscan: 10 (스크롤 빠를 때 빈 영역 깜빡임 완화)
 *
 * SPEC 6.2 F-3.1 / 11.2 / 안전장치 1.
 */

import * as React from "react"
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type FilterFn,
} from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ArrowDownIcon, ArrowUpIcon, ArrowUpDownIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { KeywordStatusBadge } from "@/components/dashboard/keyword-status-badge"
import { InspectStatusBadge } from "@/components/dashboard/inspect-status-badge"
import { SyncKeywordsButton } from "@/components/dashboard/sync-keywords-button"
import { cn } from "@/lib/utils"
import type {
  KeywordStatus,
  InspectStatus,
} from "@/lib/generated/prisma/client"

// =============================================================================
// 타입
// =============================================================================

/** RSC → 클라이언트 전달용 키워드 행. raw 컬럼 / 시크릿 X. */
export type KeywordRow = {
  id: string
  nccKeywordId: string
  keyword: string
  /** EXACT / PHRASE / BROAD (응답 누락 시 null) */
  matchType: string | null
  /** 그룹 입찰가 미사용일 때만 사용 (Int? — number 직렬화) */
  bidAmt: number | null
  useGroupBidAmt: boolean
  userLock: boolean
  status: KeywordStatus
  inspectStatus: InspectStatus
  /** Decimal(5,2) → number 직렬화. 없으면 null. */
  recentAvgRnk: number | null
  /** ISO 문자열 (RSC 직렬화) */
  updatedAt: string
  adgroup: {
    id: string
    name: string
    nccAdgroupId: string
    campaign: {
      id: string
      name: string
    }
  }
}

// =============================================================================
// 필터 정의 (클라이언트 측, 5천 행 메모리 충분)
// =============================================================================

/** 키워드 텍스트 contains (대소문자 무시) */
const keywordTextFilter: FilterFn<KeywordRow> = (row, _columnId, value) => {
  const q = String(value ?? "").trim().toLowerCase()
  if (q === "") return true
  return row.original.keyword.toLowerCase().includes(q)
}

/** "전체" = 비교 skip. 그 외는 정확 일치. */
const exactMatchFilter: FilterFn<KeywordRow> = (row, columnId, value) => {
  if (value === undefined || value === null || value === "" || value === "ALL")
    return true
  // matchType 은 row.original.matchType (null 가능)
  // status / inspectStatus / adgroupId 는 row.original 에서 추출
  const v = (row.original as unknown as Record<string, unknown>)[columnId]
  return v === value
}

// =============================================================================
// 컬럼 정의
// =============================================================================

function makeColumns(): ColumnDef<KeywordRow>[] {
  return [
    {
      id: "select",
      header: ({ table }) => (
        <Checkbox
          checked={table.getIsAllPageRowsSelected()}
          onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)}
          aria-label="전체 선택"
          // F-3.3 활성 전까지 disabled — 일괄 액션 비대상.
          // indeterminate 상태도 F-3.3 도입 시 mixed 처리.
          disabled
          title="다중 선택은 F-3.3 일괄 액션 도입 시 활성화"
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(v) => row.toggleSelected(!!v)}
          aria-label={`${row.original.keyword} 선택`}
          disabled
          title="다중 선택은 F-3.3 일괄 액션 도입 시 활성화"
        />
      ),
      enableSorting: false,
      enableColumnFilter: false,
      size: 40,
    },
    {
      accessorKey: "keyword",
      header: "키워드",
      cell: ({ row }) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{row.original.keyword}</span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {row.original.nccKeywordId}
          </span>
        </div>
      ),
      filterFn: keywordTextFilter,
      enableSorting: true,
    },
    {
      id: "adgroupId",
      // accessor 가 아닌 id — 필터 비교용 키 (row.original.adgroup.id 와 별도 매핑)
      accessorFn: (row) => row.adgroup.id,
      header: "광고그룹",
      cell: ({ row }) => (
        <div className="flex max-w-xs flex-col gap-0.5">
          <span className="truncate text-sm">{row.original.adgroup.name}</span>
          <span className="truncate text-[11px] text-muted-foreground">
            {row.original.adgroup.campaign.name}
          </span>
        </div>
      ),
      filterFn: exactMatchFilter,
      enableSorting: true,
      sortingFn: (a, b) =>
        a.original.adgroup.name.localeCompare(b.original.adgroup.name, "ko"),
    },
    {
      accessorKey: "matchType",
      header: "매치",
      cell: ({ row }) => <MatchTypeBadge value={row.original.matchType} />,
      filterFn: exactMatchFilter,
      enableSorting: true,
      sortingFn: (a, b) => {
        const av = a.original.matchType ?? ""
        const bv = b.original.matchType ?? ""
        return av.localeCompare(bv)
      },
    },
    {
      accessorKey: "bidAmt",
      header: () => <div className="text-right">입찰가</div>,
      cell: ({ row }) => (
        <div className="text-right font-mono">
          {row.original.useGroupBidAmt ? (
            <span className="text-xs text-muted-foreground">그룹입찰가</span>
          ) : row.original.bidAmt !== null ? (
            row.original.bidAmt.toLocaleString()
          ) : (
            "—"
          )}
        </div>
      ),
      enableSorting: true,
      sortingFn: (a, b) => {
        // 그룹입찰가 사용 (bidAmt 무시) 행은 마지막으로 보내기
        const av = a.original.useGroupBidAmt ? null : a.original.bidAmt
        const bv = b.original.useGroupBidAmt ? null : b.original.bidAmt
        if (av === null && bv === null) return 0
        if (av === null) return 1
        if (bv === null) return -1
        return av - bv
      },
    },
    {
      accessorKey: "useGroupBidAmt",
      header: () => <div className="text-center">그룹입찰가</div>,
      cell: ({ row }) => (
        <div className="text-center text-xs">
          {row.original.useGroupBidAmt ? (
            <span className="inline-flex items-center rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              사용
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </div>
      ),
      enableSorting: false,
    },
    {
      accessorKey: "status",
      header: "상태",
      cell: ({ row }) => <KeywordStatusBadge status={row.original.status} />,
      filterFn: exactMatchFilter,
      enableSorting: true,
    },
    {
      accessorKey: "inspectStatus",
      header: "검수",
      cell: ({ row }) => (
        <InspectStatusBadge status={row.original.inspectStatus} />
      ),
      filterFn: exactMatchFilter,
      enableSorting: true,
    },
    {
      accessorKey: "recentAvgRnk",
      header: () => <div className="text-right">평균 노출</div>,
      cell: ({ row }) => (
        <div className="text-right font-mono text-xs">
          {row.original.recentAvgRnk !== null
            ? row.original.recentAvgRnk.toFixed(1)
            : "—"}
        </div>
      ),
      enableSorting: true,
      sortingFn: (a, b) => {
        const av = a.original.recentAvgRnk
        const bv = b.original.recentAvgRnk
        if (av === null && bv === null) return 0
        if (av === null) return 1
        if (bv === null) return -1
        return av - bv
      },
    },
    {
      accessorKey: "updatedAt",
      header: "최근 수정",
      cell: ({ row }) => (
        <div className="text-xs text-muted-foreground">
          {new Date(row.original.updatedAt).toLocaleString("ko-KR")}
        </div>
      ),
      enableSorting: true,
      sortingFn: (a, b) =>
        new Date(a.original.updatedAt).getTime() -
        new Date(b.original.updatedAt).getTime(),
    },
  ]
}

function MatchTypeBadge({ value }: { value: string | null }) {
  if (!value) {
    return <span className="text-xs text-muted-foreground">—</span>
  }
  const v = value.toUpperCase()
  const cls =
    v === "EXACT"
      ? "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300"
      : v === "PHRASE"
        ? "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300"
        : v === "BROAD"
          ? "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300"
          : "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-300"
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        cls,
      )}
    >
      {v}
    </span>
  )
}

// =============================================================================
// 메인 컴포넌트
// =============================================================================

export function KeywordsTable({
  advertiserId,
  hasKeys,
  keywords,
}: {
  advertiserId: string
  hasKeys: boolean
  keywords: KeywordRow[]
}) {
  const columns = React.useMemo(() => makeColumns(), [])

  // -- 필터 state -------------------------------------------------------------
  const [searchInput, setSearchInput] = React.useState("")
  const [debouncedSearch, setDebouncedSearch] = React.useState("")
  const [matchTypeFilter, setMatchTypeFilter] = React.useState<string>("ALL")
  const [statusFilter, setStatusFilter] = React.useState<string>("ALL")
  const [inspectFilter, setInspectFilter] = React.useState<string>("ALL")
  const [adgroupFilter, setAdgroupFilter] = React.useState<string>("ALL")
  const [sorting, setSorting] = React.useState<SortingState>([
    { id: "updatedAt", desc: true },
  ])

  // 검색 input debounce 200ms
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput), 200)
    return () => clearTimeout(t)
  }, [searchInput])

  // 광고그룹 셀렉트 옵션 — props 데이터에서 unique 추출
  const adgroupOptions = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const k of keywords) {
      if (!map.has(k.adgroup.id)) map.set(k.adgroup.id, k.adgroup.name)
    }
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "ko"))
  }, [keywords])

  // 컬럼 필터 state 구성 (TanStack getFilteredRowModel 가 적용)
  const columnFilters = React.useMemo<ColumnFiltersState>(() => {
    const f: ColumnFiltersState = []
    if (debouncedSearch.trim() !== "") {
      f.push({ id: "keyword", value: debouncedSearch })
    }
    if (matchTypeFilter !== "ALL") {
      f.push({ id: "matchType", value: matchTypeFilter })
    }
    if (statusFilter !== "ALL") {
      f.push({ id: "status", value: statusFilter })
    }
    if (inspectFilter !== "ALL") {
      f.push({ id: "inspectStatus", value: inspectFilter })
    }
    if (adgroupFilter !== "ALL") {
      f.push({ id: "adgroupId", value: adgroupFilter })
    }
    return f
  }, [
    debouncedSearch,
    matchTypeFilter,
    statusFilter,
    inspectFilter,
    adgroupFilter,
  ])

  const table = useReactTable<KeywordRow>({
    data: keywords,
    columns,
    state: { sorting, columnFilters },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getRowId: (row) => row.id,
    enableRowSelection: false, // F-3.3 도입 시 true 로 변경
  })

  const rows = table.getRowModel().rows

  // -- 가상 스크롤 ------------------------------------------------------------
  const parentRef = React.useRef<HTMLDivElement | null>(null)
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    overscan: 10,
  })
  const virtualRows = rowVirtualizer.getVirtualItems()
  const totalSize = rowVirtualizer.getTotalSize()
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0
  const paddingBottom =
    virtualRows.length > 0
      ? totalSize - virtualRows[virtualRows.length - 1].end
      : 0

  function resetFilters() {
    setSearchInput("")
    setDebouncedSearch("")
    setMatchTypeFilter("ALL")
    setStatusFilter("ALL")
    setInspectFilter("ALL")
    setAdgroupFilter("ALL")
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-xl font-medium leading-snug">
            키워드
          </h1>
          <p className="text-sm text-muted-foreground">
            광고주 전체 키워드 목록입니다. 인라인 편집 / 일괄 액션 / CSV 가져오기는
            후속 단계에서 활성화됩니다.
          </p>
        </div>
        <SyncKeywordsButton advertiserId={advertiserId} hasKeys={hasKeys} />
      </header>

      {!hasKeys && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="text-amber-700 dark:text-amber-400">
              API 키 미설정
            </CardTitle>
            <CardDescription>
              이 광고주는 API 키 / Secret 키가 입력되지 않았습니다. SA API 호출
              (동기화)이 차단됩니다. admin 권한자가 광고주 상세 화면에서 키를
              입력하면 활성화됩니다.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* 필터 / 검색 toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
        <Input
          placeholder="키워드 검색..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="h-8 w-56"
        />
        <Select
          value={matchTypeFilter}
          onValueChange={(v) => setMatchTypeFilter(v ?? "ALL")}
        >
          <SelectTrigger className="w-32">
            <SelectValue placeholder="매치타입" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">매치 (전체)</SelectItem>
            <SelectItem value="EXACT">EXACT</SelectItem>
            <SelectItem value="PHRASE">PHRASE</SelectItem>
            <SelectItem value="BROAD">BROAD</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v ?? "ALL")}
        >
          <SelectTrigger className="w-32">
            <SelectValue placeholder="상태" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">상태 (전체)</SelectItem>
            <SelectItem value="on">ON</SelectItem>
            <SelectItem value="off">OFF</SelectItem>
            <SelectItem value="deleted">삭제됨</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={inspectFilter}
          onValueChange={(v) => setInspectFilter(v ?? "ALL")}
        >
          <SelectTrigger className="w-32">
            <SelectValue placeholder="검수" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">검수 (전체)</SelectItem>
            <SelectItem value="pending">검수중</SelectItem>
            <SelectItem value="approved">승인</SelectItem>
            <SelectItem value="rejected">거절</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={adgroupFilter}
          onValueChange={(v) => setAdgroupFilter(v ?? "ALL")}
        >
          <SelectTrigger className="w-56">
            <SelectValue placeholder="광고그룹" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">광고그룹 (전체)</SelectItem>
            {adgroupOptions.map((g) => (
              <SelectItem key={g.id} value={g.id}>
                {g.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="ghost"
          onClick={resetFilters}
          disabled={
            searchInput === "" &&
            matchTypeFilter === "ALL" &&
            statusFilter === "ALL" &&
            inspectFilter === "ALL" &&
            adgroupFilter === "ALL"
          }
        >
          초기화
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          총 {keywords.length.toLocaleString()}건
          {rows.length !== keywords.length && (
            <> (필터 후 {rows.length.toLocaleString()}건)</>
          )}
        </span>
      </div>

      {/* 일괄 액션 바 (F-3.3 활성 전까지 비활성) */}
      <div className="flex items-center gap-2 rounded-lg border bg-muted/10 px-3 py-2">
        <span className="text-xs text-muted-foreground">
          다중 선택 일괄 액션은 F-3.3 도입 시 활성화됩니다.
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled
            title="F-3.3 일괄 액션에서 활성화"
          >
            ON으로 변경
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled
            title="F-3.3 일괄 액션에서 활성화"
          >
            OFF로 변경
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled
            title="F-3.3 일괄 액션에서 활성화"
          >
            입찰가 변경
          </Button>
        </div>
      </div>

      {/* 가상 스크롤 테이블 */}
      <div
        ref={parentRef}
        className="relative max-h-[70vh] overflow-auto rounded-lg border"
      >
        {keywords.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            표시할 키워드가 없습니다. 우측 상단{" "}
            <span className="mx-1 font-medium">광고주에서 동기화</span> 버튼을
            눌러 SA 에서 가져오세요. (광고그룹을 먼저 동기화해야 합니다.)
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            현재 필터에 일치하는 키워드가 없습니다.
          </div>
        ) : (
          <table className="w-full caption-bottom text-sm">
            <thead className="sticky top-0 z-10 bg-background shadow-[inset_0_-1px_0_0_var(--border)]">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id} className="border-b">
                  {headerGroup.headers.map((header) => {
                    const canSort = header.column.getCanSort()
                    const sortDir = header.column.getIsSorted()
                    return (
                      <th
                        key={header.id}
                        className={cn(
                          "h-10 px-3 text-left align-middle text-xs font-medium text-muted-foreground",
                          canSort && "cursor-pointer select-none hover:text-foreground",
                        )}
                        onClick={
                          canSort
                            ? header.column.getToggleSortingHandler()
                            : undefined
                        }
                      >
                        <div className="inline-flex items-center gap-1">
                          {header.isPlaceholder
                            ? null
                            : flexRender(
                                header.column.columnDef.header,
                                header.getContext(),
                              )}
                          {canSort && (
                            <span className="text-muted-foreground/60">
                              {sortDir === "asc" ? (
                                <ArrowUpIcon className="size-3" />
                              ) : sortDir === "desc" ? (
                                <ArrowDownIcon className="size-3" />
                              ) : (
                                <ArrowUpDownIcon className="size-3 opacity-40" />
                              )}
                            </span>
                          )}
                        </div>
                      </th>
                    )
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {paddingTop > 0 && (
                <tr style={{ height: `${paddingTop}px` }}>
                  <td colSpan={columns.length} />
                </tr>
              )}
              {virtualRows.map((virtualRow) => {
                const row = rows[virtualRow.index]
                return (
                  <tr
                    key={row.id}
                    className="border-b transition-colors hover:bg-muted/30"
                    style={{ height: `${virtualRow.size}px` }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        className="px-3 py-2 align-middle"
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </td>
                    ))}
                  </tr>
                )
              })}
              {paddingBottom > 0 && (
                <tr style={{ height: `${paddingBottom}px` }}>
                  <td colSpan={columns.length} />
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
