"use client"

/**
 * 키워드 추가 모달 (F-3.6) — 단건·다건
 *
 * 흐름 (단일 액션):
 *   1. form        — 광고그룹 + 매치타입 + 입찰가 + 시작 ON/OFF + 키워드 textarea
 *                   "추가하기" → submitting
 *   2. submitting  — 스피너 + 진행 안내. createKeywordsBatch 호출
 *                   throw → form 복귀 + toast.error
 *   3. result      — 카운트 카드 4개 (시도 / 성공 / 실패 / 충돌)
 *                   변경 ID + 클립보드 복사 (batchId="" → "변경 없음" 안내)
 *                   실패 항목 + 충돌 항목 분리 노출
 *                   "닫고 새로고침" → onClosed(true) → router.refresh
 *
 * 입력 검증 (클라이언트):
 *   - 광고그룹 미선택 → 차단
 *   - bidAmt 모드인데 빈 값/음수/비정수 → 차단
 *   - 키워드 textarea: 줄별 split + trim + 빈 줄 제외 + 50자 초과 행 표시 + dedup
 *   - 1~100건 (Zod 스키마 일치)
 *
 * staging 단계 별도 X — 폼 자체가 "미리보기 전 단계". 사용자 명시 클릭으로만 호출.
 *
 * 안전장치:
 *   - hasKeys=false / 광고그룹 0개 → 호출자(KeywordsTable) 측에서 모달 진입 차단
 *   - 100건 상한 (Zod 일치)
 *   - batchId="" 결과 (모두 충돌) → 변경 ID 영역 "변경 없음" 명시
 *
 * 폼 라이브러리:
 *   useState — 6개 필드 + 동기 검증 + textarea 줄별 처리만 필요해 react-hook-form
 *   추가 비용 대비 가치 낮음. 본 코드베이스 다른 모달 (BulkActionInputForm,
 *   KeywordsCsvImportModal) 도 동일 패턴. (CLAUDE.md react-hook-form 권장은 일반
 *   폼 페이지 기준 — 본 모달은 일관성 위해 useState 유지.)
 *
 * SPEC 6.2 F-3.6 / 11.3.
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import {
  createKeywordsBatch,
  type CreateKeywordsBatchResult,
} from "@/app/(dashboard)/[advertiserId]/keywords/actions"

// =============================================================================
// 타입
// =============================================================================

/** 키워드 페이지에서 prop 으로 전달되는 광고그룹 옵션 (RSC 조회 결과). */
export type AdgroupOption = {
  id: string
  nccAdgroupId: string
  name: string
  campaign: { id: string; name: string }
}

type Step = "form" | "submitting" | "result"

type MatchType = "EXACT" | "PHRASE" | "BROAD"

// 키워드 추가 Zod 스키마 한도.
const MAX_KEYWORDS = 100
const MAX_KEYWORD_LEN = 50

// =============================================================================
// 메인 컴포넌트
// =============================================================================

