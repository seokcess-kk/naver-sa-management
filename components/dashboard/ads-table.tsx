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
  ChevronDownIcon,
  ChevronUpIcon,
  ListFilterIcon,
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
import Link from "next/link"

import { AdStatusBadge } from "@/components/dashboard/ad-status-badge"
import { EmptyState } from "@/components/dashboard/empty-state"
import { InspectStatusBadge } from "@/components/dashboard/inspect-status-badge"
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
  fetchAdsStats,
  type BulkActionAdsInput,
} from "@/app/(dashboard)/[advertiserId]/ads/actions"
import { cn } from "@/lib/utils"
import {
  EMPTY_METRICS,
  PERIOD_LABELS,
  formatInt,
  formatPct,
  formatWon,
  sumMetrics,
  type AdMetrics,
  type AdsPeriod,
} from "@/lib/dashboard/metrics"
import type { AdStatus, InspectStatus } from "@/lib/generated/prisma/client"

// 상한 — bulkActionAdsSchema 의 .max(500) 와 일치.
const BULK_ACTION_MAX = 500

// Base UI Select.Value 가 raw value 를 그대로 표시하는 문제 — 한글 라벨 매핑.
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
  /** P1 stats (광고주별 캐시 5분/1시간) — RSC 가 page.tsx 에서 batch 조회. */
  metrics: AdMetrics
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
// adType 별로 ad 구조가 상이 (TEXT_45 / RSA_AD / GFA 이미지 통합광고 등):
//   1. headline / title / description 등 일반 텍스트 키 우선
//   2. 없으면 RSA_AD 의 headlines[0]
//   3. 없으면 GFA 이미지 광고 (dittoId / thumbnail) → "이미지 광고" 라벨
//   4. 모두 없으면 "본문 정보 없음" 라벨
//      (raw JSON 직렬화는 사용자에게 의미 없는 dittoId / 내부 키가 그대로 노출되어 제거)
//
// 후속 PR 에서 adType 별 정밀 미리보기 (썸네일 inline 표시 등) 가능.

function extractAdPreview(fields: unknown): string {
  if (fields === null || fields === undefined) return ""
  if (typeof fields !== "object") return String(fields).slice(0, 60)
  const obj = fields as Record<string, unknown>

  // 1차 후보 — 텍스트 가능성 높은 키 순서 (TEXT_45 / 텍스트 광고 변형)
  const textKeys = [
    "headline",
    "title",
    "description",
    "subject",
    "name",
    "headline1",
    "subject1",
    "productName",
    "productNm",
    "text",
    "body",
  ]
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

  // GFA 이미지 통합광고 — 텍스트 본문 없음. dittoId / thumbnail 만 존재.
  // 식별은 두 번째 줄의 nccAdId 로 가능 (cell render 가 항상 표시).
  if (
    typeof obj["thumbnail"] === "string" ||
    typeof obj["dittoId"] === "string" ||
    typeof obj["imageUrl"] === "string" ||
    typeof obj["image"] === "string"
  ) {
    return "이미지 광고"
  }

  // URL 만 있는 광고 (통합 광고그룹의 일부 형식) — pc.display / pc.final 폴백.
  const urlFromPcMobile = pickUrlFromPcMobile(obj)
  if (urlFromPcMobile) return urlFromPcMobile

  // 폴백 — raw JSON 직렬화 대신 친절 라벨.
  // (dittoId / thumbnail 같은 내부 키가 잘린 채 노출되는 UX 문제 회피)
  return "본문 정보 없음"
}

/**
 * pc / mobile 객체에서 URL 추출 (display 우선 → final → punyCode).
 *
 * 본문 텍스트가 없는 광고 (통합광고그룹 일부) 의 식별자 폴백:
 *   {"pc":{"final":"https://...","display":"https://..."},"mobile":{...}}
 */
function pickUrlFromPcMobile(obj: Record<string, unknown>): string {
  const pc = obj["pc"]
  const mobile = obj["mobile"]
  for (const candidate of [pc, mobile]) {
    if (candidate && typeof candidate === "object") {
      const o = candidate as Record<string, unknown>
      const url = o["display"] ?? o["final"] ?? o["punyCode"]
      if (typeof url === "string" && url.trim().length > 0) {
        return url.trim()
      }
    }
  }
  return ""
}

/**
 * 소재 본문 분리 추출 (셀 풍부화용).
 *
 * SA 콘솔 "소재" 컬럼과 동일 정보:
 *   - headline (제목 1줄)
 *   - description (설명 1~2줄)
 *   - displayUrl (표시 URL)
 *   - landingUrl (연결 URL)
 *   - thumbnail (이미지 광고)
 *
 * adType 별 키 차이 (TEXT_45 / RSA_AD / GFA 이미지) 를 휴리스틱으로 흡수.
 * 매칭 안 되는 키는 빈 문자열 / null.
 */
