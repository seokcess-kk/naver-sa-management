"use client"

/**
 * 키워드 CSV 가져오기 모달 (F-3.4 / 5천행 Job Table 패턴)
 *
 * 5단계 상태 머신:
 *   1. upload     — 파일 선택(input + drag&drop) + 형식 안내. 5MB / .csv .txt
 *                   파일 읽기 성공 시 즉시 parseAndValidateCsv 호출 → validating
 *   2. validating — 검증 중 스피너. throw 발생 시 upload 복귀 + toast.error
 *   3. review     — parseAndValidateCsv 결과 표시. 3 탭(정상 / 오류 / 충돌).
 *                   충돌 행 resolution 선택, 오류는 안내만(차단 X). 확정 → applying
 *   4. applying   — applyCsvChangeBatch 호출 (즉시 batchId 반환) + GET /api/batch/{id}
 *                   5초 간격 polling. ChangeBatch.status === 'done' / 'failed' 면 result.
 *   5. result     — 카운트 카드 / 진행률 / ChangeBatch ID
 *                   "닫고 새로고침" → onClosed(true) → router.refresh
 *
 * 안전장치:
 *   - 즉시 적용 X — review 단계 항상 거침 (백엔드 흐름 일치)
 *   - 오류 행은 적용 대상 미포함 (확정 시 자동 제외)
 *   - 충돌 행은 사용자 결정 필수 (skip / UPDATE 전환). 미선택 시 disabled
 *   - hasKeys=false 시 호출자 측에서 모달 진입 차단 (본 컴포넌트는 가정)
 *   - polling 중 모달 닫기 → polling 취소 (cleanup)
 *
 * 비대상:
 *   - F-3.5 CSV 다운로드
 *   - 키워드 추가/삭제 별도 액션
 *
 * SPEC v0.2.1 6.2 F-3.4 / 11장 / 3.5 (Job Table + Chunk Executor).
 */

