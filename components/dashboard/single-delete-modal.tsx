"use client"

/**
 * 단건 삭제 모달 (제네릭) — F-3.7 / F-4.7 / F-5.x 공통 병합
 *
 * 기존 3개 모달(keywords / ads / extensions-delete-modal)을 하나로 병합.
 * 엔티티별 차이(라벨 / 삭제 action / 2차 확인 대상 / 대상 정보 렌더)는 `entity` 로 분기.
 * 본 모달은 테이블(클라이언트 컴포넌트) 내부에서만 렌더 — 서버 액션 직접 import 안전.
 *
 * 흐름 (3단계 상태 머신 — 3종 동일):
 *   1. confirm     — 삭제 대상 정보 + 2차 확인 텍스트 재입력 칸
 *                   trim 비교 일치 시에만 삭제 버튼 활성. 빈 입력/불일치 → disabled.
 *   2. submitting  — 스피너 + "삭제 중...". 엔티티별 delete server action 호출
 *                   catch:
 *                     - AuthorizationError    → toast "관리자 권한 필요" + 닫기
 *                     - 확인 텍스트 불일치     → confirm 복귀 + inline 에러 (백엔드 안전망)
 *                     - 기타                   → toast.error + confirm 복귀
 *   3. result      — ok:true 카드 + 변경 ID + 클립보드 복사 / ok:false destructive 카드
 *
 * 안전장치 (CLAUDE.md 안전장치 6 — 절대 약화 금지):
 *   - admin 외 사용자는 호출자(테이블)에서 메뉴 자체 disabled — 본 모달 진입 X
 *   - 2차 확인 텍스트 (오타·잘못된 행 보호) — 클라이언트 검증 + 백엔드 검증 이중
 *   - destructive variant 버튼
 *   - 변경 ID 노출 (감사용)
 *
 * SPEC 6.2 F-3.7 / F-4.7 / F-5.x / 안전장치 6.
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
import { deleteAdSingle } from "@/app/(dashboard)/[advertiserId]/ads/actions"
import { deleteAdExtensionSingle } from "@/app/(dashboard)/[advertiserId]/extensions/actions"
import { deleteKeywordSingle } from "@/app/(dashboard)/[advertiserId]/keywords/actions"

// =============================================================================
// 타입 — 모달 진입에 필요한 최소 row 정보 (테이블 row 의존성 차단)
// =============================================================================

/** 키워드 삭제 대상 (KeywordRow 의존성 차단). */
export type DeleteTargetRow = {
  /** 앱 DB Keyword.id (Server Action 페이로드) */
  id: string
  /** SA 키워드 ID (사용자 표시 + 결과 매칭) */
  nccKeywordId: string
  /** 삭제 대상 키워드 텍스트 (2차 확인 비교 대상) */
  keyword: string
  /** 매치타입 — 정보 표시용 (null 가능) */
  matchType: string | null
  /** 광고그룹 이름 — 정보 표시용 */
  adgroupName: string
}

/** 소재 삭제 대상 (AdRow 의존성 차단). */
export type DeleteAdTargetRow = {
  /** 앱 DB Ad.id (Server Action 페이로드) */
  id: string
  /** SA 소재 ID (사용자 표시 + 2차 확인 비교 대상) */
  nccAdId: string
  /** 소재 타입 (TEXT_45 등) — 정보 표시용 (null 가능) */
  adType: string | null
  /** 소재 미리보기 텍스트 — 정보 표시용 (truncate) */
  preview: string
  /** 광고그룹 이름 — 정보 표시용 */
  adgroupName: string
}

/** 확장소재 삭제 대상 (ExtensionRow 의존성 차단). */
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

type Step = "confirm" | "submitting" | "result"

/** 엔티티별 결과를 정규화한 공통 결과 shape. */
type NormalizedDeleteResult =
  | { ok: true; batchId: string; resultId: string }
  | { ok: false; error: string }

