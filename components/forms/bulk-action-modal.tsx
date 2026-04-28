"use client"

/**
 * 다중 선택 일괄 액션 4단계 모달 — 공통 컴포넌트 (F-2.3 / SPEC 11.3)
 *
 * 목적:
 *   F-2.1 캠페인·F-2.2 광고그룹 두 테이블이 각자 4단계 모달
 *   (`input → preview → submit → result`)을 직접 구현해 코드 중복이 컸다.
 *   본 컴포넌트는 4단계 상태 머신·진행 표시·ChangeBatch ID 노출·결과 분리만
 *   책임지고, **입력 폼 / 전·후 비교 표 / Server Action 호출**은 호출자가
 *   render prop / onSubmit 으로 주입한다.
 *
 * 4단계 (SPEC 11.3 공통 패턴):
 *   1. input   : `renderInput(items, onReady)` — 호출자가 액션별 입력 폼 정의.
 *                onReady(input) 호출 → preview 단계 진입.
 *                input 단계가 필요 없는 액션 (예: ON/OFF 토글)은 호출자가
 *                renderInput 안에서 mount 시 즉시 onReady() 호출 가능.
 *   2. preview : `renderPreview(items, input)` — 전/후 비교 표.
 *                "확정 적용" 버튼 → onSubmit(input) → submit 단계.
 *   3. submit  : 처리 중 스피너 + "처리 중 N/총 N건". onSubmit 완료 → result.
 *   4. result  : ChangeBatch ID(클립보드 복사) + 성공/실패 카운트 카드 +
 *                실패 항목 리스트 + 닫기.
 *
 * 비책임 (호출자에 위임):
 *   - Server Action 호출 → onSubmit prop
 *   - router.refresh / toast / selection clear → onClosed 콜백
 *   - 입력 폼 검증 (호출자가 onReady 호출 전에 수행)
 *   - 전/후 비교 표의 컬럼 구성 (캠페인은 ON/OFF, 광고그룹은 PC/M 등 다름)
 *
 * 디자인 시스템 (기존 campaigns-table 모달 그대로):
 *   shadcn Dialog / Card / Table / Button + sonner toast + Tailwind 4.
 */

