"use client"

/**
 * 연결 상태 + 비즈머니 카드 (F-1.5)
 *
 * - 광고주 컨텍스트 대시보드 페이지에 노출
 * - 자기 자신 endpoint(/billing/bizmoney)로 SA API 헬스체크 + 잔액 조회
 * - hasKeys=false면 disabled + 안내
 * - 새로고침 버튼 (수동 재조회)
 * - budgetLock / refundLock 표시
 *
 * 초기 상태:
 *   RSC가 페이지 진입 시 checkConnection을 호출해 props.initial 로 전달.
 *   클라이언트는 새로고침 버튼만 제공. effect 내 setState 회피 (React Compiler 정책).
 *
 * SPEC 6.1 F-1.5.
 */

import * as React from "react"
import { toast } from "sonner"
import { RefreshCwIcon, CheckCircle2Icon, AlertCircleIcon, BanknoteIcon, LockIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  checkConnection,
  type CheckConnectionResult,
} from "@/app/(dashboard)/[advertiserId]/actions"

type ConnState =
  | { kind: "idle" }
  | {
      kind: "ok"
      bizmoney: number
      budgetLock: boolean
      refundLock: boolean
      checkedAt: string
    }
  | { kind: "error"; error: string; checkedAt: string }

function fromResult(res: CheckConnectionResult): ConnState {
  if (res.ok) {
    return {
      kind: "ok",
      bizmoney: res.bizmoney,
      budgetLock: res.budgetLock,
      refundLock: res.refundLock,
      checkedAt: res.checkedAt,
    }
  }
  return {
    kind: "error",
    error: res.error,
    checkedAt: new Date().toISOString(),
  }
}

export function ConnectionStatusCard({
  advertiserId,
  hasKeys,
  initial,
}: {
  advertiserId: string
  hasKeys: boolean
  /** RSC 사전 점검 결과. hasKeys=false 또는 RSC 단계에서 점검 안 했으면 null */
  initial: CheckConnectionResult | null
}) {
  const [state, setState] = React.useState<ConnState>(
    initial ? fromResult(initial) : { kind: "idle" },
  )
  const [pending, startTransition] = React.useTransition()

  function handleCheck() {
    if (!hasKeys) {
      toast.error("키 미설정 — API 키 / Secret 키를 먼저 입력하세요")
      return
    }
    startTransition(async () => {
      try {
        const res = await checkConnection(advertiserId)
        setState(fromResult(res))
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setState({
          kind: "error",
          error: msg,
          checkedAt: new Date().toISOString(),
        })
      }
    })
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 border-b">
        <div>
          <CardTitle className="flex items-center gap-2">
            연결 상태 · 비즈머니
            {state.kind === "ok" ? (
              <CheckCircle2Icon className="size-4 text-emerald-600" />
            ) : state.kind === "error" ? (
              <AlertCircleIcon className="size-4 text-destructive" />
            ) : null}
          </CardTitle>
          <CardDescription>
            {!hasKeys
              ? "API 키/시크릿 미입력 — 점검 차단"
              : state.kind === "ok"
                ? `최근 점검: ${new Date(state.checkedAt).toLocaleString("ko-KR")}`
                : state.kind === "error"
                  ? `점검 실패: ${state.error}`
                  : "수동 점검 — `/billing/bizmoney` 헬스체크"}
          </CardDescription>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleCheck}
          disabled={pending || !hasKeys}
        >
          <RefreshCwIcon
            className={pending ? "animate-spin size-3.5" : "size-3.5"}
          />
          {pending ? "점검 중..." : "새로고침"}
        </Button>
      </CardHeader>
      {state.kind === "ok" ? (
        <CardContent className="grid grid-cols-1 gap-3 py-4 sm:grid-cols-3">
          <Stat
            icon={<BanknoteIcon className="size-4" />}
            label="비즈머니 잔액"
            value={`${state.bizmoney.toLocaleString()} 원`}
          />
          <Stat
            icon={<LockIcon className="size-4" />}
            label="예산 잠금"
            value={state.budgetLock ? "잠김" : "정상"}
            accent={state.budgetLock ? "destructive" : "ok"}
          />
          <Stat
            icon={<LockIcon className="size-4" />}
            label="환불 잠금"
            value={state.refundLock ? "잠김" : "정상"}
            accent={state.refundLock ? "destructive" : "ok"}
          />
        </CardContent>
      ) : null}
    </Card>
  )
}

function Stat({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode
  label: string
  value: string
  accent?: "ok" | "destructive"
}) {
  const valueClass =
    accent === "destructive"
      ? "text-destructive"
      : accent === "ok"
        ? "text-emerald-700 dark:text-emerald-400"
        : "text-foreground"
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className={`mt-1 font-mono text-base font-medium ${valueClass}`}>
        {value}
      </div>
    </div>
  )
}
