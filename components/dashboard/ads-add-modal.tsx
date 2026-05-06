"use client"

/**
 * 소재 추가 모달 (F-4.6) — TEXT_45 단건 (P1 단순화)
 *
 * 흐름 (3단계 상태 머신 — KeywordsAddModal 패턴 응용):
 *   1. form        — 광고그룹 + adType + 소재 본문 입력 (TEXT_45 만)
 *                    "추가하기" → submitting
 *   2. submitting  — 스피너 + 진행 안내. createAdsBatch 호출
 *                    throw → form 복귀 + toast.error
 *   3. result      — 카운트 카드 (시도 / 성공 / 실패) + 변경 ID
 *                    실패 항목 노출 + 성공 시 nccAdId 노출
 *                    "닫고 새로고침" → onClosed(true) → router.refresh
 *
 * 본 PR 단순화:
 *   - **한 번에 1개 소재만** (동적 폼 복잡도 줄이기 위해)
 *   - **adType="TEXT_45" 만 지원**
 *     - 후속 PR 에서 adType 별 동적 fields + 다건 추가 + RSA_AD 등 보강
 *
 * TEXT_45 fields (네이버 SA sample 기준):
 *   - headline    : 제목 (45자 — adType 명칭 유래)
 *   - description : 설명 (45자)
 *   - pc.final    : PC 랜딩 URL (필수)
 *   - mobile.final: 모바일 랜딩 URL (선택 — 비우면 PC 와 동일 사용 정책은 SA 측)
 *
 * 입력 검증 (클라이언트):
 *   - 광고그룹 미선택 → 차단
 *   - headline / description / pc.final 빈값 → 차단
 *   - URL 형식: 매우 엄격 X — http(s):// 시작 정도만 안내 (백엔드/SA 가 최종 검증)
 *
 * 안전장치 (KeywordsAddModal 패턴 준수):
 *   - hasKeys=false / 광고그룹 0개 → 호출자(AdsTable) 측에서 모달 진입 차단
 *   - 폼 자체가 "미리보기 전 단계" — 사용자 명시 클릭으로만 호출
 *
 * 폼 라이브러리:
 *   useState — 단순 입력 5개 + 동기 검증만 필요해 react-hook-form 비용 대비 가치 낮음.
 *   본 코드베이스 다른 모달 (KeywordsAddModal / AdsDeleteModal) 도 동일 패턴.
 *
 * SPEC 6.2 F-4.6.
 */

import * as React from "react"
import { toast } from "sonner"
import { CopyIcon, AlertTriangleIcon, InfoIcon } from "lucide-react"

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
  createAdsBatch,
  type CreateAdsBatchResult,
} from "@/app/(dashboard)/[advertiserId]/ads/actions"
import {
  lintCopyFields,
  hasBlockingIssues,
  type LintIssue,
  type LintIndustry,
} from "@/lib/copy-policy/lint"

// =============================================================================
// 타입
// =============================================================================

/** 광고주 한정 광고그룹 옵션 (RSC 조회 결과). */
export type AdAdgroupOption = {
  id: string
  nccAdgroupId: string
  name: string
  campaign: { id: string; name: string }
}

type Step = "form" | "submitting" | "result"

// 본 PR 단순화 — TEXT_45 만. 후속 PR 에서 RSA_AD 등 추가 + 동적 fields.
type AdType = "TEXT_45"

// TEXT_45 입력 한도 (네이버 SA 기준).
const HEADLINE_MAX = 45
const DESCRIPTION_MAX = 45

// =============================================================================
// 메인 컴포넌트
// =============================================================================