import * as React from "react"
import { toast } from "sonner"
import { CopyIcon, UploadIcon, FileTextIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import {
  parseAndValidateCsv,
  applyCsvChangeBatch,
  type CsvRow,
  type CsvValidationItem,
  type ParseAndValidateResult,
  type CsvApplyDirective,
  type ApplyCsvResult,
} from "@/app/(dashboard)/[advertiserId]/keywords/actions"

// =============================================================================
// 타입
// =============================================================================

type Step = "upload" | "validating" | "review" | "applying" | "result"

type ConflictResolution = "skip" | "update"

const MAX_FILE_BYTES = 5 * 1024 * 1024 // 5MB

const ALLOWED_EXTS = [".csv", ".txt"] as const

type ConflictItem = Extract<CsvValidationItem, { kind: "conflict" }>
type ErrorItem = Extract<CsvValidationItem, { kind: "error" }>
type ValidItem = Extract<CsvValidationItem, { kind: "valid" }>
type WarningItem = Extract<CsvValidationItem, { kind: "warning" }>

/** GET /api/batch/{id} 응답 shape (lib/api/batch/[id]/route.ts 와 동일). */
type BatchProgress = {
  batch: {
    id: string
    action: string
    status: string // "pending" | "running" | "done" | "failed" | "canceled"
    total: number
    processed: number
    attempt: number
    createdAt: string
    finishedAt: string | null
  }
  counts: Record<string, number> // pending / done / failed / running / skipped
}

const POLL_INTERVAL_MS = 5000

// =============================================================================
// 메인 컴포넌트
// =============================================================================

export function KeywordsCsvImportModal({
  advertiserId,
  open,
  onOpenChange,
  onClosed,
}: {
  advertiserId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 모달 닫힘 시점 호출. didApply=true 면 적용 결과로 닫힌 것 (router.refresh 등) */
  onClosed?: (didApply: boolean) => void
}) {
  const [step, setStep] = React.useState<Step>("upload")
  const [fileName, setFileName] = React.useState<string | null>(null)
  const [validation, setValidation] =
    React.useState<ParseAndValidateResult | null>(null)
  const [conflictResolutions, setConflictResolutions] = React.useState<
    Map<number, ConflictResolution>
  >(new Map())
  const [applying, setApplying] = React.useState(false)
  /** 즉시 반환 받은 batchId + total + byOperation. polling 시작 시 채워짐. */
  const [submitted, setSubmitted] = React.useState<ApplyCsvResult | null>(null)
  /** 마지막 polling 결과 — applying / result 단계에서 진행률 표시용. */
  const [progress, setProgress] = React.useState<BatchProgress | null>(null)
  const [activeTab, setActiveTab] = React.useState<string>("valid")

  // 모달 close 시 호출자에게 적용 여부 통보
  const handleClose = React.useCallback(() => {
    const didApply = step === "result"
    onOpenChange(false)
    onClosed?.(didApply)
  }, [step, onOpenChange, onClosed])

  // -- 파일 처리 -----------------------------------------------------------
  const handleFile = React.useCallback(
    async (file: File) => {
      // 확장자 검사
      const lower = file.name.toLowerCase()
      const okExt = ALLOWED_EXTS.some((ext) => lower.endsWith(ext))
      if (!okExt) {
        toast.error(`지원 안 되는 확장자 — ${ALLOWED_EXTS.join(", ")} 만 가능`)
        return
      }
      if (file.size > MAX_FILE_BYTES) {
        toast.error(
          `파일 크기 초과 (${(file.size / 1024 / 1024).toFixed(1)}MB) — 5MB 이하`,
        )
        return
      }

      setFileName(file.name)
      setStep("validating")

      try {
        const text = await file.text()
        const r = await parseAndValidateCsv(advertiserId, text)
        setValidation(r)
        // 충돌 resolution 초기화 — 모두 미선택
        setConflictResolutions(new Map())
        // 탭 기본 — 정상 행이 있으면 valid, 없으면 가장 의미있는 것
        if (r.byKind.valid + r.byKind.warning > 0) {
          setActiveTab("valid")
        } else if (r.byKind.conflict > 0) {
          setActiveTab("conflict")
        } else {
          setActiveTab("error")
        }
        setStep("review")
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        toast.error(`CSV 검증 실패: ${msg}`)
        setStep("upload")
        setFileName(null)
      }
    },
    [advertiserId],
  )

  // -- 확정 적용 -----------------------------------------------------------
  async function handleApply() {
    if (!validation) return
    // directives 구성:
    //   - valid / warning → kind:"valid"
    //   - conflict + 사용자 선택 → kind:"conflict"+resolution. update 시 row.nccKeywordId 채움
    //   - error → 제외
    //   - 미선택 conflict 도 제외 (확정 버튼 disabled 로 차단되지만 안전망)
    const directives: CsvApplyDirective[] = []
    for (const it of validation.items) {
      if (it.kind === "valid" || it.kind === "warning") {
        directives.push({ kind: "valid", row: it.row })
      } else if (it.kind === "conflict") {
        const resolution = conflictResolutions.get(it.row.rowIndex)
        if (!resolution) continue
        if (resolution === "skip") {
          directives.push({
            kind: "conflict",
            row: it.row,
            resolution: "skip",
          })
        } else {
          // update — row.nccKeywordId 를 existingNccKeywordId 로 채워서 전송
          // (백엔드 명세: conflict update 행 nccKeywordId 누락 시 throw)
          const filledRow: CsvRow = {
            ...it.row,
            nccKeywordId: it.existingNccKeywordId ?? it.row.nccKeywordId,
          }
          directives.push({
            kind: "conflict",
            row: filledRow,
            resolution: "update",
          })
        }
      }
      // error 는 묵시적 제외
    }

    if (directives.length === 0) {
      toast.error("적용 대상 행 없음 — 정상 행 또는 충돌 처리 결정 필요")
      return
    }

    setApplying(true)
    setStep("applying")
    setProgress(null)
    try {
      // 즉시 반환 — ChangeBatch 적재만 동기. SA 호출은 Cron 이 처리.
      const r = await applyCsvChangeBatch(advertiserId, directives)
      setSubmitted(r)
      // polling 시작은 useEffect 가 step==='applying' && submitted!=null 감지로 트리거.
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`적용 실패: ${msg}`)
      setStep("review")
      setSubmitted(null)
    } finally {
      setApplying(false)
    }
  }

  // -- polling effect (applying → result 전이) ----------------------------
  React.useEffect(() => {
    if (step !== "applying" || !submitted) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    async function poll() {
      if (cancelled || !submitted) return
      try {
        const res = await fetch(`/api/batch/${submitted.batchId}`, {
          credentials: "include",
          cache: "no-store",
        })
        if (!res.ok) {
          // 인증 만료 등 — toast 후 review 복귀
          throw new Error(`HTTP ${res.status}`)
        }
        const data = (await res.json()) as BatchProgress
        if (cancelled) return
        setProgress(data)

        const status = data.batch.status
        if (status === "done" || status === "failed" || status === "canceled") {
          // 종료 — result 단계로
          setStep("result")
          return
        }
        // 진행 중 — 다음 polling 예약
        timer = setTimeout(poll, POLL_INTERVAL_MS)
      } catch (e) {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : String(e)
        toast.error(`진행률 조회 실패: ${msg}`)
        // 일시 오류 — polling 재시도 (사용자가 수동 닫지 않는 한 계속)
        timer = setTimeout(poll, POLL_INTERVAL_MS)
      }
    }

    // 첫 호출은 짧은 지연 (백엔드 적재 직후 race condition 회피)
    timer = setTimeout(poll, 500)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [step, submitted])

  // -- 화면 분기 -----------------------------------------------------------
  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>키워드 CSV 가져오기</DialogTitle>
          <DialogDescription>
            CSV 파일을 업로드해 키워드를 일괄 생성·수정·OFF 처리합니다. 검증 후
            미리보기 단계에서 적용 여부를 결정합니다.
          </DialogDescription>
        </DialogHeader>

        {step === "upload" && (
          <UploadView fileName={fileName} onFile={handleFile} />
        )}

        {step === "validating" && (
          <div className="py-12 text-center text-sm text-muted-foreground">
            CSV 파싱 및 검증 중...
          </div>
        )}

        {step === "review" && validation && (
          <ReviewView
            validation={validation}
            activeTab={activeTab}
            onActiveTabChange={setActiveTab}
            conflictResolutions={conflictResolutions}
            onConflictResolutionChange={(rowIndex, res) => {
              setConflictResolutions((prev) => {
                const next = new Map(prev)
                next.set(rowIndex, res)
                return next
              })
            }}
            onBulkConflict={(res) => {
              setConflictResolutions(() => {
                const next = new Map<number, ConflictResolution>()
                for (const it of validation.items) {
                  if (it.kind === "conflict") {
                    next.set(it.row.rowIndex, res)
                  }
                }
                return next
              })
            }}
          />
        )}

        {step === "applying" && (
          <ApplyingView submitted={submitted} progress={progress} />
        )}

        {step === "result" && submitted && (
          <ResultView submitted={submitted} progress={progress} />
        )}

        <DialogFooter>
          {step === "upload" && (
            <Button variant="outline" onClick={handleClose}>
              취소
            </Button>
          )}
          {step === "review" && validation && (
            <ReviewFooter
              validation={validation}
              conflictResolutions={conflictResolutions}
              onCancel={handleClose}
              onApply={handleApply}
              applying={applying}
            />
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
// upload 단계
// =============================================================================

function UploadView({
  fileName,
  onFile,
}: {
  fileName: string | null
  onFile: (file: File) => void
}) {
  const [dragOver, setDragOver] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)

  return (
    <div className="flex flex-col gap-4">
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 transition-colors",
          dragOver
            ? "border-primary bg-primary/5"
            : "border-muted-foreground/30 bg-muted/20",
        )}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const file = e.dataTransfer.files?.[0]
          if (file) onFile(file)
        }}
      >
        <UploadIcon className="size-8 text-muted-foreground" />
        <div className="text-sm font-medium">
          파일을 끌어다 놓거나, 아래 버튼으로 선택
        </div>
        <div className="text-xs text-muted-foreground">
          .csv / .txt · 최대 5MB · UTF-8 (BOM 허용)
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onFile(file)
            // 같은 파일 재선택 가능하도록 reset
            e.target.value = ""
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => inputRef.current?.click()}
          className="mt-1"
        >
          파일 선택
        </Button>
        {fileName && (
          <div className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <FileTextIcon className="size-3.5" />
            {fileName}
          </div>
        )}
      </div>

      <details className="rounded-md border bg-muted/30 px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium">
          CSV 형식 안내
        </summary>
        <div className="mt-2 space-y-2 text-xs text-muted-foreground">
          <p>
            컬럼 순서는 무관하며, 헤더 행이 필수입니다. 빈 셀은 UPDATE 시
            &quot;변경 안 함&quot;으로 처리됩니다. CREATE 행에는 externalId 가
            필수입니다(멱등성 키).
          </p>
          <div className="overflow-x-auto rounded border bg-background">
            <table className="w-full text-[11px]">
              <thead className="border-b bg-muted/40 text-left font-medium">
                <tr>
                  <th className="px-2 py-1">컬럼</th>
                  <th className="px-2 py-1">CREATE</th>
                  <th className="px-2 py-1">UPDATE</th>
                  <th className="px-2 py-1">OFF</th>
                  <th className="px-2 py-1">설명</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {[
                  ["operation", "필수", "필수", "필수", "CREATE / UPDATE / OFF"],
                  ["nccKeywordId", "-", "필수", "필수", "키워드 ID"],
                  ["nccAdgroupId", "필수", "-", "-", "광고그룹 ID"],
                  ["keyword", "필수", "선택", "-", "키워드 텍스트"],
                  ["matchType", "필수", "선택", "-", "EXACT / PHRASE / BROAD"],
                  ["bidAmt", "선택", "선택", "-", "입찰가 (정수, 음수 불가)"],
                  ["useGroupBidAmt", "선택", "선택", "-", "true / false"],
                  ["userLock", "선택", "선택", "-", "true=OFF / false=ON"],
                  ["externalId", "필수", "선택", "-", "사용자 멱등성 키"],
                ].map(([col, c, u, off, desc]) => (
                  <tr key={col} className="border-b last:border-0">
                    <td className="px-2 py-1">{col}</td>
                    <td className="px-2 py-1">{c}</td>
                    <td className="px-2 py-1">{u}</td>
                    <td className="px-2 py-1">{off}</td>
                    <td className="px-2 py-1 font-sans">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            DELETE 는 비대상입니다. 삭제는 OFF (userLock=true) 로 대체합니다.
            5000행 상한 — 초과 시 검증 단계에서 거부됩니다. 적용은 백그라운드
            Job 으로 진행되며, 상단 진행률이 5초 간격으로 갱신됩니다.
          </p>
        </div>
      </details>
    </div>
  )
}

// =============================================================================
// review 단계
// =============================================================================

function ReviewView({
  validation,
  activeTab,
  onActiveTabChange,
  conflictResolutions,
  onConflictResolutionChange,
  onBulkConflict,
}: {
  validation: ParseAndValidateResult
  activeTab: string
  onActiveTabChange: (v: string) => void
  conflictResolutions: Map<number, ConflictResolution>
  onConflictResolutionChange: (rowIndex: number, res: ConflictResolution) => void
  onBulkConflict: (res: ConflictResolution) => void
}) {
  const validItems = validation.items.filter(
    (it): it is ValidItem | WarningItem =>
      it.kind === "valid" || it.kind === "warning",
  )
  const errorItems = validation.items.filter(
    (it): it is ErrorItem => it.kind === "error",
  )
  const conflictItems = validation.items.filter(
    (it): it is ConflictItem => it.kind === "conflict",
  )

  const okCount = validation.byKind.valid + validation.byKind.warning

  return (
    <div className="flex flex-col gap-3">
      {/* 카운터 바 */}
      <div className="grid grid-cols-3 gap-2">
        <CountCard
          label="정상"
          value={okCount}
          accent={okCount > 0 ? "emerald" : undefined}
        />
        <CountCard
          label="오류"
          value={validation.byKind.error}
          accent={validation.byKind.error > 0 ? "destructive" : undefined}
        />
        <CountCard
          label="충돌"
          value={validation.byKind.conflict}
          accent={validation.byKind.conflict > 0 ? "amber" : undefined}
        />
      </div>

      {/* unknownAdgroupIds 경고 */}
      {validation.unknownAdgroupIds.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
          <strong>광고주 DB 에 없는 nccAdgroupId</strong> (
          {validation.unknownAdgroupIds.length}건):{" "}
          <span className="font-mono">
            {validation.unknownAdgroupIds.slice(0, 5).join(", ")}
            {validation.unknownAdgroupIds.length > 5 ? " ..." : ""}
          </span>
          <p className="mt-1 text-[11px]">
            해당 CREATE 행은 오류로 분류되어 적용 대상에서 제외됩니다.
          </p>
        </div>
      )}

      {/* 탭 */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => {
          if (typeof v === "string") onActiveTabChange(v)
        }}
      >
        <TabsList>
          <TabsTrigger value="valid">정상 ({okCount})</TabsTrigger>
          <TabsTrigger value="error">
            오류 ({validation.byKind.error})
          </TabsTrigger>
          <TabsTrigger value="conflict">
            충돌 ({validation.byKind.conflict})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="valid">
          <ValidTable items={validItems} />
        </TabsContent>
        <TabsContent value="error">
          <ErrorTable items={errorItems} />
        </TabsContent>
        <TabsContent value="conflict">
          <ConflictTable
            items={conflictItems}
            resolutions={conflictResolutions}
            onChange={onConflictResolutionChange}
            onBulk={onBulkConflict}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// -----------------------------------------------------------------------------
// 정상 탭
// -----------------------------------------------------------------------------

function ValidTable({ items }: { items: Array<ValidItem | WarningItem> }) {
  if (items.length === 0) {
    return (
      <div className="rounded-md border bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
        정상 행이 없습니다.
      </div>
    )
  }

  return (
    <div className="max-h-80 overflow-y-auto rounded-md border">
      <table className="w-full text-xs">
        <thead className="sticky top-0 z-10 border-b bg-muted/60">
          <tr className="text-left">
            <th className="px-2 py-1.5">행</th>
            <th className="px-2 py-1.5">operation</th>
            <th className="px-2 py-1.5">키워드</th>
            <th className="px-2 py-1.5">광고그룹/키워드ID</th>
            <th className="px-2 py-1.5">변경/매치</th>
            <th className="px-2 py-1.5">비고</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const r = it.row
            const isWarning = it.kind === "warning"
            return (
              <tr
                key={`${it.kind}-${r.rowIndex}`}
                className={cn(
                  "border-b last:border-0",
                  isWarning &&
                    "bg-amber-50/60 dark:bg-amber-950/30",
                )}
              >
                <td className="px-2 py-1 font-mono">{r.rowIndex}</td>
                <td className="px-2 py-1">
                  <OpBadge op={r.operation} />
                </td>
                <td className="px-2 py-1">{r.keyword ?? "—"}</td>
                <td className="px-2 py-1 font-mono text-[11px]">
                  {r.operation === "CREATE"
                    ? r.nccAdgroupId
                    : r.nccKeywordId}
                </td>
                <td className="px-2 py-1">
                  {r.operation === "CREATE" ? (
                    <span className="font-mono text-[11px]">{r.matchType}</span>
                  ) : (
                    <ChangedFields row={r} />
                  )}
                </td>
                <td className="px-2 py-1">
                  {isWarning ? (
                    <span
                      className="text-[11px] text-amber-800 dark:text-amber-300"
                      title={(it as WarningItem).warnings.join(" / ")}
                    >
                      {(it as WarningItem).warnings.join(" / ")}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** UPDATE/OFF 행의 변경 필드 요약 */
function ChangedFields({ row }: { row: CsvRow }) {
  const parts: string[] = []
  if (row.bidAmt !== null && row.bidAmt !== undefined) {
    parts.push(`bid=${row.bidAmt}`)
  }
  if (row.useGroupBidAmt !== null && row.useGroupBidAmt !== undefined) {
    parts.push(`group=${row.useGroupBidAmt}`)
  }
  if (row.userLock !== null && row.userLock !== undefined) {
    parts.push(`lock=${row.userLock}`)
  }
  if (parts.length === 0) {
    return <span className="text-[11px] text-muted-foreground">변경 없음</span>
  }
  return (
    <span className="font-mono text-[11px] text-foreground/80">
      {parts.join(" / ")}
    </span>
  )
}

// -----------------------------------------------------------------------------
// 오류 탭
// -----------------------------------------------------------------------------

function ErrorTable({ items }: { items: ErrorItem[] }) {
  if (items.length === 0) {
    return (
      <div className="rounded-md border bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
        오류 행이 없습니다.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
        오류 행은 적용 대상에서 자동 제외됩니다. 수정 후 재업로드하거나, 정상·충돌
        행만 적용하려면 그대로 진행하세요.
      </div>
      <div className="max-h-80 overflow-y-auto rounded-md border border-destructive/30">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 border-b bg-destructive/10">
            <tr className="text-left">
              <th className="px-2 py-1.5">행</th>
              <th className="px-2 py-1.5">오류</th>
              <th className="px-2 py-1.5">원본</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.rowIndex} className="border-b last:border-0">
                <td className="px-2 py-1 align-top font-mono">{it.rowIndex}</td>
                <td className="px-2 py-1 align-top">
                  <ul className="list-disc pl-3 text-destructive">
                    {it.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </td>
                <td className="px-2 py-1 align-top">
                  <code className="break-all text-[10px] text-muted-foreground">
                    {summarizeRaw(it.raw)}
                  </code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function summarizeRaw(raw: Record<string, string>): string {
  const keys = ["operation", "nccKeywordId", "nccAdgroupId", "keyword", "matchType"]
  const parts = keys
    .map((k) => (raw[k] ? `${k}=${raw[k]}` : null))
    .filter(Boolean)
  return parts.slice(0, 4).join(" / ")
}

// -----------------------------------------------------------------------------
// 충돌 탭
// -----------------------------------------------------------------------------

function ConflictTable({
  items,
  resolutions,
  onChange,
  onBulk,
}: {
  items: ConflictItem[]
  resolutions: Map<number, ConflictResolution>
  onChange: (rowIndex: number, res: ConflictResolution) => void
  onBulk: (res: ConflictResolution) => void
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-md border bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
        충돌 행이 없습니다.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs dark:border-amber-800/60 dark:bg-amber-950/40">
        <span className="text-amber-900 dark:text-amber-200">
          이미 존재하는 키워드와 충돌합니다. 각 행에 대해 처리 방식을
          선택하세요.
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onBulk("skip")}
            className="h-7 text-xs"
          >
            모두 skip
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onBulk("update")}
            className="h-7 text-xs"
          >
            모두 UPDATE 전환
          </Button>
        </div>
      </div>
      <div className="max-h-80 overflow-y-auto rounded-md border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 border-b bg-amber-100/60 dark:bg-amber-950/40">
            <tr className="text-left">
              <th className="px-2 py-1.5">행</th>
              <th className="px-2 py-1.5">키워드</th>
              <th className="px-2 py-1.5">매치</th>
              <th className="px-2 py-1.5">충돌 사유</th>
              <th className="px-2 py-1.5">처리</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const res = resolutions.get(it.row.rowIndex)
              return (
                <tr
                  key={it.row.rowIndex}
                  className={cn(
                    "border-b last:border-0",
                    !res && "bg-amber-50/40 dark:bg-amber-950/20",
                  )}
                >
                  <td className="px-2 py-1 font-mono">{it.row.rowIndex}</td>
                  <td className="px-2 py-1">{it.row.keyword ?? "—"}</td>
                  <td className="px-2 py-1 font-mono text-[11px]">
                    {it.row.matchType ?? "—"}
                  </td>
                  <td className="px-2 py-1 text-[11px]">
                    {it.reason === "external_id_exists"
                      ? "externalId 이미 사용됨"
                      : `자연키 중복 (기존 ID: ${it.existingNccKeywordId ?? "?"})`}
                  </td>
                  <td className="px-2 py-1">
                    <ConflictRadio
                      rowIndex={it.row.rowIndex}
                      value={res}
                      canUpdate={Boolean(it.existingNccKeywordId)}
                      onChange={(v) => onChange(it.row.rowIndex, v)}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ConflictRadio({
  rowIndex,
  value,
  canUpdate,
  onChange,
}: {
  rowIndex: number
  value: ConflictResolution | undefined
  canUpdate: boolean
  onChange: (v: ConflictResolution) => void
}) {
  const name = `conflict-${rowIndex}`
  return (
    <div className="flex items-center gap-3">
      <Label className="inline-flex cursor-pointer items-center gap-1 text-[11px]">
        <input
          type="radio"
          name={name}
          checked={value === "skip"}
          onChange={() => onChange("skip")}
        />
        skip
      </Label>
      <Label
        className={cn(
          "inline-flex items-center gap-1 text-[11px]",
          canUpdate ? "cursor-pointer" : "cursor-not-allowed opacity-50",
        )}
        title={canUpdate ? undefined : "기존 키워드 ID 미상 — UPDATE 불가"}
      >
        <input
          type="radio"
          name={name}
          checked={value === "update"}
          disabled={!canUpdate}
          onChange={() => onChange("update")}
        />
        UPDATE 전환
      </Label>
    </div>
  )
}

// -----------------------------------------------------------------------------
// review 단계 footer
// -----------------------------------------------------------------------------

function ReviewFooter({
  validation,
  conflictResolutions,
  onCancel,
  onApply,
  applying,
}: {
  validation: ParseAndValidateResult
  conflictResolutions: Map<number, ConflictResolution>
  onCancel: () => void
  onApply: () => void
  applying: boolean
}) {
  // 충돌 미선택 행 수
  const conflictPending = validation.items.filter((it) => {
    if (it.kind !== "conflict") return false
    return !conflictResolutions.get(it.row.rowIndex)
  }).length

  // 적용 대상 (정상 + 충돌 중 update/skip 결정된 것 — skip 도 directives 에 들어가지만 효과는 0건)
  const okCount = validation.byKind.valid + validation.byKind.warning
  const conflictUpdateCount = Array.from(conflictResolutions.values()).filter(
    (v) => v === "update",
  ).length

  const effectiveCount = okCount + conflictUpdateCount
  const hasNothingToApply = effectiveCount === 0
  const disabled = applying || conflictPending > 0 || hasNothingToApply

  return (
    <div className="flex w-full items-center justify-between gap-2">
      <div className="flex flex-col text-[11px] text-muted-foreground">
        {validation.byKind.error > 0 && (
          <span>오류 {validation.byKind.error}건은 제외됩니다.</span>
        )}
        {conflictPending > 0 && (
          <span className="text-amber-700 dark:text-amber-400">
            충돌 {conflictPending}건의 처리 방식을 선택해야 적용 가능합니다.
          </span>
        )}
        {hasNothingToApply && conflictPending === 0 && (
          <span>적용 대상 행이 없습니다.</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={onCancel}>
          전체 중단
        </Button>
        <Button onClick={onApply} disabled={disabled}>
          {applying ? "적용 중..." : `확정 적용 (${effectiveCount}건)`}
        </Button>
      </div>
    </div>
  )
}

// =============================================================================
// applying 단계 — 진행률 polling
// =============================================================================

function ApplyingView({
  submitted,
  progress,
}: {
  submitted: ApplyCsvResult | null
  progress: BatchProgress | null
}) {
  if (!submitted) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        변경 적용 시작 중...
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3 py-4">
      <ProgressPanel submitted={submitted} progress={progress} />
      <p className="text-center text-[11px] text-muted-foreground">
        백그라운드 Job 으로 처리 중입니다. 모달을 닫아도 작업은 계속되며, 결과는
        ChangeBatch ID 로 다시 확인할 수 있습니다.
      </p>
    </div>
  )
}

// =============================================================================
// result 단계
// =============================================================================

function ResultView({
  submitted,
  progress,
}: {
  submitted: ApplyCsvResult
  progress: BatchProgress | null
}) {
  function copyBatchId() {
    navigator.clipboard
      .writeText(submitted.batchId)
      .then(() => toast.success("ChangeBatch ID 복사됨"))
      .catch(() => toast.error("복사 실패"))
  }

  const counts = progress?.counts ?? {}
  const done = counts.done ?? 0
  const failed = counts.failed ?? 0
  const pending = counts.pending ?? 0
  const total = progress?.batch.total ?? submitted.total
  const finalStatus = progress?.batch.status ?? "running"

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-4 gap-2">
        <CountCard label="요청" value={total} />
        <CountCard label="성공" value={done} accent="emerald" />
        <CountCard
          label="실패"
          value={failed}
          accent={failed > 0 ? "destructive" : undefined}
        />
        <CountCard
          label="대기"
          value={pending}
          accent={pending > 0 ? "amber" : undefined}
        />
      </div>

      {/* byOperation 적재 분포 (Cron 처리 결과별 분해는 후속 PR 에서 ChangeItem groupBy) */}
      <div className="overflow-hidden rounded-md border">
        <table className="w-full text-xs">
          <thead className="bg-muted/60">
            <tr className="text-left">
              <th className="px-2 py-1.5">operation</th>
              <th className="px-2 py-1.5 text-right">적재</th>
            </tr>
          </thead>
          <tbody>
            {(["CREATE", "UPDATE", "OFF"] as const).map((op) => {
              const n = submitted.byOperation[op]
              return (
                <tr key={op} className="border-b last:border-0">
                  <td className="px-2 py-1">
                    <OpBadge op={op} />
                  </td>
                  <td className="px-2 py-1 text-right font-mono">{n}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* ChangeBatch ID */}
      <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
        <span className="text-xs text-muted-foreground">ChangeBatch ID</span>
        <code className="flex-1 truncate font-mono text-xs">
          {submitted.batchId}
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

      {/* 상태 안내 */}
      {finalStatus === "done" && failed === 0 && (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-900/20 dark:text-emerald-300">
          모든 변경이 성공적으로 적용되었습니다.
        </p>
      )}
      {finalStatus === "failed" && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          일부 또는 모든 변경이 실패했습니다. 실패 항목은 ChangeBatch ID 로
          롤백 페이지(F-6.4)에서 확인 / 재시도할 수 있습니다.
        </p>
      )}
    </div>
  )
}

// =============================================================================
// 진행률 패널 (applying / result 공용)
// =============================================================================

function ProgressPanel({
  submitted,
  progress,
}: {
  submitted: ApplyCsvResult
  progress: BatchProgress | null
}) {
  const total = progress?.batch.total ?? submitted.total
  const processed = progress?.batch.processed ?? 0
  const status = progress?.batch.status ?? "pending"
  const counts = progress?.counts ?? {}
  const done = counts.done ?? 0
  const failed = counts.failed ?? 0
  const pending = counts.pending ?? Math.max(total - processed, 0)

  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">진행률</span>
        <span className="font-mono text-muted-foreground">
          {processed} / {total} ({pct}%) · status={status}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            status === "failed"
              ? "bg-destructive"
              : status === "done"
                ? "bg-emerald-500"
                : "bg-primary",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="grid grid-cols-4 gap-2 pt-1">
        <CountCard label="대기" value={pending} />
        <CountCard label="성공" value={done} accent="emerald" />
        <CountCard
          label="실패"
          value={failed}
          accent={failed > 0 ? "destructive" : undefined}
        />
        <CountCard label="요청" value={total} />
      </div>
    </div>
  )
}

// =============================================================================
// 공용 보조
// =============================================================================

function CountCard({
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
      ? "text-emerald-700 dark:text-emerald-400"
      : accent === "destructive"
        ? "text-destructive"
        : accent === "amber"
          ? "text-amber-700 dark:text-amber-400"
          : "text-foreground"
  return (
    <div className="rounded-md border bg-background p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 font-mono text-lg font-medium", cls)}>
        {value}
      </div>
    </div>
  )
}

function OpBadge({ op }: { op: "CREATE" | "UPDATE" | "OFF" }) {
  const cls =
    op === "CREATE"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
      : op === "UPDATE"
        ? "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300"
        : "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
  return (
    <span
      className={cn(
        "inline-block rounded px-1.5 py-0.5 text-[10px] font-medium",
        cls,
      )}
    >
      {op}
    </span>
  )
}
