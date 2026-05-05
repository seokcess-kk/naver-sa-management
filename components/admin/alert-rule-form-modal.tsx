"use client"

/**
 * 알림 룰 생성 / 편집 모달 (F-8.x)
 *
 * 모드:
 *   - 신규: rule=null + open=true → type select 가능, 모든 필드 빈 값으로 시작
 *   - 편집: rule!=null + open=true → type 변경 비허용 (스펙 — 새로 만들고 기존 삭제 권장)
 *
 * params shape:
 *   - 공통: advertiserId 필수 (모델에 advertiserId 컬럼이 없어 params 에 저장)
 *   - budget_burn: thresholds (50/80/100% 기본, 멀티 체크박스)
 *   - bizmoney_low: days (기본 3)
 *   - api_auth_error / inspect_rejected: 추가 입력 X
 *   - cpc_surge: thresholdPct(5..500, 기본 50) + minClicks(10..10000, 기본 100)
 *   - impressions_drop: thresholdPct(5..100, 기본 50) + minImpressions(100..1000000, 기본 1000)
 *   - budget_pace: deviationPct(5..100, 기본 30) + minHour(1..23, 기본 6)
 *
 * 안전장치:
 *   - thresholds 1개 이상 필수
 *   - days 1..30 범위
 *   - 광고주 셀렉트 비어있으면 제출 차단
 *   - 신규 3종 type 별 Zod 범위와 동일하게 클라이언트 사전 검증
 */

import * as React from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  createAlertRule,
  updateAlertRule,
  type AlertRuleRow,
  type AlertRuleType,
} from "@/app/admin/alert-rules/actions"

// =============================================================================
// 상수 / 헬퍼
// =============================================================================

const ALERT_TYPES: { value: AlertRuleType; label: string; description: string }[] = [
  {
    value: "budget_burn",
    label: "예산 소진 (budget_burn)",
    description: "캠페인 일 예산 소진 임계 (기본 50/80/100%)",
  },
  {
    value: "bizmoney_low",
    label: "비즈머니 부족 (bizmoney_low)",
    description: "비즈머니 잔액이 활성 캠페인 N일치 일 예산 합 미만",
  },
  {
    value: "api_auth_error",
    label: "API 인증 실패 (api_auth_error)",
    description: "SA API 호출 인증/권한 실패",
  },
  {
    value: "inspect_rejected",
    label: "검수 거절 (inspect_rejected)",
    description: "최근 N분 내 거절된 키워드/소재/확장소재",
  },
  {
    value: "cpc_surge",
    label: "CPC 급등 (cpc_surge)",
    description: "캠페인별 7일 평균 CPC 대비 오늘 CPC가 N% 이상 상승 (기본 +50%)",
  },
  {
    value: "impressions_drop",
    label: "노출 급감 (impressions_drop)",
    description: "7일 평균 시간당 노출 대비 오늘 노출이 N% 이상 감소 (기본 -50%)",
  },
  {
    value: "budget_pace",
    label: "예산 페이스 이상 (budget_pace)",
    description: "현재 시각 기준 예상 페이스 대비 N%p 이상 초과 소진 (기본 +30%p)",
  },
  {
    value: "rank_deviation",
    label: "목표 순위 이탈 (rank_deviation)",
    description:
      "BiddingPolicy 등록 키워드의 평균 노출 순위가 목표 ±N에서 벗어남 (기본 ±2)",
  },
  {
    value: "mobile_first_page",
    label: "모바일 첫 페이지 이탈 (mobile_first_page)",
    description:
      "평균 순위 임계(기본 5위) 초과 + 7일 클릭 표본(기본 50) 충분한 키워드. 강한 신호로만 사용",
  },
  {
    value: "optimization_summary",
    label: "자동 비딩 일일 요약 (optimization_summary)",
    description:
      "어제(KST) OptimizationRun 결과 집계. 매일 dailyHourKst(기본 9시) 1회 발송",
  },
  {
    value: "suggestion_inbox",
    label: "Inbox 권고 누적 (suggestion_inbox)",
    description:
      "최근 N시간(기본 24h) 내 신규 BidSuggestion이 임계(기본 5) 이상이면 알림",
  },
  {
    value: "quality_stagnation",
    label: "품질지수 정체 (quality_stagnation)",
    description:
      "Keyword.qualityScore 7/14/30일 정체 단계별 알림 (기본 4/5/6 미만)",
  },
  {
    value: "budget_pacing",
    label: "어제 예산 100% 도달 (budget_pacing)",
    description:
      "어제(KST) 일예산 100% 이상 소진 캠페인 카운트. 광고주 단위 1일 1건 일일 요약",
  },
  {
    value: "llm_daily_summary",
    label: "일일 운영 요약 (llm_daily_summary)",
    description:
      "매일 KST 09:00 LLM(Sonnet)이 어제 운영 결과(자동 비딩/Inbox/알림)를 1단락 요약. ANTHROPIC_API_KEY 없으면 정형 텍스트 폴백",
  },
]

