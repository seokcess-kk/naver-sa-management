"use client"

/**
 * 확장소재 목록 + 다중 선택 일괄 액션 (F-5.x)
 *
 * AdsTable / KeywordsTable 패턴을 베이스로 응용:
 *
 * F-5.1 / F-5.2 — 목록 / 동기화:
 *   - 5천 행 가상 스크롤 (TanStack Virtual: estimateSize 56 / overscan 10)
 *   - 컬럼: 체크박스 / 텍스트(payload[type]) / 광고그룹(+캠페인) / 타입 / 상태 /
 *           검수(+memo) / 최근 수정 / 액션(케밥)
 *   - 정렬: 헤더 클릭 → asc / desc / 없음 순환
 *   - 클라이언트 필터: 텍스트 검색(debounce 200ms) / 타입 / 상태 / 검수 / 광고그룹
 *   - 동기화 버튼 (광고주 단위, type 미지정 → 둘 다)
 *
 * F-5.x — 다중 선택 일괄 액션 (확장소재는 입찰가 없음 → toggle 만):
 *   - 체크박스 다중 선택 활성. enableRowSelection=true.
 *   - 액션 2종: ON으로 변경 / OFF으로 변경
 *   - BulkActionModal 4단계 (input → preview → submit → result)
 *     · input 단계 즉시 onReady (toggle 은 입력 없음)
 *     · preview 단계 RSC props 기반 전/후 비교
 *     · 확정 시 bulkActionAdExtensions(advertiserId, input) 호출
 *   - 선택 1~500건 (zod 스키마 일치)
 *
 * F-5.4 — 추가 모달 (광고그룹 N × 텍스트 M 일괄 생성):
 *   - 헤더 "확장소재 추가" 버튼. hasKeys=false / 광고그룹 0개 시 disabled.
 *
 * F-5.x — 단건 삭제 (admin 한정 + 2차 확인):
 *   - 행 케밥 메뉴 → ExtensionsDeleteModal (텍스트 재입력)
 *   - userRole !== 'admin' 일 때 메뉴 자체 disabled
 *   - status='deleted' 행은 메뉴 disabled (이미 삭제됨)
 *
 * 본 PR 비대상 (후속):
 *   - F-5.3 이미지(IMAGE) — Supabase Storage 후속 PR
 *   - 인라인 편집 (text 변경) — type 별 fields 다양 → 별도 PR
 *   - 9종 중 P1 비대상 7종
 *
 * 광고주 횡단 차단:
 *   - props.extensions 는 RSC 에서 `where: { adgroup: { campaign: { advertiserId } } }`
 *     로 한정된 결과만. UI 레벨 별도 advertiserId 검사 X.
 *
 * SPEC 6.2 F-5.x / 11.2 / 안전장치 1·6.
 */

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
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
  type Row,
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
import { AdExtensionStatusBadge } from "@/components/dashboard/ad-extension-status-badge"
import { ExtensionTypeBadge } from "@/components/dashboard/extension-type-badge"
import { InspectStatusBadge } from "@/components/dashboard/inspect-status-badge"
import {
  ExtensionsAddModal,
  type ExtensionAdgroupOption,
} from "@/components/dashboard/extensions-add-modal"
import { ExtensionsImageAddModal } from "@/components/dashboard/extensions-image-add-modal"
import {
  ExtensionsDeleteModal,
  type DeleteAdExtensionTargetRow,
} from "@/components/dashboard/extensions-delete-modal"
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
  bulkActionAdExtensions,
  type BulkActionAdExtensionsInput,
} from "@/app/(dashboard)/[advertiserId]/extensions/actions"
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
  AdExtensionStatus,
  AdExtensionType,
  InspectStatus,
} from "@/lib/generated/prisma/client"

// 상한 — bulkActionExtensionsSchema 의 .max(500) 와 일치.
const BULK_ACTION_MAX = 500

