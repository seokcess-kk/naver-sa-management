"use client"

/**
 * ChangeBatch 상세 클라이언트 (F-6.x)
 *
 * 구조 (위에서 아래로):
 *   1. HeaderCard         — 기본 정보 + summary JSON 접이식
 *   2. ActionPanel        — "실패 항목 재시도" / "롤백" 버튼 + 결과 박스
 *   3. ItemsTable         — items 목록 (status 필터 + before/after 모달)
 *
 * 상태:
 *   - 재시도/롤백 결과는 본 화면에 인라인 박스로 표시 + router.refresh.
 *   - 새 ChangeBatch ID (롤백) 는 클립보드 복사 + 상세 페이지 이동 링크 노출.
 *
 * 안전장치:
 *   - 롤백 옵션 ignoreDrift 는 명시적 체크박스 + 안내문.
 *   - drift 행은 amber 톤. unsupported_action / no_before / sa_failed 등 reason 별 안내.
 *   - 재시도/롤백 버튼은 종료 상태 / 비지원 액션일 때 disabled.
 */

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { CopyIcon, EyeIcon, ChevronDownIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
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
  retryFailedItems,
  rollbackChangeBatch,
  type ChangeBatchDetail,
  type ChangeItemRow,
  type RetryResult,
  type RollbackResult,
  type RollbackItemResult,
} from "@/app/admin/change-batches/actions"
import type { ChangeItemStatus } from "@/lib/generated/prisma/client"
import { ChangeItemDetailModal } from "@/components/admin/change-batch-item-modal"
import { StatusBadge } from "@/components/admin/change-batches-client"

// =============================================================================
// 헬퍼 (롤백/재시도 화이트리스트 — actions.ts 와 동기 유지)
// =============================================================================

const ROLLBACK_SUPPORTED_ACTIONS = new Set<string>([
  "keyword.toggle",
  "keyword.bid",
  "keyword.inline_update",
  "adgroup.toggle",
  "adgroup.bid",
  "adgroup.budget",
  "campaign.toggle",
  "campaign.budget",
  "ad.toggle",
  "adext.toggle",
])

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

function prettyJson(value: unknown): string {
  if (value == null) return "(없음)"
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function ItemStatusBadge({ status }: { status: ChangeItemStatus }) {
  const tone =
    status === "done"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
      : status === "running"
        ? "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300"
        : status === "failed"
          ? "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300"
          : status === "skipped"
            ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
            : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {status}
    </span>
  )
}

function copyToClipboard(text: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast.success("ID 복사됨"))
    .catch(() => toast.error("복사 실패"))
}

// =============================================================================
// 메인
// =============================================================================

export function ChangeBatchDetail({
  batch,
}: {
  batch: ChangeBatchDetail
}) {
  // 재시도/롤백 직후 결과 표시. 새 데이터를 받으려면 router.refresh 후
  // 부모 RSC 가 새 batch prop 을 내려준다 (key 변경 → state reset).
  const [retryResult, setRetryResult] = React.useState<RetryResult | null>(
    null,
  )
  const [rollbackResult, setRollbackResult] =
    React.useState<RollbackResult | null>(null)

  return (
    <div className="flex flex-col gap-6">
      <HeaderCard batch={batch} />
      <ActionPanel
        batch={batch}
        retryResult={retryResult}
        rollbackResult={rollbackResult}
        onRetryDone={setRetryResult}
        onRollbackDone={setRollbackResult}
      />
      <ItemsTable items={batch.items} />
    </div>
  )
}

// =============================================================================
// 1. 헤더 카드
// =============================================================================