import * as React from "react"
import { toast } from "sonner"
import { CopyIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

// =============================================================================
// 타입
// =============================================================================

export type BulkActionResultItem = {
  id: string
  ok: boolean
  error?: string
}

export type BulkActionResult = {
  batchId: string
  total: number
  success: number
  failed: number
  items: BulkActionResultItem[]
}

type Step = "input" | "preview" | "submit" | "result"

export type BulkActionModalProps<TItem, TInput> = {
  /** 모달 open 상태 (제어형). */
  open: boolean
  /** 닫기 요청 (X 버튼 / 취소 / 백드롭). */
  onOpenChange: (open: boolean) => void

  /** 화면 상단 제목 (예: "ON으로 변경 (일괄)"). */
  title: string
  /** 보조 설명 (없으면 기본: "{itemLabel} N개 선택됨..."). */
  description?: string

  /** 다중 선택된 행. */
  selectedItems: TItem[]
  /** 결과 화면 라벨 (예: "캠페인" / "광고그룹"). description 기본값에도 사용. */
  itemLabel: string

  /**
   * input 단계 렌더 prop.
   *
   * 호출자가 액션별 입력 폼을 그리고, 입력 완료 시점에 `onReady(input)`을
   * 호출해야 한다. 입력이 필요 없는 액션이라면 `useEffect(() => onReady(...), [])`
   * 으로 mount 즉시 preview 로 진입시킬 수 있다.
   */
  renderInput: (
    items: TItem[],
    onReady: (input: TInput) => void,
  ) => React.ReactNode

  /** preview 단계 렌더 prop — 전/후 비교 표 등. */
  renderPreview: (items: TItem[], input: TInput) => React.ReactNode

  /** 확정 적용 — Server Action 호출. 호출자가 동기/비동기 모두 처리 가능. */
  onSubmit: (input: TInput) => Promise<BulkActionResult>

  /** 결과 화면에서 result.items[].id 와 매칭할 표시명 추출. */
  getItemDisplayName: (item: TItem) => string
  /** result.items[].id 와 매칭할 ID (대개 nccCampaignId / nccAdgroupId). */
  getItemId: (item: TItem) => string

  /** 모달이 닫힌 직후 호출 (router.refresh 등 호출자 책임). */
  onClosed?: (didApply: boolean) => void

  /**
   * preview 단계에서 confirm 버튼의 variant.
   * "강제 시도 (실패 예상)" 같은 destructive 케이스에 사용.
   * 기본 "default".
   */
  confirmButtonVariant?: "default" | "destructive"
  /** preview 단계 confirm 버튼 라벨 (기본 "확정 적용"). */
  confirmButtonLabel?: string
}

// =============================================================================
// 메인 컴포넌트
// =============================================================================

export function BulkActionModal<TItem, TInput>({
  open,
  onOpenChange,
  title,
  description,
  selectedItems,
  itemLabel,
  renderInput,
  renderPreview,
  onSubmit,
  getItemDisplayName,
  getItemId,
  onClosed,
  confirmButtonVariant = "default",
  confirmButtonLabel = "확정 적용",
}: BulkActionModalProps<TItem, TInput>) {
  // 4단계 상태 머신.
  //
  // 상태 reset 전략:
  //   호출자(예: campaigns-table / adgroups-table)는
  //   `{modalProps !== null && <BulkActionModal open ... />}` 패턴으로
  //   액션 진입마다 컴포넌트를 mount, 종료 시 unmount 시킨다.
  //   이 mount/unmount 사이클이 자연스레 useState 초기값으로 reset 되므로
  //   `useEffect(open → setStep("input")...)` 식의 cascading render 가
  //   필요 없다 (react-hooks/set-state-in-effect 회피).
  //
  //   재사용 컴포넌트가 mount 를 유지한 채 open 만 토글하는 사용처가
  //   생기면, 호출자 측에서 `<BulkActionModal key={action} ...>` 로
  //   reset 키를 추가해야 한다.
  const [step, setStep] = React.useState<Step>("input")
  const [input, setInput] = React.useState<TInput | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const [result, setResult] = React.useState<BulkActionResult | null>(null)

  // 호출자가 input 단계에서 호출 → preview 단계 진입
  const handleReady = React.useCallback((next: TInput) => {
    setInput(next)
    setStep("preview")
  }, [])

  // preview "뒤로" — input 단계로 복귀하여 값 수정
  function handleBack() {
    setStep("input")
  }

  async function handleConfirm() {
    if (input === null) return
    setStep("submit")
    setSubmitting(true)
    try {
      const res = await onSubmit(input)
      setResult(res)
      setStep("result")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`일괄 변경 오류: ${msg}`)
      setStep("preview")
    } finally {
      setSubmitting(false)
    }
  }

  function handleClose() {
    // result 단계에서만 "적용됨" 으로 간주 → 호출자가 router.refresh 등 호출
    const didApply = step === "result"
    onOpenChange(false)
    onClosed?.(didApply)
  }

  const desc =
    description ??
    `${selectedItems.length}개 ${itemLabel} 선택됨. 변경은 미리보기 확인 후 적용됩니다.`

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{desc}</DialogDescription>
        </DialogHeader>

        {step === "input" && renderInput(selectedItems, handleReady)}

        {step === "preview" && input !== null && renderPreview(selectedItems, input)}

        {step === "submit" && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            적용 중... ({selectedItems.length}건)
          </div>
        )}

        {step === "result" && result && (
          <ResultView
            result={result}
            items={selectedItems}
            getItemDisplayName={getItemDisplayName}
            getItemId={getItemId}
          />
        )}

        <DialogFooter>
          {step === "input" && (
            <Button variant="outline" onClick={handleClose}>
              취소
            </Button>
          )}
          {step === "preview" && (
            <>
              <Button
                variant="outline"
                onClick={handleBack}
                disabled={submitting}
              >
                뒤로
              </Button>
              <Button
                onClick={handleConfirm}
                disabled={submitting}
                variant={confirmButtonVariant}
              >
                {confirmButtonLabel}
              </Button>
            </>
          )}
          {step === "result" && (
            <Button onClick={handleClose}>닫고 새로고침</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// =============================================================================
// 결과 뷰 (성공/실패 분리 + ChangeBatch ID — SPEC 11.3 의무)
// =============================================================================

function ResultView<TItem>({
  result,
  items,
  getItemDisplayName,
  getItemId,
}: {
  result: BulkActionResult
  items: TItem[]
  getItemDisplayName: (item: TItem) => string
  getItemId: (item: TItem) => string
}) {
  const failedItems = result.items.filter((i) => !i.ok)
  const successItems = result.items.filter((i) => i.ok)

  // result.items[].id → 표시명 매핑 (id 매칭 안되면 id 그대로 폴백)
  const displayNameById = React.useMemo(() => {
    const m = new Map<string, string>()
    for (const it of items) {
      m.set(getItemId(it), getItemDisplayName(it))
    }
    return m
  }, [items, getItemDisplayName, getItemId])

  function copyBatchId() {
    navigator.clipboard
      .writeText(result.batchId)
      .then(() => toast.success("ChangeBatch ID 복사됨"))
      .catch(() => toast.error("복사 실패"))
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="요청" value={result.total} />
        <Stat label="성공" value={result.success} accent="emerald" />
        <Stat label="실패" value={result.failed} accent="destructive" />
      </div>

      <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
        <span className="text-xs text-muted-foreground">ChangeBatch ID</span>
        <code className="flex-1 truncate font-mono text-xs">
          {result.batchId}
        </code>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={copyBatchId}
          title="ID 복사"
        >
          <CopyIcon />
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled
          title="롤백 화면 준비 중 (F-6.4)"
        >
          롤백 페이지로 이동
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        롤백 페이지(F-6.4)에서 본 ID 로 변경 이력을 조회·되돌릴 수 있습니다.
      </p>

      {failedItems.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5">
          <div className="border-b border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive">
            실패 {failedItems.length}건
          </div>
          <ul className="max-h-40 overflow-y-auto px-3 py-2 text-xs">
            {failedItems.map((it) => {
              const name = displayNameById.get(it.id)
              return (
                <li
                  key={it.id}
                  className="border-b border-destructive/10 py-1 last:border-0"
                >
                  <span className="font-mono text-muted-foreground">
                    {name ?? it.id}
                  </span>
                  <span className="ml-2 text-destructive">
                    {it.error ?? "원인 미상"}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {successItems.length > 0 && failedItems.length === 0 && (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-900/20 dark:text-emerald-300">
          모든 변경이 성공적으로 적용되었습니다.
        </p>
      )}
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
  accent?: "emerald" | "destructive"
}) {
  const valueClass =
    accent === "emerald"
      ? "text-emerald-700 dark:text-emerald-400"
      : accent === "destructive"
        ? "text-destructive"
        : "text-foreground"
  return (
    <div className="rounded-md border bg-background p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-0.5 font-mono text-lg font-medium ${valueClass}`}>
        {value}
      </div>
    </div>
  )
}
