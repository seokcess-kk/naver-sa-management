"use client"

/**
 * 비딩 정책 폼 모달 (F-11.1) — create / edit 단일 모달
 *
 * 흐름:
 *   - mode="create": 키워드 셀렉터 (검색 가능 list) + device + targetRank + maxBid/minBid + enabled
 *     device 변경 시 listKeywordsWithoutPolicy 재호출 (해당 device 정책이 없는 키워드만)
 *   - mode="edit": 키워드 / device 고정 (read-only) — 변경 가능 필드만 (targetRank, maxBid, minBid, enabled)
 *
 * 검증:
 *   - targetRank 1..10
 *   - maxBid >= minBid (둘 다 있을 때)
 *   - 키워드 미선택 (create) → 차단
 *
 * 구조 결정:
 *   - 내부 폼은 PolicyFormBody 로 분리. open 일 때만 mount → useState 초기값을 그대로
 *     사용하고 useEffect 내 setState 회피 (React 19 react-hooks/set-state-in-effect 준수).
 *   - mode / policy?.id 변경 시 key prop 으로 PolicyFormBody 강제 remount.
 *
 * 안전장치:
 *   - 키워드 셀렉터는 listKeywordsWithoutPolicy 결과 (광고주 한정 + device 정책 없음)
 *   - viewer 는 호출자(PolicyTableClient)가 모달 진입 자체를 차단
 *   - 제출 후 onDone 호출 → 호출자가 router.refresh
 *
 * SPEC 6.11 F-11.1 / 11.3.
 */

import * as React from "react"
import { toast } from "sonner"
import { CheckIcon, SearchIcon } from "lucide-react"

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
import { Checkbox } from "@/components/ui/checkbox"
import {
  createBiddingPolicy,
  updateBiddingPolicy,
  listKeywordsWithoutPolicy,
  type BiddingPolicyRow,
  type KeywordOption,
} from "@/app/(dashboard)/[advertiserId]/bidding-policies/actions"

type Mode = "create" | "edit"
type Device = "PC" | "MOBILE"