function HeaderCard({ batch }: { batch: ChangeBatchDetail }) {
  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <CardTitle>기본 정보</CardTitle>
            <CardDescription>
              ChangeBatch 한 건의 메타 정보입니다. summary 는 액션별 적재
              스키마를 따릅니다 (advertiserId 등).
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={batch.status} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 py-4 sm:grid-cols-2">
        <Field label="ID">
          <div className="flex items-center gap-1">
            <code className="min-w-0 flex-1 truncate font-mono text-xs">
              {batch.id}
            </code>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => copyToClipboard(batch.id)}
              title="ID 복사"
            >
              <CopyIcon />
            </Button>
          </div>
        </Field>
        <Field label="action">
          <code className="font-mono text-xs">{batch.action}</code>
        </Field>
        <Field label="사용자">
          <span className="text-sm">
            {batch.userDisplayName ?? (
              <span className="italic text-muted-foreground">
                {batch.userId ? "(삭제됨)" : "(시스템)"}
              </span>
            )}
          </span>
        </Field>
        <Field label="userId">
          <code className="font-mono text-[11px] text-muted-foreground">
            {batch.userId ?? "-"}
          </code>
        </Field>
        <Field label="진행">
          <span className="text-sm tabular-nums">
            <span className="font-medium">{batch.processed}</span>
            <span className="text-muted-foreground"> / {batch.total}</span>
            {batch.failedCount > 0 ? (
              <span className="ml-2 text-destructive">
                실패 {batch.failedCount}
              </span>
            ) : null}
          </span>
        </Field>
        <Field label="attempt">
          <span className="text-sm tabular-nums">{batch.attempt}</span>
        </Field>
        <Field label="생성 시각">
          <span className="text-sm">{formatDateTime(batch.createdAt)}</span>
        </Field>
        <Field label="종료 시각">
          <span className="text-sm">
            {batch.finishedAt ? formatDateTime(batch.finishedAt) : "-"}
          </span>
        </Field>
        <div className="sm:col-span-2">
          <details className="group rounded-lg border bg-muted/30 px-3 py-2 text-xs">
            <summary className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <ChevronDownIcon className="size-3 transition-transform group-open:-rotate-180" />
              summary JSON
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded border bg-background p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
              {prettyJson(batch.summary)}
            </pre>
          </details>
        </div>
      </CardContent>
    </Card>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div>{children}</div>
    </div>
  )
}

// =============================================================================
// 2. 액션 영역 (재시도 / 롤백)
// =============================================================================