type CommonDeleteModalProps = {
  advertiserId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 모달 닫힌 직후 — didApply=true 면 호출자가 router.refresh */
  onClosed?: (didApply: boolean) => void
}

export type SingleDeleteModalProps =
  | ({ entity: "keyword"; row: DeleteTargetRow } & CommonDeleteModalProps)
  | ({ entity: "ad"; row: DeleteAdTargetRow } & CommonDeleteModalProps)
  | ({
      entity: "extension"
      row: DeleteAdExtensionTargetRow
    } & CommonDeleteModalProps)

// =============================================================================
// 엔티티별 스펙 — 라벨 / 2차 확인 대상 / delete action / 대상 정보 렌더
// =============================================================================

type DeleteSpec = {
  /** "키워드" | "소재" | "확장소재" — 파생 문구(title/완료/실패 등)의 베이스. */
  entityLabel: string
  /** confirm 단계 다이얼로그 설명 (엔티티별 재입력 대상 명시). */
  confirmDescription: string
  /** 2차 확인 비교 대상 텍스트 (trim 완료). */
  compareTarget: string
  /** 백엔드가 던지는 정확한 불일치 에러 메시지 (race condition 안전망). */
  serverMismatchMessage: string
  /** 삭제 대상 정보 블록 제목 ("삭제할 키워드" 등). */
  targetInfoTitle: string
  /** 삭제 대상 정보 본문 (엔티티별 상이). */
  targetInfoBody: React.ReactNode
  /** confirm 입력 id (label htmlFor 연결). */
  inputId: string
  /** confirm 입력 라벨. */
  confirmInputLabel: string
  /** confirm 입력 placeholder. */
  placeholder: string
  /** confirm 입력 추가 className (소재는 font-mono). */
  inputClassName?: string
  /** 불일치 인라인 에러 문구. */
  mismatchErrorText: string
  /** idempotent(이미 삭제됨) 안내 문구. */
  noBatchNote: string
  /** 엔티티별 delete server action 호출 → 정규화 결과. */
  callDelete: (confirmText: string) => Promise<NormalizedDeleteResult>
}

/** 삭제 대상 정보 본문 공용 래퍼 라인. */
function targetLine(children: React.ReactNode) {
  return <div className="flex flex-col gap-0.5">{children}</div>
}

