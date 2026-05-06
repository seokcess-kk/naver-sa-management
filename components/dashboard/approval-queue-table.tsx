"use client"

/**
 * F-D.4 ApprovalQueue 테이블 (Client)
 *
 * 정책 / 패턴 (bid-suggestion-table 참고):
 *   - shadcn Table + 클라이언트 정렬·필터 (행 < 1000 가정 — 가상 스크롤 미적용)
 *   - 다중 선택 헤더 액션 2개:
 *     * "선택 승인" → 모달 미리보기 (count + 광고그룹별 합계) → 확정 → approveQueue
 *     * "선택 거부" → 단순 확인 → rejectQueue
 *   - 결과 다이얼로그 — ChangeBatch ID 표시 (B.3 패턴)
 *
 * 본 PR 범위:
 *   - kind='search_term_promote' 만 (search_term_exclude 는 비대상 — pending 표시만)
 *   - payload.searchTerm / payload.adgroupId / payload.metrics 표시
 *
 * 비대상:
 *   - 가상 스크롤
 *   - useChangeBatchProgress polling
 *   - search_term_exclude 흐름
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  approveQueue,
  rejectQueue,
  type ApproveQueueResult,
} from "@/app/(dashboard)/[advertiserId]/approval-queue/actions"
import { cn } from "@/lib/utils"

// =============================================================================
// 타입
// =============================================================================

export type ApprovalQueueKind = "search_term_promote" | "search_term_exclude"

export type PromoteMetrics = {
  impressions: number
  clicks: number
  cost: number
  conversions: number | null
  ctr: number | null
  cpc: number | null
  cpa: number | null
}

export type PromotePayload = {
  searchTerm?: string
  adgroupId?: string
  metrics?: PromoteMetrics
}

export type ApprovalQueueRow = {
  id: string
  kind: ApprovalQueueKind
  payload: PromotePayload | Record<string, unknown> | null
  createdAt: string // ISO
}

export type AdgroupOption = {
  id: string
  name: string
  status: "on" | "off" | "deleted"
  campaignName: string
}

type KindFilter = "all" | "search_term_promote" | "search_term_exclude"

// =============================================================================
// 본 컴포넌트
// =============================================================================

export function ApprovalQueueTable({
  advertiserId,
  rows,
  adgroupOptions,
  userRole,
}: {
  advertiserId: string
  rows: ApprovalQueueRow[]
  adgroupOptions: AdgroupOption[]
  userRole: "admin" | "operator" | "viewer"
}) {
  const router = useRouter()
  const canMutate = userRole === "admin" || userRole === "operator"

  // 필터
  const [kindFilter, setKindFilter] = React.useState<KindFilter>("all")
  const [textFilter, setTextFilter] = React.useState("")

  // 선택
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())

  // 모달
  const [approveOpen, setApproveOpen] = React.useState(false)
  const [rejectOpen, setRejectOpen] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [resultDialog, setResultDialog] =
    React.useState<ApproveQueueResult | null>(null)

  // 광고그룹 이름 매핑
  const adgroupNameById = React.useMemo(() => {
    const m = new Map<string, { name: string; campaignName: string }>()
    for (const g of adgroupOptions) {
      m.set(g.id, { name: g.name, campaignName: g.campaignName })
    }
    return m
  }, [adgroupOptions])

  // 필터 적용
  const filtered = React.useMemo(() => {
    const t = textFilter.trim().toLowerCase()
    return rows.filter((r) => {
      if (kindFilter !== "all" && r.kind !== kindFilter) return false
      if (t.length > 0) {
        const p = (r.payload ?? {}) as PromotePayload
        const adgroupName = p.adgroupId
          ? (adgroupNameById.get(p.adgroupId)?.name ?? "")
          : ""
        const blob = [p.searchTerm ?? "", adgroupName, r.kind]
          .join(" ")
          .toLowerCase()
        if (!blob.includes(t)) return false
      }
      return true
    })
  }, [rows, kindFilter, textFilter, adgroupNameById])

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((r) => selectedIds.has(r.id))
  const someFilteredSelected =
    filtered.some((r) => selectedIds.has(r.id)) && !allFilteredSelected

  function toggleAll() {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allFilteredSelected) {
        for (const r of filtered) next.delete(r.id)
      } else {
        for (const r of filtered) next.add(r.id)
      }
      return next
    })
  }
  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // 선택 행
  const selectedRows = React.useMemo(
    () => filtered.filter((r) => selectedIds.has(r.id)),
    [filtered, selectedIds],
  )

  // 미리보기 통계 — kind=search_term_promote 만 처리되므로 그것만 분석
  const previewStats = React.useMemo(() => {
    let promoteCount = 0
    let nonPromoteCount = 0
    let invalidAdgroupCount = 0
    let tooLongCount = 0
    const byAdgroup = new Map<string, number>() // adgroupId → count
    for (const r of selectedRows) {
      if (r.kind !== "search_term_promote") {
        nonPromoteCount++
        continue
      }
      const p = (r.payload ?? {}) as PromotePayload
      const adgroupId = p.adgroupId
      const searchTerm = p.searchTerm ?? ""
      if (!adgroupId || !adgroupNameById.has(adgroupId)) {
        invalidAdgroupCount++
        continue
      }
      if (searchTerm.length > 50) {
        tooLongCount++
        continue
      }
      promoteCount++
      byAdgroup.set(adgroupId, (byAdgroup.get(adgroupId) ?? 0) + 1)
    }
    return {
      promoteCount,
      nonPromoteCount,
      invalidAdgroupCount,
      tooLongCount,
      byAdgroup,
    }
  }, [selectedRows, adgroupNameById])

  // -- 승인 흐름 ------------------------------------------------------------
  async function handleApprove() {
    if (selectedIds.size === 0) return
    setSubmitting(true)
    try {
      const res = await approveQueue(advertiserId, Array.from(selectedIds))
      if (!res.ok) {
        toast.error(`승인 실패: ${res.error}`)
        return
      }
      setApproveOpen(false)
      setSelectedIds(new Set())
      setResultDialog(res.data)
      router.refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`승인 오류: ${msg}`)
    } finally {
      setSubmitting(false)
    }
  }

  // -- 거부 흐름 ------------------------------------------------------------
  async function handleReject() {
    if (selectedIds.size === 0) return
    setSubmitting(true)
    try {
      const res = await rejectQueue(advertiserId, Array.from(selectedIds))
      if (!res.ok) {
        toast.error(`거부 실패: ${res.error}`)
        return
      }
      toast.success(`${res.data.count}건 거부 완료`)
      setRejectOpen(false)
      setSelectedIds(new Set())
      router.refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`거부 오류: ${msg}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 헤더: 카운트 + 액션 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          전체 <strong className="text-foreground">{rows.length}</strong>건
          {filtered.length !== rows.length ? (
            <>
              {" "}/ 필터{" "}
              <strong className="text-foreground">{filtered.length}</strong>건
            </>
          ) : null}
          {selectedIds.size > 0 ? (
            <>
              {" "}/ 선택{" "}
              <strong className="text-foreground">{selectedIds.size}</strong>건
            </>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {canMutate ? (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={selectedIds.size === 0}
                onClick={() => setRejectOpen(true)}
              >
                선택 거부
              </Button>
              <Button
                size="sm"
                disabled={selectedIds.size === 0}
                onClick={() => setApproveOpen(true)}
              >
                선택 승인
              </Button>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              (viewer 는 승인/거부 불가)
            </span>
          )}
        </div>
      </div>

      {/* 필터 바 */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/20 px-3 py-2">
        <Input
          placeholder="검색어 / 광고그룹 / 유형 검색"
          value={textFilter}
          onChange={(e) => setTextFilter(e.target.value)}
          className="h-8 max-w-xs"
        />
        <Select
          value={kindFilter}
          onValueChange={(v) => setKindFilter(v as KindFilter)}
        >
          <SelectTrigger className="h-8 w-56">
            <SelectValue placeholder="유형" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">유형 (전체)</SelectItem>
            <SelectItem value="search_term_promote">
              신규 키워드 등록
            </SelectItem>
            <SelectItem value="search_term_exclude">
              제외 키워드 등록 (보류)
            </SelectItem>
          </SelectContent>
        </Select>
        {(textFilter || kindFilter !== "all") && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setTextFilter("")
              setKindFilter("all")
            }}
          >
            초기화
          </Button>
        )}
      </div>

      {/* 빈 상태 / 테이블 */}
      {rows.length === 0 ? (
        <div className="rounded-md border bg-muted/20 px-4 py-12 text-center">
          <p className="text-sm font-medium">대기 중인 항목이 없습니다</p>
          <p className="mt-1 text-xs text-muted-foreground">
            검색어 분석 페이지(`/search-term-import`) 에서 신규 후보를 선택해
            승인 큐로 보낼 수 있습니다.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-md border bg-muted/20 px-4 py-12 text-center">
          <p className="text-sm font-medium">필터에 일치하는 항목이 없습니다</p>
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={allFilteredSelected}
                    indeterminate={someFilteredSelected}
                    onCheckedChange={toggleAll}
                    disabled={!canMutate || filtered.length === 0}
                    aria-label="필터된 항목 전체 선택"
                  />
                </TableHead>
                <TableHead className="w-44">kind</TableHead>
                <TableHead>검색어</TableHead>
                <TableHead className="w-64">광고그룹</TableHead>
                <TableHead className="w-24 text-right">노출</TableHead>
                <TableHead className="w-24 text-right">클릭</TableHead>
                <TableHead className="w-28 text-right">비용</TableHead>
                <TableHead className="w-28 text-right">CPA</TableHead>
                <TableHead className="w-32">적재</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => (
                <QueueRowView
                  key={r.id}
                  row={r}
                  selected={selectedIds.has(r.id)}
                  onToggle={() => toggleOne(r.id)}
                  canMutate={canMutate}
                  adgroupNameById={adgroupNameById}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* 승인 미리보기 모달 */}
      <Dialog
        open={approveOpen}
        onOpenChange={(o) => !submitting && setApproveOpen(o)}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>선택 승인 — 미리보기</DialogTitle>
            <DialogDescription>
              선택한 신규 키워드 후보를 변경 작업으로 적재합니다.
              백그라운드에서 1분 간격으로 처리되어 네이버 SA 에 키워드가
              등록됩니다 (수 분 내 반영).
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <span className="text-muted-foreground">선택</span>
                  <span className="ml-2 font-medium">
                    {selectedRows.length}건
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">신규 등록</span>
                  <span className="ml-2 font-medium text-emerald-600">
                    {previewStats.promoteCount}건
                  </span>
                </div>
                {previewStats.nonPromoteCount > 0 && (
                  <div>
                    <span className="text-muted-foreground">
                      kind 보류 (제외 등록)
                    </span>
                    <span className="ml-2 font-medium text-muted-foreground">
                      {previewStats.nonPromoteCount}건
                    </span>
                  </div>
                )}
                {previewStats.invalidAdgroupCount > 0 && (
                  <div>
                    <span className="text-muted-foreground">광고그룹 무효</span>
                    <span className="ml-2 font-medium text-destructive">
                      {previewStats.invalidAdgroupCount}건
                    </span>
                  </div>
                )}
                {previewStats.tooLongCount > 0 && (
                  <div>
                    <span className="text-muted-foreground">키워드 길이 초과</span>
                    <span className="ml-2 font-medium text-destructive">
                      {previewStats.tooLongCount}건
                    </span>
                  </div>
                )}
              </div>
            </div>

            {previewStats.nonPromoteCount > 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs dark:border-amber-900/60 dark:bg-amber-950/30">
                제외 키워드 등록(search_term_exclude)은 본 PR 비대상입니다 —
                선택 시 그대로 pending 유지됩니다.
              </div>
            )}

            {/* 광고그룹별 합계 */}
            {previewStats.byAdgroup.size > 0 && (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>광고그룹</TableHead>
                      <TableHead className="text-right">신규 키워드</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {Array.from(previewStats.byAdgroup.entries())
                      .slice(0, 8)
                      .map(([adgroupId, count]) => {
                        const meta = adgroupNameById.get(adgroupId)
                        return (
                          <TableRow key={adgroupId}>
                            <TableCell className="text-xs">
                              <div className="flex flex-col">
                                <span>{meta?.name ?? adgroupId}</span>
                                {meta && (
                                  <span className="text-[10px] text-muted-foreground">
                                    {meta.campaignName}
                                  </span>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              {count}
                            </TableCell>
                          </TableRow>
                        )
                      })}
                  </TableBody>
                </Table>
                {previewStats.byAdgroup.size > 8 && (
                  <div className="border-t bg-muted/20 px-3 py-1.5 text-center text-[11px] text-muted-foreground">
                    ...외 광고그룹 {previewStats.byAdgroup.size - 8}개
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setApproveOpen(false)}
              disabled={submitting}
            >
              취소
            </Button>
            <Button
              onClick={handleApprove}
              disabled={submitting || previewStats.promoteCount === 0}
            >
              {submitting ? "승인 중..." : "확정 승인"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 거부 확인 모달 */}
      <Dialog
        open={rejectOpen}
        onOpenChange={(o) => !submitting && setRejectOpen(o)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>선택 거부</DialogTitle>
            <DialogDescription>
              선택한 {selectedIds.size}건을 거부 처리합니다. 거부된 항목은
              승인 큐에서 사라집니다 (status=rejected).
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRejectOpen(false)}
              disabled={submitting}
            >
              취소
            </Button>
            <Button
              variant="destructive"
              onClick={handleReject}
              disabled={submitting}
            >
              {submitting ? "처리 중..." : "거부"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 결과 다이얼로그 */}
      <Dialog
        open={resultDialog !== null}
        onOpenChange={(o) => !o && setResultDialog(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>승인 요청 완료</DialogTitle>
            <DialogDescription>
              변경 작업이 생성되었습니다. 백그라운드에서 1분 간격으로 처리되어
              네이버 SA 에 키워드가 등록됩니다 (수 분 내 반영).
            </DialogDescription>
          </DialogHeader>
          {resultDialog && (
            <div className="space-y-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <div>
                <span className="text-muted-foreground">총 선택</span>
                <span className="ml-2 font-medium">{resultDialog.count}건</span>
              </div>
              <div>
                <span className="text-muted-foreground">대기열 적재</span>
                <span className="ml-2 font-medium">
                  {resultDialog.enqueued}건
                </span>
              </div>
              {resultDialog.preFailed > 0 && (
                <div>
                  <span className="text-muted-foreground">사전 실패</span>
                  <span className="ml-2 font-medium text-destructive">
                    {resultDialog.preFailed}건
                  </span>
                </div>
              )}
              {resultDialog.skippedKindCount > 0 && (
                <div>
                  <span className="text-muted-foreground">kind 보류</span>
                  <span className="ml-2 font-medium text-muted-foreground">
                    {resultDialog.skippedKindCount}건
                  </span>
                </div>
              )}
              {resultDialog.batchId && (
                <div className="break-all border-t pt-2">
                  <span className="text-muted-foreground">변경 ID</span>
                  <div className="mt-0.5 font-mono text-xs">
                    {resultDialog.batchId}
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setResultDialog(null)}>확인</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// =============================================================================
// 행 컴포넌트
// =============================================================================

function QueueRowView({
  row,
  selected,
  onToggle,
  canMutate,
  adgroupNameById,
}: {
  row: ApprovalQueueRow
  selected: boolean
  onToggle: () => void
  canMutate: boolean
  adgroupNameById: Map<string, { name: string; campaignName: string }>
}) {
  const p = (row.payload ?? {}) as PromotePayload
  const adgroupMeta = p.adgroupId
    ? adgroupNameById.get(p.adgroupId)
    : undefined
  const m = p.metrics ?? null

  // 사전 실패 시각 구분 (광고그룹 무효 / 텍스트 길이 초과)
  const invalidAdgroup =
    row.kind === "search_term_promote" &&
    p.adgroupId !== undefined &&
    !adgroupMeta
  const tooLong = (p.searchTerm ?? "").length > 50
  const isPreFailed = invalidAdgroup || tooLong
  const isNonPromote = row.kind !== "search_term_promote"

  return (
    <TableRow
      className={cn(
        isPreFailed && "bg-amber-50/40 dark:bg-amber-950/10",
        isNonPromote && "bg-muted/20",
      )}
    >
      <TableCell>
        <Checkbox
          checked={selected}
          onCheckedChange={onToggle}
          disabled={!canMutate}
          aria-label="선택"
        />
      </TableCell>
      <TableCell>
        <KindBadge kind={row.kind} />
      </TableCell>
      <TableCell>
        <div className="flex flex-col">
          <span className="text-sm font-medium" title={p.searchTerm ?? ""}>
            {p.searchTerm ?? "—"}
          </span>
          {tooLong && (
            <span className="text-[10px] text-amber-700 dark:text-amber-400">
              길이 초과 ({(p.searchTerm ?? "").length}자 &gt; 50)
            </span>
          )}
        </div>
      </TableCell>
      <TableCell className="text-xs">
        {adgroupMeta ? (
          <div className="flex flex-col">
            <span>{adgroupMeta.name}</span>
            <span className="text-[10px] text-muted-foreground">
              {adgroupMeta.campaignName}
            </span>
          </div>
        ) : p.adgroupId ? (
          <span className="text-[11px] text-amber-700 dark:text-amber-400">
            광고그룹 미존재
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-right font-mono text-xs">
        {m && typeof m.impressions === "number"
          ? m.impressions.toLocaleString()
          : "—"}
      </TableCell>
      <TableCell className="text-right font-mono text-xs">
        {m && typeof m.clicks === "number" ? m.clicks.toLocaleString() : "—"}
      </TableCell>
      <TableCell className="text-right font-mono text-xs">
        {m && typeof m.cost === "number"
          ? Math.round(m.cost).toLocaleString()
          : "—"}
      </TableCell>
      <TableCell className="text-right font-mono text-xs">
        {m && m.cpa !== null && m.cpa !== undefined
          ? Math.round(m.cpa).toLocaleString()
          : "—"}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {formatDate(row.createdAt)}
      </TableCell>
    </TableRow>
  )
}

// =============================================================================
// 보조 컴포넌트
// =============================================================================

function KindBadge({ kind }: { kind: ApprovalQueueKind }) {
  if (kind === "search_term_promote") {
    return (
      <span className="inline-flex items-center rounded-md bg-emerald-100 px-1.5 py-0.5 text-[11px] font-medium text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
        신규 키워드
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded-md bg-rose-100 px-1.5 py-0.5 text-[11px] font-medium text-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
      제외 키워드
    </span>
  )
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  const h = String(d.getHours()).padStart(2, "0")
  const mi = String(d.getMinutes()).padStart(2, "0")
  return `${m}-${day} ${h}:${mi}`
}