export function PolicyFormModal({
  advertiserId,
  mode,
  policy,
  open,
  onOpenChange,
  onDone,
}: {
  advertiserId: string
  mode: Mode
  policy: BiddingPolicyRow | null
  open: boolean
  onOpenChange: (o: boolean) => void
  /** 성공 후 모달 닫고 새로고침 */
  onDone: () => void
}) {
  // PolicyFormBody 는 open 일 때만 mount → 초기값을 useState 로 그대로 사용.
  // mode / policy.id 변경 시 key 변경으로 강제 remount → 폼 초기화.
  const bodyKey =
    mode === "edit" && policy ? `edit:${policy.id}` : "create"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "비딩 정책 추가" : "비딩 정책 편집"}
          </DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "키워드 + device 단위로 목표 노출 순위 정책을 등록합니다. 자동 조정 cron(F-11.2)이 매시간 본 정책을 기준으로 입찰가를 조정합니다."
              : "변경 가능 필드는 목표 순위 / maxBid / minBid / 활성 여부입니다. 키워드 / device 변경은 새 정책 추가 + 기존 삭제로 처리하세요."}
          </DialogDescription>
        </DialogHeader>

        {open && (
          <PolicyFormBody
            key={bodyKey}
            advertiserId={advertiserId}
            mode={mode}
            policy={policy}
            onCancel={() => onOpenChange(false)}
            onDone={onDone}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

// =============================================================================
// PolicyFormBody — 폼 본문 (open 시에만 mount)
// =============================================================================

function PolicyFormBody({
  advertiserId,
  mode,
  policy,
  onCancel,
  onDone,
}: {
  advertiserId: string
  mode: Mode
  policy: BiddingPolicyRow | null
  onCancel: () => void
  onDone: () => void
}) {
  // -- 폼 state — 초기값을 props 에서 직접 도출 (effect setState 회피) -------
  const [keywordId, setKeywordId] = React.useState<string>(
    mode === "edit" && policy ? policy.keywordId : "",
  )
  const [device, setDevice] = React.useState<Device>(
    mode === "edit" && policy ? policy.device : "PC",
  )
  const [targetRank, setTargetRank] = React.useState<string>(
    mode === "edit" && policy ? String(policy.targetRank) : "1",
  )
  const [maxBidInput, setMaxBidInput] = React.useState<string>(
    mode === "edit" && policy && policy.maxBid != null
      ? String(policy.maxBid)
      : "",
  )
  const [minBidInput, setMinBidInput] = React.useState<string>(
    mode === "edit" && policy && policy.minBid != null
      ? String(policy.minBid)
      : "",
  )
  const [enabled, setEnabled] = React.useState<boolean>(
    mode === "edit" && policy ? policy.enabled : true,
  )

  // -- create 전용: keyword 옵션 목록 -----------------------------------------
  const [keywordOptions, setKeywordOptions] = React.useState<KeywordOption[]>(
    [],
  )
  const [keywordSearch, setKeywordSearch] = React.useState<string>("")
  const [optionsLoading, setOptionsLoading] = React.useState<boolean>(
    mode === "create",
  )
  const [optionsError, setOptionsError] = React.useState<string | null>(null)

  const [submitting, setSubmitting] = React.useState<boolean>(false)

  // create 모드 — device 변경 시 keyword 옵션 재조회.
  //
  // setState 는 모두 promise 콜백(async 결과 도착 후)에서만 호출 — react-hooks/set-state-in-effect 준수.
  // 초기 loading 상태는 useState 초기값 (mode === "create") 으로 설정. device 변경 후 재로딩
  // 동안에는 기존 목록을 그대로 보여주는 trade-off (작은 list — UX 부담 없음).
  React.useEffect(() => {
    if (mode !== "create") return
    let cancelled = false
    void (async () => {
      try {
        const opts = await listKeywordsWithoutPolicy(advertiserId, device)
        if (cancelled) return
        setKeywordOptions(opts)
        setKeywordId((prev) =>
          prev !== "" && !opts.find((o) => o.id === prev) ? "" : prev,
        )
        setOptionsError(null)
      } catch (e) {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : String(e)
        setOptionsError(msg)
      } finally {
        if (cancelled) return
        setOptionsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [mode, advertiserId, device])

  // -- 검증 -------------------------------------------------------------------
  const targetRankNum = Number(targetRank)
  const targetRankValid =
    Number.isInteger(targetRankNum) &&
    targetRankNum >= 1 &&
    targetRankNum <= 10

  const maxBidNum = parseBid(maxBidInput)
  const minBidNum = parseBid(minBidInput)
  const maxBidValid = maxBidInput.trim() === "" || maxBidNum.ok
  const minBidValid = minBidInput.trim() === "" || minBidNum.ok
  const bidRangeValid =
    !maxBidNum.ok ||
    !minBidNum.ok ||
    (maxBidNum.value != null && minBidNum.value != null
      ? maxBidNum.value >= minBidNum.value
      : true)

  const keywordValid = mode === "edit" || keywordId !== ""
  const formValid =
    keywordValid &&
    targetRankValid &&
    maxBidValid &&
    minBidValid &&
    bidRangeValid

  // -- 검색 필터 (Combobox 가 없으니 input + list 조합) ----------------------
  const filteredOptions = React.useMemo(() => {
    if (mode !== "create") return keywordOptions
    const q = keywordSearch.trim().toLowerCase()
    if (q === "") return keywordOptions
    return keywordOptions.filter(
      (o) =>
        o.keyword.toLowerCase().includes(q) ||
        o.nccKeywordId.toLowerCase().includes(q),
    )
  }, [keywordOptions, keywordSearch, mode])

  // -- 제출 -------------------------------------------------------------------
  async function handleSubmit() {
    if (!formValid) return
    setSubmitting(true)
    try {
      if (mode === "create") {
        const res = await createBiddingPolicy({
          advertiserId,
          keywordId,
          device,
          targetRank: targetRankNum,
          maxBid: maxBidNum.value ?? null,
          minBid: minBidNum.value ?? null,
          enabled,
        })
        if (!res.ok) {
          toast.error(`정책 추가 실패: ${res.error}`)
          setSubmitting(false)
          return
        }
        toast.success("정책 추가됨")
        onDone()
      } else {
        if (!policy) {
          toast.error("편집 대상 누락")
          setSubmitting(false)
          return
        }
        // 변경된 필드만 patch — 백엔드도 부분 update 지원.
        const patch: Record<string, unknown> = {
          id: policy.id,
          advertiserId,
        }
        if (targetRankNum !== policy.targetRank)
          patch.targetRank = targetRankNum
        if ((maxBidNum.value ?? null) !== policy.maxBid)
          patch.maxBid = maxBidNum.value ?? null
        if ((minBidNum.value ?? null) !== policy.minBid)
          patch.minBid = minBidNum.value ?? null
        if (enabled !== policy.enabled) patch.enabled = enabled

        // 변경 없음 — 무해 종료
        if (Object.keys(patch).length <= 2) {
          toast.message("변경 사항 없음")
          onDone()
          return
        }

        const res = await updateBiddingPolicy(
          patch as Parameters<typeof updateBiddingPolicy>[0],
        )
        if (!res.ok) {
          toast.error(`정책 수정 실패: ${res.error}`)
          setSubmitting(false)
          return
        }
        toast.success("정책 수정됨")
        onDone()
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`오류: ${msg}`)
      setSubmitting(false)
    }
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        {/* 키워드 — create 만 셀렉터, edit 은 read-only */}
        {mode === "create" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="policy-keyword-search">키워드</Label>
            <div className="relative">
              <SearchIcon className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="policy-keyword-search"
                value={keywordSearch}
                onChange={(e) => setKeywordSearch(e.target.value)}
                placeholder={
                  optionsLoading ? "키워드 불러오는 중..." : "키워드 검색"
                }
                className="pl-7"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            {optionsError && (
              <p className="text-[11px] text-destructive">
                키워드 목록 조회 실패: {optionsError}
              </p>
            )}
            <div className="max-h-48 overflow-y-auto rounded-md border bg-background">
              {optionsLoading ? (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  불러오는 중...
                </div>
              ) : filteredOptions.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  {keywordOptions.length === 0
                    ? `${device} 에 대해 정책이 없는 키워드가 없습니다`
                    : "검색 결과가 없습니다"}
                </div>
              ) : (
                <ul>
                  {filteredOptions.slice(0, 200).map((o) => {
                    const selected = o.id === keywordId
                    return (
                      <li key={o.id}>
                        <button
                          type="button"
                          onClick={() => setKeywordId(o.id)}
                          className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted ${
                            selected ? "bg-muted" : ""
                          }`}
                        >
                          <div className="flex min-w-0 flex-col">
                            <span className="truncate font-medium">
                              {o.keyword}
                            </span>
                            <span className="truncate text-[10px] text-muted-foreground">
                              {o.adgroupName} · {o.nccKeywordId}
                            </span>
                          </div>
                          {selected && (
                            <CheckIcon className="size-3.5 shrink-0 text-emerald-600" />
                          )}
                        </button>
                      </li>
                    )
                  })}
                  {filteredOptions.length > 200 && (
                    <li className="border-t px-3 py-1.5 text-[10px] text-muted-foreground">
                      ... 결과 {filteredOptions.length}건 중 200건 표시. 검색
                      키워드를 더 좁혀주세요.
                    </li>
                  )}
                </ul>
              )}
            </div>
            {keywordId === "" && (
              <p className="text-[11px] text-muted-foreground">
                키워드를 선택하세요.
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Label className="text-sm">키워드</Label>
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <div className="font-medium">{policy?.keyword ?? "—"}</div>
              <div className="text-[11px] text-muted-foreground">
                {policy?.campaignName} / {policy?.adgroupName} ·{" "}
                {policy?.nccKeywordId}
              </div>
            </div>
          </div>
        )}

        {/* device */}
        <div className="flex flex-col gap-1.5">
          <Label className="text-sm">device</Label>
          {mode === "create" ? (
            <div className="flex items-center gap-4">
              {(["PC", "MOBILE"] as const).map((d) => (
                <Label
                  key={d}
                  className="flex cursor-pointer items-center gap-2 text-sm font-normal"
                >
                  <input
                    type="radio"
                    name="policy-device"
                    checked={device === d}
                    onChange={() => setDevice(d)}
                  />
                  {d}
                </Label>
              ))}
            </div>
          ) : (
            <div className="rounded-md border bg-muted/30 px-3 py-1.5 text-sm">
              {device}{" "}
              <span className="text-[11px] text-muted-foreground">
                (변경 불가)
              </span>
            </div>
          )}
        </div>

        {/* targetRank */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="policy-targetRank" className="text-sm">
            목표 노출 순위 (1~10)
          </Label>
          <Input
            id="policy-targetRank"
            type="number"
            inputMode="numeric"
            min={1}
            max={10}
            step={1}
            value={targetRank}
            onChange={(e) => setTargetRank(e.target.value)}
            className="w-32"
            aria-invalid={!targetRankValid && targetRank.trim() !== ""}
          />
          {!targetRankValid && targetRank.trim() !== "" && (
            <p className="text-[11px] text-destructive">
              1~10 사이 정수를 입력하세요.
            </p>
          )}
        </div>

        {/* maxBid / minBid */}
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="policy-maxBid" className="text-sm">
              maxBid (원, 빈값=미제한)
            </Label>
            <Input
              id="policy-maxBid"
              type="number"
              inputMode="numeric"
              min={0}
              step={10}
              value={maxBidInput}
              onChange={(e) => setMaxBidInput(e.target.value)}
              placeholder="예: 5000"
              aria-invalid={!maxBidValid}
            />
            {!maxBidValid && (
              <p className="text-[11px] text-destructive">
                양의 정수만 가능합니다.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="policy-minBid" className="text-sm">
              minBid (원, 빈값=미제한)
            </Label>
            <Input
              id="policy-minBid"
              type="number"
              inputMode="numeric"
              min={0}
              step={10}
              value={minBidInput}
              onChange={(e) => setMinBidInput(e.target.value)}
              placeholder="예: 500"
              aria-invalid={!minBidValid || !bidRangeValid}
            />
            {!minBidValid && (
              <p className="text-[11px] text-destructive">
                양의 정수만 가능합니다.
              </p>
            )}
          </div>
        </div>
        {!bidRangeValid && (
          <p className="-mt-2 text-[11px] text-destructive">
            maxBid 는 minBid 이상이어야 합니다.
          </p>
        )}

        {/* enabled */}
        <Label className="flex cursor-pointer items-center gap-2 text-sm font-normal">
          <Checkbox
            checked={enabled}
            onCheckedChange={(v) => setEnabled(!!v)}
          />
          정책 활성화 (자동 조정 대상)
        </Label>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={submitting}>
          취소
        </Button>
        <Button onClick={handleSubmit} disabled={!formValid || submitting}>
          {submitting
            ? mode === "create"
              ? "추가 중..."
              : "저장 중..."
            : mode === "create"
              ? "추가"
              : "저장"}
        </Button>
      </DialogFooter>
    </>
  )
}

// =============================================================================
// 입찰가 파서
// =============================================================================
//   - 빈값 → ok=true, value=null (미제한)
//   - 정수 양수 → ok=true, value=number
//   - 그 외 → ok=false

function parseBid(input: string): { ok: boolean; value: number | null } {
  const t = input.trim()
  if (t === "") return { ok: true, value: null }
  const n = Number(t)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return { ok: false, value: null }
  }
  return { ok: true, value: n }
}
