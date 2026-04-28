"use client"

/**
 * 소재 목록 + 다중 선택 일괄 액션 (F-4.x)
 *
 * 키워드 패턴(keywords-table.tsx)을 베이스로 단순화 응용:
 *
 * F-4.1 — 목록 / 동기화:
 *   - 5천 행 가상 스크롤 (TanStack Virtual: estimateSize 56 / overscan 10)
 *   - 컬럼: 체크박스 / 미리보기 / 광고그룹(+캠페인) / 타입 / 상태 / 검수(+memo) /
 *           최근 수정 / 액션(케밥)
 *   - 정렬: 헤더 클릭 → asc / desc / 없음 순환
 *   - 클라이언트 필터: 텍스트 검색(debounce 200ms) / adType / 상태 / 검수 / 광고그룹
 *   - 동기화 버튼 (광고주 단위)
 *
 * F-4.3 — 다중 선택 일괄 액션 (소재는 입찰가 없음 → toggle 만):
 *   - 체크박스 다중 선택 활성. enableRowSelection=true.
 *   - 액션 2종: ON으로 변경 / OFF으로 변경
 *   - BulkActionModal 4단계 (input → preview → submit → result)
 *     · input 단계 즉시 onReady (toggle 은 입력 없음)
 *     · preview 단계 RSC props 기반 전/후 비교 (소재는 별도 preview server action 없음 — 입찰가 없어 산출 계산 X)
 *     · 확정 시 bulkActionAds(advertiserId, input) 호출
 *   - 선택 1~500건 (zod 스키마 일치)
 *
 * F-4.6 — 추가 모달 (TEXT_45 단건, 본 PR 단순화):
 *   - 헤더 "소재 추가" 버튼. hasKeys=false / 광고그룹 0개 시 disabled.
 *
 * F-4.7 — 단건 삭제 (admin 한정 + 2차 확인):
 *   - 행 케밥 메뉴 → AdsDeleteModal (nccAdId 재입력)
 *   - userRole !== 'admin' 일 때 메뉴 자체 disabled
 *   - status='deleted' 행은 메뉴 disabled (이미 삭제됨)
 *
 * 본 PR 비대상 (후속):
 *   - 인라인 편집 (ad fields 자유 JSON — adType 별 동적 입력 보강 후)
 *   - CSV 가져오기 / 내보내기 (소재 본문 자유 JSON 이라 별도 설계 필요)
 *
 * 광고주 횡단 차단:
 *   - props.ads 는 RSC 에서 `where: { adgroup: { campaign: { advertiserId } } }`
 *     로 한정된 결과만. UI 레벨에서 별도 advertiserId 검사는 없음.
 *
 * SPEC 6.2 F-4.1 / F-4.3 / F-4.6 / F-4.7 / 11.2 / 안전장치 1·6.
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
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
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowUpDownIcon,
  MoreHorizontalIcon,
  InfoIcon,
} from "lucide-react"

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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { AdStatusBadge } from "@/components/dashboard/ad-status-badge"
import { InspectStatusBadge } from "@/components/dashboard/inspect-status-badge"
import { SyncAdsButton } from "@/components/dashboard/sync-ads-button"
import {
  AdsAddModal,
  type AdAdgroupOption,
} from "@/components/dashboard/ads-add-modal"
import {
  AdsDeleteModal,
  type DeleteAdTargetRow,
} from "@/components/dashboard/ads-delete-modal"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  BulkActionModal,
  type BulkActionResult,
} from "@/components/forms/bulk-action-modal"
import {
  bulkActionAds,
  type BulkActionAdsInput,
} from "@/app/(dashboard)/[advertiserId]/ads/actions"
import { cn } from "@/lib/utils"
import type { AdStatus, InspectStatus } from "@/lib/generated/prisma/client"

// 상한 — bulkActionAdsSchema 의 .max(500) 와 일치.
const BULK_ACTION_MAX = 500

// =============================================================================
// 타입
// =============================================================================

// AdsAddModal 의 광고그룹 옵션을 page.tsx 가 본 모듈만 import 하도록 re-export.
export type { AdAdgroupOption }

/** RSC → 클라이언트 전달용 소재 행. raw 컬럼 / 시크릿 X. */
export type AdRow = {
  id: string
  nccAdId: string
  /** TEXT_45 / RSA_AD 등 (응답 누락 시 null) */
  adType: string | null
  /** 소재 본문 JSON — adType 별 구조 상이. 미리보기 추출에 사용. */
  fields: unknown
  inspectStatus: InspectStatus
  /** 검수 반려 사유 (있으면 ? 마커 + title 노출) */
  inspectMemo: string | null
  status: AdStatus
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

/**
 * F-4.3 다중 선택 액션 종류 (소재는 입찰가 없음 → toggle 만).
 *
 * - toggleOn  : userLock=false 일괄 적용 (사용자 ON)
 * - toggleOff : userLock=true 일괄 적용 (사용자 OFF)
 */
type BulkAction = "toggleOn" | "toggleOff"

/** BulkActionModal<AdRow, BulkInputForAds> 의 TInput 타입 */
type BulkInputForAds = { action: "toggleOn" } | { action: "toggleOff" }

// =============================================================================
// 미리보기 추출 — fields JSON 에서 텍스트 후보 추출
// =============================================================================
//
// adType 별로 ad 구조가 상이 (TEXT_45 / RSA_AD 등). 본 PR 은 단순 휴리스틱:
//   1. headline / title / description 같은 일반 키 우선
//   2. 없으면 fields JSON.stringify slice (60자)
// 후속 PR 에서 adType 별 정밀 미리보기 (RSA_AD 의 headlines[0] 등) 가능.

function extractAdPreview(fields: unknown): string {
  if (fields === null || fields === undefined) return ""
  if (typeof fields !== "object") return String(fields).slice(0, 60)
  const obj = fields as Record<string, unknown>

  // 1차 후보 — 텍스트 가능성 높은 키 순서
  const textKeys = ["headline", "title", "description", "subject", "name"]
  for (const k of textKeys) {
    const v = obj[k]
    if (typeof v === "string" && v.trim().length > 0) {
      return v.trim()
    }
  }

  // RSA_AD 류 — headlines[0] / descriptions[0]
  const headlines = obj["headlines"]
  if (Array.isArray(headlines) && headlines.length > 0) {
    const h0 = headlines[0]
    if (typeof h0 === "string") return h0
    if (h0 && typeof h0 === "object" && "text" in h0) {
      const t = (h0 as Record<string, unknown>).text
      if (typeof t === "string") return t
    }
  }

  // 폴백 — JSON 직렬화 일부
  try {
    return JSON.stringify(fields).slice(0, 60)
  } catch {
    return ""
  }
}

// =============================================================================
// 필터 정의 (클라이언트 측, 5천 행 메모리 충분)
// =============================================================================

/** 미리보기 텍스트 + nccAdId contains (대소문자 무시) */
const adTextFilter: FilterFn<AdRow> = (row, _columnId, value) => {
  const q = String(value ?? "").trim().toLowerCase()
  if (q === "") return true
  const preview = extractAdPreview(row.original.fields).toLowerCase()
  if (preview.includes(q)) return true
  return row.original.nccAdId.toLowerCase().includes(q)
}

/** "전체" = 비교 skip. 그 외는 정확 일치. */
const exactMatchFilter: FilterFn<AdRow> = (row, columnId, value) => {
  if (value === undefined || value === null || value === "" || value === "ALL")
    return true
  const v = (row.original as unknown as Record<string, unknown>)[columnId]
  return v === value
}

// =============================================================================
// 행 컨텍스트 — 케밥 메뉴(삭제) 의존성
// =============================================================================

type RowCtx = {
  isAdmin: boolean
  /** 키 미설정이면 일부 액션 차단 (현 PR 은 케밥 메뉴 자체엔 영향 X — admin & not-deleted 만 보면 됨) */
  hasKeys: boolean
  /** 행 삭제 모달 열기 */
  onRequestDelete: (row: AdRow) => void
}

// =============================================================================
// 컬럼 정의
// =============================================================================

function makeColumns(ctx: RowCtx): ColumnDef<AdRow>[] {
  return [
    {
      id: "select",
      header: ({ table }) => {
        const allSelected =
          table.getIsAllPageRowsSelected() || table.getIsAllRowsSelected()
        return (
          <Checkbox
            checked={allSelected}
            onCheckedChange={(v) => table.toggleAllRowsSelected(!!v)}
            aria-label="전체 선택"
          />
        )
      },
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(v) => row.toggleSelected(!!v)}
          aria-label={`${row.original.nccAdId} 선택`}
        />
      ),
      enableSorting: false,
      enableColumnFilter: false,
      size: 40,
    },
    {
      id: "preview",
      // accessor 가 아닌 id — 검색 필터는 별도 정의 (extractAdPreview 사용)
      accessorFn: (row) => extractAdPreview(row.fields),
      header: "소재",
      cell: ({ row }) => {
        const preview = extractAdPreview(row.original.fields)
        return (
          <div className="flex max-w-[280px] flex-col gap-0.5">
            <span className="line-clamp-2 text-sm font-medium">
              {preview || "(미리보기 없음)"}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {row.original.nccAdId}
            </span>
          </div>
        )
      },
      filterFn: adTextFilter,
      enableSorting: true,
      sortingFn: (a, b) =>
        extractAdPreview(a.original.fields).localeCompare(
          extractAdPreview(b.original.fields),
          "ko",
        ),
    },
    {
      id: "adgroupId",
      // accessor 가 아닌 id — 필터 비교용 키
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
      accessorKey: "adType",
      header: "타입",
      cell: ({ row }) => <AdTypeBadge value={row.original.adType} />,
      filterFn: exactMatchFilter,
      enableSorting: true,
      sortingFn: (a, b) => {
        const av = a.original.adType ?? ""
        const bv = b.original.adType ?? ""
        return av.localeCompare(bv)
      },
    },
    {
      accessorKey: "status",
      header: "상태",
      cell: ({ row }) => <AdStatusBadge status={row.original.status} />,
      filterFn: exactMatchFilter,
      enableSorting: true,
    },
    {
      accessorKey: "inspectStatus",
      header: "검수",
      cell: ({ row }) => (
        <div className="flex items-center gap-1.5">
          <InspectStatusBadge status={row.original.inspectStatus} />
          {row.original.inspectMemo && (
            // tooltip 컴포넌트 미존재 — title 속성으로 hover 노출
            <span
              className="inline-flex cursor-help items-center text-muted-foreground"
              title={row.original.inspectMemo}
              aria-label="검수 메모"
            >
              <InfoIcon className="size-3" />
            </span>
          )}
        </div>
      ),
      filterFn: exactMatchFilter,
      enableSorting: true,
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
    {
      // F-4.7 — 행 우측 액션 컬럼 (케밥 메뉴 → 단건 삭제). admin 한정.
      // status='deleted' 행도 메뉴는 노출하되 항목별로 disabled.
      id: "actions",
      header: () => <span className="sr-only">행 작업</span>,
      cell: ({ row }) => <AdRowActions row={row.original} ctx={ctx} />,
      enableSorting: false,
      enableColumnFilter: false,
      size: 48,
    },
  ]
}