const DEFAULT_THRESHOLDS = [50, 80, 100]
const ALL_THRESHOLD_OPTIONS = [50, 80, 100, 150]

type ParamsShape = {
  advertiserId: string
  // budget_burn
  thresholds: number[]
  // bizmoney_low
  days: number
  // cpc_surge
  cpcThresholdPct: number
  cpcMinClicks: number
  // impressions_drop
  impDropThresholdPct: number
  impMinImpressions: number
  // budget_pace
  paceDeviationPct: number
  paceMinHour: number
}

const INITIAL_PARAMS: ParamsShape = {
  advertiserId: "",
  thresholds: DEFAULT_THRESHOLDS,
  days: 3,
  cpcThresholdPct: 50,
  cpcMinClicks: 100,
  impDropThresholdPct: 50,
  impMinImpressions: 1000,
  paceDeviationPct: 30,
  paceMinHour: 6,
}

function rowToParams(rule: AlertRuleRow): ParamsShape {
  const params = (rule.params ?? {}) as Record<string, unknown>
  const advertiserId =
    typeof params.advertiserId === "string" ? params.advertiserId : ""
  const rawThresholds = params.thresholds
  const thresholds = Array.isArray(rawThresholds)
    ? rawThresholds
        .filter((t): t is number => typeof t === "number" && Number.isFinite(t))
        .map((n) => Math.floor(n))
    : DEFAULT_THRESHOLDS
  const rawDays = params.days
  const days =
    typeof rawDays === "number" && Number.isFinite(rawDays) && rawDays >= 1
      ? Math.floor(rawDays)
      : 3

  // ⚠️ cpc_surge / impressions_drop 둘 다 thresholdPct 키를 공유.
  // rule.type 에 따라 어느 필드에 prefill 할지 분기.
  const ruleType = rule.type as AlertRuleType
  const rawThresholdPct = params.thresholdPct

  const cpcThresholdPct =
    ruleType === "cpc_surge" &&
    typeof rawThresholdPct === "number" &&
    Number.isFinite(rawThresholdPct) &&
    rawThresholdPct >= 5 &&
    rawThresholdPct <= 500
      ? Math.floor(rawThresholdPct)
      : 50
  const rawMinClicks = params.minClicks
  const cpcMinClicks =
    typeof rawMinClicks === "number" &&
    Number.isFinite(rawMinClicks) &&
    rawMinClicks >= 10 &&
    rawMinClicks <= 10000
      ? Math.floor(rawMinClicks)
      : 100

  const impDropThresholdPct =
    ruleType === "impressions_drop" &&
    typeof rawThresholdPct === "number" &&
    Number.isFinite(rawThresholdPct) &&
    rawThresholdPct >= 5 &&
    rawThresholdPct <= 100
      ? Math.floor(rawThresholdPct)
      : 50
  const rawMinImpressions = params.minImpressions
  const impMinImpressions =
    typeof rawMinImpressions === "number" &&
    Number.isFinite(rawMinImpressions) &&
    rawMinImpressions >= 100 &&
    rawMinImpressions <= 1_000_000
      ? Math.floor(rawMinImpressions)
      : 1000

  const rawDeviationPct = params.deviationPct
  const paceDeviationPct =
    typeof rawDeviationPct === "number" &&
    Number.isFinite(rawDeviationPct) &&
    rawDeviationPct >= 5 &&
    rawDeviationPct <= 100
      ? Math.floor(rawDeviationPct)
      : 30
  const rawMinHour = params.minHour
  const paceMinHour =
    typeof rawMinHour === "number" &&
    Number.isFinite(rawMinHour) &&
    rawMinHour >= 1 &&
    rawMinHour <= 23
      ? Math.floor(rawMinHour)
      : 6

  return {
    advertiserId,
    thresholds,
    days,
    cpcThresholdPct,
    cpcMinClicks,
    impDropThresholdPct,
    impMinImpressions,
    paceDeviationPct,
    paceMinHour,
  }
}

