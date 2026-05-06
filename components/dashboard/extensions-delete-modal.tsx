"use client"

/**
 * 확장소재 단건 삭제 모달 (F-5.x) — admin 한정 + 2차 확인
 *
 * KeywordsDeleteModal / AdsDeleteModal 패턴 응용.
 *
 * 흐름 (3단계 상태 머신):
 *   1. confirm     — 삭제 대상 정보 노출 + payload 텍스트(headline/description) 재입력 칸
 *                   trim 비교 일치 시에만 삭제 버튼 활성. 빈 입력/불일치 → disabled.
 *                   확장소재는 nccExtId 보다 텍스트가 사용자 친화 식별자 — 텍스트 재입력.
 *                   "삭제(destructive)" → submitting
 *   2. submitting  — 스피너 + "삭제 중...". deleteAdExtensionSingle 호출
 *                   catch:
 *                     - AuthorizationError → toast "관리자 권한 필요" + 닫기
 *                     - Error("확인 텍스트 불일치") → confirm 복귀 + inline 에러
 *                       (백엔드 안전망 발동 — race condition 케이스)
 *                     - 기타          → toast.error + confirm 복귀
 *   3. result      — ok:true 카드 + 변경 ID + 클립보드 복사
 *                    (batchId="" idempotent 케이스: "이미 삭제된 확장소재 — 변경 없음")
 *                    ok:false destructive 카드 + "닫기"
 *                    "닫고 새로고침" → onClosed(true) → router.refresh
 *
 * 안전장치 (CLAUDE.md / KeywordsDeleteModal 패턴 동일):
 *   - admin 외 사용자는 호출자(ExtensionsTable)에서 메뉴 자체 disabled — 본 모달 진입 X
 *   - 2차 확인 텍스트 (오타·잘못된 행 보호) — 클라이언트 검증 + 백엔드 검증 이중
 *   - destructive variant 버튼
 *   - 변경 ID 노출 (감사용)
 *
 * SPEC 6.2 F-5.x / 안전장치 6 (대량 삭제 비대상 + 단건 삭제 admin + 2차 확인).
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ExtensionTypeBadge } from "@/components/dashboard/extension-type-badge"
import {
  deleteAdExtensionSingle,
  type DeleteAdExtensionResult,
} from "@/app/(dashboard)/[advertiserId]/extensions/actions"

// =============================================================================
// 타입
// =============================================================================

type Step = "confirm" | "submitting" | "result"

/**
 * 모달 진입에 필요한 최소 row 정보. 테이블 row 의존성 차단 위해 별도 타입.
 */
export type DeleteAdExtensionTargetRow = {
  /** 앱 DB AdExtension.id (Server Action 페이로드) */
  id: string
  /** SA 확장소재 ID (사용자 표시 + 결과 매칭) */
  nccExtId: string
  /** 타입 — 정보 표시용 + 2차 확인 라벨 분기 */
  type: string
  /** payload 에서 추출된 텍스트 (2차 확인 비교 대상) */
  text: string
  /** 광고그룹 이름 — 정보 표시용 */
  adgroupName: string
}

// =============================================================================
// 메인 컴포넌트
// =============================================================================

