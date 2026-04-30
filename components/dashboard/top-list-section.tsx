"use client"

/**
 * F-7.4 TOP 캠페인 / 키워드 섹션 — 사이드 1/3 컴팩트 버전
 *
 * 변경 (대시보드 컴팩트 재구성):
 *   - limit 5 고정 (사이드 폭에 맞춰 단순화)
 *   - 컨트롤 1줄 — 지표 select / 기간 select / 정렬 select / 조회 버튼
 *   - "캠페인 / 키워드" Tabs 토글 (단순)
 *   - 표는 폭 좁게 — 이름 truncate, 메트릭 컬럼은 선택 metric 만 노출
 *   - 새로고침 버튼은 Hero 글로벌이 처리 — 본 카드는 "조회"(컨트롤 변경 후 재조회) 만
 *
 * 초기 데이터:
 *   RSC가 페이지 진입 시 getTopCampaigns(limit=5, metric=impCnt, period=last7days, order=desc).
 *
 * 안전장치:
 *   - hasKeys=false → 호출 차단, 안내 카드만
 *   - 정렬 / 기간 / 지표 옵션은 backend topInputSchema 와 1:1 일치
 *
 * 비대상:
 *   - 행 클릭 → 상세 페이지 이동 (후속 PR)
 *   - limit 변경 (사이드는 5 고정)
 *
 * SPEC 6.7 F-7.4 / 11.2 대시보드.
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  getTopCampaigns,
  getTopKeywords,
  type TopCampaignRow,
  type TopKeywordRow,
  type TopMetric,
} from "@/app/(dashboard)/[advertiserId]/dashboard/actions"

// =============================================================================
// 타입 / 상수
// =============================================================================

type Area = "campaigns" | "keywords"
type Period = "last7days" | "last30days"
type Order = "desc" | "asc"

const SIDE_LIMIT = 5

const METRIC_LABEL: Record<TopMetric, string> = {
  impCnt: "노출",
  clkCnt: "클릭",
  salesAmt: "비용",
  ctr: "CTR",
  cpc: "CPC",
}

const METRIC_ORDER: TopMetric[] = ["impCnt", "clkCnt", "salesAmt", "ctr", "cpc"]

const PERIOD_LABEL: Record<Period, string> = {
  last7days: "7일",
  last30days: "30일",
}

const ORDER_LABEL: Record<Order, string> = {
  desc: "TOP",
  asc: "BOTTOM",
}

const NUMBER_FMT = new Intl.NumberFormat("ko-KR")

function fmtMetric(metric: TopMetric, n: number): string {
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

// =============================================================================
// 메인
// =============================================================================

export function TopListSection({
  advertiserId,
  hasKeys,
  initial,
}: {
  advertiserId: string
  hasKeys: boolean
  /** RSC 사전 호출 (캠페인 TOP 5 / impCnt / 7일 / desc). null=hasKeys false 또는 미호출. */
  initial:
    | { ok: true; rows: TopCampaignRow[] }
    | { ok: false; error: string }
    | null
}) {
  const [area, setArea] = React.useState<Area>("campaigns")
  const [metric, setMetric] = React.useState<TopMetric>("impCnt")
  const [period, setPeriod] = React.useState<Period>("last7days")
  const [order, setOrder] = React.useState<Order>("desc")

  const [campaignRows, setCampaignRows] = React.useState<TopCampaignRow[]>(
    initial?.ok ? initial.rows : [],
  )
  const [keywordRows, setKeywordRows] = React.useState<TopKeywordRow[]>([])
  const [campaignLoaded, setCampaignLoaded] = React.useState<boolean>(
    !!initial?.ok,
  )
  const [keywordLoaded, setKeywordLoaded] = React.useState<boolean>(false)
  const [error, setError] = React.useState<string | null>(
    initial && !initial.ok ? initial.error : null,
  )
  const [pending, startTransition] = React.useTransition()

  function handleQuery() {
    if (!hasKeys) {
      toast.error("키 미설정 — API 키 / Secret 키를 먼저 입력하세요")
      return
    }
    setError(null)
    startTransition(async () => {
      try {
        if (area === "campaigns") {
          const res = await getTopCampaigns(advertiserId, {
            metric,
            period,
            order,
            limit: SIDE_LIMIT,
          })
          if (res.ok) {
            setCampaignRows(res.rows)
            setCampaignLoaded(true)
          } else {
            setError(res.error)
            toast.error(`TOP 조회 실패: ${res.error}`)
          }
        } else {
          const res = await getTopKeywords(advertiserId, {
            metric,
            period,
            order,
            limit: SIDE_LIMIT,
          })
          if (res.ok) {
            setKeywordRows(res.rows)
            setKeywordLoaded(true)
          } else {
            setError(res.error)
            toast.error(`TOP 조회 실패: ${res.error}`)
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setError(msg)
        toast.error(`TOP 조회 실패: ${msg}`)
      }
    })
  }

  if (!hasKeys) {
    return (
      <Card size="sm" className="h-full">
        <CardHeader className="border-b">
          <CardTitle>TOP 5</CardTitle>
          <CardDescription>API 키/시크릿 미입력</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card size="sm" className="h-full">
      <CardHeader className="border-b">
        <CardTitle>TOP 5</CardTitle>
        <CardDescription>{`${ORDER_LABEL[order]} ${SIDE_LIMIT} · ${METRIC_LABEL[metric]} · ${PERIOD_LABEL[period]}`}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5 pb-3">
        <Tabs
          value={area}
          onValueChange={(v) => {
            if (typeof v === "string") {
              setArea(v as Area)
            }
          }}
        >
          <TabsList className="w-full">
            <TabsTrigger value="campaigns" className="flex-1">
              캠페인
            </TabsTrigger>
            <TabsTrigger value="keywords" className="flex-1">
              키워드
            </TabsTrigger>
          </TabsList>

          {/* 컴팩트 컨트롤 — 1줄 */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Select
              value={metric}
              onValueChange={(v) => {
                if (typeof v === "string") setMetric(v as TopMetric)
              }}
            >
              <SelectTrigger className="flex-1 text-xs" size="sm">
                <SelectValue>
                  {(v: string | null) =>
                    v ? (METRIC_LABEL[v as TopMetric] ?? v) : "지표"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {METRIC_ORDER.map((m) => (
                  <SelectItem key={m} value={m}>
                    {METRIC_LABEL[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={period}
              onValueChange={(v) => {
                if (typeof v === "string") setPeriod(v as Period)
              }}
            >
              <SelectTrigger className="flex-1 text-xs" size="sm">
                <SelectValue>
                  {(v: string | null) =>
                    v ? (PERIOD_LABEL[v as Period] ?? v) : "기간"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="last7days">7일</SelectItem>
                <SelectItem value="last30days">30일</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={order}
              onValueChange={(v) => {
                if (typeof v === "string") setOrder(v as Order)
              }}
            >
              <SelectTrigger className="flex-1 text-xs" size="sm">
                <SelectValue>
                  {(v: string | null) =>
                    v ? (ORDER_LABEL[v as Order] ?? v) : "정렬"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="desc">TOP</SelectItem>
                <SelectItem value="asc">BOTTOM</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              onClick={handleQuery}
              disabled={pending}
              className="h-7 px-2"
              aria-label="조회"
            >
              <RefreshCwIcon
                className={pending ? "size-3.5 animate-spin" : "size-3.5"}
              />
            </Button>
          </div>

          {error ? (
            <div className="mt-2 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
              <AlertCircleIcon className="size-3.5 shrink-0" />
              <span className="truncate">{error}</span>
            </div>
          ) : null}

          <TabsContent value="campaigns" className="mt-2">
            <CompactCampaignsTable
              rows={campaignRows}
              loaded={campaignLoaded}
              metric={metric}
            />
          </TabsContent>
          <TabsContent value="keywords" className="mt-2">
            <CompactKeywordsTable
              rows={keywordRows}
              loaded={keywordLoaded}
              metric={metric}
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

// =============================================================================
// 표 — 캠페인 (컴팩트)
// =============================================================================

function CompactCampaignsTable({
  rows,
  loaded,
  metric,
}: {
  rows: TopCampaignRow[]
  loaded: boolean
  metric: TopMetric
}) {
  if (!loaded) {
    return <Empty>조회 버튼을 눌러 데이터를 가져오세요.</Empty>
  }
  if (rows.length === 0) {
    return <Empty>표시할 캠페인이 없습니다.</Empty>
  }
  return (
    <div className="overflow-hidden rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8 px-2 text-xs">#</TableHead>
            <TableHead className="px-2 text-xs">캠페인</TableHead>
            <TableHead className="w-20 px-2 text-right text-xs">
              {METRIC_LABEL[metric]}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={r.campaignId}>
              <TableCell className="px-2 font-mono text-[11px] text-muted-foreground">
                {i + 1}
              </TableCell>
              <TableCell
                className="max-w-0 truncate px-2 text-xs"
                title={r.name}
              >
                {r.name}
              </TableCell>
              <TableCell className="px-2 text-right font-mono text-xs tabular-nums">
                {fmtMetric(metric, r[metric])}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

// =============================================================================
// 표 — 키워드 (컴팩트)
// =============================================================================

function CompactKeywordsTable({
  rows,
  loaded,
  metric,
}: {
  rows: TopKeywordRow[]
  loaded: boolean
  metric: TopMetric
}) {
  if (!loaded) {
    return <Empty>조회 버튼을 눌러 데이터를 가져오세요.</Empty>
  }
  if (rows.length === 0) {
    return <Empty>표시할 키워드가 없습니다.</Empty>
  }
  return (
    <div className="overflow-hidden rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8 px-2 text-xs">#</TableHead>
            <TableHead className="px-2 text-xs">키워드</TableHead>
            <TableHead className="w-20 px-2 text-right text-xs">
              {METRIC_LABEL[metric]}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={r.keywordId}>
              <TableCell className="px-2 font-mono text-[11px] text-muted-foreground">
                {i + 1}
              </TableCell>
              <TableCell
                className="max-w-0 truncate px-2 text-xs"
                title={`${r.keyword} (${r.matchType ?? "—"}) · ${r.adgroupName}`}
              >
                <span className="truncate">{r.keyword}</span>
                {r.matchType ? (
                  <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                    {r.matchType}
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="px-2 text-right font-mono text-xs tabular-nums">
                {fmtMetric(metric, r[metric])}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border bg-muted/30 px-3 py-4 text-center text-xs text-muted-foreground">
      {children}
    </p>
  )
}
