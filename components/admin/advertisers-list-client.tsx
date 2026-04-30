"use client"

/**
 * 광고주 목록 — 검색·필터·정렬 + 테이블 (Client Component).
 *
 * 가정:
 *   - 광고주 100개 이내 (admin 화면). 페이지네이션 후속 PR.
 *   - TanStack Table 미사용 — 단순 React state + sort/filter 한 번 패스.
 *   - 시크릿(Bytes)은 절대 props 로 들어오지 않음. RSC 단계에서 boolean 으로 변환됨.
 *
 * 검색·필터:
 *   - 검색 입력은 300ms debounce. name / customerId / manager / category 매칭.
 *   - status: 전체 / active / paused
 *   - 키 상태: 전체 / 설정 / 미설정
 *   - 카테고리: 전체 + DB distinct 목록 (props 로 주입)
 *
 * 정렬:
 *   - "표시명" / "캠페인" / "마지막 동기화" 클릭 정렬. 기본은 createdAt desc (서버 정렬 유지).
 *
 * 행 hover 액션:
 *   - 기본: [상세] 만 노출
 *   - hover 시: [테스트 연결] [광고주 진입] 가 fade-in
 *
 * 마지막 동기화:
 *   - 5종 sync kind 중 가장 오래된 ISO 를 LastSyncBadge 에 전달.
 *   - 1개라도 누락이면 LastSyncBadge 가 "동기화 이력 없음" 처리.
 */