// =============================================================================
// 행 우측 액션 (케밥 메뉴) — F-4.7
// =============================================================================

function AdRowActions({ row, ctx }: { row: AdRow; ctx: RowCtx }) {
  const alreadyDeleted = row.status === "deleted"
  const canDelete = ctx.isAdmin && !alreadyDeleted

  const deleteTitle = !ctx.isAdmin
    ? "관리자 권한 필요"
    : alreadyDeleted
      ? "이미 삭제된 소재"
      : undefined

  return (
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`${row.nccAdId} 행 작업`}
            >
              <MoreHorizontalIcon />
            </Button>
          }
        />
        <DropdownMenuContent align="end" sideOffset={4} className="w-44">
          <DropdownMenuItem
            variant="destructive"
            disabled={!canDelete}
            title={deleteTitle}
            onClick={() => {
              if (!canDelete) return
              ctx.onRequestDelete(row)
            }}
          >
            삭제 (admin)
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function AdTypeBadge({ value }: { value: string | null }) {
  if (!value) {
    return <span className="text-xs text-muted-foreground">—</span>
  }
  const v = value.toUpperCase()
  // 알려진 adType 색 매핑 — 모르면 zinc 폴백
  const cls = v.startsWith("TEXT")
    ? "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300"
    : v.startsWith("RSA")
      ? "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300"
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

export function AdsTable({
  advertiserId,
  hasKeys,
  ads,
  adgroups,
  userRole,
}: {
  advertiserId: string
  hasKeys: boolean
  ads: AdRow[]
  /** F-4.6 소재 추가 모달용 — page.tsx 가 광고주 한정으로 별도 조회. */
  adgroups: AdAdgroupOption[]
  /** F-4.7 — admin 한정 단건 삭제 권한 (RSC 에서 ctx.user.role 전달). */
  userRole: "admin" | "operator" | "viewer"
}) {
  const router = useRouter()
  const isAdmin = userRole === "admin"

  // -- 모달 state -------------------------------------------------------------
  // F-4.6 소재 추가 모달
  const [addOpen, setAddOpen] = React.useState(false)
  // F-4.7 단건 삭제 모달 (admin 한정) — null = 닫힘. mount 시점에만 모달 마운트.
  const [deleteRow, setDeleteRow] = React.useState<AdRow | null>(null)

  // -- 다중 선택 + 일괄 액션 state (F-4.3) -----------------------------------
  // TanStack Table 의 rowSelection 은 row.id 기반 (getRowId=row.id 설정 → DB Ad.id).
  const [rowSelection, setRowSelection] = React.useState<
    Record<string, boolean>
  >({})
  const [bulkAction, setBulkAction] = React.useState<BulkAction | null>(null)

  const onRequestDelete = React.useCallback((row: AdRow) => {
    setDeleteRow(row)
  }, [])

  const ctx = React.useMemo<RowCtx>(
    () => ({
      isAdmin,
      hasKeys,
      onRequestDelete,
    }),
    [isAdmin, hasKeys, onRequestDelete],
  )

  const columns = React.useMemo(() => makeColumns(ctx), [ctx])

  // -- 필터 state -------------------------------------------------------------
  const [searchInput, setSearchInput] = React.useState("")
  const [debouncedSearch, setDebouncedSearch] = React.useState("")
  const [adTypeFilter, setAdTypeFilter] = React.useState<string>("ALL")
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

  // 광고그룹 셀렉트 옵션 — 현재 데이터에 등장하는 광고그룹만 (필터링 한정)
  const adgroupOptions = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const a of ads) {
      if (!map.has(a.adgroup.id)) map.set(a.adgroup.id, a.adgroup.name)
    }
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "ko"))
  }, [ads])

  // adType 셀렉트 옵션 — 현재 데이터에 등장하는 타입만
  const adTypeOptions = React.useMemo(() => {
    const set = new Set<string>()
    for (const a of ads) {
      if (a.adType) set.add(a.adType)
    }
    return Array.from(set).sort()
  }, [ads])

  // 컬럼 필터 state 구성 (TanStack getFilteredRowModel 가 적용)
  const columnFilters = React.useMemo<ColumnFiltersState>(() => {
    const f: ColumnFiltersState = []
    if (debouncedSearch.trim() !== "") {
      f.push({ id: "preview", value: debouncedSearch })
    }
    if (adTypeFilter !== "ALL") {
      f.push({ id: "adType", value: adTypeFilter })
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
    adTypeFilter,
    statusFilter,
    inspectFilter,
    adgroupFilter,
  ])

  const table = useReactTable<AdRow>({
    data: ads,
    columns,
    state: { sorting, columnFilters, rowSelection },
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getRowId: (row) => row.id,
    enableRowSelection: true,
  })

  const rows = table.getRowModel().rows

  // -- 가상 스크롤 ------------------------------------------------------------
  const parentRef = React.useRef<HTMLDivElement | null>(null)
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56,
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
    setAdTypeFilter("ALL")
    setStatusFilter("ALL")
    setInspectFilter("ALL")
    setAdgroupFilter("ALL")
  }

  // -- F-4.3 다중 선택 + 일괄 액션 ------------------------------------------
  const selectedRows = React.useMemo(() => {
    if (Object.keys(rowSelection).length === 0) return []
    const byId = new Map(ads.map((a) => [a.id, a]))
    const out: AdRow[] = []
    for (const id of Object.keys(rowSelection)) {
      if (rowSelection[id] !== true) continue
      const r = byId.get(id)
      if (r) out.push(r)
    }
    return out
  }, [ads, rowSelection])

  const selectedCount = selectedRows.length
  const overSelectionLimit = selectedCount > BULK_ACTION_MAX

  function clearSelection() {
    setRowSelection({})
  }

  function openBulkAction(action: BulkAction) {
    if (selectedCount === 0) {
      toast.error("소재를 1개 이상 선택하세요")
      return
    }
    if (overSelectionLimit) {
      toast.error(`한 번에 최대 ${BULK_ACTION_MAX}건까지 일괄 변경 가능합니다`)
      return
    }
    if (!hasKeys) {
      toast.error("키 미설정 — 일괄 변경 불가")
      return
    }
    setBulkAction(action)
  }

  function handleBulkActionClosed(didApply: boolean) {
    setBulkAction(null)
    if (didApply) {
      setRowSelection({})
      router.refresh()
    }
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-xl font-medium leading-snug">
            소재
          </h1>
          <p className="text-sm text-muted-foreground">
            광고그룹별 소재 목록. 체크박스로 다중 선택 후 ON/OFF 일괄 변경
            가능. (인라인 편집·CSV 는 후속 PR)
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* F-4.6 소재 추가 — hasKeys=false / 광고그룹 0개 일 때 disabled */}
          <Button
            size="sm"
            onClick={() => {
              if (!hasKeys) {
                toast.error("키 미설정 — 소재 추가 비활성")
                return
              }
              if (adgroups.length === 0) {
                toast.error(
                  "광고그룹이 없습니다. 먼저 광고그룹을 동기화하세요.",
                )
                return
              }
              setAddOpen(true)
            }}
            disabled={!hasKeys || adgroups.length === 0}
            title={
              !hasKeys
                ? "키 미설정 — 먼저 API 키 / Secret 키 입력"
                : adgroups.length === 0
                  ? "광고그룹이 없습니다. 광고그룹을 먼저 동기화하세요."
                  : "TEXT_45 단일 소재 추가"
            }
          >
            소재 추가
          </Button>
          <SyncAdsButton advertiserId={advertiserId} hasKeys={hasKeys} />
        </div>
      </header>

      {!hasKeys && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="text-amber-700 dark:text-amber-400">
              API 키 미설정
            </CardTitle>
            <CardDescription>
              이 광고주는 API 키 / Secret 키가 입력되지 않았습니다. SA API 호출
              (동기화 / 일괄 액션)이 차단됩니다. admin 권한자가 광고주 상세
              화면에서 키를 입력하면 활성화됩니다.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* 필터 / 검색 toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
        <Input
          placeholder="소재 본문 / nccAdId 검색..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="h-8 w-72"
        />
        <Select
          value={adTypeFilter}
          onValueChange={(v) => setAdTypeFilter(v ?? "ALL")}
        >
          <SelectTrigger className="w-32">
            <SelectValue placeholder="타입" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">타입 (전체)</SelectItem>
            {adTypeOptions.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
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
            adTypeFilter === "ALL" &&
            statusFilter === "ALL" &&
            inspectFilter === "ALL" &&
            adgroupFilter === "ALL"
          }
        >
          초기화
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          총 {ads.length.toLocaleString()}건
          {rows.length !== ads.length && (
            <> (필터 후 {rows.length.toLocaleString()}건)</>
          )}
        </span>
      </div>

      {/* 다중 선택 일괄 액션 바 (F-4.3) */}
      <div
        className={cn(
          "flex items-center gap-2 rounded-lg border px-3 py-2",
          selectedCount > 0
            ? "border-sky-300 bg-sky-50 dark:border-sky-900/40 dark:bg-sky-900/10"
            : "bg-muted/10",
        )}
      >
        {selectedCount === 0 ? (
          <span className="text-xs text-muted-foreground">
            {hasKeys
              ? "체크박스로 소재를 선택해 ON/OFF 일괄 액션을 적용하세요."
              : "키 미설정 — 일괄 액션 비활성. admin 권한자가 키를 입력해야 합니다."}
          </span>
        ) : (
          <>
            <span className="text-sm font-medium text-sky-900 dark:text-sky-200">
              {selectedCount.toLocaleString()}개 선택됨
            </span>
            <Button
              size="xs"
              variant="ghost"
              onClick={clearSelection}
              title="선택 해제"
            >
              선택 해제
            </Button>
            {overSelectionLimit && (
              <span
                role="alert"
                className="text-xs font-medium text-destructive"
              >
                최대 {BULK_ACTION_MAX}건까지 일괄 변경 가능 (현재{" "}
                {selectedCount.toLocaleString()}건 — 선택 줄여주세요)
              </span>
            )}
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => openBulkAction("toggleOn")}
            disabled={selectedCount === 0 || overSelectionLimit || !hasKeys}
          >
            ON으로 변경
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => openBulkAction("toggleOff")}
            disabled={selectedCount === 0 || overSelectionLimit || !hasKeys}
          >
            OFF으로 변경
          </Button>
        </div>
      </div>

      {/* 가상 스크롤 테이블 */}
      <div
        ref={parentRef}
        className="relative max-h-[70vh] overflow-auto rounded-lg border"
      >
        {ads.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            표시할 소재가 없습니다. 우측 상단{" "}
            <span className="mx-1 font-medium">광고주에서 동기화</span> 버튼을
            눌러 SA 에서 가져오세요. (광고그룹을 먼저 동기화해야 합니다.)
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            현재 필터에 일치하는 소재가 없습니다.
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
                          canSort &&
                            "cursor-pointer select-none hover:text-foreground",
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
                      <td key={cell.id} className="px-3 py-2 align-middle">
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

      {/* 다중 선택 일괄 액션 모달 (F-4.3) — toggleOn / toggleOff */}
      {bulkAction !== null && (
        <AdsBulkActionModal
          advertiserId={advertiserId}
          action={bulkAction}
          selectedRows={selectedRows}
          onOpenChange={(o) => {
            if (!o) setBulkAction(null)
          }}
          onClosed={handleBulkActionClosed}
        />
      )}

      {/* 소재 추가 모달 (F-4.6) — result 단계 도달 시 router.refresh */}
      {addOpen && (
        <AdsAddModal
          advertiserId={advertiserId}
          adgroups={adgroups}
          open
          onOpenChange={(o) => {
            if (!o) setAddOpen(false)
          }}
          onClosed={(didApply) => {
            if (didApply) {
              router.refresh()
            }
          }}
        />
      )}

      {/* F-4.7 단건 삭제 모달 (admin 한정) — deleteRow!=null 시만 mount → 자동 reset */}
      {deleteRow !== null && (
        <AdsDeleteModal
          advertiserId={advertiserId}
          row={mapToDeleteTarget(deleteRow)}
          open
          onOpenChange={(o) => {
            if (!o) setDeleteRow(null)
          }}
          onClosed={(didApply) => {
            if (didApply) {
              router.refresh()
            }
          }}
        />
      )}
    </div>
  )
}

