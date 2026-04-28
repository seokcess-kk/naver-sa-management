"use client"

/**
 * F-7.4 TOP 캠페인 / 키워드 섹션
 *
 * 책임:
 *   - 캠페인 / 키워드 영역 Tabs 전환
 *   - 컨트롤 (지표 select / 기간 select / 정렬 select / limit select)
 *   - "조회" 버튼으로 useTransition + 서버 액션 호출
 *   - 결과는 단순 표 (limit ≤ 20 → 가상화 불필요)
 *
 * 초기 데이터:
 *   RSC가 페이지 진입 시 getTopCampaigns 사전 호출 → props.initial 로 전달.
 *   영역 전환(키워드 클릭) 시는 클라이언트에서 첫 호출.
 *
 * 안전장치:
 *   - hasKeys=false → 호출 차단, 안내 카드만 표시
 *   - 정렬 / 기간 / 지표 옵션은 backend topInputSchema 와 1:1 일치
 *   - 모달 / 내비게이션 없이 단순 표시 (P1 단계)
 *
 * 비대상:
 *   - 행 클릭 → 상세 페이지 이동 (후속 PR)
 *   - 5천 행 가상화 (limit ≤ 20)
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
import { Label } from "@/components/ui/label"
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
type Period = "recent7d" | "recent30d"
type Order = "desc" | "asc"

const METRIC_LABEL: Record<TopMetric, string> = {
  impCnt: "노출",
  clkCnt: "클릭",
  salesAmt: "비용",
  ctr: "CTR",
  cpc: "CPC",
}

const METRIC_ORDER: TopMetric[] = ["impCnt", "clkCnt", "salesAmt", "ctr", "cpc"]

const PERIOD_LABEL: Record<Period, string> = {
  recent7d: "최근 7일",
  recent30d: "최근 30일",
}

const ORDER_LABEL: Record<Order, string> = {
  desc: "TOP (내림차순)",
  asc: "BOTTOM (오름차순)",
}

const LIMIT_OPTIONS = [5, 10, 20] as const

const NUMBER_FMT = new Intl.NumberFormat("ko-KR")

function fmtInt(n: number): string {
  return NUMBER_FMT.format(Math.round(n))
}

function fmtMoney(n: number): string {
  return `${NUMBER_FMT.format(Math.round(n))} 원`
}

function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return "—"
  return `${n.toFixed(2)} %`
}

function fmtCpc(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—"
  return `${NUMBER_FMT.format(Math.round(n))} 원`
}

function fmtMatchType(mt: string | null): string {
  if (!mt) return "—"
  // SA enum: EXACT / PHRASE / BROAD — 그대로 표시 (변환은 SPEC 비대상).
  return mt
}

// =============================================================================
// 메인 컴포넌트
// =============================================================================

export function TopListSection({
  advertiserId,
  hasKeys,
  initial,
}: {
  advertiserId: string
  hasKeys: boolean
  /** RSC 사전 호출 결과 (캠페인 TOP 5 / impCnt / 7일 / desc). null=hasKeys false 또는 미호출. */
  initial:
    | { ok: true; rows: TopCampaignRow[] }
    | { ok: false; error: string }
    | null
}) {
  // 컨트롤 상태
  const [area, setArea] = React.useState<Area>("campaigns")
  const [metric, setMetric] = React.useState<TopMetric>("impCnt")
  const [period, setPeriod] = React.useState<Period>("recent7d")
  const [order, setOrder] = React.useState<Order>("desc")
  const [limit, setLimit] = React.useState<5 | 10 | 20>(5)

  // 결과 상태 — 영역별 분리 (Tabs 전환 시 깜빡임 방지).
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
            limit,
          })
          if (res.ok) {
            setCampaignRows(res.rows)
            setCampaignLoaded(true)
            toast.success(`캠페인 TOP ${res.rows.length}건`)
          } else {
            setError(res.error)
            toast.error(`TOP 조회 실패: ${res.error}`)
          }
        } else {
          const res = await getTopKeywords(advertiserId, {
            metric,
            period,
            order,
            limit,
          })
          if (res.ok) {
            setKeywordRows(res.rows)
            setKeywordLoaded(true)
            toast.success(`키워드 TOP ${res.rows.length}건`)
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

  // hasKeys=false → 안내 카드만
  if (!hasKeys) {
    return (
      <Card>
        <CardHeader className="border-b">
          <CardTitle>TOP 캠페인 / 키워드</CardTitle>
          <CardDescription>
            API 키/시크릿 미입력 — TOP 조회 차단됨.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>TOP 캠페인 / 키워드</CardTitle>
        <CardDescription>
          영역 / 지표 / 기간 / 정렬을 선택해 조회. 행 클릭 상세 이동은 후속 PR
          예정.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 py-4">
        {/* 영역 Tabs */}
        <Tabs
          value={area}
          onValueChange={(v) => {
            if (typeof v === "string") {
              setArea(v as Area)
            }
          }}
        >
          <TabsList>
            <TabsTrigger value="campaigns">캠페인</TabsTrigger>
            <TabsTrigger value="keywords">키워드</TabsTrigger>
          </TabsList>

          {/* 컨트롤 — 영역 공통 */}
          <div className="mt-3 flex flex-wrap items-end gap-3">
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

            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">기간</Label>
              <Select
                value={period}
                onValueChange={(v) => {
                  if (typeof v === "string") {
                    setPeriod(v as Period)
                  }
                }}
              >
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="recent7d">{PERIOD_LABEL.recent7d}</SelectItem>
                  <SelectItem value="recent30d">{PERIOD_LABEL.recent30d}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">정렬</Label>
              <Select
                value={order}
                onValueChange={(v) => {
                  if (typeof v === "string") {
                    setOrder(v as Order)
                  }
                }}
              >
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="desc">{ORDER_LABEL.desc}</SelectItem>
                  <SelectItem value="asc">{ORDER_LABEL.asc}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">개수</Label>
              <Select
                value={String(limit)}
                onValueChange={(v) => {
                  if (typeof v === "string") {
                    const n = Number(v)
                    if (n === 5 || n === 10 || n === 20) {
                      setLimit(n)
                    }
                  }
                }}
              >
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LIMIT_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button onClick={handleQuery} disabled={pending}>
              <RefreshCwIcon
                className={pending ? "animate-spin size-3.5" : "size-3.5"}
              />
              {pending ? "조회 중..." : "조회"}
            </Button>
          </div>

          {/* 에러 안내 */}
          {error ? (
            <div className="mt-3 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <AlertCircleIcon className="size-4" />
              <span>{error}</span>
            </div>
          ) : null}

          {/* 캠페인 표 */}
          <TabsContent value="campaigns" className="pt-3">
            <CampaignsTable
              rows={campaignRows}
              loaded={campaignLoaded}
              metric={metric}
            />
          </TabsContent>
          {/* 키워드 표 */}
          <TabsContent value="keywords" className="pt-3">
            <KeywordsTable
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
// 표 — 캠페인
// =============================================================================

function CampaignsTable({
  rows,
  loaded,
  metric,
}: {
  rows: TopCampaignRow[]
  loaded: boolean
  metric: TopMetric
}) {
  if (!loaded) {
    return (
      <p className="rounded-md border bg-muted/30 px-3 py-6 text-center text-sm text-muted-foreground">
        조회 버튼을 눌러 데이터를 가져오세요.
      </p>
    )
  }
  if (rows.length === 0) {
    return (
      <p className="rounded-md border bg-muted/30 px-3 py-6 text-center text-sm text-muted-foreground">
        조건에 맞는 캠페인이 없습니다.
      </p>
    )
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">#</TableHead>
            <TableHead>캠페인</TableHead>
            <NumHead active={metric === "impCnt"}>노출</NumHead>
            <NumHead active={metric === "clkCnt"}>클릭</NumHead>
            <NumHead active={metric === "salesAmt"}>비용</NumHead>
            <NumHead active={metric === "ctr"}>CTR</NumHead>
            <NumHead active={metric === "cpc"}>CPC</NumHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={r.campaignId}>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {i + 1}
              </TableCell>
              <TableCell className="max-w-xs truncate" title={r.name}>
                {r.name}
              </TableCell>
              <NumCell active={metric === "impCnt"}>{fmtInt(r.impCnt)}</NumCell>
              <NumCell active={metric === "clkCnt"}>{fmtInt(r.clkCnt)}</NumCell>
              <NumCell active={metric === "salesAmt"}>
                {fmtMoney(r.salesAmt)}
              </NumCell>
              <NumCell active={metric === "ctr"}>{fmtPct(r.ctr)}</NumCell>
              <NumCell active={metric === "cpc"}>{fmtCpc(r.cpc)}</NumCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

// =============================================================================
// 표 — 키워드
// =============================================================================

function KeywordsTable({
  rows,
  loaded,
  metric,
}: {
  rows: TopKeywordRow[]
  loaded: boolean
  metric: TopMetric
}) {
  if (!loaded) {
    return (
      <p className="rounded-md border bg-muted/30 px-3 py-6 text-center text-sm text-muted-foreground">
        조회 버튼을 눌러 데이터를 가져오세요.
      </p>
    )
  }
  if (rows.length === 0) {
    return (
      <p className="rounded-md border bg-muted/30 px-3 py-6 text-center text-sm text-muted-foreground">
        조건에 맞는 키워드가 없습니다.
      </p>
    )
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">#</TableHead>
            <TableHead>키워드</TableHead>
            <TableHead className="w-24">매칭</TableHead>
            <TableHead>광고그룹</TableHead>
            <NumHead active={metric === "impCnt"}>노출</NumHead>
            <NumHead active={metric === "clkCnt"}>클릭</NumHead>
            <NumHead active={metric === "salesAmt"}>비용</NumHead>
            <NumHead active={metric === "ctr"}>CTR</NumHead>
            <NumHead active={metric === "cpc"}>CPC</NumHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={r.keywordId}>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {i + 1}
              </TableCell>
              <TableCell className="max-w-xs truncate" title={r.keyword}>
                {r.keyword}
              </TableCell>
              <TableCell>
                <span className="font-mono text-xs">
                  {fmtMatchType(r.matchType)}
                </span>
              </TableCell>
              <TableCell
                className="max-w-xs truncate text-muted-foreground"
                title={`${r.campaignName} / ${r.adgroupName}`}
              >
                {r.adgroupName}
              </TableCell>
              <NumCell active={metric === "impCnt"}>{fmtInt(r.impCnt)}</NumCell>
              <NumCell active={metric === "clkCnt"}>{fmtInt(r.clkCnt)}</NumCell>
              <NumCell active={metric === "salesAmt"}>
                {fmtMoney(r.salesAmt)}
              </NumCell>
              <NumCell active={metric === "ctr"}>{fmtPct(r.ctr)}</NumCell>
              <NumCell active={metric === "cpc"}>{fmtCpc(r.cpc)}</NumCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

// =============================================================================
// 표 헬퍼 — 정렬 기준 컬럼 강조
// =============================================================================

function NumHead({
  active,
  children,
}: {
  active: boolean
  children: React.ReactNode
}) {
  return (
    <TableHead
      className={
        active
          ? "text-right font-semibold text-foreground"
          : "text-right text-foreground"
      }
    >
      {children}
    </TableHead>
  )
}

function NumCell({
  active,
  children,
}: {
  active: boolean
  children: React.ReactNode
}) {
  return (
    <TableCell
      className={
        active
          ? "text-right font-mono font-medium tabular-nums"
          : "text-right font-mono tabular-nums text-muted-foreground"
      }
    >
      {children}
    </TableCell>
  )
}
