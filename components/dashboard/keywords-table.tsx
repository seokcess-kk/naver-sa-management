"use client"

/**
 * 키워드 목록 + 인라인 편집 + 다중 선택 일괄 액션 (F-3.1 / F-3.2 / F-3.3)
 *
 * F-3.1 (이전 PR):
 *   - 5천 행 가상 스크롤 (TanStack Virtual: estimateSize 56 / overscan 10)
 *   - 컬럼: 체크박스 / 키워드 / 광고그룹(+캠페인) / 매치 / 입찰가 / 그룹입찰가 사용 /
 *           상태 / 검수 / 평균 노출 / 최근 수정
 *   - 정렬: 헤더 클릭 → asc / desc / 없음 순환
 *   - 클라이언트 필터: 키워드 검색(debounce 200ms) / 매치타입 / 상태 / 검수 / 광고그룹
 *   - 동기화 버튼 (광고주 단위)
 *
 * F-3.8 검색·필터 SPEC 충족 상태:
 *   - 키워드명 검색 ✓ (F-3.1 keywordTextFilter)
 *   - 매치타입 ✓ (F-3.1)
 *   - 상태 ✓ (F-3.1)
 *   - 성과 범위(노출/클릭/비용/CTR/CPC) — F-7.1 Stats API + Redis 캐시 의존.
 *     KeywordRow 에는 성과 데이터 없음. F-7.1 도입 후 컬럼·필터 보강 (TODO).
 *
 * F-3.2 (이전 PR):
 *   - 인라인 편집 3개 컬럼: userLock(ON/OFF) / bidAmt + useGroupBidAmt / userLock
 *     - 셀 편집은 즉시 API 반영 X. 클라이언트 staging Map<keywordId, KeywordPatch>
 *       에 누적된 후 "변경 검토" 모달로 일괄 미리보기 → 확정 → bulkUpdateKeywords
 *   - 미확정 셀 시각 구분: amber 배경 + 좌측 ring
 *   - 미확정 행: 행 시작에 작은 "●" 마커
 *   - 변경 검토 바: staging.size > 0 일 때 "변경 N건 검토" + "전체 되돌리기"
 *   - BulkActionModal 재사용 (input 단계 mount 즉시 onReady — preview 직행)
 *   - 행별 "되돌리기" 버튼 (staging 에 들어간 행에만 노출)
 *
 * F-3.3 (본 PR):
 *   - 체크박스 다중 선택 활성화 (header / row 모두). enableRowSelection=true.
 *   - 다중 선택 액션 바 (F-3.2 staging 카운터 바와 별도 영역) — 3개 액션:
 *     · ON으로 변경 (toggle userLock=false 일괄)
 *     · OFF로 변경 (toggle userLock=true 일괄)
 *     · 입찰가 변경 (bid 절대값 / 비율 — input 단계에서 모드 + 값 선택)
 *   - 즉시 적용 X — BulkActionModal 4단계 (input → preview → submit → result)
 *     · preview 단계는 previewBulkAction(advertiserId, input) 호출하여 baseline
 *       정확도(서버 시점 DB + 광고그룹 bidAmt 폴백) 보장
 *     · 확정 시 bulkActionKeywords(advertiserId, input) 호출
 *   - F-3.2 인라인 편집 staging 과 분리 — staging 이 있는 row 도 정상 선택 가능,
 *     bulk action 결과는 staging 을 건드리지 않는다 (다른 흐름이므로 사용자가
 *     의도하지 않은 staging 손실을 막기 위함).
 *   - 선택 1~500건 (zod 스키마 일치). 0건이거나 키 미설정이면 액션 disabled.
 *
 * 본 PR 범위 X (후속):
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
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import Papa from "papaparse"
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
  type Row,
} from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowUpDownIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  DownloadIcon,
  ListFilterIcon,
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
  sumMetrics,
  type AdMetrics,
  type AdsPeriod,
} from "@/lib/dashboard/metrics"
import type {
  KeywordStatus,
  InspectStatus,
} from "@/lib/generated/prisma/client"

// 상한 — bulkActionKeywordsSchema 의 .max(500) 와 일치.
const BULK_ACTION_MAX = 500

// Base UI Select.Value 는 children 에 (value) => ReactNode 를 전달하지 않으면
// raw value (예: "on", "pending", "EXACT") 를 그대로 표시한다. 한글 라벨 매핑.
const MATCH_LABELS: Record<string, string> = {
  ALL: "매치 (전체)",
  EXACT: "정확 일치 (EXACT)",
  PHRASE: "구문 일치 (PHRASE)",
  BROAD: "확장 일치 (BROAD)",
}
const STATUS_LABELS: Record<string, string> = {
  ALL: "상태 (전체)",
  on: "ON",
  off: "OFF",
  deleted: "삭제됨",
}
const INSPECT_LABELS: Record<string, string> = {
  ALL: "검수 (전체)",
  pending: "검수중",
  approved: "승인",
  rejected: "거절",
}
const USERLOCK_LABELS: Record<string, string> = {
  ALL: "잠금 (전체)",
  locked: "잠금",
  unlocked: "해제",
}
const RNK_LABELS: Record<string, string> = {
  ALL: "노출 (전체)",
  top: "1-5위",
  mid: "6-10위",
  low: "11위 이상",
  none: "데이터 없음",
}

// =============================================================================
// 타입
// =============================================================================

// F-3.6 키워드 추가 모달용 광고그룹 옵션 — 정의는 keywords-add-modal.tsx,
// page.tsx 가 본 모듈만 import 하도록 re-export.
export type { AdgroupOption }

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
  /** P1 stats (광고주별 캐시 5분/1시간) — RSC 가 page.tsx 에서 batch 조회. */
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
 *
 * - toggleOn  : userLock=false 일괄 적용 (사용자 ON)
 * - toggleOff : userLock=true 일괄 적용 (사용자 OFF)
 * - bid       : 입찰가 변경 (input 단계에서 absolute/ratio 모드 + 값 선택)
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

