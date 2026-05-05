"use client"

/**
 * Suggestion Inbox 테이블 (F-11.4 Phase B.3)
 *
 * 정책 / 패턴:
 *   - shadcn Table + 클라이언트 정렬·필터 (행 < 1000 가정 — 가상 스크롤 미적용)
 *   - 다중 선택 헤더 액션: 일괄 "선택 적용" / "선택 거부"
 *   - "선택 적용" 모달 4단계: 미리보기 → 확정 → 진행률 → 결과(toast)
 *   - "선택 거부" 모달: 단순 확인 → dismissBidSuggestions
 *   - 적용 결과: ChangeBatch.id 표시 + 진행률 안내 텍스트 (cron 픽업 후 수 분 내 처리)
 *
 * 데이터:
 *   - props.suggestions: BidSuggestionRow[] — RSC 가 한 번에 로드
 *   - 키워드별 현재 입찰가 vs 권고 입찰가 Δ% (action.deltaPct + direction)
 *
 * 비대상 (후속):
 *   - 가상 스크롤 (현재 < 1000 행 가정)
 *   - useChangeBatchProgress polling 훅 (배치 결과 실시간 갱신)
 *   - 항목별 sparkline / 상세 패널
 *
 * SPEC v0.2.1 F-11.4 + plan(graceful-sparking-graham) Phase B.3
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  CheckCircle2Icon,
  XCircleIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  SparklesIcon,
  Loader2Icon,
  InfoIcon,
} from "lucide-react"

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
  approveBidSuggestions,
  dismissBidSuggestions,
  enrichSuggestionReason,
  type BidSuggestionRow,
} from "@/app/(dashboard)/[advertiserId]/bid-inbox/actions"
import { cn } from "@/lib/utils"

// =============================================================================
// 타입
// =============================================================================

type EngineFilter =
  | "all"
  | "bid"
  | "quality"
  | "targeting"
  | "budget"
  | "copy_policy"
type SeverityFilter = "all" | "info" | "warn" | "critical"

type ApproveResult = {
  batchId: string
  count: number
  preFailed: number
  enqueued: number
}

// =============================================================================
// 본 컴포넌트
// =============================================================================

export function BidSuggestionTable({
  advertiserId,
  suggestions,
  userRole,
}: {
  advertiserId: string
  suggestions: BidSuggestionRow[]
  userRole: "admin" | "operator" | "viewer"
}) {
  const router = useRouter()
  const canMutate = userRole === "admin" || userRole === "operator"

  // 필터 상태
  const [engineFilter, setEngineFilter] = React.useState<EngineFilter>("all")
  const [severityFilter, setSeverityFilter] =
    React.useState<SeverityFilter>("all")
  const [textFilter, setTextFilter] = React.useState("")

  // 선택 상태
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())

  // 모달 상태
  const [approveOpen, setApproveOpen] = React.useState(false)
  const [dismissOpen, setDismissOpen] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [resultDialog, setResultDialog] =
    React.useState<ApproveResult | null>(null)

  // F.4 — 상세 모달 (행 클릭 → AI 설명 보강)
  const [detailRow, setDetailRow] = React.useState<BidSuggestionRow | null>(
    null,
  )
  // suggestionId → enriched text (클라이언트 메모리 캐시 — 모달 재오픈 시 재호출 방지)
  const [enrichedMap, setEnrichedMap] = React.useState<Map<string, string>>(
    () => new Map(),
  )
  const [enrichingId, setEnrichingId] = React.useState<string | null>(null)

  // 필터 적용
  const filtered = React.useMemo(() => {
    const t = textFilter.trim().toLowerCase()
    return suggestions.filter((s) => {
      if (engineFilter !== "all" && s.engineSource !== engineFilter)
        return false
      if (severityFilter !== "all" && s.severity !== severityFilter)
        return false
      if (t.length > 0) {
        const k = s.keyword
        const blob = [
          k?.text ?? "",
          k?.nccKeywordId ?? "",
          k?.adgroupName ?? "",
          k?.campaignName ?? "",
          s.reason,
        ]
          .join(" ")
          .toLowerCase()
        if (!blob.includes(t)) return false
      }
      return true
    })
  }, [suggestions, engineFilter, severityFilter, textFilter])

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((s) => selectedIds.has(s.id))
  const someFilteredSelected =
    filtered.some((s) => selectedIds.has(s.id)) && !allFilteredSelected

  function toggleAll() {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allFilteredSelected) {
        for (const s of filtered) next.delete(s.id)
      } else {
        for (const s of filtered) next.add(s.id)
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

  // -- 적용 흐름 --------------------------------------------------------------
  async function handleApprove() {
    if (selectedIds.size === 0) return
    setSubmitting(true)
    try {
      const res = await approveBidSuggestions(
        advertiserId,
        Array.from(selectedIds),
      )
      if (!res.ok) {
        toast.error(`적용 실패: ${res.error}`)
        return
      }
      setApproveOpen(false)
      setSelectedIds(new Set())
      setResultDialog(res.data)
      router.refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`적용 오류: ${msg}`)
    } finally {
      setSubmitting(false)
    }
  }

  // -- 거부 흐름 --------------------------------------------------------------
  async function handleDismiss() {
    if (selectedIds.size === 0) return
    setSubmitting(true)
    try {
      const res = await dismissBidSuggestions(
        advertiserId,
        Array.from(selectedIds),
      )
      if (!res.ok) {
        toast.error(`거부 실패: ${res.error}`)
        return
      }
      toast.success(`${res.data.count}개 거부 완료`)
      setDismissOpen(false)
      setSelectedIds(new Set())
      router.refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`거부 오류: ${msg}`)
    } finally {
      setSubmitting(false)
    }
  }

  // -- F.4 enrich (lazy) -----------------------------------------------------
  async function handleEnrich(row: BidSuggestionRow) {
    // 이미 클라이언트 캐시 / 서버 보존 텍스트 있으면 호출 스킵
    if (enrichedMap.has(row.id)) return
    if (row.action.llmEnrichedReason) return
    if (row.engineSource !== "bid") {
      toast.error("'bid' 엔진만 AI 설명 가능 — 후속 PR")
      return
    }
    setEnrichingId(row.id)
    try {
      const res = await enrichSuggestionReason(advertiserId, row.id)
      if (!res.ok) {
        toast.error(`AI 설명 실패: ${res.error}`)
        return
      }
      // usedLlm=false (폴백) 도 텍스트는 받지만 캐시 보존 X — 다음 시도에서 재호출
      if (res.data.usedLlm) {
        setEnrichedMap((prev) => {
          const next = new Map(prev)
          next.set(row.id, res.data.text)
          return next
        })
        if (!res.data.cached) {
          toast.success("AI 설명 보강 완료")
        }
      } else {
        toast.warning(
          "AI 설명 사용 불가 — 정형 사유로 표시 (API 키 미설정 또는 월 한도 도달)",
        )
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`AI 설명 오류: ${msg}`)
    } finally {
      setEnrichingId(null)
    }
  }

  // 선택된 행만 추출 (모달 미리보기용)
  const selectedRows = React.useMemo(
    () => filtered.filter((s) => selectedIds.has(s.id)),
    [filtered, selectedIds],
  )

  // 미리보기 통계 (적용 모달)
  const previewStats = React.useMemo(() => {
    let upCount = 0
    let downCount = 0
    let totalDelta = 0
    let invalidCount = 0
    for (const s of selectedRows) {
      if (
        !s.keyword ||
        s.keyword.userLock ||
        s.keyword.useGroupBidAmt ||
        s.keyword.status === "deleted"
      ) {
        invalidCount++
        continue
      }
      if (s.action.direction === "up") upCount++
      else downCount++
      totalDelta += s.action.suggestedBid - s.action.currentBid
    }
    return { upCount, downCount, totalDelta, invalidCount }
  }, [selectedRows])

  return (
    <div className="flex flex-col gap-3">
      {/* 헤더: 카운트 + 필터 + 액션 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          전체 <strong className="text-foreground">{suggestions.length}</strong>건
          {filtered.length !== suggestions.length ? (
            <>
              {" "}/ 필터 적용 <strong className="text-foreground">{filtered.length}</strong>건
            </>
          ) : null}
          {selectedIds.size > 0 ? (
            <>
              {" "}/ 선택 <strong className="text-foreground">{selectedIds.size}</strong>건
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
                onClick={() => setDismissOpen(true)}
              >
                선택 거부
              </Button>
              <Button
                size="sm"
                disabled={selectedIds.size === 0}
                onClick={() => setApproveOpen(true)}
              >
                선택 적용
              </Button>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              (viewer 는 적용/거부 불가)
            </span>
          )}
        </div>
      </div>

      {/* 필터 바 */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/20 px-3 py-2">
        <Input
          placeholder="키워드 / 광고그룹 / 사유 검색"
          value={textFilter}
          onChange={(e) => setTextFilter(e.target.value)}
          className="h-8 max-w-xs"
        />
        <Select
          value={engineFilter}
          onValueChange={(v) => setEngineFilter(v as EngineFilter)}
        >
          <SelectTrigger className="h-8 w-32">
            <SelectValue placeholder="엔진" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">엔진(전체)</SelectItem>
            <SelectItem value="bid">bid</SelectItem>
            <SelectItem value="quality">quality</SelectItem>
            <SelectItem value="targeting">targeting</SelectItem>
            <SelectItem value="budget">budget</SelectItem>
            <SelectItem value="copy_policy">copy_policy</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={severityFilter}
          onValueChange={(v) => setSeverityFilter(v as SeverityFilter)}
        >
          <SelectTrigger className="h-8 w-32">
            <SelectValue placeholder="severity" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">severity(전체)</SelectItem>
            <SelectItem value="info">info</SelectItem>
            <SelectItem value="warn">warn</SelectItem>
            <SelectItem value="critical">critical</SelectItem>
          </SelectContent>
        </Select>
        {(textFilter || engineFilter !== "all" || severityFilter !== "all") && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setTextFilter("")
              setEngineFilter("all")
              setSeverityFilter("all")
            }}
          >
            초기화
          </Button>
        )}
      </div>

      {/* 빈 상태 / 테이블 */}
      {suggestions.length === 0 ? (
        <div className="rounded-md border bg-muted/20 px-4 py-12 text-center">
          <p className="text-sm font-medium">권고 항목이 없습니다</p>
          <p className="mt-1 text-xs text-muted-foreground">
            매시간 자동 분석 cron(F-11.4 Phase B.2)이 신규 권고를 적재합니다.
            BidAutomationConfig 가 inbox 모드이고 baseline 데이터가 있어야 합니다.
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
                <TableHead>키워드</TableHead>
                <TableHead>광고그룹</TableHead>
                <TableHead className="w-24">엔진</TableHead>
                <TableHead className="w-28 text-right">현재 입찰가</TableHead>
                <TableHead className="w-28 text-right">권고 입찰가</TableHead>
                <TableHead className="w-20 text-right">Δ%</TableHead>
                <TableHead className="w-24">severity</TableHead>
                <TableHead>사유</TableHead>
                <TableHead className="w-32">생성</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((s) => (
                <SuggestionRow
                  key={s.id}
                  row={s}
                  selected={selectedIds.has(s.id)}
                  onToggle={() => toggleOne(s.id)}
                  onOpenDetail={() => setDetailRow(s)}
                  canMutate={canMutate}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* 적용 미리보기 모달 */}
      <Dialog
        open={approveOpen}
        onOpenChange={(o) => !submitting && setApproveOpen(o)}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>선택 적용 — 미리보기</DialogTitle>
            <DialogDescription>
              선택한 권고 입찰가를 ChangeBatch 로 적재합니다.
              cron(`/api/batch/run`) 이 1분 간격으로 픽업해 SA API 로 입찰가를
              변경합니다.
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
                  <span className="text-muted-foreground">사전 실패</span>
                  <span className="ml-2 font-medium text-destructive">
                    {previewStats.invalidCount}건
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">상향(up)</span>
                  <span className="ml-2 font-medium text-emerald-600">
                    {previewStats.upCount}건
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">하향(down)</span>
                  <span className="ml-2 font-medium text-amber-700">
                    {previewStats.downCount}건
                  </span>
                </div>
                <div className="col-span-2">
                  <span className="text-muted-foreground">
                    입찰가 변경 합계
                  </span>
                  <span
                    className={cn(
                      "ml-2 font-mono text-sm",
                      previewStats.totalDelta >= 0
                        ? "text-emerald-600"
                        : "text-amber-700",
                    )}
                  >
                    {previewStats.totalDelta >= 0 ? "+" : ""}
                    {previewStats.totalDelta.toLocaleString()}원
                  </span>
                </div>
              </div>
            </div>

            {previewStats.invalidCount > 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs dark:border-amber-900/60 dark:bg-amber-950/30">
                일부 키워드가 잠금/삭제/그룹입찰가 사용 상태로 변경 불가합니다.
                해당 행은 ChangeItem `failed` 로 기록됩니다.
              </div>
            )}

            {/* 상위 5건 미리보기 */}
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>키워드</TableHead>
                    <TableHead className="text-right">전</TableHead>
                    <TableHead className="text-right">후</TableHead>
                    <TableHead className="text-right">Δ%</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selectedRows.slice(0, 5).map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="text-xs">
                        {s.keyword?.text ?? "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {formatBid(s.action.currentBid)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {formatBid(s.action.suggestedBid)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        <DeltaInline action={s.action} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {selectedRows.length > 5 && (
                <div className="border-t bg-muted/20 px-3 py-1.5 text-center text-[11px] text-muted-foreground">
                  ...외 {selectedRows.length - 5}건
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setApproveOpen(false)}
              disabled={submitting}
            >
              취소
            </Button>
            <Button onClick={handleApprove} disabled={submitting}>
              {submitting ? "적용 중..." : "확정 적용"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 거부 확인 모달 */}
      <Dialog
        open={dismissOpen}
        onOpenChange={(o) => !submitting && setDismissOpen(o)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>선택 거부</DialogTitle>
            <DialogDescription>
              선택한 {selectedIds.size}개 권고를 거부 처리합니다. 거부된 항목은
              Inbox 에서 사라지며 다음 cron 분석 시 재평가됩니다 (조건 충족 시
              다시 등장).
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDismissOpen(false)}
              disabled={submitting}
            >
              취소
            </Button>
            <Button
              variant="destructive"
              onClick={handleDismiss}
              disabled={submitting}
            >
              {submitting ? "처리 중..." : "거부"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 상세 모달 (F.4 — AI 설명 보강) */}
      <Dialog
        open={detailRow !== null}
        onOpenChange={(o) => !o && setDetailRow(null)}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>권고 상세</DialogTitle>
            <DialogDescription>
              정형 사유 + AI 자연어 설명 (필요 시 호출).
            </DialogDescription>
          </DialogHeader>
          {detailRow && (
            <DetailContent
              row={detailRow}
              enriched={
                detailRow.action.llmEnrichedReason ??
                enrichedMap.get(detailRow.id) ??
                null
              }
              enriching={enrichingId === detailRow.id}
              canEnrich={canMutate && detailRow.engineSource === "bid"}
              onEnrich={() => handleEnrich(detailRow)}
            />
          )}
          <DialogFooter>
            <Button onClick={() => setDetailRow(null)}>닫기</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 적용 결과 다이얼로그 */}
      <Dialog
        open={resultDialog !== null}
        onOpenChange={(o) => !o && setResultDialog(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>적용 요청 완료</DialogTitle>
            <DialogDescription>
              ChangeBatch 가 생성되었습니다. cron 이 1분 간격으로 픽업하여 SA API
              로 입찰가를 변경합니다 (수 분 내 처리).
            </DialogDescription>
          </DialogHeader>
          {resultDialog && (
            <div className="space-y-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <div>
                <span className="text-muted-foreground">총 권고</span>
                <span className="ml-2 font-medium">
                  {resultDialog.count}건
                </span>
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
              <div className="break-all border-t pt-2">
                <span className="text-muted-foreground">ChangeBatch ID</span>
                <div className="mt-0.5 font-mono text-xs">
                  {resultDialog.batchId}
                </div>
              </div>
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

function SuggestionRow({
  row,
  selected,
  onToggle,
  onOpenDetail,
  canMutate,
}: {
  row: BidSuggestionRow
  selected: boolean
  onToggle: () => void
  onOpenDetail: () => void
  canMutate: boolean
}) {
  const k = row.keyword
  // 적용 불가 케이스 시각 구분
  const invalid =
    !k || k.userLock || k.useGroupBidAmt || k.status === "deleted"
  // 행 클릭 → 상세. 단, 체크박스 셀 클릭은 stopPropagation 으로 처리.
  return (
    <TableRow
      className={cn(
        "cursor-pointer hover:bg-muted/30",
        invalid && "bg-amber-50/40 dark:bg-amber-950/10",
      )}
      onClick={onOpenDetail}
    >
      <TableCell onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={selected}
          onCheckedChange={onToggle}
          disabled={!canMutate}
          aria-label="선택"
        />
      </TableCell>
      <TableCell>
        {k ? (
          <div className="flex flex-col">
            <span className="font-medium">{k.text}</span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {k.nccKeywordId} · {k.matchType}
            </span>
            {invalid && (
              <span className="text-[10px] text-amber-700 dark:text-amber-400">
                {k.userLock
                  ? "잠금"
                  : k.status === "deleted"
                    ? "삭제됨"
                    : k.useGroupBidAmt
                      ? "그룹입찰가 사용"
                      : ""}
              </span>
            )}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">— (광고그룹 단위)</span>
        )}
      </TableCell>
      <TableCell className="text-xs">
        {k ? (
          <div className="flex flex-col">
            <span>{k.adgroupName}</span>
            <span className="text-[10px] text-muted-foreground">
              {k.campaignName}
            </span>
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        <EngineBadge engine={row.engineSource} />
      </TableCell>
      <TableCell className="text-right font-mono text-sm">
        {formatBid(row.action.currentBid)}
      </TableCell>
      <TableCell className="text-right font-mono text-sm">
        {formatBid(row.action.suggestedBid)}
      </TableCell>
      <TableCell className="text-right">
        <DeltaInline action={row.action} />
      </TableCell>
      <TableCell>
        <SeverityBadge severity={row.severity} />
      </TableCell>
      <TableCell>
        <div
          className="max-w-md truncate text-xs text-muted-foreground"
          title={row.reason}
        >
          {row.reason}
        </div>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {formatDate(row.createdAt)}
      </TableCell>
    </TableRow>
  )
}

// =============================================================================
// 상세 모달 컨텐츠 (F.4)
// =============================================================================

function DetailContent({
  row,
  enriched,
  enriching,
  canEnrich,
  onEnrich,
}: {
  row: BidSuggestionRow
  /** 서버 보존 또는 클라이언트 캐시 — null 이면 미보강 (버튼 노출) */
  enriched: string | null
  enriching: boolean
  canEnrich: boolean
  onEnrich: () => void
}) {
  const k = row.keyword
  const isUp = row.action.direction === "up"
  return (
    <div className="space-y-4">
      {/* 기본 정보 */}
      <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <div>
            <span className="text-muted-foreground">키워드</span>
            <span className="ml-2 font-medium">{k?.text ?? "—"}</span>
          </div>
          <div>
            <span className="text-muted-foreground">엔진</span>
            <span className="ml-2">
              <EngineBadge engine={row.engineSource} />
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">광고그룹</span>
            <span className="ml-2">{k?.adgroupName ?? "—"}</span>
          </div>
          <div>
            <span className="text-muted-foreground">severity</span>
            <span className="ml-2">
              <SeverityBadge severity={row.severity} />
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">현재 입찰가</span>
            <span className="ml-2 font-mono">
              {formatBid(row.action.currentBid)}원
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">권고 입찰가</span>
            <span
              className={cn(
                "ml-2 font-mono",
                isUp
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-amber-700 dark:text-amber-400",
              )}
            >
              {formatBid(row.action.suggestedBid)}원 ({isUp ? "+" : "-"}
              {row.action.deltaPct}%)
            </span>
          </div>
        </div>
      </div>

      {/* 정형 reason */}
      <div>
        <div className="mb-1 text-xs font-medium text-muted-foreground">
          정형 사유 (시스템)
        </div>
        <div className="rounded-md border bg-background px-3 py-2 text-sm whitespace-pre-wrap">
          {row.reason}
        </div>
      </div>

      {/* AI 설명 영역 */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">
            AI 설명 (보강)
          </span>
          {!enriched && canEnrich && (
            <Button
              size="sm"
              variant="outline"
              onClick={onEnrich}
              disabled={enriching}
              className="h-7 gap-1.5"
            >
              {enriching ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <SparklesIcon className="size-3.5" />
              )}
              {enriching ? "호출 중..." : "AI 설명 보기"}
            </Button>
          )}
        </div>
        {enriched ? (
          <div className="rounded-md border border-sky-200 bg-sky-50/50 px-3 py-2 text-sm whitespace-pre-wrap dark:border-sky-900/50 dark:bg-sky-950/20">
            {enriched}
          </div>
        ) : canEnrich ? (
          <div className="rounded-md border border-dashed bg-muted/20 px-3 py-3 text-xs text-muted-foreground">
            <div className="flex items-start gap-1.5">
              <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
              <div>
                <p>
                  Claude Haiku 4.5 호출로 정형 사유를 자연어 2~3 문장으로
                  보강합니다. 호출 1회당 약 $0.001 ~ $0.005 USD 발생합니다.
                </p>
                <p className="mt-1">
                  결과는 권고에 영구 보존되며 재호출되지 않습니다 (비용 안전).
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            {row.engineSource !== "bid"
              ? "'bid' 엔진 권고만 AI 설명 지원 (quality / targeting / budget 은 후속 PR)"
              : "viewer 권한은 AI 설명 호출 불가 (비용 발생)"}
          </div>
        )}
      </div>
    </div>
  )
}

// =============================================================================
// 보조 컴포넌트
// =============================================================================

function EngineBadge({
  engine,
}: {
  engine: BidSuggestionRow["engineSource"]
}) {
  const cls: Record<typeof engine, string> = {
    bid: "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300",
    quality: "bg-violet-100 text-violet-800 dark:bg-violet-950/40 dark:text-violet-300",
    targeting:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    budget: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    copy_policy: "bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300",
  }
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium",
        cls[engine],
      )}
    >
      {engine}
    </span>
  )
}

function SeverityBadge({
  severity,
}: {
  severity: BidSuggestionRow["severity"]
}) {
  const cls: Record<typeof severity, string> = {
    info: "bg-muted text-muted-foreground",
    warn: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    critical:
      "bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300",
  }
  const Icon = severity === "critical" ? XCircleIcon : CheckCircle2Icon
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
        cls[severity],
      )}
    >
      <Icon className="size-3" />
      {severity}
    </span>
  )
}

function DeltaInline({
  action,
}: {
  action: BidSuggestionRow["action"]
}) {
  const isUp = action.direction === "up"
  const cls = isUp
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-amber-700 dark:text-amber-400"
  const Icon = isUp ? ArrowUpIcon : ArrowDownIcon
  return (
    <span className={cn("inline-flex items-center gap-0.5 font-mono text-xs", cls)}>
      <Icon className="size-3" />
      {action.deltaPct}%
    </span>
  )
}

function formatBid(v: number | null): string {
  if (v === null) return "—"
  return v.toLocaleString()
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  const h = String(d.getHours()).padStart(2, "0")
  const mi = String(d.getMinutes()).padStart(2, "0")
  return `${m}-${day} ${h}:${mi}`
}
