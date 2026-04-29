"use client"

/**
 * F-7.2 일자별 트렌드 차트 섹션
 *
 * 책임:
 *   - grain Tabs: 일별(7일) / 시간별(오늘 24h)
 *   - metric Select: impCnt / clkCnt / salesAmt / ctr / cpc
 *   - 새로고침 버튼 (서버 재호출, useTransition pending)
 *   - LineChart (recharts) — x축 ts, y축 metric
 *
 * 초기 데이터:
 *   RSC 가 페이지 진입 시 getStatsTimeSeries({grain:"daily", days:7}) 호출 → props.initial.
 *   클라이언트는 grain / 새로고침 트리거만 (effect 내 setState 회피 — React Compiler 정책).
 *   metric 변경 시 동일 데이터 재사용 (서버 재호출 X — points 가 모든 지표 포함).
 *
 * 안전장치:
 *   - hasKeys=false → 호출 차단, 안내 카드만 표시
 *   - 시크릿 X (Stats 응답에 키 없음)
 *   - SSR 안전: shadcn ChartContainer 자체가 ResponsiveContainer 래핑 (use client)
 *
 * 비대상:
 *   - 시간대 페이스 분석 (P1.5)
 *   - 다중 metric 동시 표시 (단일 metric)
 *   - 캠페인/키워드 단위 시계열 (광고주 전체만)
 *
 * SPEC 6.7 F-7.2 / 11.2 대시보드.
 */

import * as React from "react"
import { toast } from "sonner"
import { RefreshCwIcon, AlertCircleIcon } from "lucide-react"
import {
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  getStatsTimeSeries,
  type TimeSeriesGrain,
  type TimeSeriesPoint,
  type TopMetric,
} from "@/app/(dashboard)/[advertiserId]/dashboard/actions"

// =============================================================================
// 상수 / 포매터
// =============================================================================

const DAYS_DEFAULT = 7

const METRIC_LABEL: Record<TopMetric, string> = {
  impCnt: "노출",
  clkCnt: "클릭",
  salesAmt: "비용",
  ctr: "CTR",
  cpc: "CPC",
}

const METRIC_ORDER: TopMetric[] = ["impCnt", "clkCnt", "salesAmt", "ctr", "cpc"]

/**
 * metric 별 라인 색상 (oklch 또는 hex 가능 — 여기선 tailwind 친화 hex).
 *
 * - impCnt:   blue-500
 * - clkCnt:   emerald-500
 * - salesAmt: violet-500
 * - ctr:      orange-500
 * - cpc:      pink-500
 */
const METRIC_COLOR: Record<TopMetric, string> = {
  impCnt: "#3b82f6",
  clkCnt: "#10b981",
  salesAmt: "#8b5cf6",
  ctr: "#f97316",
  cpc: "#ec4899",
}

const NUMBER_FMT = new Intl.NumberFormat("ko-KR")

function fmtMetricValue(metric: TopMetric, n: number): string {
  if (!Number.isFinite(n)) return "—"
  if (metric === "ctr") return `${n.toFixed(2)} %`
  if (metric === "cpc" || metric === "salesAmt") {
    return `${NUMBER_FMT.format(Math.round(n))} 원`
  }
  return NUMBER_FMT.format(Math.round(n))
}

/** 차트 X축 tick 포매터 (daily: MM/DD, hourly: HH시). */
function fmtTickDaily(ts: string): string {
  // "YYYY-MM-DD" → "MM/DD"
  const [, m, d] = ts.split("-")
  if (!m || !d) return ts
  return `${m}/${d}`
}

function fmtTickHourly(ts: string): string {
  // "YYYY-MM-DD HH" → "HH시"
  const hh = ts.split(" ")[1]
  if (!hh) return ts
  return `${hh}시`
}

// =============================================================================
// 타입
// =============================================================================

type TrendState =
  | { kind: "ok"; points: TimeSeriesPoint[]; checkedAt: string }
  | { kind: "error"; error: string; checkedAt: string }
  | { kind: "idle" }

// =============================================================================
// 메인 컴포넌트
// =============================================================================