// AdRow → DeleteAdTargetRow (모달이 AdRow 의존성을 가지지 않도록 좁힌 타입).
function mapToDeleteTarget(row: AdRow): DeleteAdTargetRow {
  return {
    id: row.id,
    nccAdId: row.nccAdId,
    adType: row.adType,
    preview: extractAdPreview(row.fields),
    adgroupName: row.adgroup.name,
  }
}

// =============================================================================
// F-4.3 일괄 액션 모달 (BulkActionModal 래퍼)
// =============================================================================
//
// keywords-table 의 KeywordsBulkActionModal 패턴 응용 (단순화 — toggle 만, preview 는 RSC props 기반).
//
// 역할:
//   - input 단계: toggleOn / toggleOff → 입력 없음 (mount 즉시 onReady)
//   - preview 단계: 선택된 rows 의 현재 상태(before) → 액션 후 상태(after) 표
//                  소재는 입찰가 없음 → 별도 server preview action 불필요 (RSC props 충분)
//   - onSubmit: bulkActionAds(advertiserId, input) 호출 → BulkActionResult 변환

function AdsBulkActionModal({
  advertiserId,
  action,
  selectedRows,
  onOpenChange,
  onClosed,
}: {
  advertiserId: string
  action: BulkAction
  selectedRows: AdRow[]
  onOpenChange: (open: boolean) => void
  onClosed: (didApply: boolean) => void
}) {
  const title =
    action === "toggleOn" ? "ON으로 변경 (일괄)" : "OFF으로 변경 (일괄)"

  // input → bulkActionAds 페이로드 매핑
  const mapToServerInput = React.useCallback(
    (input: BulkInputForAds): BulkActionAdsInput => {
      const userLock = input.action === "toggleOff"
      return {
        action: "toggle",
        items: selectedRows.map((r) => ({
          adId: r.id,
          userLock,
        })),
      }
    },
    [selectedRows],
  )

  const handleSubmit = React.useCallback(
    async (input: BulkInputForAds): Promise<BulkActionResult> => {
      const payload = mapToServerInput(input)
      const res = await bulkActionAds(advertiserId, payload)
      // 결과 화면 표시명 매칭은 nccAdId 기반 (BulkActionModal getItemId 와 일치).
      return {
        batchId: res.batchId,
        total: res.total,
        success: res.success,
        failed: res.failed,
        items: res.items.map((it) => {
          const row = selectedRows.find((r) => r.id === it.adId)
          return {
            id: row?.nccAdId ?? it.adId,
            ok: it.ok,
            error: it.error,
          }
        }),
      }
    },
    [advertiserId, selectedRows, mapToServerInput],
  )

  return (
    <BulkActionModal<AdRow, BulkInputForAds>
      open
      onOpenChange={onOpenChange}
      title={title}
      itemLabel="소재"
      selectedItems={selectedRows}
      renderInput={(_, onReady) => (
        <ImmediateReady action={action} onReady={onReady} />
      )}
      renderPreview={(items) => (
        <AdToggleChangePreview items={items} action={action} />
      )}
      onSubmit={handleSubmit}
      getItemDisplayName={(r) => extractAdPreview(r.fields) || r.nccAdId}
      getItemId={(r) => r.nccAdId}
      onClosed={onClosed}
    />
  )
}

