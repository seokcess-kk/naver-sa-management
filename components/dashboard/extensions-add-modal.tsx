"use client"

/**
 * 확장소재 추가 모달 (F-5.4) — 광고그룹 N × 텍스트 M 일괄 생성
 *
 * KeywordsAddModal / AdsAddModal 패턴 응용.
 *
 * 흐름 (3단계 상태 머신):
 *   1. form        — 타입(headline/description) + 광고그룹(다중) + 텍스트(textarea, 줄당 1개)
 *                    "추가하기 (N×M건)" → submitting
 *   2. submitting  — 스피너 + 진행 안내. createAdExtensionsBatch 호출
 *                    throw → form 복귀 + toast.error
 *   3. result      — 카운트 카드 (요청 / 성공 / 실패) + 변경 ID + 클립보드 복사
 *                    실패 항목 분리 노출
 *                    "닫고 새로고침" → onClosed(true) → router.refresh
 *
 * 입력 검증 (클라이언트 + 백엔드 superRefine 이중):
 *   - 타입(radio): headline / description 단일 선택
 *   - 광고그룹: 1~50개 (체크박스 리스트, 다중)
 *   - 텍스트: 줄별 split → trim → 빈 줄 제외 → 길이 검증 → dedup
 *     · headline: 15자 이내
 *     · description: 45자 이내
 *     · 1~20개
 *   - 총 생성 N×M: 광고그룹 수 × 텍스트 수 미리보기 표시
 *
 * 안전장치:
 *   - hasKeys=false / 광고그룹 0개 → 호출자(ExtensionsTable)에서 모달 진입 차단
 *   - 길이 초과 행 빨간 표시 + 차단
 *   - 광고그룹 체크박스 리스트는 50개 상한 검증 (Zod .max(50) 일치)
 *
 * 폼 라이브러리:
 *   useState — 4개 필드(type, selectedAdgroups, textsRaw, etc.) + 동기 검증.
 *   다른 모달 (KeywordsAddModal / AdsAddModal) 일관성 유지.
 *
 * SPEC 6.2 F-5.4.
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
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import {
  createAdExtensionsBatch,
  type CreateAdExtensionsBatchResult,
} from "@/app/(dashboard)/[advertiserId]/extensions/actions"

// =============================================================================
// 타입
// =============================================================================

/** 광고주 한정 광고그룹 옵션 (RSC 조회 결과). */
export type ExtensionAdgroupOption = {
  id: string
  nccAdgroupId: string
  name: string
  campaign: { id: string; name: string }
}

type Step = "form" | "submitting" | "result"
type ExtType = "headline" | "description"

// 입력 한도 — 백엔드 createExtensionsSchema 와 일치.
const MAX_ADGROUPS = 50
const MAX_TEXTS = 20
const HEADLINE_MAX = 15
const DESCRIPTION_MAX = 45

const TYPE_LIMITS: Record<ExtType, number> = {
  headline: HEADLINE_MAX,
  description: DESCRIPTION_MAX,
}

// =============================================================================
// 메인 컴포넌트
// =============================================================================

