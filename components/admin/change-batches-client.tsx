"use client"

/**
 * ChangeBatch 목록 클라이언트 (F-6.x)
 *
 * 구조:
 *   - 상단 필터 폼: userId / action / status / 날짜 범위
 *   - 결과 테이블: createdAt / userDisplayName / action / status(badge) / total / processed / failedCount / [상세]
 *   - "더 보기" 버튼: hasMore=true 시 cursor 다음 페이지 append
 *   - 행 클릭 또는 "상세" → /admin/change-batches/{id} 이동
 *
 * 상태 흐름:
 *   - useTransition 으로 조회 중 pending 표시
 *   - 새 필터 적용 → cursor 리셋 (onClick 핸들러 안에서 setState — effect 미사용)
 *   - "더 보기" → 같은 필터 + cursor 만 다음 응답으로 전환
 *
 * 안전장치:
 *   - 권한은 admin layout 에서 redirect, actions 내부 assertRole — 본 클라이언트 미관여
 *   - 빈 문자열 필드는 undefined 로 변환하여 전송 (Zod min(1) 에 걸리지 않도록)
 *
 * 디자인:
 *   - status 별 배지 색: pending=zinc, running=sky, done=emerald, failed=destructive
 *   - audit-logs-client.tsx 패턴 응용
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { EyeIcon } from "lucide-react"

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
import {
  listChangeBatches,
  type ChangeBatchFilter,
  type ChangeBatchPage,
  type ChangeBatchRow,
} from "@/app/admin/change-batches/actions"
import type { ChangeBatchStatus } from "@/lib/generated/prisma/client"

// =============================================================================
// 헬퍼
// =============================================================================

const PAGE_LIMIT = 50

function formatDateTime(iso: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso))
}

/**
 * input type="date" 의 "YYYY-MM-DD" 값을 ISO 문자열로 변환.
 *   - from: 그 날 00:00:00 (로컬)
 *   - to:   그 날 23:59:59.999 (로컬)
 * 빈 문자열은 undefined.
 */
function dateInputToIso(
  v: string,
  edge: "start" | "end",
): string | undefined {
  if (!v) return undefined
  const [yStr, mStr, dStr] = v.split("-")
  if (!yStr || !mStr || !dStr) return undefined
  const y = Number(yStr)
  const m = Number(mStr)
  const d = Number(dStr)
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return undefined
  }
  const date =
    edge === "start"
      ? new Date(y, m - 1, d, 0, 0, 0, 0)
      : new Date(y, m - 1, d, 23, 59, 59, 999)
  return date.toISOString()
}

function emptyToUndefined(v: string): string | undefined {
  const t = v.trim()
  return t.length > 0 ? t : undefined
}

export function StatusBadge({ status }: { status: ChangeBatchStatus }) {
  const tone =
    status === "done"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
      : status === "running"
        ? "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300"
        : status === "failed"
          ? "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300"
          : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {status}
    </span>
  )
}

// =============================================================================
// 폼 상태
// =============================================================================

type FormState = {
  userId: string
  action: string
  status: string // "all" or value
  fromDate: string // "YYYY-MM-DD"
  toDate: string
}

const INITIAL_FORM: FormState = {
  userId: "",
  action: "",
  status: "all",
  fromDate: "",
  toDate: "",
}

function buildFilter(form: FormState, cursor?: string): ChangeBatchFilter {
  const status =
    form.status === "all"
      ? undefined
      : (form.status as "pending" | "running" | "done" | "failed")
  return {
    userId: emptyToUndefined(form.userId),
    action: emptyToUndefined(form.action),
    status,
    fromTs: dateInputToIso(form.fromDate, "start"),
    toTs: dateInputToIso(form.toDate, "end"),
    cursor,
    limit: PAGE_LIMIT,
  }
}

// =============================================================================
// 메인
// =============================================================================

