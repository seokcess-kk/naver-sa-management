"use client"

/**
 * 감사 로그 — 필터 + 결과 테이블 + 상세 모달 (F-1.7)
 *
 * 구조:
 *   - 상단 필터 폼: action / targetType / userId / targetId / advertiserId / 날짜 범위
 *   - 결과 테이블: ts / userDisplayName / action / targetType / targetId / [상세]
 *   - "더 보기" 버튼: hasMore=true 시 cursor 다음 페이지 append
 *   - 상세 모달: before / after JSON pretty
 *
 * 상태 흐름:
 *   - useTransition 으로 조회 중 pending 표시
 *   - 새 필터 적용 → cursor 리셋 (onClick 핸들러 안에서 setState — effect 미사용)
 *   - "더 보기" → 같은 필터 + cursor 만 다음 응답으로 전환
 *
 * 안전장치:
 *   - 권한은 admin layout 에서 redirect, actions 내부 assertRole — 본 클라이언트 미관여
 *   - listAuditLogs 의 limit 상한(200) 은 backend 에서 clamp — 본 컴포넌트는 50 고정
 *   - 빈 문자열 필드는 undefined 로 변환하여 전송 (Zod min(1) 에 걸리지 않도록)
 *   - 시크릿 마스킹은 적재 단계 책임 — JSON 그대로 표시
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
  listAuditLogs,
  type AuditFilter,
  type AuditFilterOptions,
  type AuditLogPage,
  type AuditLogRow,
} from "@/app/admin/audit/actions"
import { AuditDetailModal } from "@/components/admin/audit-detail-modal"

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

// =============================================================================
// 폼 상태
// =============================================================================

type FormState = {
  action: string // "all" or value
  targetType: string // "all" or value
  userId: string
  targetId: string
  advertiserId: string
  fromDate: string // "YYYY-MM-DD"
  toDate: string
}

const INITIAL_FORM: FormState = {
  action: "all",
  targetType: "all",
  userId: "",
  targetId: "",
  advertiserId: "",
  fromDate: "",
  toDate: "",
}

function buildFilter(form: FormState, cursor?: string): AuditFilter {
  return {
    action: form.action !== "all" ? form.action : undefined,
    targetType: form.targetType !== "all" ? form.targetType : undefined,
    userId: emptyToUndefined(form.userId),
    targetId: emptyToUndefined(form.targetId),
    advertiserId: emptyToUndefined(form.advertiserId),
    fromTs: dateInputToIso(form.fromDate, "start"),
    toTs: dateInputToIso(form.toDate, "end"),
    cursor,
    limit: PAGE_LIMIT,
  }
}

// =============================================================================
// 메인
// =============================================================================

export function AuditLogsClient({
  initial,
  filterOptions,
}: {
  initial: AuditLogPage
  filterOptions: AuditFilterOptions
}) {
  const [form, setForm] = React.useState<FormState>(INITIAL_FORM)
  // 현재 적용된 필터(서버 응답을 만든 필터). "더 보기" 시 그대로 cursor 만 갈아끼움.
  const [appliedFilter, setAppliedFilter] = React.useState<FormState>(
    INITIAL_FORM,
  )
  const [items, setItems] = React.useState<AuditLogRow[]>(initial.items)
  const [nextCursor, setNextCursor] = React.useState<string | null>(
    initial.nextCursor,
  )
  const [hasMore, setHasMore] = React.useState(initial.hasMore)

  const [pending, startTransition] = React.useTransition()
  const [moreLoading, setMoreLoading] = React.useState(false)

  // 상세 모달 상태
  const [detailRow, setDetailRow] = React.useState<AuditLogRow | null>(null)

  function handleSearch() {
    const snapshot = form
    startTransition(async () => {
      try {
        const res = await listAuditLogs(buildFilter(snapshot))
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
        const res = await listAuditLogs(buildFilter(INITIAL_FORM))
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
      const res = await listAuditLogs(
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

  return (
    <div className="flex flex-col">
      {/* 필터 폼 */}
      <div className="flex flex-col gap-3 px-4 py-3 border-b">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">action</Label>
            <Select
              value={form.action}
              onValueChange={(v) =>
                setForm((s) => ({ ...s, action: v ?? "all" }))
              }
            >
              <SelectTrigger className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">전체</SelectItem>
                {filterOptions.actions.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">targetType</Label>
            <Select
              value={form.targetType}
              onValueChange={(v) =>
                setForm((s) => ({ ...s, targetType: v ?? "all" }))
              }
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">전체</SelectItem>
                {filterOptions.targetTypes.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

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
            <Label className="text-xs">targetId</Label>
            <Input
              value={form.targetId}
              onChange={(e) =>
                setForm((s) => ({ ...s, targetId: e.target.value }))
              }
              placeholder="대상 엔티티 ID"
              className="w-56 font-mono text-xs"
              autoComplete="off"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">advertiserId</Label>
            <Input
              value={form.advertiserId}
              onChange={(e) =>
                setForm((s) => ({ ...s, advertiserId: e.target.value }))
              }
              placeholder="Advertiser.id"
              className="w-56 font-mono text-xs"
              autoComplete="off"
            />
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
            <TableHead className="px-4">시각</TableHead>
            <TableHead>사용자</TableHead>
            <TableHead>action</TableHead>
            <TableHead>targetType</TableHead>
            <TableHead>targetId</TableHead>
            <TableHead className="px-4 text-right">상세</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={6}
                className="px-4 py-10 text-center text-sm text-muted-foreground"
              >
                {pending
                  ? "조회 중..."
                  : "조건에 맞는 로그가 없습니다."}
              </TableCell>
            </TableRow>
          ) : (
            items.map((row) => (
              <TableRow
                key={row.id}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => setDetailRow(row)}
              >
                <TableCell className="px-4 text-xs text-muted-foreground tabular-nums">
                  {formatDateTime(row.ts)}
                </TableCell>
                <TableCell className="text-sm">
                  {row.userDisplayName ?? (
                    <span className="text-muted-foreground italic">
                      (삭제됨)
                    </span>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {row.action}
                </TableCell>
                <TableCell className="text-sm">{row.targetType}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {row.targetId ?? "-"}
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

      {/* 상세 모달 */}
      <AuditDetailModal
        row={detailRow}
        onClose={() => setDetailRow(null)}
      />
    </div>
  )
}
