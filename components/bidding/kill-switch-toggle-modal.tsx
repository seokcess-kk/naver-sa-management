"use client"

/**
 * Kill Switch 토글 모달 (F-11.6) — admin only
 *
 * - 정지 / 재개 모두 본 모달로 처리. currentEnabled 로 동작 분기.
 * - 사유 (reason) 는 향후 확장용 (현 backend toggleBiddingKillSwitch 는 reason 미수신).
 *   본 PR 은 입력만 받고 backend 로 안 보냄 — UI에서 사용자가 본인 판단을 정리하는 용도.
 *   AuditLog 에는 backend 가 자동 적재 (action='advertiser.kill_switch_toggle').
 * - 2차 확인 — "정지" / "재개" 모두 destructive 수준은 아니지만 보수적으로 명시.
 *
 * SPEC 6.11 F-11.6.
 */

import * as React from "react"
import { toast } from "sonner"
import { ShieldAlertIcon } from "lucide-react"

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
import { toggleBiddingKillSwitch } from "@/app/admin/advertisers/actions"

export function KillSwitchToggleModal({
  advertiserId,
  currentEnabled,
  open,
  onOpenChange,
  onDone,
}: {
  advertiserId: string
  /** 현재 Kill Switch 상태 — true=이미 정지 중. 토글 동작은 !currentEnabled. */
  currentEnabled: boolean
  open: boolean
  onOpenChange: (o: boolean) => void
  onDone: () => void
}) {
  // 토글 후 도달할 상태 (UI 표시용).
  const nextEnabled = !currentEnabled
  const action = nextEnabled ? "정지" : "재개"
  const [reason, setReason] = React.useState<string>("")
  const [submitting, setSubmitting] = React.useState<boolean>(false)

  // open 변경 시 reason 초기화 — onOpenChange 콜백에 위임 (effect 내 setState 회피).
  function handleOpenChange(o: boolean) {
    if (submitting) return
    if (!o) setReason("")
    onOpenChange(o)
  }

  async function handleSubmit() {
    setSubmitting(true)
    try {
      const res = await toggleBiddingKillSwitch({
        advertiserId,
        enabled: nextEnabled,
      })
      if (!res.ok) {
        toast.error(`${action} 실패: ${res.error}`)
        setSubmitting(false)
        return
      }
      // reason 은 backend 미수신 — 운영자 메모 용도로만 보존 (현 PR).
      // 후속 PR 에서 toggleBiddingKillSwitch 시그니처에 reason 추가 검토.
      toast.success(`자동 비딩 ${action} 완료`)
      onDone()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`${action} 오류: ${msg}`)
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlertIcon
              className={
                nextEnabled
                  ? "size-4 text-destructive"
                  : "size-4 text-emerald-600"
              }
            />
            자동 비딩 {action}
          </DialogTitle>
          <DialogDescription>
            {nextEnabled
              ? "본 광고주의 자동 비딩 cron(F-11.2) / 룰 트리거 / OptimizationRun 신규 실행이 모두 차단됩니다. 수동 입찰가 변경은 영향 없습니다."
              : "본 광고주의 자동 비딩이 다시 활성화됩니다. 다음 cron 실행 주기부터 정책에 따라 입찰가가 자동 조정됩니다."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div
            className={
              nextEnabled
                ? "rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                : "rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-900/10 dark:text-emerald-300"
            }
          >
            {nextEnabled
              ? "정지 후에도 변경 이력(ChangeBatch)은 보존되며, 이미 진행 중인 chunk 처리는 그대로 완료됩니다."
              : "재개는 즉시 적용됩니다. 다음 cron 실행 (매시간 정각) 부터 정책 평가가 시작됩니다."}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kill-switch-reason" className="text-sm">
              사유 (선택, 향후 확장용)
            </Label>
            <Textarea
              id="kill-switch-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                nextEnabled
                  ? "예: BizMoney 소진 / SA API 오류 / 운영 점검 등"
                  : "예: 점검 완료 / 사고 처리 종료 등"
              }
              className="min-h-20 text-xs"
              maxLength={500}
            />
            <p className="text-[10px] text-muted-foreground">
              현재는 운영자 메모용으로만 사용됩니다 (백엔드 미저장). AuditLog 에
              자동 토글 기록이 별도 적재됩니다.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            취소
          </Button>
          <Button
            variant={nextEnabled ? "destructive" : "default"}
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? `${action} 중...` : `${action}하기`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
