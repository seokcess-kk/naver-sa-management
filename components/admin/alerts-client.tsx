"use client"

/**
 * 알림 이벤트 — 필터 + 결과 테이블 + 상세 모달 (F-8.x)
 *
 * 구조:
 *   - 상단 필터: ruleId / status / advertiserId / 날짜 범위
 *   - 결과 테이블: createdAt / rule.type / status badge / payload 요약 / sentAt / [상세]
 *   - "더 보기" 버튼: hasMore=true 시 cursor 다음 페이지 append
 *   - 상세 모달: payload JSON pretty
 *
 * 날짜 필터:
 *   - listAlertEvents 액션은 fromTs / toTs 미지원 → 클라이언트에서 cursor 결과 후 필터 (UX 보조).
 *     백엔드 후속 PR 에서 fromTs/toTs 추가 시 본 컴포넌트도 변경.
 *
 * 안전장치:
 *   - 권한은 admin layout / actions 가 보장
 *   - listAlertEvents limit 상한 200 — 본 컴포넌트는 100 고정
 *   - 빈 문자열 필드는 undefined 로 변환
 */

import * as React from "react"
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  listAlertEvents,
  type AlertEventFilter,
  type AlertEventPage,
  type AlertEventRow,
} from "@/app/admin/alerts/actions"

// =============================================================================
// 헬퍼
// =============================================================================

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

const TYPE_LABEL: Record<string, string> = {
  budget_burn: "예산 소진",
  bizmoney_low: "비즈머니 부족",
  api_auth_error: "API 인증 실패",
  inspect_rejected: "검수 거절",
}

const STATUS_LABEL: Record<string, string> = {
  pending: "대기",
  sent: "발송",
  failed: "실패",
  muted: "음소거",
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "sent"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
      : status === "failed"
        ? "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300"
        : status === "muted"
          ? "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          : "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  )
}

function SeverityDot({ severity }: { severity: string | null }) {
  const color =
    severity === "critical"
      ? "bg-rose-500"
      : severity === "warn"
        ? "bg-amber-500"
        : severity === "info"
          ? "bg-sky-500"
          : "bg-zinc-400"
  return <span className={`inline-block size-2 rounded-full ${color}`} />
}

function payloadSeverity(payload: unknown): string | null {
  if (payload == null || typeof payload !== "object") return null
  const v = (payload as Record<string, unknown>).severity
  return typeof v === "string" ? v : null
}

function payloadTitle(payload: unknown): string {
  if (payload == null || typeof payload !== "object") return "-"
  const v = (payload as Record<string, unknown>).title
  return typeof v === "string" ? v : "-"
}

function payloadBody(payload: unknown): string {
  if (payload == null || typeof payload !== "object") return ""
  const v = (payload as Record<string, unknown>).body
  return typeof v === "string" ? v : ""
}

function emptyToUndefined(v: string): string | undefined {
  const t = v.trim()
  return t.length > 0 ? t : undefined
}

function dateInputToIso(v: string, edge: "start" | "end"): string | undefined {
  if (!v) return undefined
  const [yStr, mStr, dStr] = v.split("-")
  if (!yStr || !mStr || !dStr) return undefined
  const y = Number(yStr)
  const m = Number(mStr)
  const d = Number(dStr)
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return undefined
  }
  return edge === "start"
    ? new Date(y, m - 1, d, 0, 0, 0, 0).toISOString()
    : new Date(y, m - 1, d, 23, 59, 59, 999).toISOString()
}