function buildParams(
  type: AlertRuleType,
  shape: ParamsShape,
): Record<string, unknown> {
  const base: Record<string, unknown> = { advertiserId: shape.advertiserId }
  if (type === "budget_burn") {
    base.thresholds = [...shape.thresholds].sort((a, b) => a - b)
  } else if (type === "bizmoney_low") {
    base.days = shape.days
  } else if (type === "cpc_surge") {
    base.thresholdPct = shape.cpcThresholdPct
    base.minClicks = shape.cpcMinClicks
  } else if (type === "impressions_drop") {
    base.thresholdPct = shape.impDropThresholdPct
    base.minImpressions = shape.impMinImpressions
  } else if (type === "budget_pace") {
    base.deviationPct = shape.paceDeviationPct
    base.minHour = shape.paceMinHour
  }
  // api_auth_error / inspect_rejected: 추가 필드 X (advertiserId 만)
  return base
}

// =============================================================================
// 메인
// =============================================================================

export function AlertRuleFormModal({
  mode,
  rule,
  open,
  onOpenChange,
  advertisers,
  onDone,
}: {
  mode: "create" | "edit"
  /** edit 모드면 prefill 원본 룰. create 모드면 null. */
  rule: AlertRuleRow | null
  open: boolean
  onOpenChange: (next: boolean) => void
  advertisers: { id: string; name: string; customerId: string }[]
  /** 성공 시 parent 측 router.refresh() 등에 사용. */
  onDone: () => void
}) {
  // 부모가 modalOpen=true 와 함께 rule 을 갈아끼울 때마다 본 모달 내부 폼 상태도 리셋되어야 함.
  // useEffect + setState 패턴은 react-hooks/set-state-in-effect 위반 → key 기반 remount 로 처리.
  // 부모가 본 컴포넌트 위에서 key 를 바꿔주는 것보다, 본 컴포넌트 내부에서 inner 분리하는 편이 호출부 단순.
  if (!open) {
    // 닫혀있으면 inner 인스턴스 unmount → 다음 open 시 fresh state.
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-xl sm:max-w-xl" />
      </Dialog>
    )
  }
  return (
    <AlertRuleFormModalInner
      key={rule?.id ?? "new"}
      mode={mode}
      rule={rule}
      open={open}
      onOpenChange={onOpenChange}
      advertisers={advertisers}
      onDone={onDone}
    />
  )
}

