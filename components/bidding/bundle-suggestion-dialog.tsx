"use client"

/**
 * 묶음 권고 모달 (scope='adgroup')
 *
 * 흐름:
 *   1. open=true & suggestionId 변경 시 getBundleSuggestionDetail 호출 (useEffect + AbortController)
 *   2. 로딩 중 Skeleton 표시 / 에러 시 메시지
 *   3. summary 4 카드 + 키워드 테이블 (체크박스 / drift 표시 / userLock 비활성)
 *   4. 액션: 전체 선택 / 전체 해제 / drift만 해제 토글 + 선택된 N개 적용 / 보류
 *
 * 본 컴포넌트 범위 (4단계 = 실제 ChangeBatch 적재는 후속 PR):
 *   - onApply prop placeholder — 호출 시 콘솔 + toast
 *   - drift 행은 자동 체크 해제 X (운영자가 명시 선택). 단 "drift만 해제" 토글 제공
 *   - userLock=true / status='deleted' 행만 강제 비활성 (적용 비대상)
 *
 * 데이터 가정:
 *   - props.suggestionId 의 BidSuggestion 은 scope='adgroup' (호출부 보장)
 *   - itemsJson 항목은 최대 100~200개 — 가상 스크롤 미적용
 */

import * as React from "react"
import { toast } from "sonner"
import {
  AlertTriangleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  Loader2Icon,
  PackageIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  getBundleSuggestionDetail,
  type BundleSuggestionDetail,
  type BundleSuggestionDetailItem,
} from "@/app/(dashboard)/[advertiserId]/bid-inbox/actions"
import { cn } from "@/lib/utils"

const NUMBER_FORMATTER = new Intl.NumberFormat("ko-KR")
const SIGNED_NUMBER_FORMATTER = new Intl.NumberFormat("ko-KR", {
  signDisplay: "exceptZero",
})

export type BundleSuggestionDialogProps = {
  open: boolean
  /** 닫기 시그널 (모달 외부 클릭 / 보류 / 적용 후 등). */
  onOpenChange: (open: boolean) => void
  advertiserId: string
  /** scope='adgroup' BidSuggestion id. open=false 시 무시. */
  suggestionId: string | null
  /**
   * 적용 콜백 — 4단계 후속 PR 에서 ChangeBatch 적재 흐름 연결.
   * 본 PR 에서는 placeholder 호출만 (콘솔 + toast).
   */
  onApply?: (selectedKeywordIds: string[]) => Promise<void>
  /** viewer 권한이면 적용 버튼 disable. */
  canMutate: boolean
}