function prettyJson(value: unknown): string {
  if (value == null) return "(없음)"
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

// =============================================================================
// 폼 상태
// =============================================================================

type FormState = {
  ruleId: string
  status: string // "all" or value
  advertiserId: string
  fromDate: string
  toDate: string
}

const INITIAL_FORM: FormState = {
  ruleId: "all",
  status: "all",
  advertiserId: "all",
  fromDate: "",
  toDate: "",
}

function buildFilter(
  form: FormState,
  cursor: string | undefined,
  limit: number,
): AlertEventFilter {
  return {
    ruleId: form.ruleId !== "all" ? form.ruleId : undefined,
    status:
      form.status !== "all"
        ? (form.status as AlertEventFilter["status"])
        : undefined,
    advertiserId:
      form.advertiserId !== "all" ? form.advertiserId : undefined,
    cursor,
    limit,
  }
}

/** 백엔드가 fromTs/toTs 미지원 → 클라이언트 측에서 createdAt 범위 필터 적용 (UX 보조). */
function clientDateFilter(
  rows: AlertEventRow[],
  form: FormState,
): AlertEventRow[] {
  const fromIso = dateInputToIso(form.fromDate, "start")
  const toIso = dateInputToIso(form.toDate, "end")
  if (!fromIso && !toIso) return rows
  const fromMs = fromIso ? new Date(fromIso).getTime() : Number.NEGATIVE_INFINITY
  const toMs = toIso ? new Date(toIso).getTime() : Number.POSITIVE_INFINITY
  return rows.filter((r) => {
    const t = new Date(r.createdAt).getTime()
    return t >= fromMs && t <= toMs
  })
}

// =============================================================================
// 메인
// =============================================================================

export function AlertsClient({
  initial,
  initialLimit,
  rules,
  advertisers,
}: {
  initial: AlertEventPage
  initialLimit: number
  rules: { id: string; type: string }[]
  advertisers: { id: string; name: string; customerId: string }[]
}) {
  const [form, setForm] = React.useState<FormState>(INITIAL_FORM)
  const [appliedFilter, setAppliedFilter] =
    React.useState<FormState>(INITIAL_FORM)
  const [items, setItems] = React.useState<AlertEventRow[]>(initial.items)
  const [nextCursor, setNextCursor] = React.useState<string | null>(
    initial.nextCursor,
  )
  const [hasMore, setHasMore] = React.useState(initial.hasMore)

  const [pending, startTransition] = React.useTransition()
  const [moreLoading, setMoreLoading] = React.useState(false)

  // 상세 모달
  const [detailRow, setDetailRow] = React.useState<AlertEventRow | null>(null)

  function handleSearch() {
    const snapshot = form
    startTransition(async () => {
      try {
        const res = await listAlertEvents(
          buildFilter(snapshot, undefined, initialLimit),
        )
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
        const res = await listAlertEvents(
          buildFilter(INITIAL_FORM, undefined, initialLimit),
        )
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
      const res = await listAlertEvents(
        buildFilter(appliedFilter, nextCursor, initialLimit),
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

  // 클라이언트 날짜 필터 적용 (백엔드 미지원)
  const visibleItems = React.useMemo(
    () => clientDateFilter(items, appliedFilter),
    [items, appliedFilter],
  )

  return (
    <div className="flex flex-col">
      {/* 필터 */}
      <div className="flex flex-col gap-3 px-4 py-3 border-b">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">룰</Label>
            <Select
              value={form.ruleId}
              onValueChange={(v) =>
                setForm((s) => ({ ...s, ruleId: v ?? "all" }))
              }
            >
              <SelectTrigger className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">전체</SelectItem>
                {rules.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {TYPE_LABEL[r.type] ?? r.type} · {r.id.slice(0, 8)}…
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">상태</Label>
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
                <SelectItem value="pending">대기</SelectItem>
                <SelectItem value="sent">발송</SelectItem>
                <SelectItem value="failed">실패</SelectItem>
                <SelectItem value="muted">음소거</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">광고주</Label>
            <Select
              value={form.advertiserId}
              onValueChange={(v) =>
                setForm((s) => ({ ...s, advertiserId: v ?? "all" }))
              }
            >
              <SelectTrigger className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">전체</SelectItem>
                {advertisers.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name} ({a.customerId})
                  </SelectItem>
                ))}
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
            <Button variant="outline" onClick={handleReset} disabled={pending}>
              초기화
            </Button>
            <Button onClick={handleSearch} disabled={pending}>
              {pending ? "조회 중..." : "조회"}
            </Button>
          </div>
        </div>

        {(emptyToUndefined(form.fromDate) ||
          emptyToUndefined(form.toDate)) && (
          <p className="text-[11px] text-muted-foreground">
            * 날짜 필터는 현재 페이지의 결과 안에서만 적용됩니다 (서버 측
            keyset cursor 와 분리).
          </p>
        )}
      </div>

      {/* 결과 표 */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="px-4">시각</TableHead>
            <TableHead>룰</TableHead>
            <TableHead>상태</TableHead>
            <TableHead>내용</TableHead>
            <TableHead>발송</TableHead>
            <TableHead className="px-4 text-right">상세</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visibleItems.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={6}
                className="px-4 py-10 text-center text-sm text-muted-foreground"
              >
                {pending
                  ? "조회 중..."
                  : "조건에 맞는 이벤트가 없습니다."}
              </TableCell>
            </TableRow>
          ) : (
            visibleItems.map((row) => {
              const sev = payloadSeverity(row.payload)
              const title = payloadTitle(row.payload)
              const body = payloadBody(row.payload)
              return (
                <TableRow
                  key={row.id}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => setDetailRow(row)}
                >
                  <TableCell className="px-4 text-xs text-muted-foreground tabular-nums">
                    {formatDateTime(row.createdAt)}
                  </TableCell>
                  <TableCell className="text-sm">
                    {TYPE_LABEL[row.ruleType] ?? row.ruleType}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={row.status} />
                  </TableCell>
                  <TableCell className="min-w-0 max-w-md">
                    <div className="flex items-center gap-2">
                      <SeverityDot severity={sev} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">{title}</div>
                        {body && (
                          <div className="truncate text-xs text-muted-foreground">
                            {body.slice(0, 120)}
                          </div>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground tabular-nums">
                    {row.sentAt ? formatDateTime(row.sentAt) : "-"}
                  </TableCell>
                  <TableCell className="px-4">
                    <div className="flex items-center justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation()
                          setDetailRow(row)
                        }}
                      >
                        <EyeIcon />
                        보기
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })
          )}
        </TableBody>
      </Table>

      {/* 페이징 */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-t">
        <div className="text-xs text-muted-foreground">
          현재 {visibleItems.length}건 / 누적 {items.length}건
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

      <AlertDetailModal
        row={detailRow}
        onClose={() => setDetailRow(null)}
      />
    </div>
  )
}

// =============================================================================
// 상세 모달 (audit-detail-modal 응용)
// =============================================================================

function AlertDetailModal({
  row,
  onClose,
}: {
  row: AlertEventRow | null
  onClose: () => void
}) {
  const open = row != null
  function handleOpenChange(next: boolean) {
    if (!next) onClose()
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>알림 이벤트 상세</DialogTitle>
          <DialogDescription>
            평가기 적재 시점의 payload 전체 입니다. 시크릿 평문은 평가기/dispatch
            단계에서 사전 배제됩니다.
          </DialogDescription>
        </DialogHeader>

        {row != null ? (
          <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
              <Meta label="ID" value={row.id} mono />
              <Meta label="시각" value={formatDateTime(row.createdAt)} />
              <Meta label="ruleId" value={row.ruleId} mono />
              <Meta
                label="룰 type"
                value={TYPE_LABEL[row.ruleType] ?? row.ruleType}
              />
              <Meta label="status" value={STATUS_LABEL[row.status] ?? row.status} />
              <Meta
                label="sentAt"
                value={row.sentAt ? formatDateTime(row.sentAt) : "-"}
              />
            </dl>

            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="text-xs font-medium text-muted-foreground">
                payload
              </div>
              <pre className="max-h-96 overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
                {prettyJson(row.payload)}
              </pre>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            닫기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Meta({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd
        className={
          mono
            ? "min-w-0 flex-1 truncate font-mono text-[11px]"
            : "min-w-0 flex-1 truncate"
        }
      >
        {value}
      </dd>
    </div>
  )
}