/**
 * input 단계 즉시 onReady — toggle 은 별도 입력 없음.
 *
 * BulkActionModal 의 input 단계에서 mount 즉시 onReady 호출하여
 * preview 단계로 직행한다 (사용자 추가 입력 없음).
 */
function ImmediateReady({
  action,
  onReady,
}: {
  action: BulkAction
  onReady: (input: BulkInputForAds) => void
}) {
  React.useEffect(() => {
    onReady({ action })
    // 한 번만 호출. action 변동 시에도 컴포넌트가 unmount/remount 되어 자연스레 재실행.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <p className="text-sm text-muted-foreground">
      선택한 소재의 ON/OFF 를 변경합니다. 미리보기로 이동 중...
    </p>
  )
}

// =============================================================================
// preview 단계 — 선택된 rows 의 현재 상태(before) → 액션 후 상태(after) 표
// =============================================================================

function AdToggleChangePreview({
  items,
  action,
}: {
  items: AdRow[]
  action: BulkAction
}) {
  const targetStatus: AdStatus = action === "toggleOn" ? "on" : "off"
  // 적용 후 상태가 현재와 동일한 행은 "변경 없음" 으로 표시 (skip 비슷).
  const noChange = items.filter((it) => it.status === targetStatus).length
  const willChange = items.length - noChange

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3 text-xs">
        <span className="font-medium text-foreground">
          변경 {willChange.toLocaleString()}건
        </span>
        {noChange > 0 && (
          <span className="font-medium text-muted-foreground">
            변경 없음 {noChange.toLocaleString()}건 (이미 {targetStatus.toUpperCase()})
          </span>
        )}
      </div>
      <div className="max-h-72 overflow-y-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>소재</TableHead>
              <TableHead>광고그룹</TableHead>
              <TableHead>현재</TableHead>
              <TableHead>→ 적용 후</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((it) => {
              const same = it.status === targetStatus
              const preview = extractAdPreview(it.fields)
              return (
                <TableRow
                  key={it.id}
                  className={cn(same && "text-muted-foreground")}
                >
                  <TableCell className="max-w-[240px] truncate font-medium">
                    {preview || "(미리보기 없음)"}
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {it.nccAdId}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-[160px] truncate text-xs text-muted-foreground">
                    {it.adgroup.name}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <AdStatusBadge status={it.status} />
                  </TableCell>
                  <TableCell className="font-medium">
                    {same ? (
                      <span className="text-xs text-muted-foreground">
                        변경 없음
                      </span>
                    ) : (
                      <AdStatusBadge status={targetStatus} />
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