type AdPreviewParts = {
  headline: string
  description: string
  displayUrl: string
  landingUrl: string
  thumbnail: string | null
}

function extractAdParts(fields: unknown): AdPreviewParts {
  const empty: AdPreviewParts = {
    headline: "",
    description: "",
    displayUrl: "",
    landingUrl: "",
    thumbnail: null,
  }
  if (fields === null || fields === undefined) return empty
  if (typeof fields !== "object") return empty
  const obj = fields as Record<string, unknown>

  // headline 후보
  let headline =
    pickString(obj, ["headline", "title", "subject", "headline1", "subject1"]) ||
    pickFirstFromArrayObj(obj, "headlines") ||
    ""

  // description 후보
  const description =
    pickString(obj, ["description", "body", "text", "description1"]) ||
    pickFirstFromArrayObj(obj, "descriptions") ||
    ""

  // 표시 URL — 일반적으로 pc.display 또는 displayUrl
  const displayUrl =
    pickString(obj, ["displayUrl", "displayURL"]) ||
    pickNestedString(obj, ["pc", "display"]) ||
    pickNestedString(obj, ["mobile", "display"]) ||
    ""

  // 연결 URL — pc.final / mobile.final / landingUrl
  const landingUrl =
    pickString(obj, ["landingUrl", "finalUrl"]) ||
    pickNestedString(obj, ["pc", "final"]) ||
    pickNestedString(obj, ["mobile", "final"]) ||
    ""

  // 이미지 광고 thumbnail (GFA 이미지 광고 / 통합 캠페인)
  const thumbnail =
    pickString(obj, ["thumbnail", "imageUrl", "image"]) || null

  // 본문 텍스트 모두 누락 + URL 있는 광고 (통합광고그룹의 일부 형식 — 본문 없이 URL 만)
  // → URL 을 headline 자리에 표시해 식별 가능하도록.
  // (cell render 의 displayUrl 라인은 headline 과 같으면 중복이라 숨김)
  if (!headline && !description && !thumbnail && (displayUrl || landingUrl)) {
    headline = displayUrl || landingUrl
  }

  return { headline, description, displayUrl, landingUrl, thumbnail }
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === "string" && v.trim().length > 0) return v.trim()
  }
  return ""
}

function pickNestedString(
  obj: Record<string, unknown>,
  path: [string, string],
): string {
  const a = obj[path[0]]
  if (a && typeof a === "object") {
    const v = (a as Record<string, unknown>)[path[1]]
    if (typeof v === "string" && v.trim().length > 0) return v.trim()
  }
  return ""
}