// 셀에서 staging 을 직접 읽고 변경할 수 있는 컨텍스트. row.id 기반.
type StagingCtx = {
  staging: StagingMap
  /** 단건 patch 머지 — 원본과 같아진 필드는 제거, patch 가 비면 row 제거 */
  applyPatch: (row: KeywordRow, patch: KeywordPatch) => void
  /** 행 단위 되돌리기 (모든 staging 필드 제거) */
  revertRow: (row: KeywordRow) => void
  /** 편집 가능 여부 (hasKeys=false 면 false) */
  editable: boolean
  /** F-3.7 — admin 한정 단건 삭제 권한. operator/viewer 는 메뉴 disabled. */
  isAdmin: boolean
  /** F-3.7 — 행 삭제 모달 열기 (action 컬럼 케밥 메뉴) */
  onRequestDelete: (row: KeywordRow) => void
  /** F-10 — 입찰가 시뮬레이터 모달 열기 (action 컬럼 케밥 메뉴). hasKeys 필요. */
  onRequestEstimate: (row: KeywordRow) => void
}

// =============================================================================
// F-3.5 CSV 내보내기 (현재 필터 / 정렬 적용된 rows → 클라이언트 직렬화)
// =============================================================================
//
// SPEC 6.3 CSV 규격 컬럼 순서:
//   operation, nccKeywordId, nccAdgroupId, keyword, matchType,
//   bidAmt, useGroupBidAmt, userLock, externalId
//
// - operation 은 "UPDATE" 고정 (재업로드 시 UPDATE 흐름 호환)
// - bidAmt null → 빈 셀 (그룹 입찰가 사용 행)
// - matchType null → 빈 셀
// - externalId null → 빈 셀 (UPDATE 에서는 optional)
// - boolean 은 "true"/"false" 문자열
// - 인코딩: UTF-8 + BOM (\uFEFF) → 한글 엑셀 호환
// - 파일명: keywords_{advertiserId}_{YYYYMMDD}_{HHmmss}.csv
//
// 서버 호출 X — 이미 RSC 에서 advertiserId 한정으로 가져온 rows 만 직렬화.

const KEYWORD_CSV_COLUMNS = [
  "operation",
  "nccKeywordId",
  "nccAdgroupId",
  "keyword",
  "matchType",
  "bidAmt",
  "useGroupBidAmt",
  "userLock",
  "externalId",
] as const

