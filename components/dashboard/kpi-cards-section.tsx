"use client"

/**
 * F-7.1 KPI 4 기간 비교 그리드
 *
 * 표시:
 *   - row: 노출 / 클릭 / 비용 / CTR / CPC (+ recentAvgRnk 데이터 있으면 마지막 row)
 *   - col: 오늘 / 어제 / 7일 / 30일 (PERIOD_ORDER 고정)
 *   - "오늘" 컬럼만 어제 대비 ±% 표시 (지표별 색상 정책 — 비용은 amber 보수, 그 외 emerald/rose)
 *   - 절대값 0.5% 이내는 "—" (변화 없음 표기)
 *
 * 새로고침: Hero 글로벌 새로고침이 RSC 전체를 재호출 → 본 컴포넌트는 자체 트리거 없음.
 *
 * 초기 데이터: RSC가 getDashboardKpi 호출 → props.initial. 클라이언트는 표시만.
 *
 * 안전장치:
 *   - hasKeys=false → 안내 카드만 표시
 *   - 시크릿 X (Stats 응답에 키 없음)
 *
 * SPEC 6.7 F-7.1 / 11.2 대시보드.
 */

import * as React from "react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import type {
  DashboardKpi,
  KpiPeriod,
  KpiSummary,
} from "@/app/(dashboard)/[advertiserId]/dashboard/actions"

// =============================================================================
// 상수
// =============================================================================

const PERIOD_LABEL: Record<KpiPeriod, string> = {
  today: "오늘",
  yesterday: "어제",
  last7days: "7일",
  last30days: "30일",
}

const PERIOD_ORDER: KpiPeriod[] = ["today", "yesterday", "last7days", "last30days"]

type MetricKey = "impCnt" | "clkCnt" | "salesAmt" | "ctr" | "cpc"

const METRIC_LABEL: Record<MetricKey, string> = {
  impCnt: "노출",
  clkCnt: "클릭",
  salesAmt: "비용",
  ctr: "CTR",
  cpc: "CPC",
}

const METRIC_ORDER: MetricKey[] = ["impCnt", "clkCnt", "salesAmt", "ctr", "cpc"]

/**
 * 비용 계열은 증가가 부정 신호(예산 가속) → amber. 그 외는 양수 호재 색상.
 *
 * - "increase-good": 양수 emerald, 음수 rose (노출 / 클릭 / CTR — 다다익선)
 * - "increase-bad" : 양수 amber, 음수 emerald (비용 — 적을수록 좋음)
 * - "neutral"      : CPC — 단가 자체로 좋고 나쁨 단정 어려움. 양수 amber, 음수 emerald (안전 보수)
 */
type ChangeBias = "increase-good" | "increase-bad" | "neutral"

const METRIC_BIAS: Record<MetricKey, ChangeBias> = {
  impCnt: "increase-good",
  clkCnt: "increase-good",
  salesAmt: "increase-bad",
  ctr: "increase-good",
  cpc: "neutral",
}

/** 변화 미미 임계값. ±0.5% 이내는 "—" 처리 (소음 제거). */
const FLAT_THRESHOLD_PCT = 0.5

// =============================================================================
// 포매터
// =============================================================================

const NUMBER_FMT = new Intl.NumberFormat("ko-KR")

function fmtMetric(metric: MetricKey, n: number): string {
  if (!Number.isFinite(n)) return "—"
  if (metric === "ctr") return `${n.toFixed(2)}%`
  if (metric === "salesAmt") {
    return `${NUMBER_FMT.format(Math.round(n))}원`
  }
  if (metric === "cpc") {
    if (n <= 0) return "—"
    return `${NUMBER_FMT.format(Math.round(n))}원`
  }
  return NUMBER_FMT.format(Math.round(n))
}

function fmtRnk(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—"
  return n.toFixed(2)
}

// =============================================================================
// 변화율 계산
// =============================================================================

/**
 * 어제 대비 오늘 변화율 (%) — 분모 0 이거나 비유한 시 null.
 */
function changePct(today: number, yesterday: number): number | null {
  if (!Number.isFinite(today) || !Number.isFinite(yesterday)) return null
  if (yesterday === 0) return null
  return ((today - yesterday) / yesterday) * 100
}

function changeText(pct: number): string {
  const abs = Math.abs(pct)
  const arrow = pct > 0 ? "↑" : "↓"
  return `${arrow}${abs.toFixed(1)}%`
}