export function ExtensionsDeleteModal({
  advertiserId,
  row,
  open,
  onOpenChange,
  onClosed,
}: {
  advertiserId: string
  row: DeleteAdExtensionTargetRow
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 모달 닫힌 직후 — didApply=true 면 호출자가 router.refresh */
  onClosed?: (didApply: boolean) => void
}) {
  const [step, setStep] = React.useState<Step>("confirm")
  const [confirmText, setConfirmText] = React.useState<string>("")
  const [serverMismatch, setServerMismatch] = React.useState<boolean>(false)
  const [result, setResult] =
    React.useState<DeleteAdExtensionResult | null>(null)

  // -- 2차 확인 검증 ----------------------------------------------------------
  // 확장소재는 payload 의 텍스트(headline / description)를 비교 대상으로 사용.
  // 텍스트가 비어있는 경우(payload 누락 — 방어적) nccExtId 폴백.
  const trimmedInput = confirmText.trim()
  const trimmedTarget = row.text.trim().length > 0
    ? row.text.trim()
    : row.nccExtId.trim()
  const exactMatch =
    trimmedInput.length > 0 && trimmedInput === trimmedTarget
  const showMismatchError =
    (trimmedInput.length > 0 && !exactMatch) || serverMismatch

  // -- 제출 -------------------------------------------------------------------
  async function handleSubmit() {
    if (!exactMatch) return
    setServerMismatch(false)
    setStep("submitting")
    try {
      const res = await deleteAdExtensionSingle(advertiserId, {
        extensionId: row.id,
        confirmText: trimmedInput,
      })
      setResult(res)
      setStep("result")
    } catch (e) {
      const name = e instanceof Error ? e.name : ""
      const msg = e instanceof Error ? e.message : String(e)

      if (name === "AuthorizationError") {
        // admin 권한 부족 — 메뉴에서 차단됐어야 했지만 안전망.
        toast.error("관리자 권한 필요")
        onOpenChange(false)
        onClosed?.(false)
        return
      }
      if (msg === "확인 텍스트 불일치") {
        // race condition (사용자가 입력 중 텍스트가 변경되었거나 백엔드 검증 시점 차이).
        setServerMismatch(true)
        setStep("confirm")
        return
      }
      // 기타 — 네트워크 / 시크릿 미설정 / SA 호출 실패 등
      toast.error(`삭제 오류: ${msg}`)
      setStep("confirm")
    }
  }

  // -- 닫기 -------------------------------------------------------------------
  function handleClose() {
    // result 단계 도달 시 didApply=true (idempotent 케이스 포함 — 사용자 인지 후 닫기).
    // confirm/submitting 단계에서 닫으면 didApply=false (변경 없음).
    const didApply = step === "result" && result?.ok === true
    onOpenChange(false)
    onClosed?.(didApply)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>확장소재 삭제</DialogTitle>
          <DialogDescription>
            {step === "confirm" &&
              "이 작업은 되돌릴 수 없습니다. 잘못된 행을 막기 위해 확장소재 텍스트를 다시 입력해 확인하세요."}
            {step === "submitting" && "확장소재를 삭제하고 있습니다..."}
            {step === "result" &&
              (result?.ok
                ? "확장소재 삭제 결과를 확인하세요."
                : "삭제에 실패했습니다.")}
          </DialogDescription>
        </DialogHeader>

        {step === "confirm" && (
          <ConfirmView
            row={row}
            confirmText={confirmText}
            setConfirmText={(v) => {
              setConfirmText(v)
              if (serverMismatch) setServerMismatch(false)
            }}
            showMismatchError={showMismatchError}
            onEnter={handleSubmit}
            canSubmit={exactMatch}
          />
        )}

        {step === "submitting" && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            삭제 중...
          </div>
        )}

        {step === "result" && result && <ResultView result={result} />}

        <DialogFooter>
          {step === "confirm" && (
            <>
              <Button variant="outline" onClick={handleClose}>
                취소
              </Button>
              <Button
                variant="destructive"
                onClick={handleSubmit}
                disabled={!exactMatch}
              >
                삭제
              </Button>
            </>
          )}
          {step === "result" && (
            <Button onClick={handleClose}>
              {result?.ok ? "닫고 새로고침" : "닫기"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// =============================================================================
// confirm 단계 — 2차 확인 폼
// =============================================================================

function ConfirmView({
  row,
  confirmText,
  setConfirmText,
  showMismatchError,
  onEnter,
  canSubmit,
}: {
  row: DeleteAdExtensionTargetRow
  confirmText: string
  setConfirmText: (v: string) => void
  showMismatchError: boolean
  onEnter: () => void
  canSubmit: boolean
}) {
  // 비교 대상 텍스트: row.text 비어있으면 nccExtId 폴백 (안전망).
  const compareTarget =
    row.text.trim().length > 0 ? row.text.trim() : row.nccExtId.trim()
  const targetLabel =
    row.text.trim().length > 0
      ? row.type === "headline"
        ? "추가제목 텍스트"
        : row.type === "description"
          ? "추가설명 텍스트"
          : "확장소재 텍스트"
      : "확장소재 ID"

  return (
    <div className="flex flex-col gap-4">
      {/* 경고 배너 */}
      <div
        role="alert"
        className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
      >
        이 작업은 되돌릴 수 없습니다.
      </div>

      {/* 삭제 대상 정보 */}
      <div className="flex flex-col gap-1.5 rounded-md border bg-muted/30 px-3 py-2">
        <div className="text-[11px] font-medium text-muted-foreground">
          삭제할 확장소재
        </div>
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <ExtensionTypeBadge type={row.type} />
            {row.text.trim().length > 0 ? (
              <span className="line-clamp-2 font-medium">{row.text}</span>
            ) : (
              <span className="text-muted-foreground">(텍스트 없음)</span>
            )}
          </div>
          <span className="font-mono text-[11px] text-muted-foreground">
            확장소재 ID: {row.nccExtId}
          </span>
          <span className="text-xs text-muted-foreground">
            광고그룹: {row.adgroupName}
          </span>
        </div>
      </div>

      {/* 2차 확인 입력 */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="delete-extension-confirmText" className="text-sm">
          확인을 위해 {targetLabel}를 다시 입력하세요
        </Label>
        <Input
          id="delete-extension-confirmText"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={compareTarget}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          aria-invalid={showMismatchError}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSubmit) {
              e.preventDefault()
              onEnter()
            }
          }}
        />
        {showMismatchError && (
          <p className="text-[11px] text-destructive">
            텍스트가 일치하지 않습니다. 위에 표시된 내용과 정확히 동일하게
            입력하세요.
          </p>
        )}
      </div>
    </div>
  )
}

// =============================================================================
// result 단계
// =============================================================================

function ResultView({ result }: { result: DeleteAdExtensionResult }) {
  if (!result.ok) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-3 text-sm text-destructive">
        <div className="font-medium">확장소재 삭제 실패</div>
        <div className="mt-1 text-xs">{result.error}</div>
      </div>
    )
  }
  return <SuccessView batchId={result.batchId} nccExtId={result.nccExtId} />
}