export function ExtensionsAddModal({
  advertiserId,
  adgroups,
  open,
  onOpenChange,
  onClosed,
}: {
  advertiserId: string
  adgroups: ExtensionAdgroupOption[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 모달 닫힌 직후 — didApply=true 면 호출자가 router.refresh */
  onClosed?: (didApply: boolean) => void
}) {
  const [step, setStep] = React.useState<Step>("form")
  const [result, setResult] =
    React.useState<CreateAdExtensionsBatchResult | null>(null)

  // -- 폼 state ---------------------------------------------------------------
  const [type, setType] = React.useState<ExtType>("headline")
  // 선택된 광고그룹 nccAdgroupId 집합 (체크박스 리스트).
  const [selectedAgIds, setSelectedAgIds] = React.useState<Set<string>>(
    new Set(),
  )
  // 광고그룹 검색 (목록이 길 수 있어 빠른 필터).
  const [agSearch, setAgSearch] = React.useState<string>("")
  // 텍스트 textarea (줄당 1개).
  const [textsRaw, setTextsRaw] = React.useState<string>("")

  // -- 광고그룹 검색 + 정렬 ---------------------------------------------------
  const filteredAdgroups = React.useMemo(() => {
    const q = agSearch.trim().toLowerCase()
    const arr = q
      ? adgroups.filter(
          (g) =>
            g.name.toLowerCase().includes(q) ||
            g.campaign.name.toLowerCase().includes(q),
        )
      : adgroups
    return [...arr].sort((a, b) => {
      const c = a.campaign.name.localeCompare(b.campaign.name, "ko")
      if (c !== 0) return c
      return a.name.localeCompare(b.name, "ko")
    })
  }, [adgroups, agSearch])

  // -- 텍스트 textarea 파싱 ---------------------------------------------------
  // 줄별 split → trim → 빈 줄 제외 → 길이 검증 → dedup.
  const parsed = React.useMemo(() => {
    const limit = TYPE_LIMITS[type]
    const lines = textsRaw.split(/\r?\n/)
    const validTexts: string[] = []
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
      if (t.length > limit) {
        tooLong.push(t)
        continue
      }
      if (seen.has(t)) {
        dupCount++
        continue
      }
      seen.add(t)
      validTexts.push(t)
    }
    return { validTexts, tooLong, dupCount, emptyLines }
  }, [textsRaw, type])

  // -- 검증 -------------------------------------------------------------------
  const adgroupCount = selectedAgIds.size
  const textCount = parsed.validTexts.length
  const overAgLimit = adgroupCount > MAX_ADGROUPS
  const overTextLimit = textCount > MAX_TEXTS
  const tooLongPresent = parsed.tooLong.length > 0

  const adgroupValid = adgroupCount >= 1 && !overAgLimit
  const textsValid = textCount >= 1 && !overTextLimit && !tooLongPresent
  const formValid = adgroupValid && textsValid

  const totalCombinations = adgroupCount * textCount

  // -- 광고그룹 선택 핸들 -----------------------------------------------------
  function toggleAdgroup(nccAdgroupId: string, checked: boolean) {
    setSelectedAgIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(nccAdgroupId)
      else next.delete(nccAdgroupId)
      return next
    })
  }
  function selectAllFiltered() {
    setSelectedAgIds((prev) => {
      const next = new Set(prev)
      for (const g of filteredAdgroups) next.add(g.nccAdgroupId)
      return next
    })
  }
  function clearAdgroups() {
    setSelectedAgIds(new Set())
  }

  // -- 제출 -------------------------------------------------------------------
  async function handleSubmit() {
    if (!formValid) return
    setStep("submitting")
    try {
      const res = await createAdExtensionsBatch(advertiserId, {
        type,
        texts: parsed.validTexts,
        nccAdgroupIds: Array.from(selectedAgIds),
      })
      setResult(res)
      setStep("result")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`확장소재 추가 오류: ${msg}`)
      setStep("form")
    }
  }

  // -- 닫기 -------------------------------------------------------------------
  function handleClose() {
    // result 단계 도달 시 새로고침 의미 있음 (성공/실패 무관).
    const didApply = step === "result"
    onOpenChange(false)
    onClosed?.(didApply)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>확장소재 추가</DialogTitle>
          <DialogDescription>
            {step === "form" &&
              "타입을 선택하고 적용할 광고그룹과 텍스트를 입력하세요. 광고그룹 N × 텍스트 M = N×M개의 확장소재가 생성됩니다."}
            {step === "submitting" &&
              "확장소재를 추가하고 있습니다. 잠시만 기다려주세요..."}
            {step === "result" && "확장소재 추가 결과를 확인하세요."}
          </DialogDescription>
        </DialogHeader>

        {step === "form" && (
          <FormView
            adgroups={adgroups}
            filteredAdgroups={filteredAdgroups}
            selectedAgIds={selectedAgIds}
            toggleAdgroup={toggleAdgroup}
            selectAllFiltered={selectAllFiltered}
            clearAdgroups={clearAdgroups}
            agSearch={agSearch}
            setAgSearch={setAgSearch}
            type={type}
            setType={(t) => {
              setType(t)
              // 타입 변경 시 dedup 결과가 바뀔 수 있으므로 사용자가 인지하도록 textarea 는 그대로 유지.
            }}
            textsRaw={textsRaw}
            setTextsRaw={setTextsRaw}
            parsed={parsed}
            adgroupCount={adgroupCount}
            textCount={textCount}
            totalCombinations={totalCombinations}
            overAgLimit={overAgLimit}
            overTextLimit={overTextLimit}
          />
        )}

        {step === "submitting" && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {totalCombinations}건 추가 중...
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
                {totalCombinations > 0 && ` (${totalCombinations}건)`}
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
  filteredAdgroups,
  selectedAgIds,
  toggleAdgroup,
  selectAllFiltered,
  clearAdgroups,
  agSearch,
  setAgSearch,
  type,
  setType,
  textsRaw,
  setTextsRaw,
  parsed,
  adgroupCount,
  textCount,
  totalCombinations,
  overAgLimit,
  overTextLimit,
}: {
  adgroups: ExtensionAdgroupOption[]
  filteredAdgroups: ExtensionAdgroupOption[]
  selectedAgIds: Set<string>
  toggleAdgroup: (nccAdgroupId: string, checked: boolean) => void
  selectAllFiltered: () => void
  clearAdgroups: () => void
  agSearch: string
  setAgSearch: (v: string) => void
  type: ExtType
  setType: (v: ExtType) => void
  textsRaw: string
  setTextsRaw: (v: string) => void
  parsed: {
    validTexts: string[]
    tooLong: string[]
    dupCount: number
    emptyLines: number
  }
  adgroupCount: number
  textCount: number
  totalCombinations: number
  overAgLimit: boolean
  overTextLimit: boolean
}) {
  const limit = TYPE_LIMITS[type]
  return (
    <div className="flex flex-col gap-4">
      {/* 타입 (radio) */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-sm">타입</Label>
        <div className="flex items-center gap-4">
          {(
            [
              { v: "headline" as const, label: "추가제목" },
              { v: "description" as const, label: "추가설명" },
            ]
          ).map((opt) => (
            <Label
              key={opt.v}
              className="flex cursor-pointer items-center gap-2 text-sm font-normal"
            >
              <input
                type="radio"
                name="extension-type"
                value={opt.v}
                checked={type === opt.v}
                onChange={() => setType(opt.v)}
                className="size-4 cursor-pointer"
              />
              {opt.label}
              <span className="text-[10px] text-muted-foreground">
                ({opt.v === "headline" ? HEADLINE_MAX : DESCRIPTION_MAX}자
                이내)
              </span>
            </Label>
          ))}
        </div>
      </div>

      {/* 광고그룹 다중 선택 */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-end justify-between">
          <Label className="text-sm">
            대상 광고그룹 (1~{MAX_ADGROUPS}개)
          </Label>
          <span className="text-[11px] text-muted-foreground">
            {adgroupCount.toLocaleString()}개 선택됨
            {overAgLimit && (
              <span className="ml-2 font-medium text-destructive">
                {MAX_ADGROUPS}개 초과
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={agSearch}
            onChange={(e) => setAgSearch(e.target.value)}
            placeholder="광고그룹 / 캠페인 이름 검색"
            className="h-8 flex-1 rounded-md border bg-background px-2 text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={selectAllFiltered}
            disabled={filteredAdgroups.length === 0}
            title={
              filteredAdgroups.length > MAX_ADGROUPS
                ? `검색 결과 ${filteredAdgroups.length}개 — ${MAX_ADGROUPS}개 상한 초과 가능`
                : undefined
            }
          >
            검색결과 전체 선택
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={clearAdgroups}
            disabled={adgroupCount === 0}
          >
            선택 해제
          </Button>
        </div>
        <div className="max-h-48 overflow-y-auto rounded-md border bg-background">
          {adgroups.length === 0 ? (
            <div className="flex h-16 items-center justify-center text-xs text-muted-foreground">
              사용 가능한 광고그룹이 없습니다.
            </div>
          ) : filteredAdgroups.length === 0 ? (
            <div className="flex h-16 items-center justify-center text-xs text-muted-foreground">
              검색 결과 없음.
            </div>
          ) : (
            <ul className="divide-y">
              {filteredAdgroups.map((g) => {
                const checked = selectedAgIds.has(g.nccAdgroupId)
                return (
                  <li key={g.id} className="px-2 py-1.5">
                    <Label className="flex cursor-pointer items-center gap-2 font-normal">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) =>
                          toggleAdgroup(g.nccAdgroupId, !!v)
                        }
                      />
                      <div className="flex flex-1 flex-col gap-0">
                        <span className="text-sm">{g.name}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {g.campaign.name}
                        </span>
                      </div>
                    </Label>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        {adgroupCount === 0 && (
          <p className="text-[11px] text-muted-foreground">
            광고그룹을 1개 이상 선택하세요.
          </p>
        )}
      </div>

      {/* 텍스트 textarea */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-end justify-between">
          <Label htmlFor="extension-texts" className="text-sm">
            텍스트 (줄당 1개, 1~{MAX_TEXTS}개 / 각 {limit}자 이내)
          </Label>
          <span className="text-[11px] text-muted-foreground">
            {textCount.toLocaleString()}개 유효
            {overTextLimit && (
              <span className="ml-2 font-medium text-destructive">
                {MAX_TEXTS}개 초과
              </span>
            )}
          </span>
        </div>
        <Textarea
          id="extension-texts"
          value={textsRaw}
          onChange={(e) => setTextsRaw(e.target.value)}
          placeholder={
            type === "headline"
              ? "예) 무료배송 / 신상품 50% 할인 / 회원가입 즉시 적립"
              : "예) 정품 무료배송, 회원가입 시 추가 5% 적립 / 한정 수량 — 오늘만 특가"
          }
          className="min-h-32 font-mono text-sm"
          aria-invalid={parsed.tooLong.length > 0 || overTextLimit}
        />
        {/* 검증 안내 */}
        {(parsed.tooLong.length > 0 ||
          parsed.dupCount > 0 ||
          parsed.emptyLines > 0) && (
          <div className="flex flex-col gap-0.5 text-[11px]">
            {parsed.tooLong.length > 0 && (
              <span className="text-destructive">
                {parsed.tooLong.length}개 줄이 {limit}자를 초과합니다 — 확정
                불가:
                <ul className="ml-3 mt-0.5 list-disc font-mono">
                  {parsed.tooLong.slice(0, 3).map((t, i) => (
                    <li key={i} className="truncate">
                      ({t.length}자) {t}
                    </li>
                  ))}
                  {parsed.tooLong.length > 3 && (
                    <li>...외 {parsed.tooLong.length - 3}개</li>
                  )}
                </ul>
              </span>
            )}
            {parsed.dupCount > 0 && (
              <span className="text-muted-foreground">
                중복 {parsed.dupCount}개 자동 제거됨 (해당 줄은 무시).
              </span>
            )}
            {parsed.emptyLines > 0 && (
              <span className="text-muted-foreground">
                빈 줄 {parsed.emptyLines}개 자동 제거됨.
              </span>
            )}
          </div>
        )}
        {textCount === 0 && parsed.tooLong.length === 0 && (
          <p className="text-[11px] text-muted-foreground">
            텍스트를 1개 이상 입력하세요.
          </p>
        )}
      </div>

      {/* 미리보기 — N × M 안내 */}
      <div className="rounded-md border bg-muted/40 px-3 py-2">
        <div className="text-[11px] font-medium text-muted-foreground">
          미리보기
        </div>
        <div className="mt-0.5 text-sm">
          광고그룹 <strong>{adgroupCount}</strong>개 × 텍스트{" "}
          <strong>{textCount}</strong>개 ={" "}
          <strong className="text-foreground">{totalCombinations}</strong>개의{" "}
          {type === "headline" ? "추가제목" : "추가설명"}이 생성됩니다.
        </div>
      </div>
    </div>
  )
}

// =============================================================================
// result 단계
// =============================================================================

function ResultView({ result }: { result: CreateAdExtensionsBatchResult }) {
  const noBatch = result.batchId === ""
  const failedItems = result.items.filter((it) => !it.ok)

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

      {/* 실패 항목 분리 노출 */}
      {failedItems.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
          <div className="text-xs font-medium text-destructive">
            실패 항목 ({failedItems.length}개)
          </div>
          <ul className="max-h-40 overflow-y-auto text-[11px] text-destructive">
            {failedItems.slice(0, 50).map((it) => (
              <li
                key={it.index}
                className="flex items-start gap-2 border-b border-destructive/10 py-1 last:border-b-0"
              >
                <span className="font-mono text-[10px] text-destructive/70">
                  #{it.index + 1}
                </span>
                <div className="flex flex-1 flex-col gap-0">
                  <span className="line-clamp-1 font-medium">{it.text}</span>
                  <span className="font-mono text-[10px] text-destructive/70">
                    nccAdgroupId: {it.ownerId}
                  </span>
                  <span className="text-destructive">
                    {it.error ?? "원인 미상"}
                  </span>
                </div>
              </li>
            ))}
            {failedItems.length > 50 && (
              <li className="py-1 text-[10px] text-destructive/70">
                ...외 {failedItems.length - 50}개 (전체는 변경 ID 로 조회)
              </li>
            )}
          </ul>
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
