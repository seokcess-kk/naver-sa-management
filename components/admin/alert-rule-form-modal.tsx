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
 *
 * 안전장치:
 *   - thresholds 1개 이상 필수
 *   - days 1..30 범위
 *   - 광고주 셀렉트 비어있으면 제출 차단
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
]

const DEFAULT_THRESHOLDS = [50, 80, 100]
const ALL_THRESHOLD_OPTIONS = [50, 80, 100, 150]

type ParamsShape = {
  advertiserId: string
  thresholds: number[] // budget_burn
  days: number // bizmoney_low
}

const INITIAL_PARAMS: ParamsShape = {
  advertiserId: "",
  thresholds: DEFAULT_THRESHOLDS,
  days: 3,
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
  return { advertiserId, thresholds, days }
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
                <SelectValue placeholder="광고주 선택" />
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