function ActionPanel({
  batch,
  retryResult,
  rollbackResult,
  onRetryDone,
  onRollbackDone,
}: {
  batch: ChangeBatchDetail
  retryResult: RetryResult | null
  rollbackResult: RollbackResult | null
  onRetryDone: (r: RetryResult | null) => void
  onRollbackDone: (r: RollbackResult | null) => void
}) {
  const supported = ROLLBACK_SUPPORTED_ACTIONS.has(batch.action)
  const hasFailed = batch.failedCount > 0
  const hasDone = batch.items.some((it) => it.status === "done")
  // 재시도: 실패 항목 있고 화이트리스트 액션
  const canRetry = supported && hasFailed
  // 롤백: 성공 항목 있고 화이트리스트 액션. (failed 도 같이 done 이 있다면 가능)
  const canRollback = supported && hasDone

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>액션</CardTitle>
        <CardDescription>
          {supported ? (
            <>
              실패 항목 재시도 (F-6.3) / 변경 롤백 (F-6.4) 을 수행할 수 있습니다.
              롤백은 toggle / update 계열만 지원합니다.
            </>
          ) : (
            <>
              본 액션 (
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                {batch.action}
              </code>
              ) 은 재시도 / 롤백 비지원입니다 — 생성 / 삭제 / 동기화 액션은 본
              PR 비대상.
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 py-4">
        <div className="flex flex-wrap gap-2">
          <RetryModal
            batchId={batch.id}
            failedCount={batch.failedCount}
            disabled={!canRetry}
            onResult={onRetryDone}
          />
          <RollbackModal
            batchId={batch.id}
            actionName={batch.action}
            disabled={!canRollback}
            onResult={onRollbackDone}
          />
        </div>

        {retryResult ? <RetryResultBox result={retryResult} /> : null}
        {rollbackResult ? (
          <RollbackResultBox result={rollbackResult} />
        ) : null}
      </CardContent>
    </Card>
  )
}

// =============================================================================
// 2-A. 재시도 모달 + 결과
// =============================================================================

function RetryModal({
  batchId,
  failedCount,
  disabled,
  onResult,
}: {
  batchId: string
  failedCount: number
  disabled: boolean
  onResult: (r: RetryResult | null) => void
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [pending, setPending] = React.useState(false)

  async function handleConfirm() {
    setPending(true)
    try {
      const res = await retryFailedItems(batchId)
      onResult(res)
      if (!res.ok) {
        toast.error(res.error ?? "재시도 실패")
      } else {
        toast.success(
          `재시도 완료 — 성공 ${res.successAfterRetry} / 실패 ${res.stillFailed}`,
        )
      }
      setOpen(false)
      router.refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`재시도 오류: ${msg}`)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" disabled={disabled}>
            실패 항목 재시도 ({failedCount})
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>실패 항목 재시도</DialogTitle>
          <DialogDescription>
            실패 ChangeItem ({failedCount}건) 을 SA 일괄 PUT 으로 재호출합니다.
            ChangeItem 의 idempotencyKey 는 동일하게 유지되며, 새 row 가
            생성되지 않습니다 (멱등). 네이버 SA PUT 은 idempotent 합니다.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          targetId 가 없는 항목 (CREATE 사전 단계) 은 자동 skip 됩니다. SA
          호출 그룹 단위 실패는 그룹 전체가 다시 failed 처리됩니다.
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            취소
          </Button>
          <Button onClick={handleConfirm} disabled={pending}>
            {pending ? "재시도 중..." : "재시도"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RetryResultBox({ result }: { result: RetryResult }) {
  if (!result.ok) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-3 text-sm text-destructive">
        <div className="font-medium">재시도 실패</div>
        <div className="mt-1 text-xs">{result.error}</div>
      </div>
    )
  }
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-3">
      <div className="text-sm font-medium">재시도 결과</div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <Stat label="재시도" value={result.retried} />
        <Stat
          label="성공"
          value={result.successAfterRetry}
          accent="emerald"
        />
        <Stat
          label="여전히 실패"
          value={result.stillFailed}
          accent="destructive"
        />
      </div>
      {result.retried === 0 ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          재시도 대상이 없었습니다 (실패 항목 0).
        </p>
      ) : null}
    </div>
  )
}

// =============================================================================
// 2-B. 롤백 모달 + 결과
// =============================================================================

function RollbackModal({
  batchId,
  actionName,
  disabled,
  onResult,
}: {
  batchId: string
  actionName: string
  disabled: boolean
  onResult: (r: RollbackResult | null) => void
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [ignoreDrift, setIgnoreDrift] = React.useState(false)
  const [saRecheck, setSaRecheck] = React.useState(false)

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      setIgnoreDrift(false)
      setSaRecheck(false)
    }
  }

  async function handleConfirm() {
    setPending(true)
    try {
      const res = await rollbackChangeBatch(batchId, { ignoreDrift, saRecheck })
      onResult(res)
      toast.success(
        `롤백 완료 — 성공 ${res.success} / 실패 ${res.failed} / drift skip ${res.drift}`,
      )
      setOpen(false)
      setIgnoreDrift(false)
      setSaRecheck(false)
      router.refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`롤백 오류: ${msg}`)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button variant="destructive" disabled={disabled}>
            롤백
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>변경 롤백</DialogTitle>
          <DialogDescription>
            본 ChangeBatch (
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              {actionName}
            </code>
            ) 의 변경을 되돌립니다. toggle / update 계열에 한정되며, 완료된
            (status=done) 항목만 대상입니다.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
            <div className="font-medium text-foreground">drift 감지</div>
            <p className="mt-1 text-muted-foreground">
              기본은 DB 현재값과 적재된 after JSON 이 다르면 drift 로
              판정합니다. SA 재조회 옵션을 켜면 네이버 SA 측 현재값과 직접
              비교해 외부 변경(타 사용자/자동화/네이버측)도 감지합니다. drift
              항목은 기본 skip.
            </p>
          </div>

          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={saRecheck}
              onCheckedChange={(v) => setSaRecheck(v === true)}
            />
            <span>
              <strong>SA 재조회로 정밀 검사</strong>
              <span className="ml-1 text-muted-foreground">
                — 네이버 SA 측 외부 변경(타 사용자/자동화/네이버측)을
                감지합니다. 호출이 늘어 시간이 더 걸립니다.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={ignoreDrift}
              onCheckedChange={(v) => setIgnoreDrift(v === true)}
            />
            <span>
              <strong>drift 강제 무시</strong>
              <span className="ml-1 text-muted-foreground">
                — drift 항목도 강제로 before 값으로 덮어씌웁니다.
              </span>
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={pending}
          >
            취소
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={pending}
          >
            {pending ? "롤백 중..." : "롤백 실행"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RollbackResultBox({ result }: { result: RollbackResult }) {
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-3">
      <div className="text-sm font-medium">롤백 결과</div>

      <div className="mt-2 grid grid-cols-4 gap-2">
        <Stat label="대상" value={result.total} />
        <Stat label="성공" value={result.success} accent="emerald" />
        <Stat label="실패" value={result.failed} accent="destructive" />
        <Stat label="drift skip" value={result.drift} accent="amber" />
      </div>

      <div className="mt-3 flex items-center gap-2 rounded-md border bg-background px-3 py-2">
        <span className="text-xs text-muted-foreground">새 ChangeBatch ID</span>
        <code className="flex-1 truncate font-mono text-xs">
          {result.newBatchId}
        </code>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => copyToClipboard(result.newBatchId)}
          title="ID 복사"
        >
          <CopyIcon />
        </Button>
        <Button
          size="sm"
          variant="outline"
          render={
            <Link href={`/admin/change-batches/${result.newBatchId}`} />
          }
        >
          이동
        </Button>
      </div>

      {result.items.length > 0 ? (
        <RollbackItemsList items={result.items} />
      ) : null}
    </div>
  )
}

function RollbackItemsList({ items }: { items: RollbackItemResult[] }) {
  // reason 별로 분류: drift / unsupported_action / no_before / sa_failed
  const drift = items.filter((it) => it.reason === "drift")
  const noBefore = items.filter((it) => it.reason === "no_before")
  const unsupported = items.filter(
    (it) => it.reason === "unsupported_action",
  )
  const saFailed = items.filter((it) => it.reason === "sa_failed")

  return (
    <div className="mt-3 flex flex-col gap-2 text-xs">
      {drift.length > 0 ? (
        <ReasonGroup
          tone="amber"
          title={`drift skip (${drift.length})`}
          subtitle="DB 현재값과 적재된 after 가 다름. ignoreDrift=true 로 강제 가능."
          items={drift}
        />
      ) : null}
      {noBefore.length > 0 ? (
        <ReasonGroup
          tone="zinc"
          title={`before 없음 (${noBefore.length})`}
          subtitle="원 ChangeItem 에 before 가 비어 롤백 불가."
          items={noBefore}
        />
      ) : null}
      {unsupported.length > 0 ? (
        <ReasonGroup
          tone="destructive"
          title={`비지원 액션 (${unsupported.length})`}
          subtitle="targetType 이 롤백 매핑에 없음. 코드 동기 필요."
          items={unsupported}
        />
      ) : null}
      {saFailed.length > 0 ? (
        <ReasonGroup
          tone="destructive"
          title={`SA 호출 실패 (${saFailed.length})`}
          subtitle="네이버 SA PUT 응답 누락 또는 그룹 단위 실패."
          items={saFailed}
        />
      ) : null}
    </div>
  )
}

function ReasonGroup({
  tone,
  title,
  subtitle,
  items,
}: {
  tone: "amber" | "zinc" | "destructive"
  title: string
  subtitle: string
  items: RollbackItemResult[]
}) {
  const cls =
    tone === "amber"
      ? "border-amber-300 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/10"
      : tone === "destructive"
        ? "border-destructive/40 bg-destructive/5"
        : "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/20"
  return (
    <div className={`rounded-md border ${cls}`}>
      <div className="border-b border-current/10 px-3 py-1.5">
        <div className="text-[11px] font-medium">{title}</div>
        <div className="text-[11px] text-muted-foreground">{subtitle}</div>
      </div>
      <ul className="max-h-40 overflow-y-auto px-3 py-2">
        {items.map((it) => (
          <li
            key={it.itemId}
            className="border-b border-current/10 py-1 last:border-0"
          >
            <span className="font-mono text-[11px] text-muted-foreground">
              [{it.targetType}] {it.targetId ?? "-"}
            </span>
            {it.error ? (
              <span className="ml-2 text-[11px]">— {it.error}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string
  value: number
  accent?: "emerald" | "destructive" | "amber"
}) {
  const cls =
    accent === "emerald"
      ? "text-emerald-700 dark:text-emerald-300"
      : accent === "destructive"
        ? "text-destructive"
        : accent === "amber"
          ? "text-amber-700 dark:text-amber-300"
          : ""
  return (
    <div className="rounded-md border bg-background px-2 py-1.5 text-center">
      <div className="text-[10px] uppercase text-muted-foreground">
        {label}
      </div>
      <div className={`text-base font-medium tabular-nums ${cls}`}>
        {value}
      </div>
    </div>
  )
}

// =============================================================================
// 3. items 테이블
// =============================================================================

function ItemsTable({ items }: { items: ChangeItemRow[] }) {
  const [statusFilter, setStatusFilter] = React.useState<string>("all")
  const [detailRow, setDetailRow] = React.useState<ChangeItemRow | null>(null)

  const filtered = React.useMemo(() => {
    if (statusFilter === "all") return items
    return items.filter((it) => it.status === statusFilter)
  }, [items, statusFilter])

  // 상태별 카운트 (헤더 표시)
  const counts = React.useMemo(() => {
    const c: Record<string, number> = {
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
      skipped: 0,
    }
    for (const it of items) c[it.status] = (c[it.status] ?? 0) + 1
    return c
  }, [items])

  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>ChangeItem 목록</CardTitle>
            <CardDescription>
              <span className="font-medium">{items.length}</span> 건 — 성공{" "}
              {counts.done ?? 0} / 실패 {counts.failed ?? 0} / pending{" "}
              {counts.pending ?? 0}
              {(counts.skipped ?? 0) > 0
                ? ` / skipped ${counts.skipped ?? 0}`
                : ""}
            </CardDescription>
          </div>
          <div className="flex items-end gap-2">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">status 필터</Label>
              <Select
                value={statusFilter}
                onValueChange={(v) => setStatusFilter(v ?? "all")}
              >
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">전체</SelectItem>
                  <SelectItem value="pending">pending</SelectItem>
                  <SelectItem value="running">running</SelectItem>
                  <SelectItem value="done">done</SelectItem>
                  <SelectItem value="failed">failed</SelectItem>
                  <SelectItem value="skipped">skipped</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-4">targetType</TableHead>
              <TableHead>targetId</TableHead>
              <TableHead>status</TableHead>
              <TableHead className="text-right">attempt</TableHead>
              <TableHead>error</TableHead>
              <TableHead className="px-4 text-right">상세</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="px-4 py-8 text-center text-sm text-muted-foreground"
                >
                  {items.length === 0
                    ? "ChangeItem 이 없습니다."
                    : "조건에 맞는 항목이 없습니다."}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => setDetailRow(row)}
                >
                  <TableCell className="px-4 text-sm">
                    {row.targetType}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {row.targetId ?? "-"}
                  </TableCell>
                  <TableCell>
                    <ItemStatusBadge status={row.status} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">
                    {row.attempt}
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-xs text-muted-foreground">
                    {row.error ?? "-"}
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
                        before/after
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>

      <ChangeItemDetailModal
        row={detailRow}
        onClose={() => setDetailRow(null)}
      />
    </Card>
  )
}

