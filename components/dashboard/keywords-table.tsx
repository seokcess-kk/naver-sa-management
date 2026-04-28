"use client"

/**
 * 키워드 목록 + 인라인 편집 (F-3.1 / F-3.2) — TanStack Table v8 + TanStack Virtual
 *
 * F-3.1 (이전 PR):
 *   - 5천 행 가상 스크롤 (TanStack Virtual: estimateSize 56 / overscan 10)
 *   - 컬럼: 체크박스 / 키워드 / 광고그룹(+캠페인) / 매치 / 입찰가 / 그룹입찰가 사용 /
 *           상태 / 검수 / 평균 노출 / 최근 수정
 *   - 정렬: 헤더 클릭 → asc / desc / 없음 순환
 *   - 클라이언트 필터: 키워드 검색(debounce 200ms) / 매치타입 / 상태 / 검수 / 광고그룹
 *   - 동기화 버튼 (광고주 단위)
 *
 * F-3.2 (본 작업):
 *   - 인라인 편집 3개 컬럼: userLock(ON/OFF) / bidAmt + useGroupBidAmt / userLock
 *     - 셀 편집은 즉시 API 반영 X. 클라이언트 staging Map<keywordId, KeywordPatch>
 *       에 누적된 후 "변경 검토" 모달로 일괄 미리보기 → 확정 → bulkUpdateKeywords
 *   - 미확정 셀 시각 구분: amber 배경 + 좌측 ring
 *   - 미확정 행: 행 시작에 작은 "●" 마커
 *   - 변경 검토 바: staging.size > 0 일 때 "변경 N건 검토" + "전체 되돌리기"
 *   - BulkActionModal 재사용 (input 단계 mount 즉시 onReady — preview 직행)
 *   - 행별 "되돌리기" 버튼 (staging 에 들어간 행에만 노출)
 *
 * 본 PR 범위 X (후속):
 *   - F-3.3 다중 선택 일괄 — 체크박스 + 액션 버튼은 disabled 자리 그대로 유지
 *     (인라인 편집과 다중 선택은 같은 테이블에 공존하지만 흐름은 별개)
 *   - F-3.4 / F-3.5 CSV
 *   - F-3.6 / F-3.7 키워드 추가 / 단건 삭제
 *
 * 광고주 횡단 차단:
 *   - props.keywords 는 RSC 에서 `where: { adgroup: { campaign: { advertiserId } } }`
 *     로 한정된 결과만. UI 레벨에서 별도 advertiserId 검사는 없음.
 *
 * staging 상태 모델:
 *   - Map<row.id (앱 DB Keyword.id), KeywordPatch>
 *   - 같은 row 의 같은 필드를 다시 편집하면 머지 (replace 아님)
 *   - patch 값이 원본과 같아지면 그 필드는 patch 에서 제거
 *   - patch 가 비면 Map 에서 row 제거 ("변경 취소")
 *
 * 가상 스크롤 호환:
 *   - 인라인 편집 인풋 추가로 행 높이 증가 → estimateSize 56 (기존 48) 로 상향
 *   - staging Map 은 매 변경마다 새 Map 인스턴스로 교체 → 컴포넌트 리렌더 자연스럽게 동작
 *   - 셀 컴포넌트는 staging 을 props 로 받아 직접 조회 (메모이제이션 X)
 *
 * SPEC 6.2 F-3.1 / F-3.2 / 11.2 / 안전장치 1.
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type CellContext,
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
import { KeywordStatusBadge } from "@/components/dashboard/keyword-status-badge"
import { InspectStatusBadge } from "@/components/dashboard/inspect-status-badge"
import { SyncKeywordsButton } from "@/components/dashboard/sync-keywords-button"
import {
  BulkActionModal,
  type BulkActionResult,
} from "@/components/forms/bulk-action-modal"
import { bulkUpdateKeywords } from "@/app/(dashboard)/[advertiserId]/keywords/actions"
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

// 셀에서 staging 을 직접 읽고 변경할 수 있는 컨텍스트. row.id 기반.
type StagingCtx = {
  staging: StagingMap
  /** 단건 patch 머지 — 원본과 같아진 필드는 제거, patch 가 비면 row 제거 */
  applyPatch: (row: KeywordRow, patch: KeywordPatch) => void
  /** 행 단위 되돌리기 (모든 staging 필드 제거) */
  revertRow: (row: KeywordRow) => void
  /** 편집 가능 여부 (hasKeys=false 면 false) */
  editable: boolean
}

// =============================================================================
// staging 머지 유틸
// =============================================================================

/**
 * 새 patch 한 건을 머지한 결과 patch 를 반환.
 *
 * - row 원본과 같아진 필드는 결과에서 제거
 * - 결과가 비면 null (= Map 에서 row 제거)
 */
