"use client"

/**
 * F-7.1 KPI 카드 섹션
 *
 * 책임:
 *   - 4개 기간(today / yesterday / recent7d / recent30d) Tabs 전환
 *   - 각 기간 내 4 카드 (노출 / 클릭 / 비용 / CTR) + CPC 보조 텍스트
 *   - recentAvgRnk 제공 시 보조 카드 1개 추가 표시
 *   - 새로고침 버튼 (서버 재호출, useTransition pending)
 *
 * 초기 데이터:
 *   RSC가 페이지 진입 시 getDashboardKpi 호출 → props.initial 로 전달.
 *   클라이언트는 새로고침만 제공 (effect 내 setState 회피 — React Compiler 정책).
 *
 * 안전장치:
 *   - hasKeys=false → 호출 차단, 안내 카드만 표시
 *   - 시크릿 X (Stats 응답에 키 없음)
 *   - 에러는 toast + 카드 본문에 안내 메시지
 *
 * SPEC 6.7 F-7.1 / 11.2 대시보드.
 */

import * as React from "react"
import { toast } from "sonner"
import { RefreshCwIcon, AlertCircleIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  getDashboardKpi,
  type DashboardKpi,
  type KpiPeriod,
  type KpiSummary,
} from "@/app/(dashboard)/[advertiserId]/dashboard/actions"

// =============================================================================
// 타입 / 상수
// =============================================================================

type KpiState =
  | { kind: "ok"; kpi: DashboardKpi; checkedAt: string }
  | { kind: "error"; error: string; checkedAt: string }
  | { kind: "idle" }

const PERIOD_LABEL: Record<KpiPeriod, string> = {
  today: "오늘",
  yesterday: "어제",
  recent7d: "최근 7일",
  recent30d: "최근 30일",
}

const PERIOD_ORDER: KpiPeriod[] = ["today", "yesterday", "recent7d", "recent30d"]

// =============================================================================
// 포매터
// =============================================================================

const NUMBER_FMT = new Intl.NumberFormat("ko-KR")

function fmtInt(n: number): string {
  return NUMBER_FMT.format(Math.round(n))
}

function fmtMoney(n: number): string {
  return `${NUMBER_FMT.format(Math.round(n))} 원`
}

function fmtPct(n: number): string {
  // Stats 응답의 ctr 은 % 단위(예: 1.23 → 1.23%) — 그대로 표시.
  if (!Number.isFinite(n)) return "—"
  return `${n.toFixed(2)} %`
}

function fmtCpc(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—"
  return `${NUMBER_FMT.format(Math.round(n))} 원`
}

function fmtRnk(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—"
  return n.toFixed(2)
}

// =============================================================================
// 메인 컴포넌트
// =============================================================================

export function KpiCardsSection({
  advertiserId,
  hasKeys,
  initial,
}: {
  advertiserId: string
  hasKeys: boolean
  /** RSC 사전 호출 결과. hasKeys=false 시 null. */
  initial:
    | { ok: true; kpi: DashboardKpi }
    | { ok: false; error: string }
    | null
}) {
  const [state, setState] = React.useState<KpiState>(() => {
    if (!initial) return { kind: "idle" }
    if (initial.ok) {
      return { kind: "ok", kpi: initial.kpi, checkedAt: new Date().toISOString() }
    }
    return {
      kind: "error",
      error: initial.error,
      checkedAt: new Date().toISOString(),
    }
  })
  const [activePeriod, setActivePeriod] = React.useState<KpiPeriod>("today")
  const [pending, startTransition] = React.useTransition()

  function handleRefresh() {
    if (!hasKeys) {
      toast.error("키 미설정 — API 키 / Secret 키를 먼저 입력하세요")
      return
    }
    startTransition(async () => {
      try {
        const res = await getDashboardKpi(advertiserId)
        if (res.ok) {
          setState({
            kind: "ok",
            kpi: res.kpi,
            checkedAt: new Date().toISOString(),
          })
          toast.success("KPI 새로고침 완료")
        } else {
          setState({
            kind: "error",
            error: res.error,
            checkedAt: new Date().toISOString(),
          })
          toast.error(`KPI 조회 실패: ${res.error}`)
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setState({
          kind: "error",
          error: msg,
          checkedAt: new Date().toISOString(),
        })
        toast.error(`KPI 조회 실패: ${msg}`)
      }
    })
  }

  // hasKeys=false → 안내 카드만
  if (!hasKeys) {
    return (
      <Card>
        <CardHeader className="border-b">
          <CardTitle>대시보드 KPI</CardTitle>
          <CardDescription>
            API 키/시크릿 미입력 — 성과 조회 차단됨. admin 권한자가 광고주 상세
            화면에서 키를 입력하면 활성화됩니다.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 border-b">
        <div>
          <CardTitle>대시보드 KPI</CardTitle>
          <CardDescription>
            {state.kind === "ok"
              ? `최근 조회: ${new Date(state.checkedAt).toLocaleString("ko-KR")} · Stats API 자동 캐시 (오늘 5분 / 과거 1시간)`
              : state.kind === "error"
                ? `조회 실패: ${state.error}`
                : "오늘 / 어제 / 7일 / 30일 누적 지표"}
          </CardDescription>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleRefresh}
          disabled={pending}
        >
          <RefreshCwIcon
            className={pending ? "animate-spin size-3.5" : "size-3.5"}
          />
          {pending ? "조회 중..." : "새로고침"}
        </Button>
      </CardHeader>
      <CardContent className="py-4">
        {state.kind === "error" ? (
          <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertCircleIcon className="size-4" />
            <span>{state.error}</span>
          </div>
        ) : null}

        <Tabs
          value={activePeriod}
          onValueChange={(v) => {
            if (typeof v === "string") {
              setActivePeriod(v as KpiPeriod)
            }
          }}
        >
          <TabsList>
            {PERIOD_ORDER.map((p) => (
              <TabsTrigger key={p} value={p}>
                {PERIOD_LABEL[p]}
              </TabsTrigger>
            ))}
          </TabsList>

          {PERIOD_ORDER.map((p) => (
            <TabsContent key={p} value={p} className="pt-4">
              <KpiPeriodGrid
                summary={state.kind === "ok" ? state.kpi[p] : null}
              />
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  )
}

// =============================================================================
// 기간별 그리드
// =============================================================================

function KpiPeriodGrid({ summary }: { summary: KpiSummary | null }) {
  // idle / error 상태는 placeholder.
  if (!summary) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="노출" value="—" />
        <KpiCard label="클릭" value="—" />
        <KpiCard label="비용" value="—" />
        <KpiCard label="CTR" value="—" />
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <KpiCard label="노출" value={fmtInt(summary.impCnt)} />
      <KpiCard label="클릭" value={fmtInt(summary.clkCnt)} />
      <KpiCard
        label="비용"
        value={fmtMoney(summary.salesAmt)}
        sub={`평균 CPC ${fmtCpc(summary.cpc)}`}
      />
      <KpiCard label="CTR" value={fmtPct(summary.ctr)} />
      {typeof summary.recentAvgRnk === "number" ? (
        <KpiCard
          label="평균 노출 순위"
          value={fmtRnk(summary.recentAvgRnk)}
          sub="P1 읽기 전용 — 최적화는 P2"
        />
      ) : null}
    </div>
  )
}

// =============================================================================
// 작은 카드
// =============================================================================

function KpiCard({
  label,
  value,
  sub,
}: {
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-lg font-medium">{value}</div>
      {sub ? (
        <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>
      ) : null}
    </div>
  )
}
