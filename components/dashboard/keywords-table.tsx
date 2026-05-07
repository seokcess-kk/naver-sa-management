"use client"

/**
 * 키워드 목록 + 인라인 편집 + 다중 선택 일괄 액션 (F-3.1 / F-3.2 / F-3.3)
 *
 * **서버 페이지네이션 모드** (정식 출시 전 disruptive 리팩토링):
 *   - 광고주 1개 키워드 44k+ 환경 — 5천 행 in-memory 한계 9배 초과
 *   - 클라이언트는 현재 페이지만 보유 (50/100/200/500), 필터·정렬·검색·페이지 변경은
 *     모두 URL 갱신 → RSC 재조회 → props 갱신
 *   - TanStack Table manualPagination/manualSorting/manualFiltering=true
 *   - 5천 행 가상 스크롤(TanStack Virtual) 제거 — 페이지당 ≤500 이라 일반 스크롤 충분
 *
 * F-3.1:
 *   - 컬럼: 체크박스 / 키워드 / 광고그룹(+캠페인) / 매치 / 입찰가 / ON-OFF /
 *           상태 / 검수 / 평균 노출 / 노출수 / 클릭수 / CTR / CPC / 총비용 / 최근 수정 / 액션
 *   - 정렬 가능: keyword, bidAmt, recentAvgRnk, updatedAt (서버 정렬 — URL sort 갱신)
 *     그 외 컬럼은 헤더 클릭 비활성 (F-3.1 요구 사항)
 *   - 검색: 키워드 텍스트 (300ms debounce) → URL q 갱신
 *   - 상태 필터: all / on / off / deleted → URL keywordStatus 갱신
 *
 * F-3.2 인라인 편집:
 *   - bidAmt + useGroupBidAmt / userLock — 셀 편집 즉시 API 반영 X
 *   - 클라이언트 staging Map<keywordId, KeywordPatch> 에 누적 → "변경 검토" 모달 → bulkUpdateKeywords
 *   - 미확정 셀 시각 구분: amber 배경 + ring
 *   - **페이지 간 보존**: staging 은 useState 로 관리. URL 변경(페이지/정렬/필터)
 *     은 RSC 재조회만 → KeywordsTable unmount 안 됨 → staging 유지.
 *     단, 페이지 새로고침 / 광고주 변경 시 초기화.
 *
 * F-3.3 다중 선택 일괄 액션:
 *   - 체크박스 — TanStack Table rowSelection 대신 컴포넌트 자체 selectedIds: Set<string>.
 *     **페이지 간 누적 보존**. 헤더 체크박스 = 현재 페이지 toggle, 다른 페이지 영향 X.
 *     사용자가 명시적으로 "전체 해제" 누르기 전엔 유지.
 *   - 액션바 카운트 = selectedIds.size (전 페이지 누적)
 *   - 액션: ON/OFF 토글 / 입찰가 변경 (절대값 / 비율 / 정액 증감)
 *   - 즉시 적용 X — BulkActionModal 4단계 (input → preview → submit → result)
 *   - 선택 1~500건 (zod 스키마와 일치)
 *
 * F-3.5 CSV 내보내기:
 *   - 현재 URL 필터 (q / status / scope) 그대로 server action 에 전달 — 현재 페이지가 아닌
 *     필터 매칭 전체. 페이지네이션 무관.
 *   - **TODO** — 본 PR 에선 export 버튼 disabled. 백엔드 server action(exportKeywordsCsv)
 *     준비되면 전환.
 *
 * 광고주 횡단 차단:
 *   - props.keywords 는 RSC 에서 `where: { adgroup: { campaign: { advertiserId } } }`
 *     로 한정된 결과만. UI 레벨에서 별도 advertiserId 검사는 없음.
 *
 * SPEC 6.2 F-3.1 / F-3.2 / F-3.3 / 11.2 / 안전장치 1.
 */

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type CellContext,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowUpDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  RotateCcwIcon,
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
import { Label } from "@/components/ui/label"
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
import { EmptyState } from "@/components/dashboard/empty-state"
import { KeywordStatusBadge } from "@/components/dashboard/keyword-status-badge"
import { InspectStatusBadge } from "@/components/dashboard/inspect-status-badge"
import { KeywordsCsvImportModal } from "@/components/dashboard/keywords-csv-import-modal"
import {
  KeywordsAddModal,
  type AdgroupOption,
} from "@/components/dashboard/keywords-add-modal"
import {
  KeywordsDeleteModal,
  type DeleteTargetRow,
} from "@/components/dashboard/keywords-delete-modal"
import { KeywordEstimateModal } from "@/components/dashboard/keyword-estimate-modal"
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
  bulkActionKeywords,
  bulkUpdateKeywords,
  exportKeywordsCsv,
  fetchKeywordsStats,
  previewBulkAction,
  type BulkActionKeywordsInput,
} from "@/app/(dashboard)/[advertiserId]/keywords/actions"
import { cn } from "@/lib/utils"
import {
  PERIOD_LABELS,
  formatInt,
  formatPct,
  formatWon,
  type AdMetrics,
  type AdsPeriod,
} from "@/lib/dashboard/metrics"
import {
  KEYWORD_PAGE_SIZES,
  type KeywordSort,
  type KeywordStatusFilter,
} from "@/lib/navigation/keyword-page-params"
import type {
  KeywordStatus,
  InspectStatus,
} from "@/lib/generated/prisma/client"

// 상한 — bulkActionKeywordsSchema 의 .max(500) 와 일치.
const BULK_ACTION_MAX = 500

const STATUS_FILTER_LABELS: Record<KeywordStatusFilter, string> = {
  all: "상태 (전체)",
  on: "ON",
  off: "OFF",
  deleted: "삭제됨",
}

// =============================================================================
// 타입
// =============================================================================

// F-3.6 키워드 추가 모달용 광고그룹 옵션 — 정의는 keywords-add-modal.tsx,
// page.tsx 가 본 모듈만 import 하도록 re-export.
export type { AdgroupOption }

// 페이지 / 백엔드 / 본 컴포넌트 공유 타입 — page-params 모듈에서 single source.
export type { KeywordSort, KeywordStatusFilter } from "@/lib/navigation/keyword-page-params"

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
  /** F-3.5 CSV 내보내기 — UPDATE 행 재업로드 시 멱등키 보존. CREATE 외엔 optional. */
  externalId: string | null
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
  /** P1 stats (광고주별 캐시 5분/1시간) — 클라이언트가 useEffect 로 fetchKeywordsStats. */
  metrics: AdMetrics
}

/**
 * 인라인 편집 staging 단건.
 *
 * - undefined 필드 = "이 row 에서 변경 안 함" (DB 원본 유지)
 * - bidAmt = null = "그룹 입찰가 사용으로 전환" (useGroupBidAmt=true 와 함께 staging)
 * - bidAmt = number = 직접 입찰가 설정
 *
 * 머지 정책:
 *   같은 row 에 같은 필드가 다시 들어오면 새 값으로 교체.
 *   patch 의 값이 row 원본과 동일해지면 그 필드만 제거 (= 부분 되돌리기).
 *   patch 가 비면 Map 에서 row 자체 제거.
 */
type KeywordPatch = {
  bidAmt?: number | null
  useGroupBidAmt?: boolean
  userLock?: boolean
}

type StagingMap = Map<string, KeywordPatch>

/**
 * F-3.3 다중 선택 액션 종류.
 */
type BulkAction = "toggleOn" | "toggleOff" | "bid"

/** BulkActionModal<KeywordRow, BulkInputForKeywords> 의 TInput 타입 (액션별 union) */
type BulkInputForKeywords =
  | { action: "toggleOn" }
  | { action: "toggleOff" }
  | { action: "bid"; mode: "absolute"; bidAmt: number }
  | { action: "bid"; mode: "delta"; amount: number; roundTo: 10 | 50 | 100 }
  | {
      action: "bid"
      mode: "ratio"
      percent: number
      roundTo: 10 | 50 | 100
    }

/** previewBulkAction 반환 항목 — actions.ts 의 PreviewItem 과 동일 shape */
type BulkPreviewItem = {
  keywordId: string
  keyword: string
  nccKeywordId: string
  adgroupName: string
  before: { bidAmt: number | null; useGroupBidAmt: boolean; userLock: boolean }
  after: { bidAmt: number | null; useGroupBidAmt: boolean; userLock: boolean } | null
  skipReason?: string
}

// 셀에서 staging / 선택을 직접 읽고 변경할 수 있는 컨텍스트. row.id 기반.
type StagingCtx = {
  staging: StagingMap
  applyPatch: (row: KeywordRow, patch: KeywordPatch) => void
  revertRow: (row: KeywordRow) => void
  editable: boolean
  isAdmin: boolean
  onRequestDelete: (row: KeywordRow) => void
  onRequestEstimate: (row: KeywordRow) => void
  /** 현재 행이 선택됐는지 */
  isRowSelected: (rowId: string) => boolean
  /** 단일 행 선택 토글 */
  toggleRow: (rowId: string, checked: boolean) => void
  /** 헤더 체크박스 — 현재 페이지 모든 행 선택 / 해제 (다른 페이지 영향 X) */
  togglePage: (checked: boolean) => void
  /** 현재 페이지 selection 상태 */
  pageSelectionState: "all" | "some" | "none"
}