function mergePatch(
  row: KeywordRow,
  current: KeywordPatch | undefined,
  next: KeywordPatch,
): KeywordPatch | null {
  const merged: KeywordPatch = { ...(current ?? {}), ...next }

  // bidAmt: null 은 "그룹입찰가 전환" 의미라 row 원본과 비교 시 row.useGroupBidAmt
  // 가 true 였다면 변경 의미 없음 (이미 그룹입찰가 사용 중) → 제거.
  if (merged.bidAmt !== undefined) {
    if (merged.bidAmt === null) {
      // null 은 그룹입찰가로 전환 의도. useGroupBidAmt=true 와 짝으로만 의미 있음.
      // useGroupBidAmt 가 false 인데 bidAmt=null 만 들어온 어색한 조합은 제거.
      // (UI 가 항상 짝으로 setStaging 하므로 기본적으로 발생 X — 안전망)
      if (row.useGroupBidAmt) {
        delete merged.bidAmt
      }
    } else if (
      !row.useGroupBidAmt &&
      typeof row.bidAmt === "number" &&
      row.bidAmt === merged.bidAmt
    ) {
      // useGroupBidAmt=false 상태에서 같은 숫자값으로 회귀
      delete merged.bidAmt
    }
  }

  if (merged.useGroupBidAmt !== undefined) {
    if (row.useGroupBidAmt === merged.useGroupBidAmt) {
      delete merged.useGroupBidAmt
      // 짝으로 들어온 bidAmt=null (그룹입찰가 전환) 도 같이 정리
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

/** 적용 후 effective 값을 산출 (셀 표시용). patch 없으면 row 원본 그대로. */
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

function makeColumns(ctx: StagingCtx): ColumnDef<KeywordRow>[] {
  return [
    {
      id: "select",
      header: () => (
        <Checkbox
          checked={false}
          onCheckedChange={() => {}}
          aria-label="전체 선택"
          // F-3.3 활성 전까지 disabled — 다중 선택 일괄 액션 비대상.
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
      // 변경 마커 + 행 단위 되돌리기 버튼 — staging 에 등재된 행만 노출
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
      enableColumnFilter: false,
      size: 60,
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
      // 입찰가 + 그룹입찰가 사용을 한 셀에 결합 — 인라인 편집 가능
      id: "bid",
      accessorFn: (row) => (row.useGroupBidAmt ? null : row.bidAmt),
      header: () => <div className="text-right">입찰가</div>,
      cell: (info: CellContext<KeywordRow, unknown>) => (
        <BidCell row={info.row.original} ctx={ctx} />
      ),
      enableSorting: true,
      sortingFn: (a, b) => {
        // 그룹입찰가 사용 (bidAmt 무시) 행은 마지막으로 보내기.
        // 정렬 기준은 staging 적용 후가 아닌 원본값 (정렬 stability 우선).
        const av = a.original.useGroupBidAmt ? null : a.original.bidAmt
        const bv = b.original.useGroupBidAmt ? null : b.original.bidAmt
        if (av === null && bv === null) return 0
        if (av === null) return 1
        if (bv === null) return -1
        return av - bv
      },
    },
    {
      // userLock 토글 — ON/OFF 인라인 편집
      id: "userLock",
      accessorFn: (row) => row.userLock,
      header: () => <div className="text-center">ON/OFF</div>,
      cell: (info: CellContext<KeywordRow, unknown>) => (
        <UserLockCell row={info.row.original} ctx={ctx} />
      ),
      enableSorting: true,
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

  // userLock=true → "OFF" (사용자가 잠금), false → "ON"
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
      // 빈 값 → 변경 취소 (편집 모드만 종료)
      setEditing(false)
      return
    }
    const n = Number(trimmed)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      // 잘못된 값 → 편집 모드 유지
      return
    }
    // useGroupBidAmt 가 true 였다면 자동으로 false 로 함께 staging
    // (개별 입찰가 입력 = 그룹 입찰가 사용 해제 의도)
    const next: KeywordPatch = { bidAmt: n }
    if (eff.useGroupBidAmt) next.useGroupBidAmt = false
    ctx.applyPatch(row, next)
    setEditing(false)
  }

  function cancel() {
    setEditing(false)
  }

  // 그룹 입찰가 사용으로 전환 — bidAmt=null + useGroupBidAmt=true 짝.
  // (이름이 `use*` 로 시작하면 ESLint 가 React Hook 으로 오인 → 다른 이름 사용)
  function switchToGroupBid() {
    if (!ctx.editable) return
    ctx.applyPatch(row, { useGroupBidAmt: true, bidAmt: null })
    setEditing(false)
  }

  function disableGroupBid() {
    // 그룹 입찰가 사용 해제 — 입력 모드로 전환 (값은 사용자가 입력)
    if (!ctx.editable) return
    ctx.applyPatch(row, { useGroupBidAmt: false })
    setDraft("")
    setEditing(true)
  }

  // -- 표시 -------------------------------------------------------------------
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
            // onBlur 보다 먼저 실행되도록 mousedown — 그룹입찰가로 전환 후 즉시 닫힘
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
      {/* 그룹입찰가 미사용일 때 작은 보조 액션 */}
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

export function KeywordsTable({
  advertiserId,
  hasKeys,
  keywords,
}: {
  advertiserId: string
  hasKeys: boolean
  keywords: KeywordRow[]
}) {
  const router = useRouter()

  // -- staging state ----------------------------------------------------------
  const [staging, setStaging] = React.useState<StagingMap>(() => new Map())
  const [modalOpen, setModalOpen] = React.useState(false)

  const applyPatch = React.useCallback(
    (row: KeywordRow, patch: KeywordPatch) => {
      setStaging((prev) => {
        const next = new Map(prev)
        const merged = mergePatch(row, prev.get(row.id), patch)
        if (merged === null) next.delete(row.id)
        else next.set(row.id, merged)
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
  }, [])

  function revertAll() {
    setStaging(new Map())
  }

  // ctx 는 셀이 직접 staging 을 읽고 변경할 수 있도록 columns 에 주입
  const ctx = React.useMemo<StagingCtx>(
    () => ({ staging, applyPatch, revertRow, editable: hasKeys }),
    [staging, applyPatch, revertRow, hasKeys],
  )

  const columns = React.useMemo(() => makeColumns(ctx), [ctx])

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
    // 인라인 편집 인풋 + 보조 액션 행 추가 → 행 높이 56 (기존 48에서 상향)
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
    setMatchTypeFilter("ALL")
    setStatusFilter("ALL")
    setInspectFilter("ALL")
    setAdgroupFilter("ALL")
  }

  // -- staging 적용된 row 배열 (모달 / 미리보기) -----------------------------
  const stagingRows = React.useMemo(() => {
    if (staging.size === 0) return []
    const byId = new Map(keywords.map((k) => [k.id, k]))
    const result: KeywordRow[] = []
    for (const id of staging.keys()) {
      const r = byId.get(id)
      if (r) result.push(r)
    }
    return result
  }, [keywords, staging])

  // BulkActionModal 의 onSubmit — bulkUpdateKeywords 호출 + 결과 매핑
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
      // 결과 화면의 displayName 매칭은 nccKeywordId 기반.
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
      router.refresh()
    }
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-xl font-medium leading-snug">
            키워드
          </h1>
          <p className="text-sm text-muted-foreground">
            셀을 클릭해 인라인 편집 후 일괄 적용. 다중 선택 일괄 액션 / CSV 는
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
              (동기화 / 인라인 편집)이 차단됩니다. admin 권한자가 광고주 상세
              화면에서 키를 입력하면 활성화됩니다.
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

      {/* 변경 검토 바 (F-3.2 인라인 편집 staging 카운터) */}
      <div
        className={cn(
          "flex items-center gap-2 rounded-lg border px-3 py-2",
          staging.size > 0
            ? "border-amber-300 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/10"
            : "bg-muted/10",
        )}
      >
        {staging.size === 0 ? (
          <span className="text-xs text-muted-foreground">
            {hasKeys
              ? "셀을 클릭해 인라인 편집을 시작하세요. 변경은 일괄 미리보기 후 적용됩니다."
              : "키 미설정 — 인라인 편집 비활성. admin 권한자가 키를 입력해야 합니다."}
          </span>
        ) : (
          <span className="text-sm font-medium text-amber-900 dark:text-amber-200">
            미확정 변경 {staging.size}건
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={revertAll}
            disabled={staging.size === 0}
          >
            전체 되돌리기
          </Button>
          <Button
            size="sm"
            onClick={() => setModalOpen(true)}
            disabled={staging.size === 0 || !hasKeys}
          >
            변경 {staging.size}건 검토
          </Button>
        </div>
      </div>

      {/* 다중 선택 일괄 액션 바 (F-3.3 도입 전까지 비활성 — 인라인 편집과 별개 흐름) */}
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
                const isDirty = staging.has(row.original.id)
                return (
                  <tr
                    key={row.id}
                    className={cn(
                      "border-b transition-colors hover:bg-muted/30",
                      isDirty &&
                        "bg-amber-50/40 hover:bg-amber-50/60 dark:bg-amber-900/5 dark:hover:bg-amber-900/10",
                    )}
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

      {/* 변경 검토 모달 — BulkActionModal 재사용 (input 단계 mount 즉시 onReady) */}
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
    </div>
  )
}

// =============================================================================
// 모달 — input 단계 즉시 통과 (인라인 편집은 사용자 입력이 이미 staging 에 누적됨)
// =============================================================================

function ImmediateReady({ onReady }: { onReady: () => void }) {
  React.useEffect(() => {
    onReady()
    // 한 번만 호출. onReady 의존성 변동 시에도 재호출 X.
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
  // 행마다 변경된 필드별로 한 줄씩 펼침. (한 행에 여러 필드 변경 가능)
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
    // useGroupBidAmt + bidAmt 가 같이 들어오는 경우 (그룹입찰가 전환) 는 한 줄로 표기
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
      // 그룹입찰가 사용 해제 — bidAmt 가 함께 patch 면 그 값까지 표기, 없으면 해제만
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
      // useGroupBidAmt 변경 없이 bidAmt 만 (이미 false 였던 행에서 숫자만 변경)
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