function getDeleteSpec(props: SingleDeleteModalProps): DeleteSpec {
  const { advertiserId } = props

  switch (props.entity) {
    case "keyword": {
      const row = props.row
      return {
        entityLabel: "키워드",
        confirmDescription:
          "이 작업은 되돌릴 수 없습니다. 잘못된 행을 막기 위해 키워드 텍스트를 다시 입력해 확인하세요.",
        compareTarget: row.keyword.trim(),
        serverMismatchMessage: "확인 키워드 텍스트 불일치",
        targetInfoTitle: "삭제할 키워드",
        targetInfoBody: targetLine(
          <>
            <span className="font-medium">
              &ldquo;{row.keyword}&rdquo;
              {row.matchType && (
                <span className="ml-2 text-xs text-muted-foreground">
                  ({row.matchType})
                </span>
              )}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              키워드 ID: {row.nccKeywordId}
            </span>
            <span className="text-xs text-muted-foreground">
              광고그룹: {row.adgroupName}
            </span>
          </>,
        ),
        inputId: "delete-confirmKeyword",
        confirmInputLabel: "확인을 위해 키워드 텍스트를 다시 입력하세요",
        placeholder: row.keyword,
        mismatchErrorText:
          "텍스트가 일치하지 않습니다. 위에 표시된 키워드와 정확히 동일하게 입력하세요.",
        noBatchNote: "이미 삭제된 키워드 — 변경 없음 (변경 사항 없음).",
        callDelete: async (confirmText) => {
          const res = await deleteKeywordSingle(advertiserId, {
            keywordId: row.id,
            confirmKeyword: confirmText,
          })
          return res.ok
            ? { ok: true, batchId: res.batchId, resultId: res.nccKeywordId }
            : res
        },
      }
    }

    case "ad": {
      const row = props.row
      return {
        entityLabel: "소재",
        confirmDescription:
          "이 작업은 되돌릴 수 없습니다. 잘못된 행을 막기 위해 소재 ID 를 다시 입력해 확인하세요.",
        compareTarget: row.nccAdId.trim(),
        serverMismatchMessage: "확인 텍스트 불일치",
        targetInfoTitle: "삭제할 소재",
        targetInfoBody: targetLine(
          <>
            <span className="line-clamp-2 font-medium">
              {row.preview || "(미리보기 없음)"}
              {row.adType && (
                <span className="ml-2 text-xs text-muted-foreground">
                  ({row.adType})
                </span>
              )}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              소재 ID: {row.nccAdId}
            </span>
            <span className="text-xs text-muted-foreground">
              광고그룹: {row.adgroupName}
            </span>
          </>,
        ),
        inputId: "delete-ad-confirmText",
        confirmInputLabel: "확인을 위해 위 소재 ID 를 다시 입력하세요",
        placeholder: row.nccAdId,
        inputClassName: "font-mono",
        mismatchErrorText:
          "ID 가 일치하지 않습니다. 위에 표시된 소재 ID 와 정확히 동일하게 입력하세요.",
        noBatchNote: "이미 삭제된 소재 — 변경 사항이 없습니다.",
        callDelete: async (confirmText) => {
          const res = await deleteAdSingle(advertiserId, {
            adId: row.id,
            confirmText,
          })
          return res.ok
            ? { ok: true, batchId: res.batchId, resultId: res.nccAdId }
            : res
        },
      }
    }

    case "extension": {
      const row = props.row
      // 확장소재는 payload 텍스트(headline/description)를 비교 대상으로 사용.
      // 텍스트가 비어있는 경우(image / payload 누락) nccExtId 폴백.
      const hasText = row.text.trim().length > 0
      const compareTarget = hasText ? row.text.trim() : row.nccExtId.trim()
      const targetLabel = hasText
        ? row.type === "headline"
          ? "추가제목 텍스트"
          : row.type === "description"
            ? "추가설명 텍스트"
            : "확장소재 텍스트"
        : "확장소재 ID"
      return {
        entityLabel: "확장소재",
        confirmDescription:
          "이 작업은 되돌릴 수 없습니다. 잘못된 행을 막기 위해 확장소재 텍스트를 다시 입력해 확인하세요.",
        compareTarget,
        serverMismatchMessage: "확인 텍스트 불일치",
        targetInfoTitle: "삭제할 확장소재",
        targetInfoBody: targetLine(
          <>
            <div className="flex items-center gap-2">
              <ExtensionTypeBadge type={row.type} />
              {hasText ? (
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
          </>,
        ),
        inputId: "delete-extension-confirmText",
        confirmInputLabel: `확인을 위해 ${targetLabel}를 다시 입력하세요`,
        placeholder: compareTarget,
        mismatchErrorText:
          "텍스트가 일치하지 않습니다. 위에 표시된 내용과 정확히 동일하게 입력하세요.",
        noBatchNote: "이미 삭제된 확장소재 — 변경 없음 (변경 사항 없음).",
        callDelete: async (confirmText) => {
          const res = await deleteAdExtensionSingle(advertiserId, {
            extensionId: row.id,
            confirmText,
          })
          return res.ok
            ? { ok: true, batchId: res.batchId, resultId: res.nccExtId }
            : res
        },
      }
    }
  }
}

// =============================================================================
// 메인 컴포넌트
// =============================================================================

export function SingleDeleteModal(props: SingleDeleteModalProps) {
  const { open, onOpenChange, onClosed } = props

  const [step, setStep] = React.useState<Step>("confirm")
  const [confirmText, setConfirmText] = React.useState<string>("")
  const [serverMismatch, setServerMismatch] = React.useState<boolean>(false)
  const [result, setResult] = React.useState<NormalizedDeleteResult | null>(
    null,
  )

  const spec = getDeleteSpec(props)

  // -- 2차 확인 검증 ----------------------------------------------------------
  const trimmedInput = confirmText.trim()
  const exactMatch =
    trimmedInput.length > 0 && trimmedInput === spec.compareTarget
  const showMismatchError =
    (trimmedInput.length > 0 && !exactMatch) || serverMismatch

  // -- 제출 -------------------------------------------------------------------
  async function handleSubmit() {
    if (!exactMatch) return
    setServerMismatch(false)
    setStep("submitting")
    try {
      const res = await spec.callDelete(trimmedInput)
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
      if (msg === spec.serverMismatchMessage) {
        // race condition (입력 중 대상 변경 또는 백엔드 검증 시점 차이).
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
          <DialogTitle>{spec.entityLabel} 삭제</DialogTitle>
          <DialogDescription>
            {step === "confirm" && spec.confirmDescription}
            {step === "submitting" &&
              `${spec.entityLabel}를 삭제하고 있습니다...`}
            {step === "result" &&
              (result?.ok
                ? `${spec.entityLabel} 삭제 결과를 확인하세요.`
                : "삭제에 실패했습니다.")}
          </DialogDescription>
        </DialogHeader>

        {step === "confirm" && (
          <ConfirmView
            spec={spec}
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

        {step === "result" && result && (
          <ResultView result={result} spec={spec} />
        )}

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
  spec,
  confirmText,
  setConfirmText,
  showMismatchError,
  onEnter,
  canSubmit,
}: {
  spec: DeleteSpec
  confirmText: string
  setConfirmText: (v: string) => void
  showMismatchError: boolean
  onEnter: () => void
  canSubmit: boolean
}) {
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
          {spec.targetInfoTitle}
        </div>
        {spec.targetInfoBody}
      </div>

      {/* 2차 확인 입력 */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={spec.inputId} className="text-sm">
          {spec.confirmInputLabel}
        </Label>
        <Input
          id={spec.inputId}
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={spec.placeholder}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          aria-invalid={showMismatchError}
          className={spec.inputClassName}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSubmit) {
              e.preventDefault()
              onEnter()
            }
          }}
        />
        {showMismatchError && (
          <p className="text-[11px] text-destructive">
            {spec.mismatchErrorText}
          </p>
        )}
      </div>
    </div>
  )
}

// =============================================================================
// result 단계
// =============================================================================

function ResultView({
  result,
  spec,
}: {
  result: NormalizedDeleteResult
  spec: DeleteSpec
}) {
  if (!result.ok) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-3 text-sm text-destructive">
        <div className="font-medium">{spec.entityLabel} 삭제 실패</div>
        <div className="mt-1 text-xs">{result.error}</div>
      </div>
    )
  }
  return (
    <SuccessView
      batchId={result.batchId}
      resultId={result.resultId}
      spec={spec}
    />
  )
}

function SuccessView({
  batchId,
  resultId,
  spec,
}: {
  batchId: string
  resultId: string
  spec: DeleteSpec
}) {
  // batchId="" 인 idempotent 케이스 (이미 deleted 였던 대상) 분기 처리.
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
        <div className="font-medium">{spec.entityLabel} 삭제 완료</div>
        <div className="mt-0.5 font-mono text-[11px] text-emerald-800 dark:text-emerald-400">
          {spec.entityLabel} ID: {resultId}
        </div>
      </div>

      {noBatch ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/10 dark:text-amber-300">
          {spec.noBatchNote}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
            <span className="text-xs text-muted-foreground">변경 ID</span>
            <code className="flex-1 truncate font-mono text-xs">
              {batchId}
            </code>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={copyBatchId}
              title="ID 복사"
            >
              <CopyIcon />
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            admin 변경 이력 화면에서 이 변경 ID로 조회할 수 있습니다 (삭제는
            자동 롤백 대상이 아님).
          </p>
        </>
      )}
    </div>
  )
}