// =============================================================================
// staging 머지 유틸
// =============================================================================

function mergePatch(
  row: KeywordRow,
  current: KeywordPatch | undefined,
  next: KeywordPatch,
): KeywordPatch | null {
  const merged: KeywordPatch = { ...(current ?? {}), ...next }

  if (merged.bidAmt !== undefined) {
    if (merged.bidAmt === null) {
      if (row.useGroupBidAmt) {
        delete merged.bidAmt
      }
    } else if (
      !row.useGroupBidAmt &&
      typeof row.bidAmt === "number" &&
      row.bidAmt === merged.bidAmt
    ) {
      delete merged.bidAmt
    }
  }

  if (merged.useGroupBidAmt !== undefined) {
    if (row.useGroupBidAmt === merged.useGroupBidAmt) {
      delete merged.useGroupBidAmt
      if (merged.bidAmt === null) delete merged.bidAmt
    }
  }

  if (merged.userLock !== undefined && row.userLock === merged.userLock) {
    delete merged.userLock
  }

  if (
    merged.bidAmt === undefined &&
    merged.useGroupBidAmt === undefined &&
    merged.userLock === undefined
  ) {
    return null
  }
  return merged
}

function effective(row: KeywordRow, patch: KeywordPatch | undefined) {
  return {
    bidAmt:
      patch?.bidAmt !== undefined ? patch.bidAmt : row.bidAmt,
    useGroupBidAmt:
      patch?.useGroupBidAmt !== undefined
        ? patch.useGroupBidAmt
        : row.useGroupBidAmt,
    userLock: patch?.userLock !== undefined ? patch.userLock : row.userLock,
  }
}

// =============================================================================
// sort 토큰 ↔ TanStack SortingState 변환
// =============================================================================

const SORT_FIELD_BY_COLUMN_ID: Record<string, "keyword" | "bidAmt" | "recentAvgRnk" | "updatedAt"> = {
  keyword: "keyword",
  bid: "bidAmt", // 컬럼 id 는 "bid", sort 토큰 필드는 "bidAmt"
  recentAvgRnk: "recentAvgRnk",
  updatedAt: "updatedAt",
}

function parseSortToState(sort: KeywordSort): SortingState {
  const [field, dir] = sort.split(":") as [string, "asc" | "desc"]
  // bidAmt → 컬럼 id "bid"
  const columnId = field === "bidAmt" ? "bid" : field
  return [{ id: columnId, desc: dir === "desc" }]
}

function buildSortToken(columnId: string, desc: boolean): KeywordSort | null {
  const field = SORT_FIELD_BY_COLUMN_ID[columnId]
  if (!field) return null
  return `${field}:${desc ? "desc" : "asc"}` as KeywordSort
}

// =============================================================================
// 컬럼 정의
// =============================================================================

function makeColumns(ctx: StagingCtx): ColumnDef<KeywordRow>[] {
  return [
    {
      id: "select",
      header: () => {
        // base-ui Checkbox 는 boolean 만 받음 (indeterminate 미지원).
        // some 일 때는 checked=true 로 처리 + 다음 클릭은 unchecked → 페이지 전체 해제.
        // ariadia-checked 보조 + 부모 div 에 ring 으로 시각 보강.
        const checked =
          ctx.pageSelectionState === "all" || ctx.pageSelectionState === "some"
        return (
          <span
            className={cn(
              "inline-flex items-center justify-center rounded-sm",
              ctx.pageSelectionState === "some" && "ring-1 ring-primary/40",
            )}
            title={
              ctx.pageSelectionState === "some"
                ? "현재 페이지 일부 선택됨 — 클릭하면 페이지 전체 해제"
                : ctx.pageSelectionState === "all"
                  ? "현재 페이지 전체 선택됨 — 클릭하면 페이지 전체 해제"
                  : "현재 페이지 전체 선택"
            }
          >
            <Checkbox
              checked={checked}
              onCheckedChange={(v) => ctx.togglePage(!!v)}
              aria-label="현재 페이지 전체 선택"
              aria-checked={
                ctx.pageSelectionState === "some" ? "mixed" : checked
              }
            />
          </span>
        )
      },
      cell: ({ row }) => (
        <Checkbox
          checked={ctx.isRowSelected(row.original.id)}
          onCheckedChange={(v) => ctx.toggleRow(row.original.id, !!v)}
          aria-label={`${row.original.keyword} 선택`}
        />
      ),
      enableSorting: false,
      size: 40,
    },
    {
      id: "stagingMarker",
      header: () => <span className="sr-only">변경 표시</span>,
      cell: ({ row }) => {
        const patch = ctx.staging.get(row.original.id)
        if (!patch) return null
        return (
          <div className="flex items-center gap-1">
            <span
              aria-label="변경됨"
              title="이 행에 미확정 변경이 있습니다"
              className="inline-block size-1.5 rounded-full bg-amber-500"
            />
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => ctx.revertRow(row.original)}
              title="이 행 변경 되돌리기"
            >
              <RotateCcwIcon />
            </Button>
          </div>
        )
      },
      enableSorting: false,
      size: 60,
    },
    {
      accessorKey: "keyword",
      id: "keyword",
      header: "키워드",
      cell: ({ row }) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{row.original.keyword}</span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {row.original.nccKeywordId}
          </span>
        </div>
      ),
      enableSorting: true,
    },
    {
      id: "adgroup",
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
      enableSorting: false,
    },
    {
      accessorKey: "matchType",
      header: "매치",
      cell: ({ row }) => <MatchTypeBadge value={row.original.matchType} />,
      enableSorting: false,
    },
    {
      id: "bid",
      accessorFn: (row) => (row.useGroupBidAmt ? null : row.bidAmt),
      header: "입찰가",
      cell: (info: CellContext<KeywordRow, unknown>) => (
        <BidCell row={info.row.original} ctx={ctx} />
      ),
      enableSorting: true,
      meta: { align: "right" },
    },
    {
      id: "userLock",
      accessorFn: (row) => row.userLock,
      header: "ON/OFF",
      cell: (info: CellContext<KeywordRow, unknown>) => (
        <UserLockCell row={info.row.original} ctx={ctx} />
      ),
      enableSorting: false,
      meta: { align: "center" },
    },
    {
      accessorKey: "status",
      header: "상태",
      cell: ({ row }) => <KeywordStatusBadge status={row.original.status} />,
      enableSorting: false,
    },
    {
      accessorKey: "inspectStatus",
      header: "검수",
      cell: ({ row }) => (
        <InspectStatusBadge status={row.original.inspectStatus} />
      ),
      enableSorting: false,
    },
    {
      accessorKey: "recentAvgRnk",
      id: "recentAvgRnk",
      header: "평균 노출",
      cell: ({ row }) => (
        <div className="text-right font-mono text-xs">
          {row.original.recentAvgRnk !== null
            ? row.original.recentAvgRnk.toFixed(1)
            : "—"}
        </div>
      ),
      enableSorting: true,
      meta: { align: "right" },
    },
    {
      id: "impCnt",
      accessorFn: (row) => row.metrics.impCnt,
      header: "노출수",
      cell: ({ row }) => (
        <div className="text-right font-mono text-sm">
          {formatInt(row.original.metrics.impCnt)}
        </div>
      ),
      enableSorting: false,
      meta: { align: "right" },
    },
    {
      id: "clkCnt",
      accessorFn: (row) => row.metrics.clkCnt,
      header: "클릭수",
      cell: ({ row }) => (
        <div className="text-right font-mono text-sm">
          {formatInt(row.original.metrics.clkCnt)}
        </div>
      ),
      enableSorting: false,
      meta: { align: "right" },
    },
    {
      id: "ctr",
      accessorFn: (row) => row.metrics.ctr,
      header: "클릭률",
      cell: ({ row }) => (
        <div className="text-right font-mono text-sm">
          {formatPct(row.original.metrics.ctr)}
        </div>
      ),
      enableSorting: false,
      meta: { align: "right" },
    },
    {
      id: "cpc",
      accessorFn: (row) => row.metrics.cpc,
      header: "평균 CPC",
      cell: ({ row }) => (
        <div className="text-right font-mono text-sm">
          {formatWon(row.original.metrics.cpc)}
        </div>
      ),
      enableSorting: false,
      meta: { align: "right" },
    },
    {
      id: "salesAmt",
      accessorFn: (row) => row.metrics.salesAmt,
      header: "총비용",
      cell: ({ row }) => (
        <div className="text-right font-mono text-sm font-medium">
          {formatWon(row.original.metrics.salesAmt)}
        </div>
      ),
      enableSorting: false,
      meta: { align: "right" },
    },
    {
      accessorKey: "updatedAt",
      id: "updatedAt",
      header: "최근 수정",
      cell: ({ row }) => (
        <div className="text-xs text-muted-foreground">
          {new Date(row.original.updatedAt).toLocaleString("ko-KR")}
        </div>
      ),
      enableSorting: true,
    },
    {
      id: "actions",
      header: () => <span className="sr-only">행 작업</span>,
      cell: ({ row }) => <KeywordRowActions row={row.original} ctx={ctx} />,
      enableSorting: false,
      size: 48,
    },
  ]
}