// Base UI Select.Value 가 raw value 를 그대로 표시하는 문제 — 한글 라벨 매핑.
const TYPE_LABELS: Record<string, string> = {
  ALL: "타입 (전체)",
  headline: "추가제목",
  description: "추가설명",
  image: "이미지",
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

// =============================================================================
// 타입
// =============================================================================

// ExtensionsAddModal 의 광고그룹 옵션을 page.tsx 가 본 모듈만 import 하도록 re-export.
export type { ExtensionAdgroupOption }

/** RSC → 클라이언트 전달용 확장소재 행. raw 컬럼 / 시크릿 X. */
export type ExtensionRow = {
  id: string
  nccExtId: string
  /** 앱 DB ownerId — relation 으로 풀어서 별도 조회. */
  ownerId: string
  type: AdExtensionType
  /** 텍스트 추출 가능한 JSON: { headline: "..." } / { description: "..." } */
  payload: unknown
  inspectStatus: InspectStatus
  /** 검수 반려 사유 (있으면 ? 마커 + title 노출) */
  inspectMemo: string | null
  status: AdExtensionStatus
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
  /**
   * P1 stats — RSC 가 page.tsx 에서 batch 조회 (Redis 캐시 5분/1시간).
   * 단, 네이버 SA Stats 가 nccExtId 단위 미지원일 수 있어 모든 행이 0 일 가능성.
   * 운영에서 SA 응답 확인 후 정책 결정 (광고그룹 합산 등).
   */
  metrics: AdMetrics
}

/**
 * F-5.x 다중 선택 액션 종류 (확장소재는 입찰가 없음 → toggle 만).
 *
 * - toggleOn  : userLock=false 일괄 적용 (사용자 ON)
 * - toggleOff : userLock=true 일괄 적용 (사용자 OFF)
 */
type BulkAction = "toggleOn" | "toggleOff"

/** BulkActionModal<ExtensionRow, BulkInputForExtensions> 의 TInput 타입 */
type BulkInputForExtensions =
  | { action: "toggleOn" }
  | { action: "toggleOff" }

// =============================================================================
// 미리보기 추출 — payload JSON 에서 type 별 텍스트
// =============================================================================

function extractExtensionText(
  payload: unknown,
  type: AdExtensionType,
): string {
  if (payload === null || payload === undefined) return ""
  if (typeof payload !== "object") return ""
  const obj = payload as Record<string, unknown>
  // payload 는 { [type]: "텍스트" } 구조 (actions.ts 정의).
  const v = obj[type]
  if (typeof v === "string") return v
  // 폴백 — headline / description 키로 한번 더 시도 (응답 매핑 누락 안전망).
  for (const k of ["headline", "description"]) {
    if (k === type) continue
    const w = obj[k]
    if (typeof w === "string") return w
  }
  return ""
}

/**
 * 네이버 SA 확장소재 이미지 호스트 (path-only 응답 보정용).
 *
 * SA 응답은 `imagePath` 가 절대 URL 이 아닌 path 만 반환:
 *   "/MjAy.../...png"
 * 표시용 절대 URL 은 `https://searchad-phinf.pstatic.net{path}?type=THUMBNAIL`.
 *
 * 데이터는 path 그대로 보존(정합성), 표시 시점에만 prefix + 썸네일 옵션 부착.
 */
const SA_IMAGE_HOST = "https://searchad-phinf.pstatic.net"

/**
 * payload(JSON)에서 image type 의 url 추출 + 절대 URL 보정.
 * actions.ts 의 syncAdExtensions / createAdExtensionsBatch 가 저장하는 shape:
 *   - { image: { url: string, storagePath?: string } }
 * url 이 path-only(`/...`) 이면 SA 호스트 prefix + ?type=THUMBNAIL.
 * 이미 절대 URL 이면 그대로 반환. 누락 / 비정상 → null.
 */
function extractImageUrl(payload: unknown): string | null {
  if (payload === null || payload === undefined) return null
  if (typeof payload !== "object") return null
  const obj = payload as Record<string, unknown>
  const img = obj.image
  if (!img || typeof img !== "object") return null
  const url = (img as Record<string, unknown>).url
  if (typeof url !== "string" || url.length === 0) return null
  // 절대 URL 이면 그대로
  if (/^https?:\/\//i.test(url)) return url
  // path-only → SA 호스트 prefix + 썸네일 옵션
  const path = url.startsWith("/") ? url : `/${url}`
  return `${SA_IMAGE_HOST}${path}?type=THUMBNAIL`
}

// =============================================================================
// 필터 정의 (클라이언트 측, 5천 행 메모리 충분)
// =============================================================================

/** 텍스트 + nccExtId contains (대소문자 무시) */
const extensionTextFilter: FilterFn<ExtensionRow> = (row, _columnId, value) => {
  const q = String(value ?? "").trim().toLowerCase()
  if (q === "") return true
  const text = extractExtensionText(
    row.original.payload,
    row.original.type,
  ).toLowerCase()
  if (text.includes(q)) return true
  return row.original.nccExtId.toLowerCase().includes(q)
}

/** "전체" = 비교 skip. 그 외는 정확 일치. */
const exactMatchFilter: FilterFn<ExtensionRow> = (row, columnId, value) => {
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
  hasKeys: boolean
  /** 행 삭제 모달 열기 */
  onRequestDelete: (row: ExtensionRow) => void
}

// =============================================================================
// 컬럼 정의
// =============================================================================

function makeColumns(ctx: RowCtx): ColumnDef<ExtensionRow>[] {
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
          aria-label={`${row.original.nccExtId} 선택`}
        />
      ),
      enableSorting: false,
      enableColumnFilter: false,
      size: 40,
    },
    {
      id: "text",
      // accessor 가 아닌 id — 검색 필터는 별도 정의.
      accessorFn: (row) => extractExtensionText(row.payload, row.type),
      header: "텍스트 / 이미지",
      cell: ({ row }) => {
        // image type 은 payload.image.url 썸네일 (40x40), 그 외는 텍스트.
        if (row.original.type === "image") {
          const imageUrl = extractImageUrl(row.original.payload)
          return (
            <div className="flex max-w-[320px] items-center gap-2">
              {imageUrl ? (
                // 외부 호스트(SA / Storage) 다양 → next/image 대신 native img.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={imageUrl}
                  alt={row.original.nccExtId}
                  className="size-10 rounded border object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="flex size-10 items-center justify-center rounded border bg-muted text-[10px] text-muted-foreground">
                  N/A
                </div>
              )}
              <span className="font-mono text-[11px] text-muted-foreground">
                {row.original.nccExtId}
              </span>
            </div>
          )
        }
        const text = extractExtensionText(
          row.original.payload,
          row.original.type,
        )
        return (
          <div className="flex max-w-[320px] flex-col gap-0.5">
            <span className="line-clamp-2 text-sm font-medium">
              {text || "(텍스트 없음)"}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {row.original.nccExtId}
            </span>
          </div>
        )
      },
      filterFn: extensionTextFilter,
      enableSorting: true,
      sortingFn: (a, b) =>
        extractExtensionText(a.original.payload, a.original.type).localeCompare(
          extractExtensionText(b.original.payload, b.original.type),
          "ko",
        ),
    },
    {
      id: "adgroupId",
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
      accessorKey: "type",
      header: "타입",
      cell: ({ row }) => <ExtensionTypeBadge type={row.original.type} />,
      filterFn: exactMatchFilter,
      enableSorting: true,
    },
    {
      accessorKey: "status",
      header: "상태",
      cell: ({ row }) => (
        <AdExtensionStatusBadge status={row.original.status} />
      ),
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
      // 행 우측 액션 컬럼 (케밥 메뉴 → 단건 삭제). admin 한정.
      id: "actions",
      header: () => <span className="sr-only">행 작업</span>,
      cell: ({ row }) => <ExtensionRowActions row={row.original} ctx={ctx} />,
      enableSorting: false,
      enableColumnFilter: false,
      size: 48,
    },
  ]
}