function changeColorClass(pct: number, bias: ChangeBias): string {
  const abs = Math.abs(pct)
  if (abs < FLAT_THRESHOLD_PCT) return "text-muted-foreground"
  // bias 가 increase-good 이면 양수 = emerald, 음수 = rose
  // bias 가 increase-bad / neutral 이면 양수 = amber, 음수 = emerald
  if (bias === "increase-good") {
    return pct > 0
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-rose-600 dark:text-rose-400"
  }
  return pct > 0
    ? "text-amber-600 dark:text-amber-400"
    : "text-emerald-600 dark:text-emerald-400"
}

// =============================================================================
// 메인
// =============================================================================

export function KpiCardsSection({
  hasKeys,
  initial,
}: {
  /** RSC 호출에서 전달. 사용처 호환성 위해 advertiserId 받지만 본 컴포넌트는 사용 안 함. */
  advertiserId?: string
  hasKeys: boolean
  initial:
    | { ok: true; kpi: DashboardKpi }
    | { ok: false; error: string }
    | null
}) {
  // hasKeys=false → 안내 카드만
  if (!hasKeys) {
    return (
      <Card size="sm" className="h-full">
        <CardHeader className="border-b">
          <CardTitle>기간별 KPI</CardTitle>
          <CardDescription>
            API 키/시크릿 미입력 — 성과 조회 차단됨.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  if (!initial) {
    return (
      <Card size="sm" className="h-full">
        <CardHeader className="border-b">
          <CardTitle>기간별 KPI</CardTitle>
          <CardDescription>
            데이터 미조회 — 새로고침을 눌러 다시 시도하세요.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  if (!initial.ok) {
    return (
      <Card size="sm" className="h-full">
        <CardHeader className="border-b">
          <CardTitle>기간별 KPI</CardTitle>
          <CardDescription className="text-destructive">
            조회 실패: {initial.error}
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const kpi = initial.kpi
  const showRnk = typeof kpi.today.recentAvgRnk === "number"

  return (
    <Card size="sm" className="h-full">
      <CardHeader className="border-b">
        <CardTitle>기간별 KPI</CardTitle>
        <CardDescription>
          오늘 / 어제 / 7일 / 30일 누적 · 어제 대비 변화율 (오늘 컬럼)
        </CardDescription>
      </CardHeader>
      <CardContent className="px-2 pb-2 sm:px-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20 text-xs">지표</TableHead>
              {PERIOD_ORDER.map((p) => (
                <TableHead
                  key={p}
                  className={cn(
                    "text-right text-xs",
                    p === "today" && "text-foreground"
                  )}
                >
                  {PERIOD_LABEL[p]}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {METRIC_ORDER.map((m) => (
              <MetricRow key={m} metric={m} kpi={kpi} />
            ))}
            {showRnk ? <RnkRow kpi={kpi} /> : null}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

// =============================================================================
// 행 컴포넌트
// =============================================================================

function MetricRow({ metric, kpi }: { metric: MetricKey; kpi: DashboardKpi }) {
  const todayVal = readMetric(kpi.today, metric)
  const yesterdayVal = readMetric(kpi.yesterday, metric)
  const pct = changePct(todayVal, yesterdayVal)
  const bias = METRIC_BIAS[metric]

  return (
    <TableRow>
      <TableCell className="text-xs font-medium text-muted-foreground">
        {METRIC_LABEL[metric]}
      </TableCell>
      {PERIOD_ORDER.map((p) => {
        const v = readMetric(kpi[p], metric)
        const isToday = p === "today"
        return (
          <TableCell
            key={p}
            className={cn(
              "text-right font-mono tabular-nums",
              isToday ? "font-semibold text-foreground" : "text-foreground/80"
            )}
          >
            <div>{fmtMetric(metric, v)}</div>
            {isToday ? (
              <div
                className={cn(
                  "text-[10px] font-normal leading-tight",
                  pct === null
                    ? "text-muted-foreground"
                    : changeColorClass(pct, bias)
                )}
              >
                {pct === null
                  ? "—"
                  : Math.abs(pct) < FLAT_THRESHOLD_PCT
                    ? "—"
                    : changeText(pct)}
              </div>
            ) : null}
          </TableCell>
        )
      })}
    </TableRow>
  )
}

function RnkRow({ kpi }: { kpi: DashboardKpi }) {
  return (
    <TableRow>
      <TableCell className="text-xs font-medium text-muted-foreground">
        평균 순위
      </TableCell>
      {PERIOD_ORDER.map((p) => (
        <TableCell
          key={p}
          className={cn(
            "text-right font-mono tabular-nums",
            p === "today"
              ? "font-semibold text-foreground"
              : "text-foreground/80"
          )}
        >
          {fmtRnk(kpi[p].recentAvgRnk)}
        </TableCell>
      ))}
    </TableRow>
  )
}

function readMetric(s: KpiSummary, m: MetricKey): number {
  return s[m]
}