function AlertRuleFormModalInner({
  mode,
  rule,
  open,
  onOpenChange,
  advertisers,
  onDone,
}: {
  mode: "create" | "edit"
  rule: AlertRuleRow | null
  open: boolean
  onOpenChange: (next: boolean) => void
  advertisers: { id: string; name: string; customerId: string }[]
  onDone: () => void
}) {
  const isEdit = mode === "edit" && rule != null

  const [type, setType] = React.useState<AlertRuleType>(
    (rule?.type as AlertRuleType) ?? "budget_burn",
  )
  const [params, setParams] = React.useState<ParamsShape>(
    rule ? rowToParams(rule) : INITIAL_PARAMS,
  )
  const [channelHint, setChannelHint] = React.useState<string>(
    rule?.channelHint ?? "",
  )
  const [enabled, setEnabled] = React.useState<boolean>(rule?.enabled ?? true)
  const [pending, startTransition] = React.useTransition()

  function toggleThreshold(t: number, next: boolean) {
    setParams((s) => {
      const set = new Set(s.thresholds)
      if (next) set.add(t)
      else set.delete(t)
      return { ...s, thresholds: Array.from(set) }
    })
  }

  function handleSubmit() {
    if (!params.advertiserId) {
      toast.error("광고주를 선택하세요")
      return
    }
    if (type === "budget_burn" && params.thresholds.length === 0) {
      toast.error("임계 1개 이상 선택")
      return
    }
    if (
      type === "bizmoney_low" &&
      (!Number.isFinite(params.days) || params.days < 1 || params.days > 30)
    ) {
      toast.error("days 는 1..30 사이의 정수여야 합니다")
      return
    }
    if (type === "cpc_surge") {
      if (
        !Number.isFinite(params.cpcThresholdPct) ||
        params.cpcThresholdPct < 5 ||
        params.cpcThresholdPct > 500
      ) {
        toast.error("CPC 임계 (%)는 5..500 사이의 정수여야 합니다")
        return
      }
      if (
        !Number.isFinite(params.cpcMinClicks) ||
        params.cpcMinClicks < 10 ||
        params.cpcMinClicks > 10000
      ) {
        toast.error("최소 클릭 수는 10..10000 사이의 정수여야 합니다")
        return
      }
    }
    if (type === "impressions_drop") {
      if (
        !Number.isFinite(params.impDropThresholdPct) ||
        params.impDropThresholdPct < 5 ||
        params.impDropThresholdPct > 100
      ) {
        toast.error("노출 감소 임계 (%)는 5..100 사이의 정수여야 합니다")
        return
      }
      if (
        !Number.isFinite(params.impMinImpressions) ||
        params.impMinImpressions < 100 ||
        params.impMinImpressions > 1_000_000
      ) {
        toast.error("최소 노출 수는 100..1000000 사이의 정수여야 합니다")
        return
      }
    }
    if (type === "budget_pace") {
      if (
        !Number.isFinite(params.paceDeviationPct) ||
        params.paceDeviationPct < 5 ||
        params.paceDeviationPct > 100
      ) {
        toast.error("초과 임계 (%p)는 5..100 사이의 정수여야 합니다")
        return
      }
      if (
        !Number.isFinite(params.paceMinHour) ||
        params.paceMinHour < 1 ||
        params.paceMinHour > 23
      ) {
        toast.error("최소 평가 시각은 1..23 사이의 정수여야 합니다")
        return
      }
    }

    const built = buildParams(type, params)
    const trimmedHint = channelHint.trim()
    const channelHintArg = trimmedHint.length > 0 ? trimmedHint : null

    startTransition(async () => {
      try {
        if (isEdit && rule) {
          const res = await updateAlertRule({
            id: rule.id,
            params: built,
            channelHint: channelHintArg,
            enabled,
          })
          if (!res.ok) {
            toast.error(`수정 실패: ${res.error}`)
            return
          }
          toast.success("알림 룰을 수정했습니다")
        } else {
          const res = await createAlertRule({
            type,
            params: built,
            channelHint: channelHintArg,
            enabled,
          })
          if (!res.ok) {
            toast.error(`생성 실패: ${res.error}`)
            return
          }
          toast.success("알림 룰을 생성했습니다")
        }
        onOpenChange(false)
        onDone()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        toast.error(`오류: ${msg}`)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "알림 룰 편집" : "새 알림 룰"}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? "type 은 변경할 수 없습니다. 다른 type 으로 바꾸려면 새 룰을 만들고 기존 룰을 삭제하세요."
              : "광고주 + type 별 파라미터를 입력합니다. 같은 광고주에 같은 type 룰을 중복 등록할 수 있으나 권장하지 않습니다."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* type */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">type</Label>
            <Select
              value={type}
              onValueChange={(v) => setType(v as AlertRuleType)}
              disabled={isEdit}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALERT_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {ALERT_TYPES.find((t) => t.value === type)?.description}
            </p>
          </div>

          {/* advertiserId */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">광고주</Label>
            <Select
              value={params.advertiserId || undefined}
              onValueChange={(v) =>
                setParams((s) => ({ ...s, advertiserId: v ?? "" }))
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="광고주 선택">
                  {(v: string | null) => {
                    if (!v) return "광고주 선택"
                    const a = advertisers.find((x) => x.id === v)
                    return a ? `${a.name} (${a.customerId})` : v
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {advertisers.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground">
                    활성 광고주가 없습니다
                  </div>
                ) : (
                  advertisers.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name} ({a.customerId})
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          {/* type 별 추가 파라미터 */}
          {type === "budget_burn" && (
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">임계 (%)</Label>
              <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/30 px-3 py-2">
                {ALL_THRESHOLD_OPTIONS.map((t) => {
                  const checked = params.thresholds.includes(t)
                  return (
                    <label
                      key={t}
                      className="inline-flex cursor-pointer items-center gap-1.5 text-sm"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(next) =>
                          toggleThreshold(t, next === true)
                        }
                      />
                      {t}%
                    </label>
                  )
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                기본 50/80/100. 한 캠페인이 여러 단계 통과하면 가장 높은 단계
                1건만 알림.
              </p>
            </div>
          )}

          {type === "bizmoney_low" && (
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">안전 잔고 일수 (days)</Label>
              <Input
                type="number"
                min={1}
                max={30}
                value={params.days}
                onChange={(e) =>
                  setParams((s) => ({
                    ...s,
                    days: Number(e.target.value) || 0,
                  }))
                }
                className="w-32"
              />
              <p className="text-xs text-muted-foreground">
                비즈머니 잔액 &lt; 활성 캠페인 일예산 합 × N일 이면 알림.
              </p>
            </div>
          )}

          {type === "cpc_surge" && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">임계 (%)</Label>
                <Input
                  type="number"
                  min={5}
                  max={500}
                  step={1}
                  value={params.cpcThresholdPct}
                  onChange={(e) =>
                    setParams((s) => ({
                      ...s,
                      cpcThresholdPct: Number(e.target.value) || 0,
                    }))
                  }
                  className="w-32"
                />
                <p className="text-xs text-muted-foreground">
                  7일 평균 CPC 대비 N% 상승 시 알림. 기본 50.
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">최소 클릭 수 (7일 합산)</Label>
                <Input
                  type="number"
                  min={10}
                  max={10000}
                  step={10}
                  value={params.cpcMinClicks}
                  onChange={(e) =>
                    setParams((s) => ({
                      ...s,
                      cpcMinClicks: Number(e.target.value) || 0,
                    }))
                  }
                  className="w-32"
                />
                <p className="text-xs text-muted-foreground">
                  7일 합산 클릭이 이 미만인 캠페인은 표본 부족으로 제외. 기본 100.
                </p>
              </div>
            </>
          )}

          {type === "impressions_drop" && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">임계 (%)</Label>
                <Input
                  type="number"
                  min={5}
                  max={100}
                  step={1}
                  value={params.impDropThresholdPct}
                  onChange={(e) =>
                    setParams((s) => ({
                      ...s,
                      impDropThresholdPct: Number(e.target.value) || 0,
                    }))
                  }
                  className="w-32"
                />
                <p className="text-xs text-muted-foreground">
                  7일 평균 시간당 노출 대비 N% 감소 시 알림. 기본 50.
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">최소 노출 수 (7일 합산)</Label>
                <Input
                  type="number"
                  min={100}
                  max={1000000}
                  step={100}
                  value={params.impMinImpressions}
                  onChange={(e) =>
                    setParams((s) => ({
                      ...s,
                      impMinImpressions: Number(e.target.value) || 0,
                    }))
                  }
                  className="w-40"
                />
                <p className="text-xs text-muted-foreground">
                  7일 합산 노출이 이 미만인 캠페인 제외. 기본 1000.
                </p>
              </div>
            </>
          )}

          {type === "budget_pace" && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">초과 임계 (%p)</Label>
                <Input
                  type="number"
                  min={5}
                  max={100}
                  step={1}
                  value={params.paceDeviationPct}
                  onChange={(e) =>
                    setParams((s) => ({
                      ...s,
                      paceDeviationPct: Number(e.target.value) || 0,
                    }))
                  }
                  className="w-32"
                />
                <p className="text-xs text-muted-foreground">
                  예상 페이스 대비 N%p 이상 초과 소진 시 알림. 기본 30. (예:
                  14시(58%)에 88% 이상 소진 = +30%p)
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">최소 평가 시각 (시)</Label>
                <Input
                  type="number"
                  min={1}
                  max={23}
                  step={1}
                  value={params.paceMinHour}
                  onChange={(e) =>
                    setParams((s) => ({
                      ...s,
                      paceMinHour: Number(e.target.value) || 0,
                    }))
                  }
                  className="w-32"
                />
                <p className="text-xs text-muted-foreground">
                  이 시각 미만은 평가 skip (자정 직후 노이즈 방지). 기본 6.
                </p>
              </div>
            </>
          )}

          {(type === "api_auth_error" || type === "inspect_rejected") && (
            <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              추가 파라미터 없음. 기본 정책으로 평가됩니다.
            </p>
          )}

          {/* channelHint */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">channelHint (선택)</Label>
            <Input
              value={channelHint}
              onChange={(e) => setChannelHint(e.target.value)}
              placeholder="예: email, log (정식 채널 미정)"
              maxLength={64}
              className="w-full"
            />
            <p className="text-xs text-muted-foreground">
              현재 정식 채널은 email(개발) / log(항상). 이 필드는 라우팅 힌트일
              뿐 실제 발송 채널은 NotificationChannel 추상이 결정합니다.
            </p>
          </div>

          {/* enabled */}
          <label className="inline-flex cursor-pointer items-center gap-2">
            <Checkbox
              checked={enabled}
              onCheckedChange={(next) => setEnabled(next === true)}
            />
            <span className="text-sm">활성</span>
          </label>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            취소
          </Button>
          <Button onClick={handleSubmit} disabled={pending}>
            {pending ? "저장 중..." : isEdit ? "수정" : "생성"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