// =============================================================================
// 행 우측 액션 (케밥 메뉴) — 단건 삭제
// =============================================================================

/**
 * 필터 적용 후 행 metrics 합계 (SA 콘솔 footer 동등).
 *
 * 컬럼 13개 매핑:
 *   1 select / 2 text / 3 adgroupId / 4 type / 5 status / 6 inspectStatus /
 *   7 impCnt / 8 clkCnt / 9 ctr / 10 cpc / 11 salesAmt / 12 updatedAt / 13 actions
 *
 * 합계 표시 위치:
 *   1: 빈 / 2~6 (colSpan=5): 라벨 / 7~11: 합계 / 12~13: 빈
 *
 * 주의: SA Stats 가 nccExtId 단위 미지원이면 모든 행 metrics 가 0 → 합계도 0.
 *      (RSC 가 statsError 를 잡지 못해 응답 자체가 빈 row 셋인 케이스)
 */
function ExtensionMetricsFooter({ rows }: { rows: Row<ExtensionRow>[] }) {
  const totals = React.useMemo(
    () => sumMetrics(rows.map((r) => r.original.metrics)),
    [rows],
  )
  if (rows.length === 0) return null
  return (
    <tfoot className="sticky bottom-0 z-10 border-t-2 bg-muted/40 text-sm font-medium">
      <tr>
        <td className="px-3 py-2.5" />
        <td className="px-3 py-2.5 text-xs text-muted-foreground" colSpan={5}>
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

function ExtensionRowActions({
  row,
  ctx,
}: {
  row: ExtensionRow
  ctx: RowCtx
}) {
  const alreadyDeleted = row.status === "deleted"
  const canDelete = ctx.isAdmin && !alreadyDeleted

  const deleteTitle = !ctx.isAdmin
    ? "관리자 권한 필요"
    : alreadyDeleted
      ? "이미 삭제된 확장소재"
      : undefined

  return (
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`${row.nccExtId} 행 작업`}
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

// =============================================================================
// 메인 컴포넌트
// =============================================================================

export function ExtensionsTable({
  advertiserId,
  hasKeys,
  extensions,
  adgroups,
  userRole,
  period,
  statsError,
}: {
  advertiserId: string
  hasKeys: boolean
  extensions: ExtensionRow[]
  /** F-5.4 추가 모달용 — page.tsx 가 광고주 한정으로 별도 조회. */
  adgroups: ExtensionAdgroupOption[]
  userRole: "admin" | "operator" | "viewer"
  /** RSC 가 searchParams.period 파싱 후 전달 (lib/dashboard/metrics). */
  period: AdsPeriod
  /** stats 호출 실패 시 안내 (toolbar 우측 칩) */
  statsError: string | null
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const isAdmin = userRole === "admin"

  // 필터를 URL query 로 동기화 (이동 후 복귀해도 맥락 보존).
  // - default 값(빈 문자열 / "ALL") 은 query 에서 제거하여 URL 을 깔끔하게 유지.
  // - replace 사용 — 히스토리 누적 방지.
  // - scroll: false — 가상 스크롤 위치 유지.
  // keywords-table 의 동일 패턴.
  const updateQuery = React.useCallback(
    (patch: Record<string, string>) => {
      const next = new URLSearchParams(searchParams.toString())
      for (const [k, v] of Object.entries(patch)) {
        if (v === "" || v === "ALL") next.delete(k)
        else next.set(k, v)
      }
      const qs = next.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [router, pathname, searchParams],
  )

  // -- 모달 state -------------------------------------------------------------
  const [addOpen, setAddOpen] = React.useState(false)
  const [imageAddOpen, setImageAddOpen] = React.useState(false)
  const [deleteRow, setDeleteRow] = React.useState<ExtensionRow | null>(null)

  // -- 다중 선택 + 일괄 액션 state -------------------------------------------
  const [rowSelection, setRowSelection] = React.useState<
    Record<string, boolean>
  >({})
  const [bulkAction, setBulkAction] = React.useState<BulkAction | null>(null)

  const onRequestDelete = React.useCallback((row: ExtensionRow) => {
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
  // 초기값은 URL query 에서 읽음 (이동 후 복귀해도 맥락 보존).
  // useSearchParams 가 client 에서만 동작하므로 SSR 단계에선 기본값으로 hydrate.
  const [searchInput, setSearchInput] = React.useState(
    () => searchParams.get("q") ?? "",
  )
  const [debouncedSearch, setDebouncedSearch] = React.useState(
    () => searchParams.get("q") ?? "",
  )
  const [typeFilter, setTypeFilter] = React.useState<string>(
    () => searchParams.get("type") ?? "ALL",
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
  const [sorting, setSorting] = React.useState<SortingState>([
    { id: "updatedAt", desc: true },
  ])

  // 검색 input debounce 200ms — URL query 도 함께 갱신.
  React.useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(searchInput)
      updateQuery({ q: searchInput })
    }, 200)
    return () => clearTimeout(t)
  }, [searchInput, updateQuery])

  // 광고그룹 셀렉트 옵션 — 현재 데이터에 등장하는 광고그룹만 (필터링 한정)
  const adgroupOptions = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const e of extensions) {
      if (!map.has(e.adgroup.id)) map.set(e.adgroup.id, e.adgroup.name)
    }
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "ko"))
  }, [extensions])

  // 컬럼 필터 state 구성
  const columnFilters = React.useMemo<ColumnFiltersState>(() => {
    const f: ColumnFiltersState = []
    if (debouncedSearch.trim() !== "") {
      f.push({ id: "text", value: debouncedSearch })
    }
    if (typeFilter !== "ALL") {
      f.push({ id: "type", value: typeFilter })
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
    typeFilter,
    statusFilter,
    inspectFilter,
    adgroupFilter,
  ])

  const table = useReactTable<ExtensionRow>({
    data: extensions,
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
    setTypeFilter("ALL")
    setStatusFilter("ALL")
    setInspectFilter("ALL")
    setAdgroupFilter("ALL")
    updateQuery({
      q: "",
      type: "ALL",
      status: "ALL",
      inspect: "ALL",
      adgroup: "ALL",
    })
  }

  // -- 다중 선택 + 일괄 액션 -------------------------------------------------
  const selectedRows = React.useMemo(() => {
    if (Object.keys(rowSelection).length === 0) return []
    const byId = new Map(extensions.map((e) => [e.id, e]))
    const out: ExtensionRow[] = []
    for (const id of Object.keys(rowSelection)) {
      if (rowSelection[id] !== true) continue
      const r = byId.get(id)
      if (r) out.push(r)
    }
    return out
  }, [extensions, rowSelection])

  const selectedCount = selectedRows.length
  const overSelectionLimit = selectedCount > BULK_ACTION_MAX

  function clearSelection() {
    setRowSelection({})
  }

  function openBulkAction(action: BulkAction) {
    if (selectedCount === 0) {
      toast.error("확장소재를 1개 이상 선택하세요")
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
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          size="sm"
          onClick={() => {
            if (!hasKeys) {
              toast.error("키 미설정 — 확장소재 추가 비활성")
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
                : "추가제목 / 추가설명 일괄 추가"
          }
        >
          텍스트 추가
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            if (!hasKeys) {
              toast.error("키 미설정 — 확장소재 추가 비활성")
              return
            }
            if (adgroups.length === 0) {
              toast.error(
                "광고그룹이 없습니다. 먼저 광고그룹을 동기화하세요.",
              )
              return
            }
            setImageAddOpen(true)
          }}
          disabled={!hasKeys || adgroups.length === 0}
          title={
            !hasKeys
              ? "키 미설정 — 먼저 API 키 / Secret 키 입력"
              : adgroups.length === 0
                ? "광고그룹이 없습니다. 광고그룹을 먼저 동기화하세요."
                : "이미지 확장소재 일괄 추가 (광고그룹 N × 이미지 M)"
          }
        >
          이미지 추가
        </Button>
      </div>

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
          placeholder="텍스트 / nccExtId 검색..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="h-8 w-72"
        />
        <Select
          value={typeFilter}
          onValueChange={(v) => {
            const next = v ?? "ALL"
            setTypeFilter(next)
            updateQuery({ type: next })
          }}
        >
          <SelectTrigger className="w-36">
            <SelectValue placeholder="타입">
              {(v: string | null) => TYPE_LABELS[v ?? "ALL"] ?? "타입 (전체)"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">타입 (전체)</SelectItem>
            <SelectItem value="headline">추가제목</SelectItem>
            <SelectItem value="description">추가설명</SelectItem>
            <SelectItem value="image">이미지</SelectItem>
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
          variant="ghost"
          onClick={resetFilters}
          disabled={
            searchInput === "" &&
            typeFilter === "ALL" &&
            statusFilter === "ALL" &&
            inspectFilter === "ALL" &&
            adgroupFilter === "ALL"
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
          {statsError ? (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-900"
              title={statsError}
            >
              지표 조회 실패 — 동기화 후 재시도
            </span>
          ) : null}
          <span className="text-xs text-muted-foreground">
            총 {extensions.length.toLocaleString()}건
            {rows.length !== extensions.length && (
              <> (필터 후 {rows.length.toLocaleString()}건)</>
            )}
          </span>
        </div>
      </div>

      {/* 다중 선택 일괄 액션 바 */}
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
              ? "체크박스로 확장소재를 선택해 ON/OFF 일괄 액션을 적용하세요."
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
        {extensions.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            표시할 확장소재가 없습니다. 우측 상단{" "}
            <span className="mx-1 font-medium">동기화</span> 버튼을
            눌러 SA 에서 가져오세요. (광고그룹을 먼저 동기화해야 합니다.)
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            현재 필터에 일치하는 확장소재가 없습니다.
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
            <ExtensionMetricsFooter rows={rows} />
          </table>
        )}
      </div>

      {/* 다중 선택 일괄 액션 모달 */}
      {bulkAction !== null && (
        <ExtensionsBulkActionModal
          advertiserId={advertiserId}
          action={bulkAction}
          selectedRows={selectedRows}
          onOpenChange={(o) => {
            if (!o) setBulkAction(null)
          }}
          onClosed={handleBulkActionClosed}
        />
      )}

      {/* 추가 모달 (F-5.4 — 텍스트 N×M) */}
      {addOpen && (
        <ExtensionsAddModal
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

      {/* 이미지 추가 모달 (F-5.3 — 이미지 N×M) */}
      {imageAddOpen && (
        <ExtensionsImageAddModal
          advertiserId={advertiserId}
          adgroups={adgroups}
          open
          onOpenChange={(o) => {
            if (!o) setImageAddOpen(false)
          }}
          onClosed={(didApply) => {
            if (didApply) {
              router.refresh()
            }
          }}
        />
      )}

      {/* 단건 삭제 모달 (admin 한정) */}
      {deleteRow !== null && (
        <ExtensionsDeleteModal
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

// ExtensionRow → DeleteAdExtensionTargetRow (모달이 ExtensionRow 의존성을 가지지 않도록 좁힌 타입).
//   - image type 은 텍스트가 없으므로 nccExtId 를 2차 확인 식별자로 사용
//     (백엔드 deleteAdExtensionSingle 도 동일 폴백 — actions.ts line 1294-1296).
function mapToDeleteTarget(row: ExtensionRow): DeleteAdExtensionTargetRow {
  const text =
    row.type === "image"
      ? row.nccExtId
      : extractExtensionText(row.payload, row.type)
  return {
    id: row.id,
    nccExtId: row.nccExtId,
    type: row.type,
    text,
    adgroupName: row.adgroup.name,
  }
}

// =============================================================================
// 일괄 액션 모달 (BulkActionModal 래퍼)
// =============================================================================

function ExtensionsBulkActionModal({
  advertiserId,
  action,
  selectedRows,
  onOpenChange,
  onClosed,
}: {
  advertiserId: string
  action: BulkAction
  selectedRows: ExtensionRow[]
  onOpenChange: (open: boolean) => void
  onClosed: (didApply: boolean) => void
}) {
  const title =
    action === "toggleOn" ? "ON으로 변경 (일괄)" : "OFF으로 변경 (일괄)"

  // input → bulkActionAdExtensions 페이로드 매핑
  const mapToServerInput = React.useCallback(
    (input: BulkInputForExtensions): BulkActionAdExtensionsInput => {
      const userLock = input.action === "toggleOff"
      return {
        action: "toggle",
        items: selectedRows.map((r) => ({
          extensionId: r.id,
          userLock,
        })),
      }
    },
    [selectedRows],
  )

  const handleSubmit = React.useCallback(
    async (input: BulkInputForExtensions): Promise<BulkActionResult> => {
      const payload = mapToServerInput(input)
      const res = await bulkActionAdExtensions(advertiserId, payload)
      // 결과 화면 표시명 매칭은 nccExtId 기반.
      return {
        batchId: res.batchId,
        total: res.total,
        success: res.success,
        failed: res.failed,
        items: res.items.map((it) => {
          const row = selectedRows.find((r) => r.id === it.extensionId)
          return {
            id: row?.nccExtId ?? it.extensionId,
            ok: it.ok,
            error: it.error,
          }
        }),
      }
    },
    [advertiserId, selectedRows, mapToServerInput],
  )

  return (
    <BulkActionModal<ExtensionRow, BulkInputForExtensions>
      open
      onOpenChange={onOpenChange}
      title={title}
      itemLabel="확장소재"
      selectedItems={selectedRows}
      renderInput={(_, onReady) => (
        <ImmediateReady action={action} onReady={onReady} />
      )}
      renderPreview={(items) => (
        <ExtensionToggleChangePreview items={items} action={action} />
      )}
      onSubmit={handleSubmit}
      getItemDisplayName={(r) =>
        extractExtensionText(r.payload, r.type) || r.nccExtId
      }
      getItemId={(r) => r.nccExtId}
      onClosed={onClosed}
    />
  )
}

/**
 * input 단계 즉시 onReady — toggle 은 별도 입력 없음.
 */
function ImmediateReady({
  action,
  onReady,
}: {
  action: BulkAction
  onReady: (input: BulkInputForExtensions) => void
}) {
  React.useEffect(() => {
    onReady({ action })
    // 한 번만 호출.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <p className="text-sm text-muted-foreground">
      선택한 확장소재의 ON/OFF 를 변경합니다. 미리보기로 이동 중...
    </p>
  )
}

// =============================================================================
// preview 단계 — 선택된 rows 의 현재 상태(before) → 액션 후 상태(after) 표
// =============================================================================

function ExtensionToggleChangePreview({
  items,
  action,
}: {
  items: ExtensionRow[]
  action: BulkAction
}) {
  const targetStatus: AdExtensionStatus =
    action === "toggleOn" ? "on" : "off"
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
            변경 없음 {noChange.toLocaleString()}건 (이미{" "}
            {targetStatus.toUpperCase()})
          </span>
        )}
      </div>
      <div className="max-h-72 overflow-y-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>확장소재</TableHead>
              <TableHead>광고그룹</TableHead>
              <TableHead>현재</TableHead>
              <TableHead>→ 적용 후</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((it) => {
              const same = it.status === targetStatus
              const isImage = it.type === "image"
              const text = isImage
                ? ""
                : extractExtensionText(it.payload, it.type)
              const imageUrl = isImage ? extractImageUrl(it.payload) : null
              return (
                <TableRow
                  key={it.id}
                  className={cn(same && "text-muted-foreground")}
                >
                  <TableCell className="max-w-[260px] truncate font-medium">
                    <div className="flex items-center gap-1.5">
                      <ExtensionTypeBadge type={it.type} />
                      {isImage ? (
                        imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={imageUrl}
                            alt={it.nccExtId}
                            className="size-7 rounded border object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            (이미지 없음)
                          </span>
                        )
                      ) : (
                        <span className="truncate">
                          {text || "(텍스트 없음)"}
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {it.nccExtId}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-[160px] truncate text-xs text-muted-foreground">
                    {it.adgroup.name}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <AdExtensionStatusBadge status={it.status} />
                  </TableCell>
                  <TableCell className="font-medium">
                    {same ? (
                      <span className="text-xs text-muted-foreground">
                        변경 없음
                      </span>
                    ) : (
                      <AdExtensionStatusBadge status={targetStatus} />
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