export function AdsAddModal({
  advertiserId,
  adgroups,
  open,
  onOpenChange,
  onClosed,
}: {
  advertiserId: string
  adgroups: AdAdgroupOption[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 모달 닫힌 직후 — didApply=true 면 호출자가 router.refresh */
  onClosed?: (didApply: boolean) => void
}) {
  const [step, setStep] = React.useState<Step>("form")
  const [result, setResult] = React.useState<CreateAdsBatchResult | null>(null)

  // -- 폼 state ---------------------------------------------------------------
  const [nccAdgroupId, setNccAdgroupId] = React.useState<string>("")
  const [adType] = React.useState<AdType>("TEXT_45") // 본 PR 고정
  const [headline, setHeadline] = React.useState<string>("")
  const [description, setDescription] = React.useState<string>("")
  const [pcFinal, setPcFinal] = React.useState<string>("")
  const [mobileFinal, setMobileFinal] = React.useState<string>("")
  // userLock — UI 는 "시작 ON/OFF" (사용자 친화). 내부적으로 userLock 매핑:
  //   ON  → userLock=false / OFF → userLock=true
  const [startOn, setStartOn] = React.useState<boolean>(true)

  // -- copy-policy lint state ------------------------------------------------
  // industry: 광고주 업종 — lint 룰 분기. 기본 'general'.
  // lintIssues: 제출 시점에 채워짐. error severity 1건+ 차단, warn 은 confirm.
  const [industry, setIndustry] = React.useState<LintIndustry>("general")
  const [lintIssues, setLintIssues] = React.useState<
    Array<LintIssue & { field: string }>
  >([])

  // -- 입력 검증 -------------------------------------------------------------
  const trimmedHead = headline.trim()
  const trimmedDesc = description.trim()
  const trimmedPc = pcFinal.trim()
  const trimmedMobile = mobileFinal.trim()

  const headlineValid =
    trimmedHead.length > 0 && trimmedHead.length <= HEADLINE_MAX
  const descriptionValid =
    trimmedDesc.length > 0 && trimmedDesc.length <= DESCRIPTION_MAX
  // 단순한 형식 검증 — http(s):// 시작 정도만. 정밀 검증은 백엔드/SA 책임.
  const isLikelyUrl = (v: string) => /^https?:\/\//i.test(v)
  const pcValid = trimmedPc.length > 0 && isLikelyUrl(trimmedPc)
  const mobileValid = trimmedMobile.length === 0 || isLikelyUrl(trimmedMobile)

  const adgroupValid = nccAdgroupId !== ""
  const formValid =
    adgroupValid && headlineValid && descriptionValid && pcValid && mobileValid

  // -- 제출 -------------------------------------------------------------------
  async function handleSubmit() {
    if (!formValid) return

    // 1. copy-policy lint 검사 — headline / description (URL 은 정책 lint 무관)
    const fields = { headline: trimmedHead, description: trimmedDesc }
    const issues = lintCopyFields(fields, industry)
    setLintIssues(issues)

    // 2. error severity 1건+ → 등록 차단
    if (hasBlockingIssues(issues)) {
      toast.error("표현 검수 룰 위반 — 본문을 수정 후 다시 시도하세요.")
      return
    }

    // 3. warn severity 1건+ → 사용자 확인 (계속 진행 여부)
    const warnings = issues.filter((i) => i.severity === "warn")
    if (warnings.length > 0) {
      const ok = window.confirm(
        `경고 ${warnings.length}건 — ${warnings
          .map((w) => w.match)
          .join(", ")}. 계속 등록하시겠어요?`,
      )
      if (!ok) return
    }

    setStep("submitting")
    try {
      // TEXT_45 ad 본문 — 네이버 SA sample 기준 구조.
      // mobile.final 빈값이면 키 자체 제외 (SA 가 PC fallback 처리).
      const adFields: Record<string, unknown> = {
        headline: trimmedHead,
        description: trimmedDesc,
        pc: { final: trimmedPc },
      }
      if (trimmedMobile.length > 0) {
        adFields.mobile = { final: trimmedMobile }
      }

      const res = await createAdsBatch(advertiserId, {
        nccAdgroupId,
        adType,
        ads: [{ ad: adFields }],
        userLock: !startOn,
      })
      setResult(res)
      setStep("result")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`소재 추가 오류: ${msg}`)
      setStep("form")
    }
  }

  // -- 닫기 -------------------------------------------------------------------
  function handleClose() {
    // result 단계 도달 시 → 새로고침 의미 있음 (성공/실패 무관 — 사용자 인지 후 닫기).
    const didApply = step === "result"
    onOpenChange(false)
    onClosed?.(didApply)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>소재 추가</DialogTitle>
          <DialogDescription>
            {step === "form" &&
              "광고그룹을 선택하고 소재 본문을 입력하세요. 본 화면은 TEXT_45 단일 소재만 지원합니다 (다건·다른 타입은 후속 PR)."}
            {step === "submitting" &&
              "소재를 추가하고 있습니다. 잠시만 기다려주세요..."}
            {step === "result" && "소재 추가 결과를 확인하세요."}
          </DialogDescription>
        </DialogHeader>

        {step === "form" && (
          <FormView
            adgroups={adgroups}
            nccAdgroupId={nccAdgroupId}
            setNccAdgroupId={setNccAdgroupId}
            adType={adType}
            headline={headline}
            setHeadline={setHeadline}
            description={description}
            setDescription={setDescription}
            pcFinal={pcFinal}
            setPcFinal={setPcFinal}
            mobileFinal={mobileFinal}
            setMobileFinal={setMobileFinal}
            startOn={startOn}
            setStartOn={setStartOn}
            industry={industry}
            setIndustry={setIndustry}
            lintIssues={lintIssues}
            headlineValid={headlineValid}
            descriptionValid={descriptionValid}
            pcValid={pcValid}
            mobileValid={mobileValid}
          />
        )}

        {step === "submitting" && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            소재 1건 추가 중...
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
  adType,
  headline,
  setHeadline,
  description,
  setDescription,
  pcFinal,
  setPcFinal,
  mobileFinal,
  setMobileFinal,
  startOn,
  setStartOn,
  industry,
  setIndustry,
  lintIssues,
  headlineValid,
  descriptionValid,
  pcValid,
  mobileValid,
}: {
  adgroups: AdAdgroupOption[]
  nccAdgroupId: string
  setNccAdgroupId: (v: string) => void
  adType: AdType
  headline: string
  setHeadline: (v: string) => void
  description: string
  setDescription: (v: string) => void
  pcFinal: string
  setPcFinal: (v: string) => void
  mobileFinal: string
  setMobileFinal: (v: string) => void
  startOn: boolean
  setStartOn: (v: boolean) => void
  industry: LintIndustry
  setIndustry: (v: LintIndustry) => void
  lintIssues: Array<LintIssue & { field: string }>
  headlineValid: boolean
  descriptionValid: boolean
  pcValid: boolean
  mobileValid: boolean
}) {
  const errorIssues = lintIssues.filter((i) => i.severity === "error")
  const warnIssues = lintIssues.filter((i) => i.severity === "warn")
  return (
    <div className="flex flex-col gap-4">
      {/* 광고그룹 */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ad-adgroup-select">광고그룹</Label>
        <Select
          value={nccAdgroupId}
          onValueChange={(v) => setNccAdgroupId(v ?? "")}
        >
          <SelectTrigger id="ad-adgroup-select">
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

      {/* 업종 (lint 룰 적용) — copy-policy 검사용 */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ad-industry-select">업종 (lint 룰 적용)</Label>
        <Select
          value={industry}
          onValueChange={(v) => setIndustry((v ?? "general") as LintIndustry)}
        >
          <SelectTrigger id="ad-industry-select">
            <SelectValue placeholder="업종을 선택하세요" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="general">일반</SelectItem>
            <SelectItem value="medical">의료</SelectItem>
            <SelectItem value="finance">금융</SelectItem>
            <SelectItem value="health_food">건강기능식품</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">
          업종에 따라 표현 검수 룰이 추가 적용됩니다.
        </p>
      </div>

      {/* 소재 타입 — 본 PR 고정 (TEXT_45) */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-sm">소재 타입</Label>
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <span className="font-mono">{adType}</span>
          <span className="ml-2 text-xs text-muted-foreground">
            (본 화면은 TEXT_45 만 지원 — 후속 PR 에서 RSA_AD 등 추가)
          </span>
        </div>
      </div>

      {/* 제목 (headline) */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ad-headline">
          제목 (headline, 1~{HEADLINE_MAX}자)
        </Label>
        <Input
          id="ad-headline"
          value={headline}
          onChange={(e) => setHeadline(e.target.value)}
          maxLength={HEADLINE_MAX + 10}
          placeholder="예: 신발 50% 할인 — 오늘만"
          aria-invalid={!headlineValid && headline.trim() !== ""}
        />
        <div className="flex items-center justify-between text-[11px]">
          <span
            className={
              !headlineValid && headline.trim() !== ""
                ? "text-destructive"
                : "text-muted-foreground"
            }
          >
            {headline.trim().length === 0
              ? "제목을 입력하세요."
              : headline.trim().length > HEADLINE_MAX
                ? `${HEADLINE_MAX}자 초과`
                : ""}
          </span>
          <span className="text-muted-foreground">
            {headline.trim().length} / {HEADLINE_MAX}
          </span>
        </div>
      </div>

      {/* 설명 (description) */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ad-description">
          설명 (description, 1~{DESCRIPTION_MAX}자)
        </Label>
        <Textarea
          id="ad-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={DESCRIPTION_MAX + 10}
          placeholder="예: 정품 무료배송, 회원가입 시 추가 5% 즉시할인"
          className="min-h-20"
          aria-invalid={!descriptionValid && description.trim() !== ""}
        />
        <div className="flex items-center justify-between text-[11px]">
          <span
            className={
              !descriptionValid && description.trim() !== ""
                ? "text-destructive"
                : "text-muted-foreground"
            }
          >
            {description.trim().length === 0
              ? "설명을 입력하세요."
              : description.trim().length > DESCRIPTION_MAX
                ? `${DESCRIPTION_MAX}자 초과`
                : ""}
          </span>
          <span className="text-muted-foreground">
            {description.trim().length} / {DESCRIPTION_MAX}
          </span>
        </div>
      </div>

      {/* PC 랜딩 URL */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ad-pc-final">PC 랜딩 URL (pc.final)</Label>
        <Input
          id="ad-pc-final"
          type="url"
          value={pcFinal}
          onChange={(e) => setPcFinal(e.target.value)}
          placeholder="https://example.com/landing"
          aria-invalid={!pcValid && pcFinal.trim() !== ""}
        />
        {!pcValid && pcFinal.trim() !== "" && (
          <p className="text-[11px] text-destructive">
            http:// 또는 https:// 로 시작하는 URL 을 입력하세요.
          </p>
        )}
        {pcFinal.trim() === "" && (
          <p className="text-[11px] text-muted-foreground">
            PC 랜딩 URL 은 필수입니다.
          </p>
        )}
      </div>

      {/* 모바일 랜딩 URL */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ad-mobile-final">
          모바일 랜딩 URL (mobile.final, 선택)
        </Label>
        <Input
          id="ad-mobile-final"
          type="url"
          value={mobileFinal}
          onChange={(e) => setMobileFinal(e.target.value)}
          placeholder="https://m.example.com/landing"
          aria-invalid={!mobileValid && mobileFinal.trim() !== ""}
        />
        {!mobileValid && mobileFinal.trim() !== "" && (
          <p className="text-[11px] text-destructive">
            http:// 또는 https:// 로 시작하는 URL 을 입력하세요.
          </p>
        )}
        {mobileFinal.trim() === "" && (
          <p className="text-[11px] text-muted-foreground">
            비우면 PC 랜딩이 모바일에도 사용될 수 있습니다 (SA 정책).
          </p>
        )}
      </div>

      {/* 시작 상태 */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-sm">시작 상태</Label>
        <Label className="flex cursor-pointer items-center gap-2 text-sm font-normal">
          <Checkbox
            checked={startOn}
            onCheckedChange={(v) => setStartOn(!!v)}
          />
          ON 으로 시작 (체크 해제 시 OFF)
        </Label>
      </div>

      {/* 표현 검수 lint 결과 — submit 시 채워짐. error 차단 / warn 경고 */}
      {lintIssues.length > 0 && (
        <div className="flex flex-col gap-2">
          {errorIssues.length > 0 && (
            <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
              <div className="flex items-center gap-1.5 text-sm font-medium text-destructive">
                <AlertTriangleIcon className="size-4" />
                표현 검수 룰 위반 ({errorIssues.length}건) — 수정 후 다시 시도
              </div>
              <ul className="mt-2 flex flex-col gap-1 text-xs text-destructive">
                {errorIssues.map((i, idx) => (
                  <li
                    key={`err-${idx}-${i.ruleId}`}
                    className="flex flex-wrap items-baseline gap-1"
                  >
                    <code className="rounded bg-destructive/10 px-1 font-mono text-[10px]">
                      [{i.field}]
                    </code>
                    <code className="rounded bg-destructive/10 px-1 font-mono text-[10px]">
                      {i.match}
                    </code>
                    <span>→ {i.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {warnIssues.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900/40 dark:bg-amber-900/10">
              <div className="flex items-center gap-1.5 text-sm font-medium text-amber-900 dark:text-amber-300">
                <InfoIcon className="size-4" />
                경고 ({warnIssues.length}건) — 등록 시 확인 필요
              </div>
              <ul className="mt-2 flex flex-col gap-1 text-xs text-amber-900 dark:text-amber-300">
                {warnIssues.map((i, idx) => (
                  <li
                    key={`warn-${idx}-${i.ruleId}`}
                    className="flex flex-wrap items-baseline gap-1"
                  >
                    <code className="rounded bg-amber-200/40 px-1 font-mono text-[10px]">
                      [{i.field}]
                    </code>
                    <code className="rounded bg-amber-200/40 px-1 font-mono text-[10px]">
                      {i.match}
                    </code>
                    <span>→ {i.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// =============================================================================
// result 단계
// =============================================================================

function ResultView({ result }: { result: CreateAdsBatchResult }) {
  // 본 PR 은 단일 소재만 — items[0] 만 의미. 후속 PR 에서 다건 시 리스트 표기.
  const item0 = result.items[0]
  const noBatch = result.batchId === ""

  function copyBatchId() {
    if (noBatch) return
    navigator.clipboard
      .writeText(result.batchId)
      .then(() => toast.success("변경 ID 복사됨"))
      .catch(() => toast.error("복사 실패"))
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 카운트 카드 */}
      <div className="grid grid-cols-3 gap-2">
        <Stat label="요청" value={result.total} />
        <Stat label="성공" value={result.success} accent="emerald" />
        <Stat label="실패" value={result.failed} accent="destructive" />
      </div>

      {/* 단건 결과 — nccAdId 또는 에러 */}
      {item0 && item0.ok && item0.nccAdId && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-900/10 dark:text-emerald-300">
          <div className="font-medium">소재 생성 완료</div>
          <div className="mt-0.5 font-mono text-[11px] text-emerald-800 dark:text-emerald-400">
            nccAdId: {item0.nccAdId}
          </div>
        </div>
      )}
      {item0 && !item0.ok && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <div className="font-medium">소재 생성 실패</div>
          <div className="mt-1 text-xs">{item0.error ?? "원인 미상"}</div>
        </div>
      )}

      {/* 변경 ID 영역 */}
      {noBatch ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/10 dark:text-amber-300">
          변경 없음 — 변경 사항 없음.
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
            롤백 페이지(F-6.4)에서 본 ID 로 변경 이력을 조회할 수 있습니다.
          </p>
        </>
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