export function ChangeBatchesClient({
  initial,
}: {
  initial: ChangeBatchPage
}) {
  const router = useRouter()

  const [form, setForm] = React.useState<FormState>(INITIAL_FORM)
  // 현재 적용된 필터(서버 응답을 만든 필터). "더 보기" 시 그대로 cursor 만 갈아끼움.
  const [appliedFilter, setAppliedFilter] = React.useState<FormState>(
    INITIAL_FORM,
  )
  const [items, setItems] = React.useState<ChangeBatchRow[]>(initial.items)
  const [nextCursor, setNextCursor] = React.useState<string | null>(
    initial.nextCursor,
  )
  const [hasMore, setHasMore] = React.useState(initial.hasMore)

  const [pending, startTransition] = React.useTransition()
  const [moreLoading, setMoreLoading] = React.useState(false)

  function handleSearch() {
    const snapshot = form
    startTransition(async () => {
      try {
        const res = await listChangeBatches(buildFilter(snapshot))
        setAppliedFilter(snapshot)
        setItems(res.items)
        setNextCursor(res.nextCursor)
        setHasMore(res.hasMore)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        toast.error(`조회 오류: ${msg}`)
      }
    })
  }

  function handleReset() {
    setForm(INITIAL_FORM)
    startTransition(async () => {
      try {
        const res = await listChangeBatches(buildFilter(INITIAL_FORM))
        setAppliedFilter(INITIAL_FORM)
        setItems(res.items)
        setNextCursor(res.nextCursor)
        setHasMore(res.hasMore)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        toast.error(`초기화 오류: ${msg}`)
      }
    })
  }

  async function handleLoadMore() {
    if (!nextCursor || moreLoading) return
    setMoreLoading(true)
    try {
      const res = await listChangeBatches(
        buildFilter(appliedFilter, nextCursor),
      )
      setItems((prev) => [...prev, ...res.items])
      setNextCursor(res.nextCursor)
      setHasMore(res.hasMore)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`더 불러오기 오류: ${msg}`)
    } finally {
      setMoreLoading(false)
    }
  }

  function gotoDetail(id: string) {
    router.push(`/admin/change-batches/${id}`)
  }

  return (
    <div className="flex flex-col">
      {/* 필터 폼 */}
      <div className="flex flex-col gap-3 px-4 py-3 border-b">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">userId</Label>
            <Input
              value={form.userId}
              onChange={(e) =>
                setForm((s) => ({ ...s, userId: e.target.value }))
              }
              placeholder="UserProfile.id"
              className="w-56 font-mono text-xs"
              autoComplete="off"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">action</Label>
            <Input
              value={form.action}
              onChange={(e) =>
                setForm((s) => ({ ...s, action: e.target.value }))
              }
              placeholder="예: keyword.toggle"
              className="w-56 font-mono text-xs"
              autoComplete="off"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">status</Label>
            <Select
              value={form.status}
              onValueChange={(v) =>
                setForm((s) => ({ ...s, status: v ?? "all" }))
              }
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">전체</SelectItem>
                <SelectItem value="pending">대기 (pending)</SelectItem>
                <SelectItem value="running">실행 중 (running)</SelectItem>
                <SelectItem value="done">완료 (done)</SelectItem>
                <SelectItem value="failed">실패 (failed)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">시작일</Label>
            <Input
              type="date"
              value={form.fromDate}
              onChange={(e) =>
                setForm((s) => ({ ...s, fromDate: e.target.value }))
              }
              className="w-44"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">종료일</Label>
            <Input
              type="date"
              value={form.toDate}
              onChange={(e) =>
                setForm((s) => ({ ...s, toDate: e.target.value }))
              }
              className="w-44"
            />
          </div>

          <div className="ml-auto flex items-end gap-2">
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={pending}
            >
              초기화
            </Button>
            <Button onClick={handleSearch} disabled={pending}>
              {pending ? "조회 중..." : "조회"}
            </Button>
          </div>
        </div>
      </div>

      {/* 결과 표 */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="px-4">생성</TableHead>
            <TableHead>사용자</TableHead>
            <TableHead>action</TableHead>
            <TableHead>status</TableHead>
            <TableHead className="text-right">total</TableHead>
            <TableHead className="text-right">processed</TableHead>
            <TableHead className="text-right">failed</TableHead>
            <TableHead className="px-4 text-right">상세</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={8}
                className="px-4 py-10 text-center text-sm text-muted-foreground"
              >
                {pending
                  ? "조회 중..."
                  : "조건에 맞는 ChangeBatch 가 없습니다."}
              </TableCell>
            </TableRow>
          ) : (
            items.map((row) => (
              <TableRow
                key={row.id}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => gotoDetail(row.id)}
              >
                <TableCell className="px-4 text-xs text-muted-foreground tabular-nums">
                  {formatDateTime(row.createdAt)}
                </TableCell>
                <TableCell className="text-sm">
                  {row.userDisplayName ?? (
                    <span className="text-muted-foreground italic">
                      {row.userId ? "(삭제됨)" : "(시스템)"}
                    </span>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {row.action}
                </TableCell>
                <TableCell>
                  <StatusBadge status={row.status} />
                </TableCell>
                <TableCell className="text-right tabular-nums text-sm">
                  {row.total}
                </TableCell>
                <TableCell className="text-right tabular-nums text-sm">
                  {row.processed}
                </TableCell>
                <TableCell className="text-right tabular-nums text-sm">
                  {row.failedCount > 0 ? (
                    <span className="font-medium text-destructive">
                      {row.failedCount}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </TableCell>
                <TableCell className="px-4">
                  <div className="flex items-center justify-end">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        gotoDetail(row.id)
                      }}
                    >
                      <EyeIcon />
                      상세
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {/* 페이징 / 카운트 */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-t">
        <div className="text-xs text-muted-foreground">
          현재 {items.length}건
          {hasMore ? " (더 있음)" : ""}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleLoadMore}
          disabled={!hasMore || moreLoading || pending}
        >
          {moreLoading ? "불러오는 중..." : "더 보기"}
        </Button>
      </div>
    </div>
  )
}