// =============================================================================
// 행 우측 액션 (케밥 메뉴) — F-3.7
// =============================================================================

function KeywordRowActions({
  row,
  ctx,
}: {
  row: KeywordRow
  ctx: StagingCtx
}) {
  const alreadyDeleted = row.status === "deleted"
  const canDelete = ctx.isAdmin && !alreadyDeleted

  const deleteTitle = !ctx.isAdmin
    ? "관리자 권한 필요"
    : alreadyDeleted
      ? "이미 삭제된 키워드"
      : undefined

  const canEstimate = ctx.editable
  const estimateTitle = canEstimate
    ? undefined
    : "키 미설정 — 시뮬레이터 사용 불가"

  return (
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`${row.keyword} 행 작업`}
            >
              <MoreHorizontalIcon />
            </Button>
          }
        />
        <DropdownMenuContent align="end" sideOffset={4} className="w-48">
          <DropdownMenuItem
            disabled={!canEstimate}
            title={estimateTitle}
            onClick={() => {
              if (!canEstimate) return
              ctx.onRequestEstimate(row)
            }}
          >
            입찰가 시뮬레이터
          </DropdownMenuItem>
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

const MATCH_BADGE_LABEL: Record<string, { ko: string; full: string }> = {
  EXACT: { ko: "정확", full: "정확 일치 (EXACT)" },
  PHRASE: { ko: "구문", full: "구문 일치 (PHRASE)" },
  BROAD: { ko: "확장", full: "확장 일치 (BROAD)" },
}

function MatchTypeBadge({ value }: { value: string | null }) {
  if (!value) {
    return <span className="text-xs text-muted-foreground">—</span>
  }
  const v = value.toUpperCase()
  const meta = MATCH_BADGE_LABEL[v]
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
      title={meta?.full ?? v}
    >
      {meta?.ko ?? v}
    </span>
  )
}

// =============================================================================
// 인라인 편집 셀 — userLock (ON/OFF 토글)
// =============================================================================

function UserLockCell({
  row,
  ctx,
}: {
  row: KeywordRow
  ctx: StagingCtx
}) {
  const patch = ctx.staging.get(row.id)
  const eff = effective(row, patch)
  const dirty = patch?.userLock !== undefined

  function toggle() {
    if (!ctx.editable) return
    ctx.applyPatch(row, { userLock: !eff.userLock })
  }

  const label = eff.userLock ? "OFF" : "ON"
  const variant = eff.userLock ? "outline" : "default"

  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-md py-0.5",
        dirty &&
          "bg-amber-50 ring-1 ring-amber-300 dark:bg-amber-900/10 dark:ring-amber-900/40",
      )}
    >
      <Button
        size="xs"
        variant={variant}
        onClick={toggle}
        disabled={!ctx.editable}
        title={
          ctx.editable
            ? `${label} 으로 두려면 그대로, 토글하려면 클릭`
            : "키 미설정 — 편집 불가"
        }
        className="min-w-12"
      >
        {label}
      </Button>
    </div>
  )
}

// =============================================================================
// 인라인 편집 셀 — bidAmt + useGroupBidAmt 조합
// =============================================================================

function BidCell({
  row,
  ctx,
}: {
  row: KeywordRow
  ctx: StagingCtx
}) {
  const patch = ctx.staging.get(row.id)
  const eff = effective(row, patch)
  const dirty =
    patch?.bidAmt !== undefined || patch?.useGroupBidAmt !== undefined

  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState<string>("")

  function startEdit() {
    if (!ctx.editable) return
    setDraft(
      eff.useGroupBidAmt || eff.bidAmt === null ? "" : String(eff.bidAmt),
    )
    setEditing(true)
  }

  function commit() {
    const trimmed = draft.trim()
    if (trimmed === "") {
      setEditing(false)
      return
    }
    const n = Number(trimmed)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      return
    }
    const next: KeywordPatch = { bidAmt: n }
    if (eff.useGroupBidAmt) next.useGroupBidAmt = false
    ctx.applyPatch(row, next)
    setEditing(false)
  }

  function cancel() {
    setEditing(false)
  }

  function switchToGroupBid() {
    if (!ctx.editable) return
    ctx.applyPatch(row, { useGroupBidAmt: true, bidAmt: null })
    setEditing(false)
  }

  function disableGroupBid() {
    if (!ctx.editable) return
    ctx.applyPatch(row, { useGroupBidAmt: false })
    setDraft("")
    setEditing(true)
  }

  const cellWrap = cn(
    "flex flex-col items-end gap-0.5 rounded-md px-1 py-0.5",
    dirty &&
      "bg-amber-50 ring-1 ring-amber-300 dark:bg-amber-900/10 dark:ring-amber-900/40",
  )

  if (editing) {
    return (
      <div className={cellWrap}>
        <Input
          autoFocus
          type="number"
          inputMode="numeric"
          min={0}
          step={10}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit()
            } else if (e.key === "Escape") {
              e.preventDefault()
              cancel()
            }
          }}
          className="h-7 w-24 text-right font-mono"
          placeholder="입찰가"
        />
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault()
            switchToGroupBid()
          }}
          className="text-[10px] text-muted-foreground hover:text-foreground"
        >
          그룹 입찰가로 전환
        </button>
      </div>
    )
  }

  return (
    <div className={cellWrap}>
      {eff.useGroupBidAmt ? (
        <button
          type="button"
          onClick={disableGroupBid}
          disabled={!ctx.editable}
          className={cn(
            "text-right text-xs",
            ctx.editable
              ? "text-muted-foreground hover:text-foreground"
              : "cursor-not-allowed text-muted-foreground/60",
          )}
          title={
            ctx.editable
              ? "그룹 입찰가 사용 해제하고 직접 입력"
              : "키 미설정 — 편집 불가"
          }
        >
          그룹입찰가
        </button>
      ) : (
        <button
          type="button"
          onClick={startEdit}
          disabled={!ctx.editable}
          className={cn(
            "text-right font-mono",
            ctx.editable
              ? "hover:text-foreground"
              : "cursor-not-allowed text-muted-foreground/60",
          )}
          title={ctx.editable ? "클릭해 입찰가 편집" : "키 미설정 — 편집 불가"}
        >
          {eff.bidAmt !== null ? eff.bidAmt.toLocaleString() : "—"}
        </button>
      )}
      {!eff.useGroupBidAmt && ctx.editable && (
        <button
          type="button"
          onClick={switchToGroupBid}
          className="text-[10px] text-muted-foreground hover:text-foreground"
        >
          그룹 입찰가로 전환
        </button>
      )}
    </div>
  )
}

// =============================================================================
// 메인 컴포넌트
// =============================================================================

export type KeywordsTablePagination = {
  /** 1-based */
  page: number
  pageSize: number
  totalPages: number
}

export type KeywordsTableFilters = {
  q: string
  status: KeywordStatusFilter
  sort: KeywordSort
}