export function BundleSuggestionDialog({
  open,
  onOpenChange,
  advertiserId,
  suggestionId,
  onApply,
  canMutate,
}: BundleSuggestionDialogProps) {
  const [loading, setLoading] = React.useState(false)
  const [detail, setDetail] = React.useState<BundleSuggestionDetail | null>(
    null,
  )
  const [error, setError] = React.useState<string | null>(null)
  // 선택 상태 — Set<keywordId>. 데이터 로드 시 적용 가능 행을 기본 선택.
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = React.useState(false)

  // 데이터 로드 effect — setState 는 비동기 함수 내부에서만 호출 (lint: react-hooks/set-state-in-effect).
  React.useEffect(() => {
    if (!open || !suggestionId) return
    let cancelled = false
    async function load(targetSuggestionId: string) {
      setLoading(true)
      setError(null)
      setDetail(null)
      setSelected(new Set())
      try {
        const res = await getBundleSuggestionDetail({
          advertiserId,
          suggestionId: targetSuggestionId,
        })
        if (cancelled) return
        if (!res.ok) {
          setError(res.error)
          return
        }
        setDetail(res.data)
        // 적용 가능 행 (userLock=false && status!='deleted') 기본 선택.
        setSelected(
          new Set(
            res.data.items
              .filter((it) => isApplicable(it))
              .map((it) => it.keywordId),
          ),
        )
      } catch (e) {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : String(e)
        setError(msg)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load(suggestionId)
    return () => {
      cancelled = true
    }
  }, [open, suggestionId, advertiserId])

  function toggle(keywordId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(keywordId)) next.delete(keywordId)
      else next.add(keywordId)
      return next
    })
  }

  function selectAllApplicable() {
    if (!detail) return
    setSelected(
      new Set(
        detail.items
          .filter((it) => isApplicable(it))
          .map((it) => it.keywordId),
      ),
    )
  }
  function clearAll() {
    setSelected(new Set())
  }
  function clearDrifted() {
    if (!detail) return
    setSelected((prev) => {
      const next = new Set(prev)
      for (const it of detail.items) {
        if (it.drift) next.delete(it.keywordId)
      }
      return next
    })
  }

  async function handleApply() {
    if (!detail) return
    const ids = Array.from(selected)
    if (ids.length === 0) {
      toast.error("선택된 키워드가 없습니다")
      return
    }
    setSubmitting(true)
    try {
      if (onApply) {
        await onApply(ids)
      } else {
        // 4단계 미구현 — placeholder
        console.log("[bundle-suggestion-dialog] apply placeholder", {
          suggestionId: detail.suggestion.id,
          selectedKeywordIds: ids,
        })
        toast.info("다음 단계에서 구현 예정 — 선택 키워드 ID 콘솔 출력")
      }
    } finally {
      setSubmitting(false)
    }
  }

  // applicable 헬퍼는 컴포넌트 안에서도 외부에서도 호출되므로 모듈 함수로 정의.
  const summary = detail?.summary
  const items = detail?.items ?? []
  const applicableCount = items.filter((it) => isApplicable(it)).length
  const driftedSelected = items.filter(
    (it) => it.drift && selected.has(it.keywordId),
  ).length

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="max-h-[min(90vh,52rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackageIcon aria-hidden="true" className="size-5" />
            묶음 권고 — {detail?.suggestion.targetName ?? "광고그룹"}
          </DialogTitle>
          <DialogDescription>
            {summary
              ? `${summary.totalCount}개 키워드 · 평균 ${formatPct(summary.avgDeltaPct)}`
              : "묶음 권고 상세 로딩 중…"}
          </DialogDescription>
        </DialogHeader>

        {/* 본문 — 로딩 / 에러 / 데이터 */}
        {loading ? (
          <BundleSkeleton />
        ) : error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : detail ? (
          <div className="space-y-4">
            {/* Summary 4카드 */}
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <SummaryStat
                label="총 키워드"
                value={`${summary!.totalCount}개`}
              />
              <SummaryStat
                label="drift 발생"
                value={`${summary!.driftedCount}개`}
                tone={summary!.driftedCount > 0 ? "warning" : "neutral"}
              />
              <SummaryStat
                label="평균 변동률"
                value={formatPct(summary!.avgDeltaPct)}
                tone={summary!.avgDeltaPct < 0 ? "down" : "up"}
              />
              <SummaryStat
                label="추정 일 비용 변화"
                value={
                  summary!.itemsWithSignal === 0
                    ? "추정 불가"
                    : `${SIGNED_NUMBER_FORMATTER.format(summary!.estimatedDailyCostDelta)}원`
                }
                tone={
                  summary!.itemsWithSignal === 0
                    ? "neutral"
                    : summary!.estimatedDailyCostDelta < 0
                      ? "down"
                      : "up"
                }
                hint={
                  summary!.itemsWithSignal === 0
                    ? "최근 7일 클릭 데이터 없음"
                    : `${summary!.itemsWithSignal}/${summary!.totalCount} 키워드 신호`
                }
              />
            </div>

            {/* 선택 상태 */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-2 text-xs">
              <div className="text-muted-foreground">
                선택 <strong className="text-foreground">{selected.size}</strong>{" "}
                / 적용 가능{" "}
                <strong className="text-foreground">{applicableCount}</strong>개
                {driftedSelected > 0 && (
                  <>
                    {" "}
                    · drift 포함{" "}
                    <strong className="text-amber-700 dark:text-amber-400">
                      {driftedSelected}개
                    </strong>
                  </>
                )}
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  onClick={selectAllApplicable}
                  disabled={!canMutate || applicableCount === 0}
                >
                  전체 선택
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  onClick={clearAll}
                  disabled={selected.size === 0}
                >
                  전체 해제
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  onClick={clearDrifted}
                  disabled={driftedSelected === 0}
                >
                  drift만 해제
                </Button>
              </div>
            </div>

            {/* 키워드 테이블 */}
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead>키워드</TableHead>
                    <TableHead className="w-20">매치</TableHead>
                    <TableHead className="w-24 text-right">현재</TableHead>
                    <TableHead className="w-24 text-right">권고</TableHead>
                    <TableHead className="w-20 text-right">변동률</TableHead>
                    <TableHead className="w-24">상태</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((it) => (
                    <BundleItemRow
                      key={it.keywordId}
                      item={it}
                      checked={selected.has(it.keywordId)}
                      onToggle={() => toggle(it.keywordId)}
                      canMutate={canMutate}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            보류
          </Button>
          <Button
            onClick={handleApply}
            disabled={
              !canMutate || submitting || loading || selected.size === 0
            }
          >
            {submitting ? (
              <>
                <Loader2Icon
                  aria-hidden="true"
                  className="size-3.5 animate-spin"
                />
                적용 중…
              </>
            ) : (
              `선택된 ${selected.size}개 적용`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// =============================================================================
// 행 컴포넌트
// =============================================================================

function BundleItemRow({
  item,
  checked,
  onToggle,
  canMutate,
}: {
  item: BundleSuggestionDetailItem
  checked: boolean
  onToggle: () => void
  canMutate: boolean
}) {
  const applicable = isApplicable(item)
  const disabled = !canMutate || !applicable
  const deltaPct =
    item.beforeBid > 0
      ? ((item.afterBid - item.beforeBid) / item.beforeBid) * 100
      : 0
  const isUp = item.afterBid > item.beforeBid
  return (
    <TableRow
      className={cn(
        item.drift && "bg-amber-50 dark:bg-amber-950/20",
        !applicable && "opacity-60",
      )}
    >
      <TableCell>
        <Checkbox
          checked={checked}
          onCheckedChange={onToggle}
          disabled={disabled}
          aria-label={`${item.keyword} 선택`}
        />
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1.5">
          <span className="font-medium">{item.keyword}</span>
          {item.drift && (
            <span
              className="inline-flex items-center text-amber-700 dark:text-amber-400"
              title={`drift — 묶음 생성 시점 ${NUMBER_FORMATTER.format(
                item.beforeBid,
              )}원 → 현재 ${NUMBER_FORMATTER.format(item.currentBid)}원`}
            >
              <AlertTriangleIcon aria-hidden="true" className="size-3.5" />
            </span>
          )}
        </div>
        {item.nccKeywordId && (
          <div className="font-mono text-[10px] text-muted-foreground">
            {item.nccKeywordId}
          </div>
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {item.matchType}
      </TableCell>
      <TableCell className="text-right font-mono text-xs">
        {NUMBER_FORMATTER.format(item.currentBid)}
        {item.drift && (
          <div className="text-[10px] text-amber-700 dark:text-amber-400">
            (기준 {NUMBER_FORMATTER.format(item.beforeBid)})
          </div>
        )}
      </TableCell>
      <TableCell className="text-right font-mono text-xs">
        {NUMBER_FORMATTER.format(item.afterBid)}
      </TableCell>
      <TableCell
        className={cn(
          "text-right font-mono text-xs",
          isUp
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-amber-700 dark:text-amber-400",
        )}
      >
        <span className="inline-flex items-center justify-end gap-0.5">
          {isUp ? (
            <ArrowUpIcon aria-hidden="true" className="size-3" />
          ) : (
            <ArrowDownIcon aria-hidden="true" className="size-3" />
          )}
          {formatPct(Number(deltaPct.toFixed(1)))}
        </span>
      </TableCell>
      <TableCell className="text-xs">
        <StatusPill item={item} />
      </TableCell>
    </TableRow>
  )
}

// =============================================================================
// 보조 컴포넌트 / 유틸
// =============================================================================

function SummaryStat({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string
  value: string
  hint?: string
  tone?: "neutral" | "warning" | "up" | "down"
}) {
  const toneCls: Record<typeof tone, string> = {
    neutral: "text-foreground",
    warning: "text-amber-700 dark:text-amber-400",
    up: "text-emerald-600 dark:text-emerald-400",
    down: "text-amber-700 dark:text-amber-400",
  }
  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 font-mono text-sm font-medium", toneCls[tone])}>
        {value}
      </div>
      {hint && (
        <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div>
      )}
    </div>
  )
}

function StatusPill({ item }: { item: BundleSuggestionDetailItem }) {
  if (item.status === "deleted") {
    return (
      <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
        삭제됨
      </span>
    )
  }
  if (item.userLock) {
    return (
      <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
        잠금
      </span>
    )
  }
  if (item.drift) {
    return (
      <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
        drift
      </span>
    )
  }
  return (
    <span className="rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
      정상
    </span>
  )
}

function BundleSkeleton() {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-14 animate-pulse rounded-md border bg-muted/30"
          />
        ))}
      </div>
      <div className="h-10 animate-pulse rounded-md border bg-muted/30" />
      <div className="h-64 animate-pulse rounded-md border bg-muted/30" />
    </div>
  )
}

function isApplicable(item: BundleSuggestionDetailItem): boolean {
  // userLock=true / status='deleted' → 적용 비대상.
  return !item.userLock && item.status !== "deleted"
}

function formatPct(v: number): string {
  if (!Number.isFinite(v)) return "—"
  const sign = v > 0 ? "+" : ""
  return `${sign}${v.toFixed(1)}%`
}