import * as React from "react"
import Link from "next/link"
import {
  ArrowUpIcon,
  ArrowDownIcon,
  ArrowUpDownIcon,
  ExternalLinkIcon,
  SearchIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
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
import { TestConnectionButton } from "@/components/admin/test-connection-button"
import { KeyStatusBadge } from "@/components/admin/key-status-badge"
import { LastSyncBadge } from "@/components/dashboard/last-sync-badge"
import { cn } from "@/lib/utils"

const SYNC_KINDS = [
  "campaigns",
  "adgroups",
  "keywords",
  "ads",
  "extensions",
] as const

export type AdvertiserListRow = {
  id: string
  name: string
  customerId: string
  category: string | null
  manager: string | null
  status: "active" | "paused" | "archived"
  createdAt: string // ISO — 클라이언트 직렬화 안정성 위해 RSC 에서 toISOString()
  hasApiKey: boolean
  hasSecretKey: boolean
  /** 5종 sync kind 별 ISO. 누락 키는 정상 (미동기화). */
  lastSyncAt: Record<string, string>
  /** 캠페인 수 (status != 'deleted' 합산) */
  campaignCount: number
}

export type AdvertisersListClientProps = {
  rows: AdvertiserListRow[]
  /** DB distinct 카테고리 목록 (null 제외) — 셀렉트 옵션 */
  categories: string[]
}

type StatusFilter = "all" | "active" | "paused"
type KeyFilter = "all" | "set" | "missing"
type SortKey = "name" | "campaigns" | "lastSync" | "default"
type SortDir = "asc" | "desc"

/** 5종 sync kind 중 가장 오래된 ISO. 누락 키 1개 이상이면 undefined. */
function pickOldestSync(map: Record<string, string>): string | undefined {
  let oldestTs: number | null = null
  let oldestIso: string | undefined
  for (const k of SYNC_KINDS) {
    const iso = map[k]
    if (!iso) return undefined
    const t = Date.parse(iso)
    if (Number.isNaN(t)) continue
    if (oldestTs === null || t < oldestTs) {
      oldestTs = t
      oldestIso = iso
    }
  }
  return oldestIso
}

export function AdvertisersListClient({
  rows,
  categories,
}: AdvertisersListClientProps) {
  const [searchInput, setSearchInput] = React.useState("")
  const [search, setSearch] = React.useState("") // debounced
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all")
  const [keyFilter, setKeyFilter] = React.useState<KeyFilter>("all")
  const [categoryFilter, setCategoryFilter] = React.useState<string>("all")
  const [sortKey, setSortKey] = React.useState<SortKey>("default")
  const [sortDir, setSortDir] = React.useState<SortDir>("desc")

  // 검색 debounce 300ms — 광고주 100개 가정에서 과한 갱신 방지.
  React.useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim().toLowerCase()), 300)
    return () => clearTimeout(id)
  }, [searchInput])

  const filtered = React.useMemo(() => {
    const out: AdvertiserListRow[] = []
    for (const r of rows) {
      // 상태
      if (statusFilter !== "all" && r.status !== statusFilter) continue

      // 키 상태
      const hasBoth = r.hasApiKey && r.hasSecretKey
      if (keyFilter === "set" && !hasBoth) continue
      if (keyFilter === "missing" && hasBoth) continue

      // 카테고리
      if (categoryFilter !== "all") {
        if (categoryFilter === "__none__") {
          if (r.category) continue
        } else if (r.category !== categoryFilter) {
          continue
        }
      }

      // 검색 (name / customerId / manager / category)
      if (search.length > 0) {
        const hay = [
          r.name,
          r.customerId,
          r.manager ?? "",
          r.category ?? "",
        ]
          .join(" ")
          .toLowerCase()
        if (!hay.includes(search)) continue
      }

      out.push(r)
    }

    // 정렬
    if (sortKey !== "default") {
      const dir = sortDir === "asc" ? 1 : -1
      out.sort((a, b) => {
        if (sortKey === "name") {
          return a.name.localeCompare(b.name, "ko") * dir
        }
        if (sortKey === "campaigns") {
          return (a.campaignCount - b.campaignCount) * dir
        }
        if (sortKey === "lastSync") {
          // oldest sync (없으면 0) — 미동기화는 항상 가장 오래됨 취급
          const aIso = pickOldestSync(a.lastSyncAt)
          const bIso = pickOldestSync(b.lastSyncAt)
          const aTs = aIso ? Date.parse(aIso) : 0
          const bTs = bIso ? Date.parse(bIso) : 0
          return (aTs - bTs) * dir
        }
        return 0
      })
    }
    return out
  }, [rows, search, statusFilter, keyFilter, categoryFilter, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (sortKey !== key) {
      setSortKey(key)
      setSortDir("asc")
      return
    }
    if (sortDir === "asc") {
      setSortDir("desc")
      return
    }
    // 두 번째 desc → 정렬 해제 (default 복귀)
    setSortKey("default")
    setSortDir("desc")
  }

  const total = rows.length
  const visible = filtered.length

  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <CardTitle className="text-base">
            등록된 광고주{" "}
            <span className="text-sm font-normal text-muted-foreground">
              ({visible} / {total})
            </span>
          </CardTitle>
          <ListFilterBar
            searchInput={searchInput}
            onSearchChange={setSearchInput}
            statusFilter={statusFilter}
            onStatusChange={setStatusFilter}
            keyFilter={keyFilter}
            onKeyChange={setKeyFilter}
            categoryFilter={categoryFilter}
            onCategoryChange={setCategoryFilter}
            categories={categories}
          />
        </div>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-4">
                <SortableHeader
                  label="표시명"
                  active={sortKey === "name"}
                  dir={sortDir}
                  onClick={() => toggleSort("name")}
                />
              </TableHead>
              <TableHead>customerId</TableHead>
              <TableHead>상태</TableHead>
              <TableHead>키</TableHead>
              <TableHead className="text-right">
                <SortableHeader
                  label="캠페인"
                  active={sortKey === "campaigns"}
                  dir={sortDir}
                  onClick={() => toggleSort("campaigns")}
                  align="right"
                />
              </TableHead>
              <TableHead>
                <SortableHeader
                  label="마지막 동기화"
                  active={sortKey === "lastSync"}
                  dir={sortDir}
                  onClick={() => toggleSort("lastSync")}
                />
              </TableHead>
              <TableHead className="px-4 text-right">액션</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="px-4 py-10 text-center text-sm text-muted-foreground"
                >
                  {total === 0
                    ? "등록된 광고주가 없습니다. 우측 상단 \"새 광고주 등록\" 또는 \"CSV 일괄 등록\" 버튼으로 등록하세요."
                    : "조건에 맞는 광고주가 없습니다. 검색어 / 필터를 조정하세요."}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((a) => (
                <Row key={a.id} row={a} />
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function Row({ row }: { row: AdvertiserListRow }) {
  const oldestSync = pickOldestSync(row.lastSyncAt)
  const hasKeys = row.hasApiKey && row.hasSecretKey

  return (
    <TableRow className="group">
      <TableCell className="px-4 font-medium">
        <div className="flex flex-col gap-0.5">
          <Link
            href={`/admin/advertisers/${row.id}`}
            className="hover:underline"
          >
            {row.name}
          </Link>
          {(row.category || row.manager) && (
            <span className="text-xs text-muted-foreground">
              {row.category ?? "-"}
              {row.manager ? ` · ${row.manager}` : ""}
            </span>
          )}
        </div>
      </TableCell>
      <TableCell className="font-mono text-xs">{row.customerId}</TableCell>
      <TableCell>
        <StatusBadge status={row.status} />
      </TableCell>
      <TableCell>
        <KeyStatusBadge
          hasApiKey={row.hasApiKey}
          hasSecretKey={row.hasSecretKey}
        />
      </TableCell>
      <TableCell className="text-right tabular-nums text-sm">
        {row.campaignCount.toLocaleString("ko-KR")}
      </TableCell>
      <TableCell>
        <LastSyncBadge syncedAt={oldestSync} showHint={false} />
      </TableCell>
      <TableCell className="px-4">
        <div className="flex items-center justify-end gap-2">
          {/* hover 시 fade-in 액션 */}
          <div
            className={cn(
              "flex items-center gap-2",
              "opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100",
            )}
          >
            <TestConnectionButton id={row.id} hasKeys={hasKeys} />
            <Button
              variant="outline"
              size="sm"
              render={
                <Link
                  href={`/${row.id}`}
                  aria-label={`${row.name} 광고주 대시보드 진입`}
                />
              }
            >
              <ExternalLinkIcon className="size-3.5" />
              진입
            </Button>
          </div>
          <Button
            variant="outline"
            size="sm"
            render={<Link href={`/admin/advertisers/${row.id}`} />}
          >
            상세
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}

function SortableHeader({
  label,
  active,
  dir,
  onClick,
  align = "left",
}: {
  label: string
  active: boolean
  dir: SortDir
  onClick: () => void
  align?: "left" | "right"
}) {
  const Icon = !active
    ? ArrowUpDownIcon
    : dir === "asc"
      ? ArrowUpIcon
      : ArrowDownIcon
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground",
        align === "right" && "ml-auto",
      )}
    >
      {label}
      <Icon
        className={cn(
          "size-3.5",
          active ? "text-foreground" : "text-muted-foreground/60",
        )}
      />
    </button>
  )
}

function ListFilterBar({
  searchInput,
  onSearchChange,
  statusFilter,
  onStatusChange,
  keyFilter,
  onKeyChange,
  categoryFilter,
  onCategoryChange,
  categories,
}: {
  searchInput: string
  onSearchChange: (v: string) => void
  statusFilter: StatusFilter
  onStatusChange: (v: StatusFilter) => void
  keyFilter: KeyFilter
  onKeyChange: (v: KeyFilter) => void
  categoryFilter: string
  onCategoryChange: (v: string) => void
  categories: string[]
}) {
  const hasUncategorized = true // "(미지정)" 옵션 항상 노출
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="이름·cid·담당자 검색"
          value={searchInput}
          onChange={(e) => onSearchChange(e.target.value)}
          className="h-8 w-56 pl-8"
          aria-label="광고주 검색"
          autoComplete="off"
        />
      </div>

      <Select
        value={statusFilter}
        onValueChange={(v) => onStatusChange(v as StatusFilter)}
      >
        <SelectTrigger size="sm" className="w-32" aria-label="상태 필터">
          <SelectValue placeholder="상태">
            {(v: string | null) => {
              const labels: Record<string, string> = {
                all: "상태 전체",
                active: "활성",
                paused: "일시중지",
              }
              return v ? (labels[v] ?? v) : "상태"
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">상태 전체</SelectItem>
          <SelectItem value="active">활성</SelectItem>
          <SelectItem value="paused">일시중지</SelectItem>
        </SelectContent>
      </Select>

      <Select
        value={keyFilter}
        onValueChange={(v) => onKeyChange(v as KeyFilter)}
      >
        <SelectTrigger size="sm" className="w-32" aria-label="키 상태 필터">
          <SelectValue placeholder="키">
            {(v: string | null) => {
              const labels: Record<string, string> = {
                all: "키 전체",
                set: "키 설정",
                missing: "키 미설정",
              }
              return v ? (labels[v] ?? v) : "키"
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">키 전체</SelectItem>
          <SelectItem value="set">키 설정</SelectItem>
          <SelectItem value="missing">키 미설정</SelectItem>
        </SelectContent>
      </Select>

      <Select
        value={categoryFilter}
        onValueChange={(v) => {
          // base-ui Select 의 onValueChange 시그니처는 string | null. SelectItem 만 넣으므로 null 비도달.
          if (v !== null) onCategoryChange(v)
        }}
      >
        <SelectTrigger size="sm" className="w-40" aria-label="카테고리 필터">
          <SelectValue placeholder="카테고리">
            {(v: string | null) => {
              if (!v || v === "all") return "카테고리 전체"
              if (v === "__none__") return "(미지정)"
              return v
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">카테고리 전체</SelectItem>
          {hasUncategorized ? (
            <SelectItem value="__none__">(미지정)</SelectItem>
          ) : null}
          {categories.map((c) => (
            <SelectItem key={c} value={c}>
              {c}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function StatusBadge({ status }: { status: AdvertiserListRow["status"] }) {
  const tone =
    status === "active"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
      : status === "paused"
        ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
        : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
  const label =
    status === "active"
      ? "활성"
      : status === "paused"
        ? "일시중지"
        : "아카이브"
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {label}
    </span>
  )
}