export function KeywordsTable({
  advertiserId,
  hasKeys,
  keywords,
  total,
  pagination,
  filters,
  adgroups,
  userRole,
  period,
}: {
  advertiserId: string
  hasKeys: boolean
  /** 현재 페이지 행만 (전체 매칭 X) */
  keywords: KeywordRow[]
  /** 전체 매칭 수 (필터 적용 후) */
  total: number
  pagination: KeywordsTablePagination
  filters: KeywordsTableFilters
  adgroups: AdgroupOption[]
  userRole: "admin" | "operator" | "viewer"
  period: AdsPeriod
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const isAdmin = userRole === "admin"

  // searchParams 가 매 렌더 새 reference 라 effect 의존성에 직접 두면 무한 루프.
  // string snapshot 으로 안정화.
  const searchParamsString = searchParams.toString()

  /**
   * URL 갱신 헬퍼.
   *
   * - 빈 문자열 / 기본값 patch 는 query 에서 제거 → URL 깔끔.
   * - replace 사용 — 히스토리 누적 방지.
   * - scroll: false — 페이지 변경 시 상단으로 점프하지 않도록.
   * - resetPage=true 면 page=1 리셋 (검색 / 정렬 / 필터 / pageSize 변경 시).
   */
  const updateQuery = React.useCallback(
    (
      patch: Record<string, string | undefined>,
      options?: { resetPage?: boolean },
    ) => {
      const next = new URLSearchParams(searchParamsString)
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === "" || v === "all") next.delete(k)
        else next.set(k, v)
      }
      // 기본 정렬은 URL 에서 제거
      if (next.get("sort") === "updatedAt:desc") next.delete("sort")
      // 기본 pageSize 제거
      if (next.get("pageSize") === "100") next.delete("pageSize")
      if (options?.resetPage) next.delete("page")
      // page=1 도 default
      if (next.get("page") === "1") next.delete("page")

      const qs = next.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [router, pathname, searchParamsString],
  )

  // -- stats streaming -------------------------------------------------------
  const [keywordsWithMetrics, setKeywordsWithMetrics] = React.useState<KeywordRow[]>(keywords)
  const [statsLoading, setStatsLoading] = React.useState(true)
  const [statsError, setStatsError] = React.useState<string | null>(null)

  // 페이지 / 정렬 / 필터 변경 시마다 keywords reference 변경. 안정 key.
  const keywordsKey = React.useMemo(
    () =>
      `${pagination.page}:${pagination.pageSize}:${keywords.length}:${keywords[0]?.nccKeywordId ?? ""}:${keywords[keywords.length - 1]?.nccKeywordId ?? ""}`,
    [keywords, pagination.page, pagination.pageSize],
  )

  React.useEffect(() => {
    let cancelled = false
    setStatsLoading(true)
    setStatsError(null)
    setKeywordsWithMetrics(keywords)

    if (!hasKeys || keywords.length === 0) {
      setStatsLoading(false)
      return
    }

    fetchKeywordsStats(advertiserId, period)
      .then((res) => {
        if (cancelled) return
        if (res.ok) {
          const map = new Map(res.metrics.map((m) => [m.id, m]))
          setKeywordsWithMetrics(
            keywords.map((k) => {
              const m = map.get(k.nccKeywordId)
              return m
                ? {
                    ...k,
                    metrics: {
                      impCnt: m.impCnt,
                      clkCnt: m.clkCnt,
                      ctr: m.ctr,
                      cpc: m.cpc,
                      salesAmt: m.salesAmt,
                    },
                  }
                : k
            }),
          )
        } else {
          setStatsError(res.error)
        }
        setStatsLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setStatsError(err instanceof Error ? err.message : "stats 조회 실패")
        setStatsLoading(false)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keywordsKey 로 안정화
  }, [advertiserId, period, hasKeys, keywordsKey])

  // -- staging state (F-3.2 인라인 편집) — 페이지 간 보존 -----------------------
  const [staging, setStaging] = React.useState<StagingMap>(() => new Map())
  const [modalOpen, setModalOpen] = React.useState(false)
  const [csvOpen, setCsvOpen] = React.useState(false)
  const [addOpen, setAddOpen] = React.useState(false)
  const [deleteRow, setDeleteRow] = React.useState<KeywordRow | null>(null)
  const [estimateRow, setEstimateRow] = React.useState<KeywordRow | null>(null)

  // staging 행 캐시 — staging 에 들어간 row 의 KeywordRow 원본 보관.
  // 페이지 이동 후 동일 row 가 화면에 없어도 변경 검토 모달에서 사용.
  const [stagingRowCache, setStagingRowCache] = React.useState<Map<string, KeywordRow>>(
    () => new Map(),
  )

  // -- 다중 선택 (페이지 간 누적) — Set<keyword.id> -----------------------------
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(() => new Set())
  // 선택된 행 원본 캐시 — 다른 페이지에서 선택한 row 의 데이터 보관.
  const [selectedRowCache, setSelectedRowCache] = React.useState<Map<string, KeywordRow>>(
    () => new Map(),
  )

  const [bulkAction, setBulkAction] = React.useState<BulkAction | null>(null)

  const applyPatch = React.useCallback(
    (row: KeywordRow, patch: KeywordPatch) => {
      setStaging((prev) => {
        const next = new Map(prev)
        const merged = mergePatch(row, prev.get(row.id), patch)
        if (merged === null) next.delete(row.id)
        else next.set(row.id, merged)
        return next
      })
      setStagingRowCache((prev) => {
        if (prev.has(row.id)) return prev
        const next = new Map(prev)
        next.set(row.id, row)
        return next
      })
    },
    [],
  )

  const revertRow = React.useCallback((row: KeywordRow) => {
    setStaging((prev) => {
      if (!prev.has(row.id)) return prev
      const next = new Map(prev)
      next.delete(row.id)
      return next
    })
    setStagingRowCache((prev) => {
      if (!prev.has(row.id)) return prev
      const next = new Map(prev)
      next.delete(row.id)
      return next
    })
  }, [])

  function revertAll() {
    setStaging(new Map())
    setStagingRowCache(new Map())
  }

  const onRequestDelete = React.useCallback((row: KeywordRow) => {
    setDeleteRow(row)
  }, [])

  const onRequestEstimate = React.useCallback((row: KeywordRow) => {
    setEstimateRow(row)
  }, [])

  // 현재 페이지 row id → row 매핑
  const pageRowsById = React.useMemo(() => {
    const m = new Map<string, KeywordRow>()
    for (const k of keywordsWithMetrics) m.set(k.id, k)
    return m
  }, [keywordsWithMetrics])

  // -- 선택 핸들러 (페이지 간 누적) -------------------------------------------
  const isRowSelected = React.useCallback(
    (rowId: string) => selectedIds.has(rowId),
    [selectedIds],
  )

  const toggleRow = React.useCallback(
    (rowId: string, checked: boolean) => {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (checked) next.add(rowId)
        else next.delete(rowId)
        return next
      })
      setSelectedRowCache((prev) => {
        const next = new Map(prev)
        if (checked) {
          const row = pageRowsById.get(rowId)
          if (row) next.set(rowId, row)
        } else {
          next.delete(rowId)
        }
        return next
      })
    },
    [pageRowsById],
  )

  const togglePage = React.useCallback(
    (checked: boolean) => {
      const ids = Array.from(pageRowsById.keys())
      setSelectedIds((prev) => {
        const next = new Set(prev)
        for (const id of ids) {
          if (checked) next.add(id)
          else next.delete(id)
        }
        return next
      })
      setSelectedRowCache((prev) => {
        const next = new Map(prev)
        for (const id of ids) {
          if (checked) {
            const row = pageRowsById.get(id)
            if (row) next.set(id, row)
          } else {
            next.delete(id)
          }
        }
        return next
      })
    },
    [pageRowsById],
  )

  const pageSelectionState: "all" | "some" | "none" = React.useMemo(() => {
    const ids = Array.from(pageRowsById.keys())
    if (ids.length === 0) return "none"
    let checked = 0
    for (const id of ids) if (selectedIds.has(id)) checked++
    if (checked === 0) return "none"
    if (checked === ids.length) return "all"
    return "some"
  }, [pageRowsById, selectedIds])

  const ctx = React.useMemo<StagingCtx>(
    () => ({
      staging,
      applyPatch,
      revertRow,
      editable: hasKeys,
      isAdmin,
      onRequestDelete,
      onRequestEstimate,
      isRowSelected,
      toggleRow,
      togglePage,
      pageSelectionState,
    }),
    [
      staging,
      applyPatch,
      revertRow,
      hasKeys,
      isAdmin,
      onRequestDelete,
      onRequestEstimate,
      isRowSelected,
      toggleRow,
      togglePage,
      pageSelectionState,
    ],
  )

  const columns = React.useMemo(() => makeColumns(ctx), [ctx])

  // -- 검색 input — 300ms debounce 후 URL 갱신 (page=1 리셋) --------------------
  const [searchInput, setSearchInput] = React.useState(filters.q)

  // 외부(URL) q 변경 시 (예: scope clear) input 동기화. 단, 사용자 타이핑 중일 땐
  // searchInput !== filters.q 라 debounce effect 가 실행 → 다음 RSC 라운드에서 다시 매치.
  React.useEffect(() => {
    setSearchInput(filters.q)
  }, [filters.q])

  React.useEffect(() => {
    if (searchInput === filters.q) return
    const t = setTimeout(() => {
      updateQuery({ q: searchInput }, { resetPage: true })
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput])

  // -- TanStack Table — manualPagination/manualSorting/manualFiltering ---------
  const sortingState = React.useMemo(() => parseSortToState(filters.sort), [filters.sort])

  const handleSortingChange = React.useCallback(
    (updater: SortingState | ((old: SortingState) => SortingState)) => {
      const next =
        typeof updater === "function" ? updater(sortingState) : updater
      const head = next[0]
      if (!head) {
        updateQuery({ sort: undefined }, { resetPage: true })
        return
      }
      const token = buildSortToken(head.id, head.desc)
      if (!token) return
      updateQuery({ sort: token }, { resetPage: true })
    },
    [sortingState, updateQuery],
  )

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table imperative helpers
  const table = useReactTable<KeywordRow>({
    data: keywordsWithMetrics,
    columns,
    state: {
      sorting: sortingState,
      pagination: {
        pageIndex: pagination.page - 1, // 0-based
        pageSize: pagination.pageSize,
      },
    },
    pageCount: pagination.totalPages,
    onSortingChange: handleSortingChange,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
  })

  const rows = table.getRowModel().rows

  // -- staging 적용된 row 배열 — 페이지 간 보존 (캐시 + 현재 페이지 합산) -------
  const stagingRows = React.useMemo(() => {
    if (staging.size === 0) return []
    const byId = new Map<string, KeywordRow>(stagingRowCache)
    for (const k of keywordsWithMetrics) byId.set(k.id, k)
    const result: KeywordRow[] = []
    for (const id of staging.keys()) {
      const r = byId.get(id)
      if (r) result.push(r)
    }
    return result
  }, [keywordsWithMetrics, staging, stagingRowCache])

  // -- F-3.3 다중 선택 + 일괄 액션 — 페이지 간 누적 ----------------------------
  const selectedRows = React.useMemo(() => {
    if (selectedIds.size === 0) return []
    const byId = new Map<string, KeywordRow>(selectedRowCache)
    for (const k of keywordsWithMetrics) byId.set(k.id, k)
    const out: KeywordRow[] = []
    for (const id of selectedIds) {
      const r = byId.get(id)
      if (r) out.push(r)
    }
    return out
  }, [keywordsWithMetrics, selectedIds, selectedRowCache])

  const selectedCount = selectedIds.size
  const overSelectionLimit = selectedCount > BULK_ACTION_MAX

  function clearSelection() {
    setSelectedIds(new Set())
    setSelectedRowCache(new Map())
  }

  function openBulkAction(action: BulkAction) {
    if (selectedCount === 0) {
      toast.error("키워드를 1개 이상 선택하세요")
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
      // 인라인 staging 은 그대로 두지만 selection 은 비움 (적용 완료된 항목 누적 회피)
      setSelectedIds(new Set())
      setSelectedRowCache(new Map())
      router.refresh()
    }
  }

  const handleSubmit = React.useCallback(async (): Promise<BulkActionResult> => {
    const items = Array.from(staging.entries()).map(([keywordId, patch]) => {
      const apiItem: {
        keywordId: string
        bidAmt?: number | null
        useGroupBidAmt?: boolean
        userLock?: boolean
      } = { keywordId }
      if (patch.bidAmt !== undefined) apiItem.bidAmt = patch.bidAmt
      if (patch.useGroupBidAmt !== undefined)
        apiItem.useGroupBidAmt = patch.useGroupBidAmt
      if (patch.userLock !== undefined) apiItem.userLock = patch.userLock
      return apiItem
    })
    const res = await bulkUpdateKeywords(advertiserId, { items })
    return {
      batchId: res.batchId,
      total: res.total,
      success: res.success,
      failed: res.failed,
      items: res.items.map((it) => {
        const row = stagingRows.find((r) => r.id === it.keywordId)
        return {
          id: row?.nccKeywordId ?? it.keywordId,
          ok: it.ok,
          error: it.error,
        }
      }),
    }
  }, [advertiserId, staging, stagingRows])

  function handleClosed(didApply: boolean) {
    setModalOpen(false)
    if (didApply) {
      setStaging(new Map())
      setStagingRowCache(new Map())
      router.refresh()
    }
  }

  function gotoPage(targetPage: number) {
    const clamped = Math.min(Math.max(1, targetPage), pagination.totalPages)
    if (clamped === pagination.page) return
    updateQuery({ page: String(clamped) })
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 상단 액션 */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            const campaignIdsRaw = searchParams.get("campaignIds")
            const adgroupIdsRaw = searchParams.get("adgroupIds")
            const campaignIds = campaignIdsRaw
              ? campaignIdsRaw.split(",").filter(Boolean)
              : undefined
            const adgroupIds = adgroupIdsRaw
              ? adgroupIdsRaw.split(",").filter(Boolean)
              : undefined
            await toast.promise(
              (async () => {
                const res = await exportKeywordsCsv(advertiserId, {
                  q: filters.q || undefined,
                  status: filters.status,
                  campaignIds,
                  adgroupIds,
                })
                if (!res.ok) throw new Error(res.error)
                const blob = new Blob([res.csv], { type: "text/csv;charset=utf-8" })
                const url = URL.createObjectURL(blob)
                const a = document.createElement("a")
                a.href = url
                const ts = new Date().toISOString().replace(/[:.]/g, "-")
                a.download = `keywords-${ts}.csv`
                document.body.appendChild(a)
                a.click()
                document.body.removeChild(a)
                URL.revokeObjectURL(url)
                return res
              })(),
              {
                loading: "키워드 CSV 내보내는 중...",
                success: (res) =>
                  res.truncated
                    ? `${res.total.toLocaleString()}개 중 50,000개로 잘림 — 필터 좁혀서 재시도 권장`
                    : `${res.total.toLocaleString()}개 키워드 내보내기 완료`,
                error: (err) =>
                  `CSV 내보내기 실패: ${err instanceof Error ? err.message : String(err)}`,
              },
            )
          }}
          title="현재 필터 매칭 전체를 CSV로 내보냅니다 (페이지네이션 무관, 50,000개 한도)"
        >
          <DownloadIcon />
          CSV 내보내기
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (!hasKeys) {
              toast.error("키 미설정 — CSV 가져오기 비활성")
              return
            }
            setCsvOpen(true)
          }}
          disabled={!hasKeys}
          title={
            !hasKeys
              ? "키 미설정 — 먼저 API 키 / Secret 키 입력"
              : undefined
          }
        >
          CSV 가져오기
        </Button>
        <Button
          size="sm"
          onClick={() => {
            if (!hasKeys) {
              toast.error("키 미설정 — 키워드 추가 비활성")
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
                : "단건·다건 키워드 추가"
          }
        >
          키워드 추가
        </Button>
      </div>

      {!hasKeys && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="text-amber-700 dark:text-amber-400">
              API 키 미설정
            </CardTitle>
            <CardDescription>
              이 광고주는 API 키 / Secret 키가 입력되지 않았습니다. 네이버 SA 호출
              (동기화 / 인라인 편집)이 차단됩니다. admin 권한자가 광고주 상세
              화면에서 키를 입력하면 활성화됩니다.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* toolbar — 검색 / 상태 / 기간 / 카운트 */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
        <Input
          placeholder="키워드 검색..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="h-8 w-56"
        />
        <Select
          value={filters.status}
          onValueChange={(v) => {
            const next = (v ?? "all") as KeywordStatusFilter
            updateQuery(
              { keywordStatus: next === "all" ? undefined : next },
              { resetPage: true },
            )
          }}
        >
          <SelectTrigger className="w-32">
            <SelectValue placeholder="상태">
              {(v: string | null) =>
                STATUS_FILTER_LABELS[(v as KeywordStatusFilter) ?? "all"] ??
                "상태 (전체)"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">상태 (전체)</SelectItem>
            <SelectItem value="on">ON</SelectItem>
            <SelectItem value="off">OFF</SelectItem>
            <SelectItem value="deleted">삭제됨</SelectItem>
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setSearchInput("")
            updateQuery(
              { q: undefined, keywordStatus: undefined },
              { resetPage: true },
            )
          }}
          disabled={filters.q === "" && filters.status === "all"}
        >
          초기화
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Select
            value={period}
            onValueChange={(v) => {
              const next = (v ?? "last7days") as AdsPeriod
              updateQuery({ period: next === "last7days" ? undefined : next })
            }}
          >
            <SelectTrigger className="h-8 w-32">
              <SelectValue placeholder="기간">
                {(v: string | null) =>
                  PERIOD_LABELS[(v as AdsPeriod) ?? "last7days"]
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="today">오늘</SelectItem>
              <SelectItem value="yesterday">어제</SelectItem>
              <SelectItem value="last7days">지난 7일</SelectItem>
              <SelectItem value="last30days">지난 30일</SelectItem>
            </SelectContent>
          </Select>
          <div className="min-w-[120px]">
            {statsLoading ? (
              <span className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
                <span className="size-2 animate-pulse rounded-full bg-foreground/40" />
                지표 불러오는 중...
              </span>
            ) : statsError ? (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-900"
                title={statsError}
              >
                지표 조회 실패 — 동기화 후 재시도
              </span>
            ) : (
              <span className="invisible inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-[11px]">
                <span className="size-2 rounded-full bg-foreground/40" />
                지표 불러오는 중...
              </span>
            )}
          </div>
          <span className="text-xs text-muted-foreground">
            총 {total.toLocaleString()}개
          </span>
        </div>
      </div>

      {/* 변경 검토 바 */}
      {staging.size > 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-900/40 dark:bg-amber-900/10">
          <span className="text-sm font-medium text-amber-900 dark:text-amber-200">
            미확정 변경 {staging.size}건 (페이지 간 누적)
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={revertAll}>
              전체 되돌리기
            </Button>
            <Button
              size="sm"
              onClick={() => setModalOpen(true)}
              disabled={!hasKeys}
            >
              변경 {staging.size}건 검토
            </Button>
          </div>
        </div>
      ) : null}

      {/* 다중 선택 일괄 액션 바 */}
      {selectedCount > 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 dark:border-sky-900/40 dark:bg-sky-900/10">
          <span className="text-sm font-medium text-sky-900 dark:text-sky-200">
            {selectedCount.toLocaleString()}개 선택됨 (페이지 간 누적)
          </span>
          <Button
            size="xs"
            variant="ghost"
            onClick={clearSelection}
            title="전체 해제"
          >
            전체 해제
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
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => openBulkAction("toggleOn")}
              disabled={overSelectionLimit || !hasKeys}
            >
              ON으로 변경
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => openBulkAction("toggleOff")}
              disabled={overSelectionLimit || !hasKeys}
            >
              OFF로 변경
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => openBulkAction("bid")}
              disabled={overSelectionLimit || !hasKeys}
            >
              입찰가 변경
            </Button>
          </div>
        </div>
      ) : null}

      {/* 테이블 (가상 스크롤 제거 — 페이지당 ≤500) */}
      <div className="relative max-h-[calc(100dvh-340px)] min-h-[320px] overflow-auto rounded-lg border">
        {keywords.length === 0 && total === 0 ? (
          <EmptyState
            title="표시할 키워드가 없습니다."
            description="우측 상단 동기화 버튼을 눌러 SA 에서 가져오세요. (광고그룹을 먼저 동기화해야 합니다.)"
          />
        ) : keywords.length === 0 && total > 0 ? (
          <div className="flex flex-col items-center gap-3 p-8 text-center">
            <p className="text-sm text-muted-foreground">
              현재 필터에 일치하는 키워드가 없습니다.
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setSearchInput("")
                updateQuery(
                  { q: undefined, keywordStatus: undefined },
                  { resetPage: true },
                )
              }}
            >
              필터 초기화
            </Button>
          </div>
        ) : (
          <table className="w-full caption-bottom text-sm" style={{ tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: 44 }} />
              <col style={{ width: 36 }} />
              <col style={{ width: 280 }} />
              <col style={{ width: 192 }} />
              <col style={{ width: 84 }} />
              <col style={{ width: 110 }} />
              <col style={{ width: 80 }} />
              <col style={{ width: 88 }} />
              <col style={{ width: 88 }} />
              <col style={{ width: 96 }} />
              <col style={{ width: 96 }} />
              <col style={{ width: 88 }} />
              <col style={{ width: 80 }} />
              <col style={{ width: 120 }} />
              <col style={{ width: 144 }} />
              <col style={{ width: 168 }} />
              <col style={{ width: 56 }} />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-background shadow-[inset_0_-1px_0_0_var(--border)]">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id} className="border-b">
                  {headerGroup.headers.map((header) => {
                    const canSort = header.column.getCanSort()
                    const sortDir = header.column.getIsSorted()
                    const align = (
                      header.column.columnDef.meta as
                        | { align?: "left" | "right" | "center" }
                        | undefined
                    )?.align
                    return (
                      <th
                        key={header.id}
                        className={cn(
                          "h-10 px-3 align-middle text-xs font-medium text-muted-foreground",
                          canSort && "cursor-pointer select-none hover:text-foreground",
                        )}
                        onClick={
                          canSort
                            ? header.column.getToggleSortingHandler()
                            : undefined
                        }
                      >
                        <div
                          className={cn(
                            "flex items-center gap-1",
                            align === "right" && "justify-end",
                            align === "center" && "justify-center",
                          )}
                        >
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
              {rows.map((row) => {
                const isDirty = staging.has(row.original.id)
                return (
                  <tr
                    key={row.id}
                    className={cn(
                      "border-b transition-colors hover:bg-muted/30",
                      isDirty &&
                        "bg-amber-50/40 hover:bg-amber-50/60 dark:bg-amber-900/5 dark:hover:bg-amber-900/10",
                    )}
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
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination footer */}
      <PaginationFooter
        page={pagination.page}
        totalPages={pagination.totalPages}
        pageSize={pagination.pageSize}
        total={total}
        onGoto={gotoPage}
        onPageSizeChange={(size) => {
          updateQuery({ pageSize: String(size) }, { resetPage: true })
        }}
      />

      {/* 변경 검토 모달 */}
      {modalOpen && (
        <BulkActionModal<KeywordRow, Record<string, never>>
          open
          onOpenChange={(o) => {
            if (!o) setModalOpen(false)
          }}
          title="키워드 변경 검토"
          description={`${stagingRows.length}개 키워드 변경됨. 미리보기 확인 후 적용됩니다.`}
          selectedItems={stagingRows}
          itemLabel="키워드"
          renderInput={(_, onReady) => (
            <ImmediateReady onReady={() => onReady({})} />
          )}
          renderPreview={(items) => (
            <KeywordChangePreview items={items} staging={staging} />
          )}
          onSubmit={handleSubmit}
          getItemDisplayName={(r) => r.keyword}
          getItemId={(r) => r.nccKeywordId}
          onClosed={handleClosed}
        />
      )}

      {/* 다중 선택 일괄 액션 모달 (F-3.3) */}
      {bulkAction !== null && (
        <KeywordsBulkActionModal
          advertiserId={advertiserId}
          action={bulkAction}
          selectedRows={selectedRows}
          onOpenChange={(o) => {
            if (!o) setBulkAction(null)
          }}
          onClosed={handleBulkActionClosed}
        />
      )}

      {/* CSV 가져오기 모달 (F-3.4) */}
      {csvOpen && (
        <KeywordsCsvImportModal
          advertiserId={advertiserId}
          open
          onOpenChange={(o) => {
            if (!o) setCsvOpen(false)
          }}
          onClosed={(didApply) => {
            if (didApply) {
              router.refresh()
            }
          }}
        />
      )}

      {/* 키워드 추가 모달 (F-3.6) */}
      {addOpen && (
        <KeywordsAddModal
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

      {/* F-3.7 단건 삭제 모달 */}
      {deleteRow !== null && (
        <KeywordsDeleteModal
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

      {/* F-10 입찰가 시뮬레이터 모달 */}
      {estimateRow !== null && (
        <KeywordEstimateModal
          key={estimateRow.id}
          advertiserId={advertiserId}
          keyword={{
            id: estimateRow.id,
            nccKeywordId: estimateRow.nccKeywordId,
            keyword: estimateRow.keyword,
          }}
          open
          onOpenChange={(o) => {
            if (!o) setEstimateRow(null)
          }}
        />
      )}
    </div>
  )
}

// =============================================================================
// Pagination footer — shadcn pagination 미존재. button 조합으로 구성.
// =============================================================================

function PaginationFooter({
  page,
  totalPages,
  pageSize,
  total,
  onGoto,
  onPageSizeChange,
}: {
  page: number
  totalPages: number
  pageSize: number
  total: number
  onGoto: (page: number) => void
  onPageSizeChange: (size: number) => void
}) {
  const jumpPages = React.useMemo(
    () => buildJumpPages(page, totalPages),
    [page, totalPages],
  )

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">페이지당</span>
        <Select
          value={String(pageSize)}
          onValueChange={(v) => {
            const next = Number(v ?? "100")
            if (!Number.isFinite(next)) return
            onPageSizeChange(next)
          }}
        >
          <SelectTrigger className="h-8 w-20">
            <SelectValue placeholder="100">{(v: string | null) => v ?? "100"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(KEYWORD_PAGE_SIZES as readonly number[]).map((s) => (
              <SelectItem key={s} value={String(s)}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">
          ({total.toLocaleString()}개 매칭)
        </span>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => onGoto(1)}
          disabled={page <= 1}
          aria-label="첫 페이지"
          className="hidden sm:inline-flex"
        >
          <ChevronsLeftIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => onGoto(page - 1)}
          disabled={page <= 1}
          aria-label="이전 페이지"
        >
          <ChevronLeftIcon />
        </Button>

        {/* 점프 버튼 — 모바일 숨김 */}
        <div className="hidden items-center gap-1 sm:flex">
          {jumpPages.map((p, idx) =>
            p === "ellipsis" ? (
              <span
                key={`ellipsis-${idx}`}
                className="px-1 text-xs text-muted-foreground"
              >
                …
              </span>
            ) : (
              <Button
                key={p}
                size="xs"
                variant={p === page ? "default" : "ghost"}
                onClick={() => onGoto(p)}
                className="min-w-8"
              >
                {p}
              </Button>
            ),
          )}
        </div>

        {/* 모바일 — 현재 / 전체 표시 */}
        <span className="px-2 text-xs font-medium sm:hidden">
          {page} / {totalPages}
        </span>

        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => onGoto(page + 1)}
          disabled={page >= totalPages}
          aria-label="다음 페이지"
        >
          <ChevronRightIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => onGoto(totalPages)}
          disabled={page >= totalPages}
          aria-label="마지막 페이지"
          className="hidden sm:inline-flex"
        >
          <ChevronsRightIcon />
        </Button>
      </div>

      <span className="hidden text-xs text-muted-foreground sm:inline">
        {page} / {totalPages} 페이지
      </span>
    </div>
  )
}

/**
 * 페이지 점프 후보 — totalPages ≤ 7 이면 모두, 그 외는 [1, ..., page-1, page, page+1, ..., totalPages]
 */
function buildJumpPages(
  page: number,
  totalPages: number,
): (number | "ellipsis")[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1)
  }
  const window = new Set<number>([1, totalPages, page, page - 1, page + 1])
  if (page <= 4) {
    for (let i = 1; i <= 5; i++) window.add(i)
    window.add(totalPages)
  } else if (page >= totalPages - 3) {
    window.add(1)
    for (let i = totalPages - 4; i <= totalPages; i++) window.add(i)
  }
  const sorted = Array.from(window)
    .filter((p) => p >= 1 && p <= totalPages)
    .sort((a, b) => a - b)
  const result: (number | "ellipsis")[] = []
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) {
      result.push("ellipsis")
    }
    result.push(sorted[i])
  }
  return result
}

function mapToDeleteTarget(row: KeywordRow): DeleteTargetRow {
  return {
    id: row.id,
    nccKeywordId: row.nccKeywordId,
    keyword: row.keyword,
    matchType: row.matchType,
    adgroupName: row.adgroup.name,
  }
}

// =============================================================================
// 모달 — input 단계 즉시 통과
// =============================================================================

function ImmediateReady({ onReady }: { onReady: () => void }) {
  React.useEffect(() => {
    onReady()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

// =============================================================================
// 모달 — preview 단계 (전/후 비교 표)
// =============================================================================

function KeywordChangePreview({
  items,
  staging,
}: {
  items: KeywordRow[]
  staging: StagingMap
}) {
  type Diff = {
    rowKey: string
    keyword: string
    adgroup: string
    field: "ON/OFF" | "입찰가" | "그룹입찰가"
    before: string
    after: string
  }
  const diffs: Diff[] = []
  for (const r of items) {
    const patch = staging.get(r.id)
    if (!patch) continue
    if (patch.userLock !== undefined) {
      diffs.push({
        rowKey: `${r.id}-userLock`,
        keyword: r.keyword,
        adgroup: r.adgroup.name,
        field: "ON/OFF",
        before: r.userLock ? "OFF" : "ON",
        after: patch.userLock ? "OFF" : "ON",
      })
    }
    if (patch.useGroupBidAmt === true) {
      diffs.push({
        rowKey: `${r.id}-useGroupBidAmt-on`,
        keyword: r.keyword,
        adgroup: r.adgroup.name,
        field: "그룹입찰가",
        before:
          r.useGroupBidAmt
            ? "사용 중"
            : r.bidAmt !== null
              ? `${r.bidAmt.toLocaleString()}원`
              : "—",
        after: "그룹입찰가 사용",
      })
    } else if (patch.useGroupBidAmt === false) {
      const afterBid =
        patch.bidAmt !== undefined && patch.bidAmt !== null
          ? `${patch.bidAmt.toLocaleString()}원`
          : "직접 입력 (값 미정)"
      diffs.push({
        rowKey: `${r.id}-useGroupBidAmt-off`,
        keyword: r.keyword,
        adgroup: r.adgroup.name,
        field: "입찰가",
        before: r.useGroupBidAmt
          ? "그룹입찰가 사용"
          : r.bidAmt !== null
            ? `${r.bidAmt.toLocaleString()}원`
            : "—",
        after: afterBid,
      })
    } else if (patch.bidAmt !== undefined && patch.bidAmt !== null) {
      diffs.push({
        rowKey: `${r.id}-bidAmt`,
        keyword: r.keyword,
        adgroup: r.adgroup.name,
        field: "입찰가",
        before:
          r.bidAmt !== null ? `${r.bidAmt.toLocaleString()}원` : "—",
        after: `${patch.bidAmt.toLocaleString()}원`,
      })
    }
  }

  return (
    <div className="max-h-72 overflow-y-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>키워드</TableHead>
            <TableHead>광고그룹</TableHead>
            <TableHead>변경 항목</TableHead>
            <TableHead>전</TableHead>
            <TableHead>→ 후</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {diffs.map((d) => (
            <TableRow key={d.rowKey}>
              <TableCell className="max-w-[200px] truncate font-medium">
                {d.keyword}
              </TableCell>
              <TableCell className="max-w-[160px] truncate text-xs text-muted-foreground">
                {d.adgroup}
              </TableCell>
              <TableCell className="text-xs">{d.field}</TableCell>
              <TableCell className="text-muted-foreground">
                {d.before}
              </TableCell>
              <TableCell className="font-medium">{d.after}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

// =============================================================================
// F-3.3 다중 선택 일괄 액션 모달 (BulkActionModal 래퍼)
// =============================================================================

function KeywordsBulkActionModal({
  advertiserId,
  action,
  selectedRows,
  onOpenChange,
  onClosed,
}: {
  advertiserId: string
  action: BulkAction
  selectedRows: KeywordRow[]
  onOpenChange: (open: boolean) => void
  onClosed: (didApply: boolean) => void
}) {
  const title =
    action === "toggleOn"
      ? "ON으로 변경 (일괄)"
      : action === "toggleOff"
        ? "OFF로 변경 (일괄)"
        : "입찰가 변경 (일괄)"

  const mapToServerInput = React.useCallback(
    (input: BulkInputForKeywords): BulkActionKeywordsInput => {
      if (input.action === "toggleOn") {
        return {
          action: "toggle",
          items: selectedRows.map((r) => ({
            keywordId: r.id,
            userLock: false,
          })),
        }
      }
      if (input.action === "toggleOff") {
        return {
          action: "toggle",
          items: selectedRows.map((r) => ({
            keywordId: r.id,
            userLock: true,
          })),
        }
      }
      if (input.mode === "absolute") {
        return {
          action: "bid",
          mode: "absolute",
          bidAmt: input.bidAmt,
          keywordIds: selectedRows.map((r) => r.id),
        }
      }
      if (input.mode === "delta") {
        return {
          action: "bid",
          mode: "delta",
          amount: input.amount,
          roundTo: input.roundTo,
          keywordIds: selectedRows.map((r) => r.id),
        }
      }
      return {
        action: "bid",
        mode: "ratio",
        percent: input.percent,
        roundTo: input.roundTo,
        keywordIds: selectedRows.map((r) => r.id),
      }
    },
    [selectedRows],
  )

  const handleSubmit = React.useCallback(
    async (input: BulkInputForKeywords): Promise<BulkActionResult> => {
      const payload = mapToServerInput(input)
      const res = await bulkActionKeywords(advertiserId, payload)
      return {
        batchId: res.batchId,
        total: res.total,
        success: res.success,
        failed: res.failed,
        items: res.items.map((it) => {
          const row = selectedRows.find((r) => r.id === it.keywordId)
          return {
            id: row?.nccKeywordId ?? it.keywordId,
            ok: it.ok,
            error: it.error,
          }
        }),
      }
    },
    [advertiserId, selectedRows, mapToServerInput],
  )

  return (
    <BulkActionModal<KeywordRow, BulkInputForKeywords>
      open
      onOpenChange={onOpenChange}
      title={title}
      itemLabel="키워드"
      selectedItems={selectedRows}
      renderInput={(_, onReady) => (
        <BulkActionInputForm action={action} onReady={onReady} />
      )}
      renderPreview={(_, input) => (
        <BulkActionPreviewView
          advertiserId={advertiserId}
          input={mapToServerInput(input)}
        />
      )}
      onSubmit={handleSubmit}
      getItemDisplayName={(r) => r.keyword}
      getItemId={(r) => r.nccKeywordId}
      onClosed={onClosed}
    />
  )
}

// =============================================================================
// F-3.3 input 단계 — toggleOn/Off 즉시 통과 / bid 는 모드 + 값 입력
// =============================================================================

function BulkActionInputForm({
  action,
  onReady,
}: {
  action: BulkAction
  onReady: (input: BulkInputForKeywords) => void
}) {
  React.useEffect(() => {
    if (action === "toggleOn") onReady({ action: "toggleOn" })
    else if (action === "toggleOff") onReady({ action: "toggleOff" })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action])

  const [mode, setMode] = React.useState<"absolute" | "ratio" | "delta">(
    "absolute",
  )
  const [bidAmtInput, setBidAmtInput] = React.useState("")
  const [percentInput, setPercentInput] = React.useState("")
  const [amountInput, setAmountInput] = React.useState("")
  const [roundTo, setRoundTo] = React.useState<10 | 50 | 100>(10)

  if (action !== "bid") {
    return (
      <p className="text-sm text-muted-foreground">
        선택한 키워드의 ON/OFF 를 변경합니다. 미리보기로 이동 중...
      </p>
    )
  }

  const trimmedBid = bidAmtInput.trim()
  const bidAmt =
    trimmedBid === "" ? null : Number(trimmedBid)
  const absoluteValid =
    bidAmt !== null &&
    Number.isFinite(bidAmt) &&
    Number.isInteger(bidAmt) &&
    bidAmt >= 0

  const trimmedPct = percentInput.trim()
  const pct = trimmedPct === "" ? null : Number(trimmedPct)
  const ratioValid =
    pct !== null &&
    Number.isFinite(pct) &&
    pct >= -90 &&
    pct <= 900 &&
    Math.round(pct * 10) / 10 === pct

  const trimmedAmount = amountInput.trim()
  const amount = trimmedAmount === "" ? null : Number(trimmedAmount)
  const deltaValid =
    amount !== null &&
    Number.isFinite(amount) &&
    Number.isInteger(amount) &&
    amount >= -1_000_000 &&
    amount <= 1_000_000 &&
    amount !== 0

  const valid =
    mode === "absolute"
      ? absoluteValid
      : mode === "ratio"
        ? ratioValid
        : deltaValid

  function handleSubmitForm() {
    if (!valid) return
    if (mode === "absolute") {
      onReady({ action: "bid", mode: "absolute", bidAmt: bidAmt! })
    } else if (mode === "ratio") {
      onReady({ action: "bid", mode: "ratio", percent: pct!, roundTo })
    } else {
      onReady({ action: "bid", mode: "delta", amount: amount!, roundTo })
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <Label className="flex cursor-pointer items-center gap-2 text-sm font-normal">
          <input
            type="radio"
            name="bid-mode"
            checked={mode === "absolute"}
            onChange={() => setMode("absolute")}
          />
          절대값
        </Label>
        <Label className="flex cursor-pointer items-center gap-2 text-sm font-normal">
          <input
            type="radio"
            name="bid-mode"
            checked={mode === "ratio"}
            onChange={() => setMode("ratio")}
          />
          비율
        </Label>
        <Label className="flex cursor-pointer items-center gap-2 text-sm font-normal">
          <input
            type="radio"
            name="bid-mode"
            checked={mode === "delta"}
            onChange={() => setMode("delta")}
          />
          정액 증감
        </Label>
      </div>

      {mode === "absolute" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bulk-bidAmt">입찰가 (원)</Label>
          <Input
            id="bulk-bidAmt"
            type="number"
            inputMode="numeric"
            min={0}
            step={10}
            value={bidAmtInput}
            onChange={(e) => setBidAmtInput(e.target.value)}
            placeholder="예: 500"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && valid) handleSubmitForm()
            }}
          />
          <p className="text-xs text-muted-foreground">
            선택한 모든 키워드에 동일 입찰가가 적용됩니다 (그룹입찰가 사용은
            해제). 0 이상의 정수.
          </p>
        </div>
      ) : mode === "ratio" ? (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bulk-percent">증감 (%)</Label>
            <Input
              id="bulk-percent"
              type="number"
              inputMode="decimal"
              step={0.1}
              min={-90}
              max={900}
              value={percentInput}
              onChange={(e) => setPercentInput(e.target.value)}
              placeholder="예: 10 또는 -5"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid) handleSubmitForm()
              }}
            />
            <p className="text-xs text-muted-foreground">
              -90% ~ +900% (정수 또는 소수 1자리). 음수는 입찰가 감소.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>반올림 단위 (원)</Label>
            <div className="flex gap-2">
              {([10, 50, 100] as const).map((v) => (
                <Button
                  key={v}
                  type="button"
                  size="sm"
                  variant={roundTo === v ? "default" : "outline"}
                  onClick={() => setRoundTo(v)}
                >
                  {v}
                </Button>
              ))}
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bulk-amount">증감액 (원)</Label>
            <Input
              id="bulk-amount"
              type="number"
              inputMode="numeric"
              step={10}
              min={-1_000_000}
              max={1_000_000}
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              placeholder="예: 100 또는 -100"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid) handleSubmitForm()
              }}
            />
            <p className="text-xs text-muted-foreground">
              현재 입찰가 기준으로 같은 금액을 더하거나 뺍니다. 음수는 입찰가
              감소이며, 0원 아래로 내려가면 0원으로 보정됩니다.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>반올림 단위 (원)</Label>
            <div className="flex gap-2">
              {([10, 50, 100] as const).map((v) => (
                <Button
                  key={v}
                  type="button"
                  size="sm"
                  variant={roundTo === v ? "default" : "outline"}
                  onClick={() => setRoundTo(v)}
                >
                  {v}
                </Button>
              ))}
            </div>
          </div>
        </>
      )}

      <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/10 dark:text-amber-300">
        ⓘ 그룹 입찰가를 사용 중인 키워드는 광고그룹 기본 입찰가를 기준으로
        계산합니다. 광고그룹 기본 입찰가도 없는 행은 미리보기에서 스킵 표시되며
        적용되지 않습니다.
      </p>

      <div className="flex justify-end">
        <Button onClick={handleSubmitForm} disabled={!valid}>
          미리보기
        </Button>
      </div>
    </div>
  )
}

// =============================================================================
// F-3.3 preview 단계 — previewBulkAction 호출 후 결과 테이블
// =============================================================================

type PreviewState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: BulkPreviewItem[] }

function BulkActionPreviewView({
  advertiserId,
  input,
}: {
  advertiserId: string
  input: BulkActionKeywordsInput
}) {
  const inputKey = React.useMemo(() => JSON.stringify(input), [input])
  const [state, setState] = React.useState<PreviewState>({ kind: "loading" })

  React.useEffect(() => {
    let cancelled = false
    previewBulkAction(advertiserId, input)
      .then((res) => {
        if (cancelled) return
        setState({
          kind: "ready",
          items: res.items as BulkPreviewItem[],
        })
      })
      .catch((e) => {
        if (cancelled) return
        setState({
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [advertiserId, inputKey])

  if (state.kind === "loading") {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        미리보기 계산 중...
      </div>
    )
  }
  if (state.kind === "error") {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        미리보기 실패: {state.message}
      </div>
    )
  }
  const items = state.items
  if (items.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-muted-foreground">
        미리보기 항목이 없습니다.
      </p>
    )
  }

  const showUserLockCol = input.action === "toggle"
  const showBidCol = input.action === "bid"

  const skipCount = items.filter((it) => it.skipReason).length
  const applyCount = items.length - skipCount

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3 text-xs">
        <span className="font-medium text-foreground">
          변경 {applyCount.toLocaleString()}건
        </span>
        {skipCount > 0 && (
          <span className="font-medium text-destructive">
            skip {skipCount.toLocaleString()}건 (광고그룹 기본가도 없음)
          </span>
        )}
      </div>
      <div className="max-h-72 overflow-y-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>키워드</TableHead>
              <TableHead>광고그룹</TableHead>
              {showBidCol && (
                <>
                  <TableHead className="text-right">입찰가 (현재)</TableHead>
                  <TableHead className="text-right">→ (적용 후)</TableHead>
                </>
              )}
              {showUserLockCol && (
                <>
                  <TableHead>ON/OFF (현재)</TableHead>
                  <TableHead>→ (적용 후)</TableHead>
                </>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((it) => {
              const skip = !!it.skipReason
              return (
                <TableRow
                  key={it.keywordId}
                  className={cn(
                    skip &&
                      "bg-destructive/5 hover:bg-destructive/10 dark:bg-destructive/10",
                  )}
                >
                  <TableCell className="max-w-[200px] truncate font-medium">
                    {it.keyword}
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {it.nccKeywordId}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-[160px] truncate text-xs text-muted-foreground">
                    {it.adgroupName}
                  </TableCell>
                  {showBidCol && (
                    <>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        {formatBid(
                          it.before.bidAmt,
                          it.before.useGroupBidAmt,
                        )}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right font-mono",
                          skip && "text-destructive",
                        )}
                      >
                        {skip
                          ? "광고그룹 기본가도 없음 — 적용 안 됨"
                          : it.after !== null
                            ? formatBid(
                                it.after.bidAmt,
                                it.after.useGroupBidAmt,
                              )
                            : "—"}
                      </TableCell>
                    </>
                  )}
                  {showUserLockCol && (
                    <>
                      <TableCell className="text-xs text-muted-foreground">
                        {it.before.userLock ? "OFF" : "ON"}
                      </TableCell>
                      <TableCell className="font-medium">
                        {it.after !== null
                          ? it.after.userLock
                            ? "OFF"
                            : "ON"
                          : "—"}
                      </TableCell>
                    </>
                  )}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function formatBid(bidAmt: number | null, useGroupBidAmt: boolean): string {
  if (useGroupBidAmt) return "그룹입찰가"
  if (bidAmt === null) return "—"
  return `${bidAmt.toLocaleString()}원`
}