function pickFirstFromArrayObj(obj: Record<string, unknown>, key: string): string {
  const arr = obj[key]
  if (!Array.isArray(arr) || arr.length === 0) return ""
  const first = arr[0]
  if (typeof first === "string") return first
  if (first && typeof first === "object" && "text" in first) {
    const t = (first as Record<string, unknown>).text
    if (typeof t === "string") return t
  }
  return ""
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
        const parts = extractAdParts(row.original.fields)
        const fallback = !parts.headline && !parts.description && !parts.thumbnail
          ? extractAdPreview(row.original.fields)
          : ""
        return (
          <div className="flex max-w-[360px] items-start gap-3">
            {parts.thumbnail ? (
              // GFA 이미지 — 외부 호스트 next/image 도메인 미설정 가능성 → 단순 <img>
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={parts.thumbnail}
                alt="이미지 광고 썸네일"
                className="h-10 w-10 shrink-0 rounded border object-cover"
                loading="lazy"
              />
            ) : null}
            <div className="flex min-w-0 flex-col gap-0.5">
              {parts.headline ? (
                <span className="line-clamp-1 text-sm font-medium text-foreground">
                  {parts.headline}
                </span>
              ) : (
                <span className="line-clamp-1 text-sm font-medium text-muted-foreground">
                  {fallback || (parts.thumbnail ? "이미지 광고" : "(미리보기 없음)")}
                </span>
              )}
              {parts.description ? (
                <span className="line-clamp-1 text-xs text-muted-foreground">
                  {parts.description}
                </span>
              ) : null}
              {(() => {
                // headline 폴백으로 URL 이 들어간 케이스(본문 없는 광고)는
                // 같은 URL 을 두 번 보여주지 않도록 작은 URL 라인 숨김.
                const url = parts.displayUrl || parts.landingUrl
                if (!url) return null
                if (parts.headline === url) return null
                return (
                  <span className="line-clamp-1 text-[11px] text-muted-foreground/80">
                    {url}
                  </span>
                )
              })()}
              <span className="font-mono text-[11px] text-muted-foreground/80">
                {row.original.nccAdId}
              </span>
            </div>
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

/**
 * 필터 적용 후 행 metrics 합계 표시 (SA 콘솔 footer 와 동일).
 *
 * 합계 정의:
 *   - impCnt / clkCnt / salesAmt: 단순 합산
 *   - ctr: clkCnt / impCnt × 100 (가중평균 — 단순 ctr 평균이 아닌 실비율)
 *   - cpc: salesAmt / clkCnt (가중평균)
 *
 * 컬럼 순서 (makeColumns 기준 13개): select / preview / adgroup / type / status / inspect /
 *   impCnt / clkCnt / ctr / cpc / salesAmt / updatedAt / actions
 */
function MetricsFooter({
  rows,
  columnCount,
}: {
  rows: Row<AdRow>[]
  columnCount: number
}) {
  const totals = React.useMemo(
    () => sumMetrics(rows.map((r) => r.original.metrics)),
    [rows],
  )

  if (rows.length === 0 || columnCount === 0) return null

  return (
    <tfoot className="sticky bottom-0 z-10 border-t-2 bg-background text-sm font-medium shadow-[0_-2px_8px_-2px_rgba(0,0,0,0.08)]">
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
  period,
}: {
  advertiserId: string
  hasKeys: boolean
  ads: AdRow[]
  /** F-4.6 소재 추가 모달용 — page.tsx 가 광고주 한정으로 별도 조회. */
  adgroups: AdAdgroupOption[]
  /** F-4.7 — admin 한정 단건 삭제 권한 (RSC 에서 ctx.user.role 전달). */
  userRole: "admin" | "operator" | "viewer"
  /** RSC 가 searchParams.period 파싱 후 전달. */
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
  // keywords-table 의 동일 패턴.
  // searchParams reference 가 매 렌더 새로 생성되면 무한 루프 발생 — string 으로 안정화.
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

  // -- stats streaming (페이지 진입 후 client useEffect 가 fetchAdsStats 호출) -----
  // 초기엔 metrics: EMPTY_METRICS → 페이지 즉시 표시 → stats 도착 시 ads 갱신.
  // ads(props) 변경 시 (router.refresh / period 변경) 재요청.
  const [adsWithMetrics, setAdsWithMetrics] = React.useState<AdRow[]>(ads)
  const [statsLoading, setStatsLoading] = React.useState(true)
  const [statsError, setStatsError] = React.useState<string | null>(null)

  // ads 배열 reference 가 매 렌더 새로 생성되면 effect 무한 재실행. 안정 key 로 전환.
  const adsKey = React.useMemo(
    () =>
      `${ads.length}:${ads[0]?.nccAdId ?? ""}:${ads[ads.length - 1]?.nccAdId ?? ""}`,
    [ads],
  )

  React.useEffect(() => {
    let cancelled = false
    setStatsLoading(true)
    setStatsError(null)
    setAdsWithMetrics(ads)

    if (!hasKeys || ads.length === 0) {
      setStatsLoading(false)
      return
    }

    fetchAdsStats(advertiserId, period)
      .then((res) => {
        if (cancelled) return
        if (res.ok) {
          const map = new Map(res.metrics.map((m) => [m.id, m]))
          setAdsWithMetrics(
            ads.map((a) => ({
              ...a,
              metrics: map.get(a.nccAdId)
                ? {
                    impCnt: map.get(a.nccAdId)!.impCnt,
                    clkCnt: map.get(a.nccAdId)!.clkCnt,
                    ctr: map.get(a.nccAdId)!.ctr,
                    cpc: map.get(a.nccAdId)!.cpc,
                    salesAmt: map.get(a.nccAdId)!.salesAmt,
                  }
                : a.metrics,
            })),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ads 는 adsKey 로 대체.
  }, [advertiserId, period, hasKeys, adsKey])

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
  // 초기값은 URL query 에서 읽음 (이동 후 복귀해도 맥락 보존).
  // useSearchParams 가 client 에서만 동작하므로 SSR 단계에선 기본값으로 hydrate.
  const [searchInput, setSearchInput] = React.useState(
    () => searchParams.get("q") ?? "",
  )
  const [debouncedSearch, setDebouncedSearch] = React.useState(
    () => searchParams.get("q") ?? "",
  )
  const [adTypeFilter, setAdTypeFilter] = React.useState<string>(
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

  // 고급 필터(타입 / 상태 / 검수) 활성 갯수 — 1차 toolbar 의 "필터" 버튼 배지.
  const advancedActiveCount =
    (adTypeFilter !== "ALL" ? 1 : 0) +
    (statusFilter !== "ALL" ? 1 : 0) +
    (inspectFilter !== "ALL" ? 1 : 0)
  const [showAdvanced, setShowAdvanced] = React.useState(
    () => advancedActiveCount > 0,
  )

  // 검색 input debounce 200ms — searchInput 변경에만 반응 (updateQuery 의존성 제외).
  React.useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(searchInput)
      updateQuery({ q: searchInput })
    }, 200)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    data: adsWithMetrics,
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
    setAdTypeFilter("ALL")
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

  // -- F-4.3 다중 선택 + 일괄 액션 ------------------------------------------
  const selectedRows = React.useMemo(() => {
    if (Object.keys(rowSelection).length === 0) return []
    const byId = new Map(adsWithMetrics.map((a) => [a.id, a]))
    const out: AdRow[] = []
    for (const id of Object.keys(rowSelection)) {
      if (rowSelection[id] !== true) continue
      const r = byId.get(id)
      if (r) out.push(r)
    }
    return out
  }, [adsWithMetrics, rowSelection])

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
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
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

      {/* 1차 toolbar — 검색 / 광고그룹(scope) / 필터 펼침 / 초기화 / 우측 기간·지표·카운트 */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
        <Input
          placeholder="소재 본문 / nccAdId 검색..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="h-8 w-72"
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
          aria-controls="ads-advanced-filters"
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
            adTypeFilter === "ALL" &&
            statusFilter === "ALL" &&
            inspectFilter === "ALL" &&
            adgroupFilter === "ALL"
          }
        >
          초기화
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {/* stats 기간 select — 변경 시 RSC 재실행 (period query 갱신) */}
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
          ) : null}
          <span className="text-xs text-muted-foreground">
            총 {ads.length.toLocaleString()}건
            {rows.length !== ads.length && (
              <> (필터 후 {rows.length.toLocaleString()}건)</>
            )}
          </span>
        </div>
      </div>

      {/* 2차 toolbar — 타입 / 상태 / 검수 (가끔 쓰는 고급 필터). */}
      {showAdvanced ? (
        <div
          id="ads-advanced-filters"
          className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2"
        >
          <Select
            value={adTypeFilter}
            onValueChange={(v) => {
              const next = v ?? "ALL"
              setAdTypeFilter(next)
              updateQuery({ type: next })
            }}
          >
            <SelectTrigger className="w-32">
              <SelectValue placeholder="타입">
                {(v: string | null) =>
                  !v || v === "ALL" ? "타입 (전체)" : v
                }
              </SelectValue>
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
              OFF으로 변경
            </Button>
          </div>
        </div>
      ) : null}

      {/* 가상 스크롤 테이블 */}
      <div
        ref={parentRef}
        // 외부(페이지) 스크롤 발생 회피 — viewport 높이에서 PageHeader / nav / toolbar / 액션바 합 (~280px) 차감.
        // dvh 사용 — 모바일 chrome address bar 보정.
        className="relative max-h-[calc(100dvh-280px)] min-h-[320px] overflow-auto rounded-lg border"
      >
        {ads.length === 0 ? (
          adgroups.length === 0 ? (
            <EmptyState
              title="표시할 소재가 없습니다."
              description="소재는 광고그룹에 속합니다. 광고그룹을 먼저 동기화하세요."
              action={
                <Button
                  size="sm"
                  variant="outline"
                  render={<Link href={`/${advertiserId}/adgroups`} />}
                >
                  광고그룹 페이지로 이동
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="표시할 소재가 없습니다."
              description="우측 상단 동기화 버튼을 눌러 SA 에서 가져오세요."
            />
          )
        ) : rows.length === 0 ? (
          <EmptyState title="현재 필터에 일치하는 소재가 없습니다." />
        ) : (
          <table className="w-full caption-bottom text-sm" style={{ tableLayout: "fixed" }}>
            {/*
              컬럼 너비 표준화 — thead / tbody / tfoot 모두 colgroup 의 너비를 따름.
              13개 컬럼 매핑(makeColumns 순서 동일):
                1 select  2 preview(auto)  3 adgroup  4 type  5 status  6 inspect
                7 impCnt  8 clkCnt  9 ctr  10 cpc  11 salesAmt  12 updatedAt  13 actions
              auto(2) 가 남은 너비 차지 → 본문 풍부화 셀이 헤드라인/설명/URL 펼쳐 표시.
            */}
            <colgroup>
              <col style={{ width: 44 }} />
              <col style={{ width: 380 }} />
              <col style={{ width: 192 }} />
              <col style={{ width: 96 }} />
              <col style={{ width: 96 }} />
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
                          canSort &&
                            "cursor-pointer select-none hover:text-foreground",
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
            <MetricsFooter rows={rows} columnCount={columns.length} />
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