export function TrendChartSection({
  advertiserId,
  hasKeys,
  initial,
}: {
  advertiserId: string
  hasKeys: boolean
  /** RSC 사전 호출 결과 (daily / 7일 기본). hasKeys=false 시 null. */
  initial:
    | { ok: true; points: TimeSeriesPoint[] }
    | { ok: false; error: string }
    | null
}) {
  const [grain, setGrain] = React.useState<TimeSeriesGrain>("daily")
  const [metric, setMetric] = React.useState<TopMetric>("impCnt")
  const [state, setState] = React.useState<TrendState>(() => {
    if (!initial) return { kind: "idle" }
    if (initial.ok) {
      return {
        kind: "ok",
        points: initial.points,
        checkedAt: new Date().toISOString(),
      }
    }
    return {
      kind: "error",
      error: initial.error,
      checkedAt: new Date().toISOString(),
    }
  })
  const [pending, startTransition] = React.useTransition()

  function fetchSeries(nextGrain: TimeSeriesGrain) {
    if (!hasKeys) {
      toast.error("키 미설정 — API 키 / Secret 키를 먼저 입력하세요")
      return
    }
    startTransition(async () => {
      try {
        const res = await getStatsTimeSeries(advertiserId, {
          grain: nextGrain,
          days: nextGrain === "daily" ? DAYS_DEFAULT : undefined,
        })
        if (res.ok) {
          setState({
            kind: "ok",
            points: res.points,
            checkedAt: new Date().toISOString(),
          })
          toast.success(
            nextGrain === "daily"
              ? `일별 트렌드 ${res.points.length}일`
              : `시간별 트렌드 ${res.points.length}시간`,
          )
        } else {
          setState({
            kind: "error",
            error: res.error,
            checkedAt: new Date().toISOString(),
          })
          toast.error(`트렌드 조회 실패: ${res.error}`)
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setState({
          kind: "error",
          error: msg,
          checkedAt: new Date().toISOString(),
        })
        toast.error(`트렌드 조회 실패: ${msg}`)
      }
    })
  }

  function handleGrainChange(v: string) {
    if (v !== "daily" && v !== "hourly") return
    setGrain(v)
    // grain 전환은 데이터 형태가 다르므로 즉시 재호출.
    fetchSeries(v)
  }

  function handleRefresh() {
    fetchSeries(grain)
  }

  // hasKeys=false → 안내 카드만
  if (!hasKeys) {
    return (
      <Card>
        <CardHeader className="border-b">
          <CardTitle>일자별 트렌드</CardTitle>
          <CardDescription>
            API 키/시크릿 미입력 — 트렌드 조회 차단됨.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 border-b">
        <div>
          <CardTitle>일자별 트렌드</CardTitle>
          <CardDescription>
            {state.kind === "ok"
              ? `최근 조회: ${new Date(state.checkedAt).toLocaleString("ko-KR")} · ${grain === "daily" ? "최근 7일" : "오늘 24시간"} · ${METRIC_LABEL[metric]}`
              : state.kind === "error"
                ? `조회 실패: ${state.error}`
                : "광고주 전체 시계열 — 일별 / 시간별 단일 지표"}
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

      <CardContent className="flex flex-col gap-3 py-4">
        {/* 컨트롤 */}
        <div className="flex flex-wrap items-end gap-3">
          <Tabs value={grain} onValueChange={handleGrainChange}>
            <TabsList>
              <TabsTrigger value="daily">일별 (7일)</TabsTrigger>
              <TabsTrigger value="hourly">시간별 (오늘)</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">지표</Label>
            <Select
              value={metric}
              onValueChange={(v) => {
                if (typeof v === "string") {
                  setMetric(v as TopMetric)
                }
              }}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METRIC_ORDER.map((m) => (
                  <SelectItem key={m} value={m}>
                    {METRIC_LABEL[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* 에러 안내 */}
        {state.kind === "error" ? (
          <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertCircleIcon className="size-4" />
            <span>{state.error}</span>
          </div>
        ) : null}

        {/* 차트 */}
        <TrendChart
          points={state.kind === "ok" ? state.points : []}
          grain={grain}
          metric={metric}
          loaded={state.kind === "ok"}
        />
      </CardContent>
    </Card>
  )
}

// =============================================================================
// 차트 본체
// =============================================================================

function TrendChart({
  points,
  grain,
  metric,
  loaded,
}: {
  points: TimeSeriesPoint[]
  grain: TimeSeriesGrain
  metric: TopMetric
  loaded: boolean
}) {
  if (!loaded) {
    return (
      <p className="rounded-md border bg-muted/30 px-3 py-12 text-center text-sm text-muted-foreground">
        조회 중... (또는 새로고침을 눌러 데이터를 가져오세요)
      </p>
    )
  }
  if (points.length === 0) {
    return (
      <p className="rounded-md border bg-muted/30 px-3 py-12 text-center text-sm text-muted-foreground">
        조건에 맞는 데이터가 없습니다.
      </p>
    )
  }

  // 모든 데이터가 0인 경우 (빈 차트 안내)
  const allZero = points.every((p) => p[metric] === 0)

  // ChartConfig — metric 라벨 + 색상
  const config: ChartConfig = {
    [metric]: {
      label: METRIC_LABEL[metric],
      color: METRIC_COLOR[metric],
    },
  }

  const tickFmt = grain === "daily" ? fmtTickDaily : fmtTickHourly

  return (
    <div className="rounded-md border p-2">
      <ChartContainer config={config} className="aspect-[16/6] w-full">
        <LineChart
          data={points}
          margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
        >
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="ts"
            tickFormatter={tickFmt}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={16}
          />
          <YAxis
            tickFormatter={(v: number) => {
              if (metric === "ctr") return `${v.toFixed(1)}%`
              if (v >= 10000) return `${Math.round(v / 1000)}k`
              return NUMBER_FMT.format(Math.round(v))
            }}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            width={56}
          />
          <ChartTooltip
            cursor={{ stroke: METRIC_COLOR[metric], strokeWidth: 1 }}
            content={
              <ChartTooltipContent
                indicator="line"
                labelFormatter={(_, payload) => {
                  const ts = payload?.[0]?.payload?.ts as string | undefined
                  if (!ts) return ""
                  return ts
                }}
                formatter={(value) => {
                  if (typeof value !== "number") {
                    return [String(value), METRIC_LABEL[metric]]
                  }
                  return [fmtMetricValue(metric, value), METRIC_LABEL[metric]]
                }}
              />
            }
          />
          <Line
            type="monotone"
            dataKey={metric}
            stroke={`var(--color-${metric})`}
            strokeWidth={2}
            dot={{ r: 3 }}
            activeDot={{ r: 5 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ChartContainer>

      {allZero ? (
        <p className="mt-2 px-2 text-xs text-muted-foreground">
          선택 기간 / 지표에 데이터가 0 입니다.
        </p>
      ) : null}
    </div>
  )
}