function exportKeywordsCsv(rows: KeywordRow[], advertiserId: string) {
  const data = rows.map((r) => ({
    operation: "UPDATE",
    nccKeywordId: r.nccKeywordId,
    nccAdgroupId: r.adgroup.nccAdgroupId,
    keyword: r.keyword,
    matchType: r.matchType ?? "",
    bidAmt: r.bidAmt ?? "",
    useGroupBidAmt: String(r.useGroupBidAmt),
    userLock: String(r.userLock),
    externalId: r.externalId ?? "",
  }))
  const csv = Papa.unparse(data, {
    columns: KEYWORD_CSV_COLUMNS as unknown as string[],
  })
  const blob = new Blob(["\uFEFF" + csv], {
    type: "text/csv;charset=utf-8",
  })
  const url = URL.createObjectURL(blob)

  // 파일명 타임스탬프 — 로컬 시간 기준 YYYYMMDD_HHmmss
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const ts =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const filename = `keywords_${advertiserId}_${ts}.csv`

  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
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

/**
 * userLock boolean 필터 — "locked" / "unlocked" / "ALL" 문자열 입력.
 * boolean 자체는 select value 로 다루기 어려워 string token 사용.
 */
const userLockFilter: FilterFn<KeywordRow> = (row, _columnId, value) => {
  if (value === "ALL" || value === undefined || value === null || value === "")
    return true
  return value === "locked" ? row.original.userLock : !row.original.userLock
}

/**
 * recentAvgRnk 범위 필터 — top(1-5) / mid(6-10) / low(11+) / none(null) / ALL.
 * Decimal(5,2) → number 직렬화된 row.original.recentAvgRnk 사용.
 */
const rnkRangeFilter: FilterFn<KeywordRow> = (row, _columnId, value) => {
  if (value === "ALL" || value === undefined || value === null || value === "")
    return true
  const v = row.original.recentAvgRnk
  if (value === "none") return v === null
  if (v === null) return false
  if (value === "top") return v >= 1 && v <= 5
  if (value === "mid") return v > 5 && v <= 10
  if (value === "low") return v > 10
  return true
}

// =============================================================================
// 컬럼 정의
// =============================================================================

function makeColumns(ctx: StagingCtx): ColumnDef<KeywordRow>[] {
  return [
    {
      id: "select",
      header: ({ table }) => {
        // 가시(필터·정렬 후) 행 기준 전체 선택 토글.
        // 5천 행 중 필터 적용 후 row 수가 적은 경우 그 가시 셋만 토글하도록.
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
          aria-label={`${row.original.keyword} 선택`}
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
      header: "입찰가",
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
      meta: { align: "right" },
    },
    {
      // userLock 토글 — ON/OFF 인라인 편집
      id: "userLock",
      accessorFn: (row) => row.userLock,
      header: "ON/OFF",
      cell: (info: CellContext<KeywordRow, unknown>) => (
        <UserLockCell row={info.row.original} ctx={ctx} />
      ),
      filterFn: userLockFilter,
      enableSorting: true,
      meta: { align: "center" },
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
      header: "평균 노출",
      cell: ({ row }) => (
        <div className="text-right font-mono text-xs">
          {row.original.recentAvgRnk !== null
            ? row.original.recentAvgRnk.toFixed(1)
            : "—"}
        </div>
      ),
      filterFn: rnkRangeFilter,
      enableSorting: true,
      meta: { align: "right" },
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
      id: "impCnt",
      accessorFn: (row) => row.metrics.impCnt,
      header: "노출수",
      cell: ({ row }) => (
        <div className="text-right font-mono text-sm">
          {formatInt(row.original.metrics.impCnt)}
        </div>
      ),
      enableSorting: true,
      sortingFn: (a, b) => a.original.metrics.impCnt - b.original.metrics.impCnt,
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
      enableSorting: true,
      sortingFn: (a, b) => a.original.metrics.clkCnt - b.original.metrics.clkCnt,
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
      enableSorting: true,
      sortingFn: (a, b) => a.original.metrics.ctr - b.original.metrics.ctr,
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
      enableSorting: true,
      sortingFn: (a, b) => a.original.metrics.cpc - b.original.metrics.cpc,
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
      enableSorting: true,
      sortingFn: (a, b) => a.original.metrics.salesAmt - b.original.metrics.salesAmt,
      meta: { align: "right" },
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
      // F-3.7 — 행 우측 액션 컬럼 (케밥 메뉴 → 단건 삭제 등). admin 한정.
      // 본 컬럼은 정렬/필터 비활성. status='deleted' 행도 메뉴는 노출하되 항목별로
      // disabled 처리 (이미 삭제된 키워드는 다시 삭제 불필요).
      id: "actions",
      header: () => <span className="sr-only">행 작업</span>,
      cell: ({ row }) => <KeywordRowActions row={row.original} ctx={ctx} />,
      enableSorting: false,
      enableColumnFilter: false,
      size: 48,
    },
  ]
}

// =============================================================================
// 행 우측 액션 (케밥 메뉴) — F-3.7
// =============================================================================

/**
 * 필터 적용 후 행 metrics 합계 (SA 콘솔 footer 동등).
 *
 * 컬럼 17개 매핑:
 *   1 select / 2 stagingMarker / 3 keyword / 4 adgroupId / 5 matchType / 6 bid /
 *   7 userLock / 8 status / 9 inspectStatus / 10 recentAvgRnk /
 *   11 impCnt / 12 clkCnt / 13 ctr / 14 cpc / 15 salesAmt / 16 updatedAt / 17 actions
 *
 * 합계 표시 위치:
 *   1: 빈 / 2~10 (colSpan=9): "필터 결과 N건 합계" 라벨 / 11~15: 합계 / 16~17: 빈
 */
function KeywordMetricsFooter({ rows }: { rows: Row<KeywordRow>[] }) {
  const totals = React.useMemo(
    () => sumMetrics(rows.map((r) => r.original.metrics)),
    [rows],
  )
  if (rows.length === 0) return null
  return (
    <tfoot className="sticky bottom-0 z-10 border-t-2 bg-background text-sm font-medium shadow-[0_-2px_8px_-2px_rgba(0,0,0,0.08)]">
      <tr>
        <td className="px-3 py-2.5" />
        <td className="px-3 py-2.5 text-xs text-muted-foreground" colSpan={9}>
          필터 결과 {rows.length.toLocaleString()}건 합계
        </td>
        <td className="px-3 py-2.5 text-right font-mono">
          {formatInt(totals.impCnt)}
        </td>
        <td className="px-3 py-2.5 text-right font-mono">
          {formatInt(totals.clkCnt)}
        </td>
        <td className="px-3 py-2.5 text-right font-mono">
          {formatPct(totals.ctr)}
        </td>
        <td className="px-3 py-2.5 text-right font-mono">
          {formatWon(totals.cpc)}
        </td>
        <td className="px-3 py-2.5 text-right font-mono font-semibold">
          {formatWon(totals.salesAmt)}
        </td>
        <td className="px-3 py-2.5" />
        <td className="px-3 py-2.5" />
      </tr>
    </tfoot>
  )
}

function KeywordRowActions({
  row,
  ctx,
}: {
  row: KeywordRow
  ctx: StagingCtx
}) {
  // status='deleted' 인 행은 다시 삭제 의미 없음 (idempotent 흐름이지만 UI 상 차단).
  const alreadyDeleted = row.status === "deleted"
  const canDelete = ctx.isAdmin && !alreadyDeleted

  const deleteTitle = !ctx.isAdmin
    ? "관리자 권한 필요"
    : alreadyDeleted
      ? "이미 삭제된 키워드"
      : undefined

  // F-10 — hasKeys=false 면 시뮬레이터 호출 불가 (Server Action 측에서 차단되긴 하나
  // UI 레벨에서도 사전 disabled 로 표시. ctx.editable=hasKeys 재사용).
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

// 짧은 한글 라벨 + title 에 영문 매치 코드 (호버 툴팁) — 셀 폭 절약 + 풀 라벨 인지.
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
  adgroups,
  userRole,
  period,
}: {
  advertiserId: string
  hasKeys: boolean
  keywords: KeywordRow[]
  /** F-3.6 키워드 추가 모달용 — page.tsx 가 광고주 한정으로 별도 조회. */
  adgroups: AdgroupOption[]
  /** F-3.7 — admin 한정 단건 삭제 권한 (RSC 에서 ctx.user.role 전달). */
  userRole: "admin" | "operator" | "viewer"
  /** RSC 가 searchParams.period 파싱 후 전달 (lib/dashboard/metrics). */
  period: AdsPeriod
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const isAdmin = userRole === "admin"

  // 필터를 URL query 로 동기화 (이동 후 복귀해도 맥락 보존).
  // - default 값(빈 문자열 / "ALL") 은 query 에서 제거하여 URL 을 깔끔하게 유지.
  // - replace 사용 — 히스토리 누적 방지.
  // - scroll: false — 가상 스크롤 위치 유지.
  // searchParams 는 useSearchParams() 가 매 렌더 새 reference 를 반환할 수 있어
  // useCallback dep 에 직접 두면 router.replace → RSC 재요청 → 리렌더 → 다시
  // updateQuery 재생성 → debounce effect 재실행 무한 루프가 발생한다.
  // string snapshot 으로 안정화.
  const searchParamsString = searchParams.toString()
  const updateQuery = React.useCallback(
    (patch: Record<string, string>) => {
      const next = new URLSearchParams(searchParamsString)
      for (const [k, v] of Object.entries(patch)) {
        if (v === "" || v === "ALL") next.delete(k)
        else next.set(k, v)
      }
      const qs = next.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [router, pathname, searchParamsString],
  )

  // -- stats streaming (페이지 진입 후 client useEffect 가 fetchKeywordsStats 호출) -----
  // 초기엔 metrics: EMPTY_METRICS → 페이지 즉시 표시 → stats 도착 시 keywords 갱신.
  // staging 로직은 keywordsWithMetrics 를 base 로 사용 (data 일관성).
  const [keywordsWithMetrics, setKeywordsWithMetrics] = React.useState<KeywordRow[]>(keywords)
  const [statsLoading, setStatsLoading] = React.useState(true)
  const [statsError, setStatsError] = React.useState<string | null>(null)

  // keywords 배열 reference 가 매 렌더 새로 생성되면(부모 RSC 재실행 / HMR / Strict Mode)
  // useEffect 가 무한 재실행되어 statsLoading=true 가 풀리지 않는다.
  // 실제 데이터 변경(키워드 추가/삭제 / 재정렬)만 감지하도록 안정 string key 로 dep 전환.
  const keywordsKey = React.useMemo(
    () =>
      `${keywords.length}:${keywords[0]?.nccKeywordId ?? ""}:${keywords[keywords.length - 1]?.nccKeywordId ?? ""}`,
    [keywords],
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keywords 는 keywordsKey 로 대체. stable key 변경 시에만 재요청.
  }, [advertiserId, period, hasKeys, keywordsKey])

  // -- staging state (F-3.2 인라인 편집) --------------------------------------
  const [staging, setStaging] = React.useState<StagingMap>(() => new Map())
  const [modalOpen, setModalOpen] = React.useState(false)
  // -- F-3.4 CSV 가져오기 모달 -----------------------------------------------
  const [csvOpen, setCsvOpen] = React.useState(false)
  // -- F-3.6 키워드 추가 모달 -------------------------------------------------
  const [addOpen, setAddOpen] = React.useState(false)
  // -- F-3.7 단건 삭제 모달 (admin 한정) -------------------------------------
  // null = 닫힘. 비-null 객체 mount 시점에만 모달 마운트 → 닫힐 때 자동 reset.
  const [deleteRow, setDeleteRow] = React.useState<KeywordRow | null>(null)
  // -- F-10 입찰가 시뮬레이터 모달 (read 전용 — staging 미적용, 전 권한자 사용 가능) -----
  const [estimateRow, setEstimateRow] = React.useState<KeywordRow | null>(null)

  // -- 다중 선택 + 일괄 액션 state (F-3.3) -----------------------------------
  // TanStack Table 의 rowSelection 은 row.id 기반 (getRowId=row.id 설정 → DB Keyword.id).
  const [rowSelection, setRowSelection] = React.useState<
    Record<string, boolean>
  >({})
  // 다중 선택 액션 모달 상태 — null = 닫힘, 그 외 = 해당 액션 모달 진행 중
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

  const onRequestDelete = React.useCallback((row: KeywordRow) => {
    setDeleteRow(row)
  }, [])

  const onRequestEstimate = React.useCallback((row: KeywordRow) => {
    setEstimateRow(row)
  }, [])

  // ctx 는 셀이 직접 staging 을 읽고 변경할 수 있도록 columns 에 주입
  const ctx = React.useMemo<StagingCtx>(
    () => ({
      staging,
      applyPatch,
      revertRow,
      editable: hasKeys,
      isAdmin,
      onRequestDelete,
      onRequestEstimate,
    }),
    [
      staging,
      applyPatch,
      revertRow,
      hasKeys,
      isAdmin,
      onRequestDelete,
      onRequestEstimate,
    ],
  )

  const columns = React.useMemo(() => makeColumns(ctx), [ctx])

  // -- 필터 state -------------------------------------------------------------
  // 초기값은 URL query 에서 읽음 (F-3.8 — 이동 후 복귀해도 맥락 보존).
  // useSearchParams 가 client 에서만 동작하므로 SSR 단계에선 기본값으로 hydrate.
  const [searchInput, setSearchInput] = React.useState(
    () => searchParams.get("q") ?? "",
  )
  const [debouncedSearch, setDebouncedSearch] = React.useState(
    () => searchParams.get("q") ?? "",
  )
  const [matchTypeFilter, setMatchTypeFilter] = React.useState<string>(
    () => searchParams.get("match") ?? "ALL",
  )
  const [statusFilter, setStatusFilter] = React.useState<string>(
    () => searchParams.get("status") ?? "ALL",
  )
  const [inspectFilter, setInspectFilter] = React.useState<string>(
    () => searchParams.get("inspect") ?? "ALL",
  )
  const [adgroupFilter, setAdgroupFilter] = React.useState<string>(
    () => searchParams.get("adgroup") ?? "ALL",
  )
  const [userLockFilterValue, setUserLockFilterValue] = React.useState<string>(
    () => searchParams.get("lock") ?? "ALL",
  )
  const [rnkFilter, setRnkFilter] = React.useState<string>(
    () => searchParams.get("rnk") ?? "ALL",
  )
  const [sorting, setSorting] = React.useState<SortingState>([
    { id: "updatedAt", desc: true },
  ])

  // 고급 필터(매치 / 상태 / 검수 / 잠금 / 평균노출) 활성 갯수 — 1차 toolbar 의 "필터" 버튼 배지.
  const advancedActiveCount =
    (matchTypeFilter !== "ALL" ? 1 : 0) +
    (statusFilter !== "ALL" ? 1 : 0) +
    (inspectFilter !== "ALL" ? 1 : 0) +
    (userLockFilterValue !== "ALL" ? 1 : 0) +
    (rnkFilter !== "ALL" ? 1 : 0)

  // 진입 시 활성 필터가 있으면 자동 펼침 (URL scope 진입자도 어떤 필터가 적용됐는지
  // 즉시 보임). 사용자 토글 후엔 그 상태 유지 — 초기 1회 결정.
  const [showAdvanced, setShowAdvanced] = React.useState(
    () => advancedActiveCount > 0,
  )

  // 검색 input debounce 200ms — URL query 도 함께 갱신.
  // updateQuery 는 의존성에서 제외 — searchInput 변경에만 반응. updateQuery
  // closure 내부에 stable searchParamsString 을 사용해 stale 우려 없음.
  React.useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(searchInput)
      updateQuery({ q: searchInput })
    }, 200)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (userLockFilterValue !== "ALL") {
      f.push({ id: "userLock", value: userLockFilterValue })
    }
    if (rnkFilter !== "ALL") {
      f.push({ id: "recentAvgRnk", value: rnkFilter })
    }
    return f
  }, [
    debouncedSearch,
    matchTypeFilter,
    statusFilter,
    inspectFilter,
    adgroupFilter,
    userLockFilterValue,
    rnkFilter,
  ])

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table returns imperative helpers; keep this component out of React Compiler memoization.
  const table = useReactTable<KeywordRow>({
    data: keywordsWithMetrics,
    columns,
    state: { sorting, columnFilters, rowSelection },
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getRowId: (row) => row.id,
    // F-3.3 — 다중 선택 활성. F-3.2 staging 행도 선택 가능 (별개 흐름).
    enableRowSelection: true,
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
  // sticky tfoot 높이(약 48px) 만큼 padding-bottom 에 추가 — 마지막 가시 행이
  // sticky footer 뒤에 가려지지 않도록 빈 공간 확보.
  const STICKY_FOOTER_HEIGHT = 48
  const paddingBottom =
    virtualRows.length > 0
      ? totalSize - virtualRows[virtualRows.length - 1].end + STICKY_FOOTER_HEIGHT
      : 0

  function resetFilters() {
    setSearchInput("")
    setDebouncedSearch("")
    setMatchTypeFilter("ALL")
    setStatusFilter("ALL")
    setInspectFilter("ALL")
    setAdgroupFilter("ALL")
    setUserLockFilterValue("ALL")
    setRnkFilter("ALL")
    updateQuery({
      q: "",
      match: "ALL",
      status: "ALL",
      inspect: "ALL",
      adgroup: "ALL",
      lock: "ALL",
      rnk: "ALL",
    })
  }

  // -- staging 적용된 row 배열 (모달 / 미리보기) -----------------------------
  const stagingRows = React.useMemo(() => {
    if (staging.size === 0) return []
    const byId = new Map(keywordsWithMetrics.map((k) => [k.id, k]))
    const result: KeywordRow[] = []
    for (const id of staging.keys()) {
      const r = byId.get(id)
      if (r) result.push(r)
    }
    return result
  }, [keywordsWithMetrics, staging])

  // -- F-3.3 다중 선택 + 일괄 액션 ------------------------------------------
  // 선택된 row (필터 후 가시여부 무관, rowSelection 키 기준 — 사용자가 명시 선택).
  const selectedRows = React.useMemo(() => {
    if (Object.keys(rowSelection).length === 0) return []
    const byId = new Map(keywordsWithMetrics.map((k) => [k.id, k]))
    const out: KeywordRow[] = []
    for (const id of Object.keys(rowSelection)) {
      if (rowSelection[id] !== true) continue
      const r = byId.get(id)
      if (r) out.push(r)
    }
    return out
  }, [keywordsWithMetrics, rowSelection])

  const selectedCount = selectedRows.length
  const overSelectionLimit = selectedCount > BULK_ACTION_MAX

  function clearSelection() {
    setRowSelection({})
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
      // staging 은 그대로 둔다 (F-3.2 인라인 편집 흐름과 분리 — 사용자가 의도한
      // 인라인 편집을 bulk action 결과로 손실시키지 않기 위함).
      setRowSelection({})
      router.refresh()
    }
  }

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
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            // F-3.5 — 현재 필터 / 정렬 적용된 rows 만 직렬화 (table.getRowModel())
            const filtered = rows.map((r) => r.original)
            if (filtered.length === 0) return
            exportKeywordsCsv(filtered, advertiserId)
            toast.success(`키워드 ${filtered.length.toLocaleString()}건 내보내기 완료`)
          }}
          disabled={rows.length === 0}
          title={
            rows.length === 0
              ? "내보낼 키워드가 없습니다 (필터 결과 0건)"
              : "현재 필터 / 정렬된 키워드를 CSV 로 다운로드"
          }
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
        {/* F-3.6 키워드 추가 — hasKeys=false / 광고그룹 0개 일 때 disabled */}
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

      {/* 1차 toolbar — 검색 / 광고그룹(scope) / 필터 펼침 / 초기화 / 우측 기간·지표·카운트 */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
        <Input
          placeholder="키워드 검색..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="h-8 w-56"
        />
        <Select
          value={adgroupFilter}
          onValueChange={(v) => {
            const next = v ?? "ALL"
            setAdgroupFilter(next)
            updateQuery({ adgroup: next })
          }}
        >
          <SelectTrigger className="w-56">
            <SelectValue placeholder="광고그룹">
              {(v: string | null) =>
                !v || v === "ALL"
                  ? "광고그룹 (전체)"
                  : (adgroupOptions.find((g) => g.id === v)?.name ?? v)
              }
            </SelectValue>
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
          variant={showAdvanced ? "secondary" : "outline"}
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
          aria-controls="keywords-advanced-filters"
        >
          <ListFilterIcon />
          필터
          {advancedActiveCount > 0 ? (
            <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground/10 px-1 text-[10px] font-medium">
              {advancedActiveCount}
            </span>
          ) : null}
          {showAdvanced ? <ChevronUpIcon /> : <ChevronDownIcon />}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={resetFilters}
          disabled={
            searchInput === "" &&
            matchTypeFilter === "ALL" &&
            statusFilter === "ALL" &&
            inspectFilter === "ALL" &&
            adgroupFilter === "ALL" &&
            userLockFilterValue === "ALL" &&
            rnkFilter === "ALL"
          }
        >
          초기화
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Select
            value={period}
            onValueChange={(v) => {
              const next = (v ?? "last7days") as AdsPeriod
              updateQuery({ period: next === "last7days" ? "" : next })
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
          {/* 지표 상태 배지 — 자리 예약(min-w + invisible) 으로 streaming 시 시프트 방지. */}
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
            총 {keywords.length.toLocaleString()}건
            {rows.length !== keywords.length && (
              <> (필터 후 {rows.length.toLocaleString()}건)</>
            )}
          </span>
        </div>
      </div>

      {/* 2차 toolbar — 매치 / 상태 / 검수 / 잠금 / 평균노출 (가끔 쓰는 고급 필터). */}
      {showAdvanced ? (
        <div
          id="keywords-advanced-filters"
          className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2"
        >
          <Select
            value={matchTypeFilter}
            onValueChange={(v) => {
              const next = v ?? "ALL"
              setMatchTypeFilter(next)
              updateQuery({ match: next })
            }}
          >
            <SelectTrigger className="w-32">
              <SelectValue placeholder="매치타입">
                {(v: string | null) => MATCH_LABELS[v ?? "ALL"] ?? "매치 (전체)"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">매치 (전체)</SelectItem>
              <SelectItem value="EXACT">정확 일치 (EXACT)</SelectItem>
              <SelectItem value="PHRASE">구문 일치 (PHRASE)</SelectItem>
              <SelectItem value="BROAD">확장 일치 (BROAD)</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={statusFilter}
            onValueChange={(v) => {
              const next = v ?? "ALL"
              setStatusFilter(next)
              updateQuery({ status: next })
            }}
          >
            <SelectTrigger className="w-32">
              <SelectValue placeholder="상태">
                {(v: string | null) => STATUS_LABELS[v ?? "ALL"] ?? "상태 (전체)"}
              </SelectValue>
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
            onValueChange={(v) => {
              const next = v ?? "ALL"
              setInspectFilter(next)
              updateQuery({ inspect: next })
            }}
          >
            <SelectTrigger className="w-32">
              <SelectValue placeholder="검수">
                {(v: string | null) =>
                  INSPECT_LABELS[v ?? "ALL"] ?? "검수 (전체)"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">검수 (전체)</SelectItem>
              <SelectItem value="pending">검수중</SelectItem>
              <SelectItem value="approved">승인</SelectItem>
              <SelectItem value="rejected">거절</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={userLockFilterValue}
            onValueChange={(v) => {
              const next = v ?? "ALL"
              setUserLockFilterValue(next)
              updateQuery({ lock: next })
            }}
          >
            <SelectTrigger className="w-32">
              <SelectValue placeholder="잠금">
                {(v: string | null) =>
                  USERLOCK_LABELS[v ?? "ALL"] ?? "잠금 (전체)"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">잠금 (전체)</SelectItem>
              <SelectItem value="locked">잠금</SelectItem>
              <SelectItem value="unlocked">해제</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={rnkFilter}
            onValueChange={(v) => {
              const next = v ?? "ALL"
              setRnkFilter(next)
              updateQuery({ rnk: next })
            }}
          >
            <SelectTrigger className="w-36">
              <SelectValue placeholder="평균 노출">
                {(v: string | null) => RNK_LABELS[v ?? "ALL"] ?? "노출 (전체)"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">노출 (전체)</SelectItem>
              <SelectItem value="top">1-5위</SelectItem>
              <SelectItem value="mid">6-10위</SelectItem>
              <SelectItem value="low">11위 이상</SelectItem>
              <SelectItem value="none">데이터 없음</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {/* 변경 검토 바 — staging > 0 일 때만 노출 (사용 방법 안내는 헤더 ? 도움말로 분리됨) */}
      {staging.size > 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-900/40 dark:bg-amber-900/10">
          <span className="text-sm font-medium text-amber-900 dark:text-amber-200">
            미확정 변경 {staging.size}건
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

      {/* 다중 선택 일괄 액션 바 — selectedCount > 0 일 때만 노출 */}
      {selectedCount > 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 dark:border-sky-900/40 dark:bg-sky-900/10">
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

      {/* 가상 스크롤 테이블 */}
      <div
        ref={parentRef}
        // 외부(페이지) 스크롤 발생 회피 — viewport 높이에서 PageHeader / nav / toolbar / 액션바 합 (~280px) 차감.
        className="relative max-h-[calc(100dvh-280px)] min-h-[320px] overflow-auto rounded-lg border"
      >
        {keywords.length === 0 ? (
          <EmptyState
            title="표시할 키워드가 없습니다."
            description="우측 상단 동기화 버튼을 눌러 SA 에서 가져오세요. (광고그룹을 먼저 동기화해야 합니다.)"
          />
        ) : rows.length === 0 ? (
          <EmptyState title="현재 필터에 일치하는 키워드가 없습니다." />
        ) : (
          <table className="w-full caption-bottom text-sm" style={{ tableLayout: "fixed" }}>
            {/*
              컬럼 너비 표준화 — 17개 컬럼 (makeColumns 순서):
                1 select  2 stagingMarker  3 keyword(auto)  4 adgroup  5 matchType
                6 bid  7 userLock  8 status  9 inspect  10 recentAvgRnk
                11 impCnt  12 clkCnt  13 ctr  14 cpc  15 salesAmt
                16 updatedAt  17 actions
            */}
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
                    // columnDef.meta.align 으로 헤더 정렬 결정 (셀 정렬과 일치)
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
            <KeywordMetricsFooter rows={rows} />
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

      {/* 다중 선택 일괄 액션 모달 (F-3.3) — toggleOn / toggleOff / bid 분기 */}
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

      {/* CSV 가져오기 모달 (F-3.4) — 적용 결과로 닫히면 router.refresh */}
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

      {/* 키워드 추가 모달 (F-3.6) — result 단계 도달 시 router.refresh */}
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

      {/* F-3.7 단건 삭제 모달 (admin 한정) — deleteRow!=null 시만 mount → 자동 reset.
          본 모달 닫혀도 staging / rowSelection 은 그대로 (다른 흐름과 분리). */}
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

      {/* F-10 입찰가 시뮬레이터 모달 — estimateRow!=null 시만 mount → 자동 reset.
          다른 행에서 재오픈해도 estimateRow.id 가 바뀌면 key 변화로 강제 unmount/remount
          (모달 내부 device / 탭별 결과 / bids 입력 모두 초기화).
          read 전용이라 router.refresh 불필요. staging / selection 무영향. */}
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

// KeywordRow → DeleteTargetRow (모달이 KeywordRow 의존성을 가지지 않도록 좁힌 타입).
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

// =============================================================================
// F-3.3 다중 선택 일괄 액션 모달 (BulkActionModal 래퍼)
// =============================================================================
//
// keywords-table.tsx 의 메인 컴포넌트가 비대해지지 않도록 별도 컴포넌트로 분리.
//
// 역할:
//   - action 별로 BulkActionModal 의 title / renderInput / renderPreview / onSubmit 구성
//   - input 단계:
//       toggleOn / toggleOff → 입력 없음 (mount 즉시 onReady)
//       bid                  → BidInputForm (absolute / ratio 모드 + 값)
//   - preview 단계:
//       previewBulkAction(advertiserId, input) 호출 → BulkActionPreviewView 렌더
//   - onSubmit:
//       bulkActionKeywords(advertiserId, input) 호출 → BulkActionResult 변환
//
// 액션별 input → BulkActionKeywordsInput 매핑:
//   - toggleOn  → { action: "toggle", items: rows.map(r => ({ keywordId: r.id, userLock: false })) }
//   - toggleOff → { action: "toggle", items: rows.map(r => ({ keywordId: r.id, userLock: true })) }
//   - bid abs   → { action: "bid", mode: "absolute", bidAmt, keywordIds: rows.map(r => r.id) }
//   - bid ratio → { action: "bid", mode: "ratio", percent, roundTo, keywordIds: rows.map(r => r.id) }
//   - bid delta → { action: "bid", mode: "delta", amount, roundTo, keywordIds: rows.map(r => r.id) }

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

  // input → bulkActionKeywords 페이로드 매핑
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
      // 결과 화면 표시명 매칭은 nccKeywordId 기반 (BulkActionModal getItemId 와 일치).
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
        // BulkActionModal 의 input 은 preview 단계 동안 안정 (handleReady 한 번 set).
        // mapToServerInput 결과를 매 렌더 새로 생성해도 동일한 (advertiserId,
        // serializedInput) 조합이라 BulkActionPreviewView 가 내부에서
        // serialize-key 로 effect 재실행을 차단한다.
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
  // toggle 은 별도 입력 없음 — mount 즉시 onReady (preview 직행).
  React.useEffect(() => {
    if (action === "toggleOn") onReady({ action: "toggleOn" })
    else if (action === "toggleOff") onReady({ action: "toggleOff" })
    // bid 는 사용자 입력 대기
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action])

  // bid 입력 폼 state (action='bid' 일 때만 사용)
  const [mode, setMode] = React.useState<"absolute" | "ratio" | "delta">(
    "absolute",
  )
  const [bidAmtInput, setBidAmtInput] = React.useState("")
  const [percentInput, setPercentInput] = React.useState("")
  const [amountInput, setAmountInput] = React.useState("")
  const [roundTo, setRoundTo] = React.useState<10 | 50 | 100>(10)

  if (action !== "bid") {
    // toggle 은 mount 즉시 preview 진입 — 짧은 안내만
    return (
      <p className="text-sm text-muted-foreground">
        선택한 키워드의 ON/OFF 를 변경합니다. 미리보기로 이동 중...
      </p>
    )
  }

  // 검증
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
  // -90 ~ 900, 정수 또는 소수 1자리. zod 단계에서도 한 번 더 검증되지만 UI 친절 검사.
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
      {/* 모드 선택 (radio) */}
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
  // 단일 union state — 초기값이 "loading" 이라 effect 가 진입 시 별도 setState 불필요
  // (react-hooks/set-state-in-effect 회피).
  //
  // 호출자(KeywordsBulkActionModal) 가 매 렌더마다 mapToServerInput 으로 새
  // 객체를 만들어 전달하므로 그대로 [input] 의존성으로 쓰면 effect 가 매 렌더
  // 재실행된다. 의미적으로 같은 입력에 대해서는 한 번만 호출되도록
  // JSON.stringify 결과를 effect deps 로 삼는다 (input 은 단순 직렬화 가능 객체).
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
    // input 자체 대신 inputKey 사용 — 동일 의미의 입력은 한 번만 호출.
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

  // toggle / bid 분기: 어떤 컬럼을 보여줄지 결정.
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
