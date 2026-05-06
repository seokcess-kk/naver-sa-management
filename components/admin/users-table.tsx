"use client"

/**
 * 사용자 목록 테이블 (TanStack Table v8)
 *
 * 규모: 수십 명 → 가상화(TanStack Virtual) 미사용. 정렬·필터만.
 *
 * 컬럼: displayName / role / status / advertiserCount / createdAt / [상세 보기]
 *
 * 필터:
 *   - role 셀렉트 (전체 / admin / operator / viewer)
 *   - status 셀렉트 (전체 / active / disabled)
 *   - displayName 검색 (debounce 200ms — 키워드 테이블과 동일 패턴)
 *
 * 정렬: 헤더 클릭 → asc / desc / 없음 순환 (ArrowUpIcon / ArrowDownIcon / ArrowUpDownIcon)
 *
 * 인라인 편집 X — role / status 는 상세 페이지에서만 변경 가능.
 *   (관리자가 잘못 클릭으로 본인을 강등하는 사고 방지 + AuditLog 기록 확인)
 */

import * as React from "react"
import Link from "next/link"
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
} from "@tanstack/react-table"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowUpDownIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
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
import type { UserRow } from "@/app/admin/users/actions"
import type { UserRole, UserStatus } from "@/lib/generated/prisma/client"

// =============================================================================
// 헬퍼
// =============================================================================

function formatDate(iso: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso))
}

function RoleBadge({ role }: { role: UserRole }) {
  const tone =
    role === "admin"
      ? "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300"
      : role === "operator"
        ? "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300"
        : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {role}
    </span>
  )
}

function StatusBadge({ status }: { status: UserStatus }) {
  const tone =
    status === "active"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
      : "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400"
  const label = status === "active" ? "활성" : "비활성"
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {label}
    </span>
  )
}

// =============================================================================
// 컬럼 정의
// =============================================================================

const columns: ColumnDef<UserRow>[] = [
  {
    accessorKey: "displayName",
    header: "표시명",
    cell: ({ row }) => (
      <Link
        href={`/admin/users/${row.original.id}`}
        className="font-medium hover:underline"
      >
        {row.original.displayName}
      </Link>
    ),
    filterFn: (row, _columnId, filterValue: string) => {
      if (!filterValue) return true
      const v = String(row.original.displayName).toLowerCase()
      return v.includes(filterValue.toLowerCase())
    },
    sortingFn: (a, b) =>
      a.original.displayName.localeCompare(b.original.displayName, "ko"),
  },
  {
    accessorKey: "role",
    header: "역할",
    cell: ({ row }) => <RoleBadge role={row.original.role} />,
    filterFn: (row, _columnId, filterValue: string) => {
      if (!filterValue || filterValue === "all") return true
      return row.original.role === filterValue
    },
  },
  {
    accessorKey: "status",
    header: "상태",
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
    filterFn: (row, _columnId, filterValue: string) => {
      if (!filterValue || filterValue === "all") return true
      return row.original.status === filterValue
    },
  },
  {
    accessorKey: "advertiserCount",
    header: "광고주 수",
    cell: ({ row }) => (
      <span className="tabular-nums text-sm">
        {row.original.advertiserCount}
      </span>
    ),
  },
  {
    accessorKey: "createdAt",
    header: "등록일",
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {formatDate(row.original.createdAt)}
      </span>
    ),
    sortingFn: (a, b) =>
      a.original.createdAt.localeCompare(b.original.createdAt),
  },
  {
    id: "actions",
    header: "",
    cell: ({ row }) => (
      <div className="flex items-center justify-end">
        <Button
          variant="outline"
          size="sm"
          render={<Link href={`/admin/users/${row.original.id}`} />}
        >
          상세 보기
        </Button>
      </div>
    ),
    enableSorting: false,
  },
]

// =============================================================================
// 메인 컴포넌트
// =============================================================================

export function UsersTable({ users }: { users: UserRow[] }) {
  const [sorting, setSorting] = React.useState<SortingState>([
    { id: "createdAt", desc: true },
  ])
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    [],
  )

  // displayName 검색 — debounce 200ms (다른 테이블과 동일)
  const [search, setSearch] = React.useState("")
  React.useEffect(() => {
    const t = setTimeout(() => {
      setColumnFilters((prev) => {
        const others = prev.filter((f) => f.id !== "displayName")
        if (search.trim().length === 0) return others
        return [...others, { id: "displayName", value: search.trim() }]
      })
    }, 200)
    return () => clearTimeout(t)
  }, [search])

  const [roleFilter, setRoleFilter] = React.useState<string>("all")
  const [statusFilter, setStatusFilter] = React.useState<string>("all")

  React.useEffect(() => {
    setColumnFilters((prev) => {
      const others = prev.filter((f) => f.id !== "role")
      if (roleFilter === "all") return others
      return [...others, { id: "role", value: roleFilter }]
    })
  }, [roleFilter])

  React.useEffect(() => {
    setColumnFilters((prev) => {
      const others = prev.filter((f) => f.id !== "status")
      if (statusFilter === "all") return others
      return [...others, { id: "status", value: statusFilter }]
    })
  }, [statusFilter])

  const table = useReactTable({
    data: users,
    columns,
    state: { sorting, columnFilters },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  })

  const filteredCount = table.getRowModel().rows.length

  return (
    <div className="flex flex-col">
      {/* 필터 바 */}
      <div className="flex flex-wrap items-end gap-3 px-4 py-3 border-b">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">표시명 검색</Label>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="이름 일부 입력"
            className="w-56"
            autoComplete="off"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">역할</Label>
          <Select
            value={roleFilter}
            onValueChange={(v) => setRoleFilter(v ?? "all")}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">전체</SelectItem>
              <SelectItem value="admin">관리자 (admin)</SelectItem>
              <SelectItem value="operator">운영자 (operator)</SelectItem>
              <SelectItem value="viewer">뷰어 (viewer)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">상태</Label>
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v ?? "all")}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">전체</SelectItem>
              <SelectItem value="active">활성</SelectItem>
              <SelectItem value="disabled">비활성</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="ml-auto text-xs text-muted-foreground">
          {filteredCount} / {users.length}명
        </div>
      </div>

      {/* 테이블 */}
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((hg) => (
            <TableRow key={hg.id}>
              {hg.headers.map((header) => {
                const canSort = header.column.getCanSort()
                const sortDir = header.column.getIsSorted()
                return (
                  <TableHead key={header.id} className="px-4">
                    {header.isPlaceholder ? null : canSort ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="inline-flex items-center gap-1 text-left hover:text-foreground"
                      >
                        {flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                        {sortDir === "asc" ? (
                          <ArrowUpIcon className="size-3" />
                        ) : sortDir === "desc" ? (
                          <ArrowDownIcon className="size-3" />
                        ) : (
                          <ArrowUpDownIcon className="size-3 opacity-40" />
                        )}
                      </button>
                    ) : (
                      flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )
                    )}
                  </TableHead>
                )
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {filteredCount === 0 ? (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                className="px-4 py-10 text-center text-sm text-muted-foreground"
              >
                {users.length === 0
                  ? "등록된 사용자가 없습니다."
                  : "조건에 맞는 사용자가 없습니다."}
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} className="px-4">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}