function SuccessView({
  batchId,
  nccExtId,
}: {
  batchId: string
  nccExtId: string
}) {
  // batchId="" 인 idempotent 케이스 (이미 deleted 였던 확장소재) 분기.
  const noBatch = batchId === ""

  function copyBatchId() {
    if (noBatch) return
    navigator.clipboard
      .writeText(batchId)
      .then(() => toast.success("변경 ID 복사됨"))
      .catch(() => toast.error("복사 실패"))
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-900/10 dark:text-emerald-300">
        <div className="font-medium">확장소재 삭제 완료</div>
        <div className="mt-0.5 font-mono text-[11px] text-emerald-800 dark:text-emerald-400">
          확장소재 ID: {nccExtId}
        </div>
      </div>

      {noBatch ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/10 dark:text-amber-300">
          이미 삭제된 확장소재 — 변경 없음 (변경 사항 없음).
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
            <span className="text-xs text-muted-foreground">
              변경 ID
            </span>
            <code className="flex-1 truncate font-mono text-xs">{batchId}</code>
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
            롤백 페이지(F-6.4)에서 본 ID 로 변경 이력을 조회할 수 있습니다.
            (단, 확장소재 삭제는 P1 롤백 비대상)
          </p>
        </>
      )}
    </div>
  )
}