export function KeywordsAddModal({
  advertiserId,
  adgroups,
  open,
  onOpenChange,
  onClosed,
}: {
  advertiserId: string
  adgroups: AdgroupOption[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 모달 닫힌 직후 — didApply=true 면 호출자가 router.refresh */
  onClosed?: (didApply: boolean) => void
}) {
  const [step, setStep] = React.useState<Step>("form")
  const [result, setResult] =
    React.useState<CreateKeywordsBatchResult | null>(null)

  // -- 폼 state ---------------------------------------------------------------
  const [nccAdgroupId, setNccAdgroupId] = React.useState<string>("")
  const [matchType, setMatchType] = React.useState<MatchType>("EXACT")
  const [useGroupBidAmt, setUseGroupBidAmt] = React.useState<boolean>(true)
  const [bidAmtInput, setBidAmtInput] = React.useState<string>("")
  // userLock — UI 는 "시작 ON/OFF" (사용자 친화). 내부적으로 userLock 매핑:
  //   ON  → userLock=false
  //   OFF → userLock=true
  const [startOn, setStartOn] = React.useState<boolean>(true)
  const [keywordsRaw, setKeywordsRaw] = React.useState<string>("")

  // -- 키워드 textarea 파싱 -----------------------------------------------------
  // 줄별 split → trim → 빈 줄 제외 → 길이 검증 → dedup.
  const parsed = React.useMemo(() => {
    const lines = keywordsRaw.split(/\r?\n/)
    const validKeywords: string[] = []
    const tooLong: string[] = []
    const seen = new Set<string>()
    let dupCount = 0
    let emptyLines = 0

    for (const raw of lines) {
      const t = raw.trim()
      if (t === "") {
        emptyLines++
        continue
      }
      if (t.length > MAX_KEYWORD_LEN) {
        tooLong.push(t)
        continue
      }
      if (seen.has(t)) {
        dupCount++
        continue
      }
      seen.add(t)
      validKeywords.push(t)
    }
    return { validKeywords, tooLong, dupCount, emptyLines }
  }, [keywordsRaw])

  const overLimit = parsed.validKeywords.length > MAX_KEYWORDS

  // -- 입찰가 검증 ------------------------------------------------------------
  // useGroupBidAmt=true 면 bidAmt 무시.
  // useGroupBidAmt=false 면 bidAmt 빈/음수/비정수 → 차단.
  const trimmedBid = bidAmtInput.trim()
  const bidAmtNum = trimmedBid === "" ? null : Number(trimmedBid)
  const bidAmtValid = useGroupBidAmt
    ? true
    : bidAmtNum !== null &&
      Number.isFinite(bidAmtNum) &&
      Number.isInteger(bidAmtNum) &&
      bidAmtNum >= 0

  // -- 전체 폼 검증 -----------------------------------------------------------
  const adgroupValid = nccAdgroupId !== ""
  const keywordsValid = parsed.validKeywords.length >= 1 && !overLimit
  const formValid = adgroupValid && bidAmtValid && keywordsValid

  // -- 제출 -------------------------------------------------------------------
  async function handleSubmit() {
    if (!formValid) return
    setStep("submitting")
    try {
      const res = await createKeywordsBatch(advertiserId, {
        nccAdgroupId,
        matchType,
        useGroupBidAmt,
        bidAmt: useGroupBidAmt ? undefined : (bidAmtNum ?? undefined),
        userLock: !startOn,
        keywords: parsed.validKeywords,
      })
      setResult(res)
      setStep("result")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`키워드 추가 오류: ${msg}`)
      setStep("form")
    }
  }

  // -- 닫기 -------------------------------------------------------------------
  function handleClose() {
    // result 단계에서 (success>0 또는 result 단계 도달 자체) → 새로고침 의미 있음.
    // 모두 충돌(batchId="") 인 경우도 사용자가 결과 인지 후 닫는 것이라 refresh 해도 무방.
    const didApply = step === "result"
    onOpenChange(false)
    onClosed?.(didApply)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>키워드 추가</DialogTitle>
          <DialogDescription>
            {step === "form" &&
              "광고그룹과 매치타입, 입찰가를 설정하고 키워드를 줄당 1개씩 입력하세요. (최대 100건, 각 50자)"}
            {step === "submitting" &&
              "키워드를 추가하고 있습니다. 잠시만 기다려주세요..."}
            {step === "result" &&
              (result && result.batchId
                ? "키워드 추가 결과를 확인하세요."
                : "추가 시도가 완료되었습니다.")}
          </DialogDescription>
        </DialogHeader>

        {step === "form" && (
          <FormView
            adgroups={adgroups}
            nccAdgroupId={nccAdgroupId}
            setNccAdgroupId={setNccAdgroupId}
            matchType={matchType}
            setMatchType={setMatchType}
            useGroupBidAmt={useGroupBidAmt}
            setUseGroupBidAmt={setUseGroupBidAmt}
            bidAmtInput={bidAmtInput}
            setBidAmtInput={setBidAmtInput}
            bidAmtValid={bidAmtValid}
            startOn={startOn}
            setStartOn={setStartOn}
            keywordsRaw={keywordsRaw}
            setKeywordsRaw={setKeywordsRaw}
            parsed={parsed}
            overLimit={overLimit}
          />
        )}

        {step === "submitting" && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {parsed.validKeywords.length}건 추가 중...
          </div>
        )}

        {step === "result" && result && <ResultView result={result} />}

        <DialogFooter>
          {step === "form" && (
            <>
              <Button variant="outline" onClick={handleClose}>
                취소
              </Button>
              <Button onClick={handleSubmit} disabled={!formValid}>
                추가하기
                {parsed.validKeywords.length > 0 &&
                  ` (${parsed.validKeywords.length}건)`}
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
// form 단계
// =============================================================================

function FormView({
  adgroups,
  nccAdgroupId,
  setNccAdgroupId,
  matchType,
  setMatchType,
  useGroupBidAmt,
  setUseGroupBidAmt,
  bidAmtInput,
  setBidAmtInput,
  bidAmtValid,
  startOn,
  setStartOn,
  keywordsRaw,
  setKeywordsRaw,
  parsed,
  overLimit,
}: {
  adgroups: AdgroupOption[]
  nccAdgroupId: string
  setNccAdgroupId: (v: string) => void
  matchType: MatchType
  setMatchType: (v: MatchType) => void
  useGroupBidAmt: boolean
  setUseGroupBidAmt: (v: boolean) => void
  bidAmtInput: string
  setBidAmtInput: (v: string) => void
  bidAmtValid: boolean
  startOn: boolean
  setStartOn: (v: boolean) => void
  keywordsRaw: string
  setKeywordsRaw: (v: string) => void
  parsed: {
    validKeywords: string[]
    tooLong: string[]
    dupCount: number
    emptyLines: number
  }
  overLimit: boolean
}) {
  return (
    <div className="flex flex-col gap-4">
      {/* 광고그룹 */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="adgroup-select">광고그룹</Label>
        <Select
          value={nccAdgroupId}
          onValueChange={(v) => setNccAdgroupId(v ?? "")}
        >
          <SelectTrigger id="adgroup-select">
            <SelectValue placeholder="광고그룹을 선택하세요">
              {(v: string | null) => {
                if (!v) return "광고그룹을 선택하세요"
                const g = adgroups.find((x) => x.nccAdgroupId === v)
                return g ? `${g.name} · ${g.campaign.name}` : v
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {adgroups.map((g) => (
              <SelectItem key={g.id} value={g.nccAdgroupId}>
                <div className="flex flex-col">
                  <span>{g.name}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {g.campaign.name}
                  </span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {nccAdgroupId === "" && (
          <p className="text-[11px] text-muted-foreground">
            광고그룹을 선택하세요.
          </p>
        )}
      </div>

      {/* 매치타입 */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-sm">매치타입</Label>
        <div className="flex items-center gap-4">
          {(["EXACT", "PHRASE", "BROAD"] as const).map((m) => (
            <Label
              key={m}
              className="flex cursor-pointer items-center gap-2 text-sm font-normal"
            >
              <input
                type="radio"
                name="add-matchType"
                checked={matchType === m}
                onChange={() => setMatchType(m)}
              />
              {m}
            </Label>
          ))}
        </div>
      </div>

      {/* 입찰가 */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-sm">입찰가</Label>
        <Label className="flex cursor-pointer items-center gap-2 text-sm font-normal">
          <Checkbox
            checked={useGroupBidAmt}
            onCheckedChange={(v) => setUseGroupBidAmt(!!v)}
          />
          광고그룹 기본 입찰가 사용
        </Label>
        {!useGroupBidAmt && (
          <div className="flex flex-col gap-1">
            <Input
              id="add-bidAmt"
              type="number"
              inputMode="numeric"
              min={0}
              step={10}
              value={bidAmtInput}
              onChange={(e) => setBidAmtInput(e.target.value)}
              placeholder="예: 500"
              className="w-40"
            />
            {!bidAmtValid && bidAmtInput.trim() !== "" && (
              <p className="text-[11px] text-destructive">
                0 이상의 정수를 입력하세요.
              </p>
            )}
            {!bidAmtValid && bidAmtInput.trim() === "" && (
              <p className="text-[11px] text-muted-foreground">
                입찰가를 입력하세요 (원 단위 정수).
              </p>
            )}
          </div>
        )}
      </div>

      {/* 시작 상태 */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-sm">시작 상태</Label>
        <div className="flex items-center gap-4">
          <Label className="flex cursor-pointer items-center gap-2 text-sm font-normal">
            <input
              type="radio"
              name="add-startOn"
              checked={startOn}
              onChange={() => setStartOn(true)}
            />
            ON
          </Label>
          <Label className="flex cursor-pointer items-center gap-2 text-sm font-normal">
            <input
              type="radio"
              name="add-startOn"
              checked={!startOn}
              onChange={() => setStartOn(false)}
            />
            OFF
          </Label>
        </div>
      </div>

      {/* 키워드 textarea */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="add-keywords">
          키워드 (줄당 1개, 1~{MAX_KEYWORDS}건, 각 1~{MAX_KEYWORD_LEN}자)
        </Label>
        <Textarea
          id="add-keywords"
          value={keywordsRaw}
          onChange={(e) => setKeywordsRaw(e.target.value)}
          placeholder={"신발\n운동화\n러닝화"}
          className="min-h-32 font-mono text-sm"
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          <span className="text-muted-foreground">
            입력된 키워드:{" "}
            <strong className="text-foreground">
              {parsed.validKeywords.length}건
            </strong>
          </span>
          {parsed.dupCount > 0 && (
            <span className="text-muted-foreground">
              · 중복 {parsed.dupCount}건 자동 제외
            </span>
          )}
          {parsed.tooLong.length > 0 && (
            <span className="text-destructive">
              · {MAX_KEYWORD_LEN}자 초과 {parsed.tooLong.length}건 (제외됨)
            </span>
          )}
          {overLimit && (
            <span className="text-destructive">
              · {MAX_KEYWORDS}건 초과 — 일부 행을 줄이세요
            </span>
          )}
          {parsed.validKeywords.length === 0 && keywordsRaw.trim() !== "" && (
            <span className="text-destructive">
              · 유효한 키워드가 없습니다
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// =============================================================================
// result 단계
// =============================================================================

function ResultView({ result }: { result: CreateKeywordsBatchResult }) {
  const noBatch = result.batchId === ""
  const allConflict = noBatch && result.conflicts.length > 0
  const anySuccess = result.success > 0

  function copyBatchId() {
    navigator.clipboard
      .writeText(result.batchId)
      .then(() => toast.success("변경 ID 복사됨"))
      .catch(() => toast.error("복사 실패"))
  }

  const failedItems = result.items.filter((i) => !i.ok)

  // 시도(total) 는 충돌 제외 후 실제 호출 건수.
  // "전체 시도" = total + conflicts.length
  const totalAttempts = result.total + result.conflicts.length

  return (
    <div className="flex flex-col gap-3">
      {/* 카운트 카드 4개 */}
      <div className="grid grid-cols-4 gap-2">
        <Stat label="요청" value={totalAttempts} />
        <Stat label="성공" value={result.success} accent="emerald" />
        <Stat label="실패" value={result.failed} accent="destructive" />
        <Stat
          label="충돌(skip)"
          value={result.conflicts.length}
          accent="amber"
        />
      </div>

      {/* 변경 ID 영역 */}
      {noBatch ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/10 dark:text-amber-300">
          {allConflict
            ? "변경 없음 — 모든 키워드가 이미 존재해 추가가 skip 되었습니다 (변경 사항 없음)."
            : "변경 없음 — 추가할 키워드가 없습니다."}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
            <span className="text-xs text-muted-foreground">
              변경 ID
            </span>
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
            롤백 페이지(F-6.4)에서 본 ID 로 변경 이력을 조회·되돌릴 수
            있습니다.
          </p>
        </>
      )}

      {/* 실패 항목 */}
      {failedItems.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5">
          <div className="border-b border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive">
            실패 {failedItems.length}건
          </div>
          <ul className="max-h-40 overflow-y-auto px-3 py-2 text-xs">
            {failedItems.map((it, i) => (
              <li
                key={`${it.keyword}-${i}`}
                className="border-b border-destructive/10 py-1 last:border-0"
              >
                <span className="font-mono text-foreground">{it.keyword}</span>
                <span className="ml-2 text-destructive">
                  {it.error ?? "원인 미상"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 충돌 항목 */}
      {result.conflicts.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50/60 dark:border-amber-900/40 dark:bg-amber-900/10">
          <div className="border-b border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-900 dark:border-amber-900/40 dark:text-amber-200">
            충돌 {result.conflicts.length}건 (skip — 이미 등록된 키워드)
          </div>
          <p className="px-3 pt-1.5 text-[11px] text-muted-foreground">
            이미 등록된 키워드는 자동으로 추가되지 않습니다. 기존 키워드를
            수정하려면 키워드 목록에서 인라인 편집을 사용하세요.
          </p>
          <ul className="max-h-40 overflow-y-auto px-3 py-2 text-xs">
            {result.conflicts.map((c, i) => (
              <li
                key={`${c.keyword}-${c.matchType}-${i}`}
                className="border-b border-amber-200/60 py-1 last:border-0 dark:border-amber-900/30"
              >
                <span className="font-mono text-foreground">{c.keyword}</span>
                <span className="ml-2 text-muted-foreground">
                  · {c.matchType}
                </span>
                <span className="ml-2 text-muted-foreground">
                  · 이미 존재 ({c.existingNccKeywordId})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 성공만 (실패·충돌 X) */}
      {anySuccess && failedItems.length === 0 && result.conflicts.length === 0 && (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-900/20 dark:text-emerald-300">
          키워드 {result.success.toLocaleString()}건이 추가되었습니다.
        </p>
      )}

      {/* 성공 일부 (실패 또는 충돌과 공존) */}
      {anySuccess &&
        (failedItems.length > 0 || result.conflicts.length > 0) && (
          <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-900/20 dark:text-emerald-300">
            키워드 {result.success.toLocaleString()}건이 추가되었습니다.
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
  accent?: "emerald" | "destructive" | "amber"
}) {
  const valueClass =
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
      <div className={`mt-0.5 font-mono text-lg font-medium ${valueClass}`}>
        {value}
      </div>
    </div>
  )
}
