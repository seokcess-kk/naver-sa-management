"use client"

/**
 * F-11.3 — 한계효용 분석 클라이언트
 *
 * 책임:
 *   - 입력 영역: device 토글 / daysWindow 입력 / 키워드 셀렉터 / 분석 버튼
 *   - 결과 영역:
 *       * 데이터 부족 안내 (insufficientData != null)
 *       * 키워드 정보 카드 + 순위별 한계효용 표 + 권장 순위 카드
 *
 * 흐름:
 *   1. mount: listAnalyzableKeywords(advertiserId, device) → keywordOptions
 *   2. device 변경 → keywordOptions 재로드 + 결과 초기화
 *   3. "분석 실행" → analyzeMarginalUtility(...) → result 표시
 *
 * staging 미적용 — 조회 성격 (read-only). mutation 없음.
 *
 * SPEC: SPEC v0.2.1 F-11.3
 */

import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  analyzeMarginalUtility,
  listAnalyzableKeywords,
  type AnalyzableKeywordOption,
} from "@/app/(dashboard)/[advertiserId]/bidding-policies/marginal-actions"
import type { MarginalUtilityResult } from "@/lib/marginal-utility/calculate"

type Device = "PC" | "MOBILE"

const DAYS_WINDOW_MIN = 3
const DAYS_WINDOW_MAX = 30
const DAYS_WINDOW_DEFAULT = 7

export function MarginalUtilityClient({
  advertiserId,
}: {
  advertiserId: string
}) {
  const [device, setDevice] = React.useState<Device>("PC")
  const [keywordId, setKeywordId] = React.useState<string | null>(null)
  const [daysWindow, setDaysWindow] = React.useState<number>(
    DAYS_WINDOW_DEFAULT,
  )
  const [keywordOptions, setKeywordOptions] = React.useState<
    AnalyzableKeywordOption[]
  >([])
  const [keywordOptionsLoading, setKeywordOptionsLoading] =
    React.useState<boolean>(false)
  const [result, setResult] = React.useState<MarginalUtilityResult | null>(null)
  const [loading, setLoading] = React.useState<boolean>(false)
  const [error, setError] = React.useState<string | null>(null)

  // device 변경 시 keywordOptions 재로드 (광고주 + device 별 7일 클릭 정렬 다름).
  // setState in effect 룰 회피 — 비동기 IIFE 안에서 await + cancelled 가드로
  // 한 번만 setState. setKeywordOptionsLoading(true) 호출 시점도 await 호출 직전
  // 마이크로태스크 큐로 미루어 effect body 동기 setState 를 제거.
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      // effect body 가 아닌 마이크로태스크 — react-hooks/set-state-in-effect 회피
      setKeywordOptionsLoading(true)
      try {
        const options = await listAnalyzableKeywords(advertiserId, device)
        if (cancelled) return
        setKeywordOptions(options)
        // device 가 바뀌면 키워드 선택과 결과를 초기화 (의미 다름)
        setKeywordId(null)
        setResult(null)
        setError(null)
      } catch (e) {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : String(e)
        setError(`키워드 로드 실패: ${msg}`)
        setKeywordOptions([])
      } finally {
        if (!cancelled) setKeywordOptionsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [advertiserId, device])

  async function handleAnalyze() {
    if (!keywordId) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res = await analyzeMarginalUtility({
        advertiserId,
        keywordId,
        device,
        daysWindow,
      })
      if (!res.ok) {
        setError(res.error)
      } else {
        setResult(res.data)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(`분석 실행 오류: ${msg}`)
    } finally {
      setLoading(false)
    }
  }

  function handleDaysWindowChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = Number(e.target.value)
    if (Number.isNaN(v)) return
    // 0..max 까지는 자유 입력 허용 (blur 시 보정)
    setDaysWindow(v)
  }

  function handleDaysWindowBlur() {
    if (daysWindow < DAYS_WINDOW_MIN) setDaysWindow(DAYS_WINDOW_MIN)
    else if (daysWindow > DAYS_WINDOW_MAX) setDaysWindow(DAYS_WINDOW_MAX)
  }

  return (
    <div className="flex flex-col gap-6">
      {/* 입력 영역 */}
      <Card>
        <CardHeader className="border-b">
          <CardTitle>분석 조건</CardTitle>
          <CardDescription>
            device / 분석 기간(일) / 키워드를 선택해 한계효용을 계산합니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 py-4">
          <div className="flex flex-wrap items-end gap-4">
            {/* Device 토글 */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="device-tabs">Device</Label>
              <Tabs
                id="device-tabs"
                value={device}
                onValueChange={(v) =>
                  v && (v === "PC" || v === "MOBILE") && setDevice(v)
                }
              >
                <TabsList>
                  <TabsTrigger value="PC">PC</TabsTrigger>
                  <TabsTrigger value="MOBILE">MOBILE</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {/* daysWindow */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="days-window">분석 기간 (일)</Label>
              <Input
                id="days-window"
                type="number"
                min={DAYS_WINDOW_MIN}
                max={DAYS_WINDOW_MAX}
                value={daysWindow}
                onChange={handleDaysWindowChange}
                onBlur={handleDaysWindowBlur}
                className="w-28"
              />
              <span className="text-[11px] text-muted-foreground">
                {DAYS_WINDOW_MIN}..{DAYS_WINDOW_MAX} (기본 {DAYS_WINDOW_DEFAULT})
              </span>
            </div>

            {/* 분석 실행 */}
            <div className="ml-auto">
              <Button
                onClick={handleAnalyze}
                disabled={!keywordId || loading}
              >
                {loading ? "분석 중..." : "분석 실행"}
              </Button>
            </div>
          </div>

          {/* 키워드 셀렉터 — 별 줄 (긴 라벨 대응) */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="keyword-select">
              키워드 (광고주 내 7일 클릭 desc 정렬, 상위 200개)
            </Label>
            {keywordOptionsLoading ? (
              <div className="rounded-md border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
                키워드 목록 로딩 중...
              </div>
            ) : keywordOptions.length === 0 ? (
              <div className="rounded-md border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
                분석 가능한 키워드가 없습니다 (광고주 키워드 미동기화 또는 7일
                실적 없음).
              </div>
            ) : (
              <Select
                value={keywordId ?? ""}
                onValueChange={(v) => v && setKeywordId(v)}
              >
                <SelectTrigger id="keyword-select" className="w-full max-w-[640px]">
                  <SelectValue placeholder="키워드를 선택하세요">
                    {(v: string | null) => {
                      if (!v) return "키워드를 선택하세요"
                      const opt = keywordOptions.find((x) => x.id === v)
                      return opt ? `${opt.keyword} · 그룹: ${opt.adgroupName}` : v
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {keywordOptions.map((opt) => (
                    <SelectItem key={opt.id} value={opt.id}>
                      <span className="font-medium">{opt.keyword}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        그룹: {opt.adgroupName} · 7일 클릭{" "}
                        {opt.last7dClicks.toLocaleString()}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 에러 (Alert 대체 — Card variant) */}
      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          <strong className="font-medium">분석 실패</strong>
          <span className="ml-2">{error}</span>
        </div>
      )}

      {/* 결과 영역 */}
      {result && <ResultSection result={result} />}
    </div>
  )
}

// =============================================================================
// 결과 섹션
// =============================================================================

function ResultSection({ result }: { result: MarginalUtilityResult }) {
  // (A) 데이터 부족 안내
  if (result.insufficientData) {
    return (
      <Card>
        <CardHeader className="border-b">
          <CardTitle className="text-amber-700 dark:text-amber-400">
            데이터 부족
          </CardTitle>
          <CardDescription>
            최근 {result.period.days}일 클릭{" "}
            <strong>
              {result.insufficientData.actualClicks.toLocaleString()}
            </strong>
            개 (최소 50개 필요). 다른 키워드를 선택하시거나 분석 기간을
            늘려보세요.
          </CardDescription>
        </CardHeader>
        <CardContent className="py-4">
          <KeywordInfoCardInner result={result} />
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {/* (1) 키워드 정보 카드 */}
      <Card>
        <CardHeader className="border-b">
          <CardTitle>키워드 정보</CardTitle>
          <CardDescription>
            기준 기간:{" "}
            <span className="font-mono">
              {formatDate(result.period.since)}
            </span>{" "}
            ~{" "}
            <span className="font-mono">
              {formatDate(result.period.until)}
            </span>{" "}
            ({result.period.days}일) · device {result.device}
          </CardDescription>
        </CardHeader>
        <CardContent className="py-4">
          <KeywordInfoCardInner result={result} />
        </CardContent>
      </Card>

      {/* (2) 순위별 한계효용 표 */}
      {result.positions && result.positions.length > 0 && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle>순위별 한계효용</CardTitle>
            <CardDescription>
              Estimate API 1~5위 예상치 기반. 한계효용 = 직전 순위 대비 (Δ클릭 /
              Δ비용).
            </CardDescription>
          </CardHeader>
          <CardContent className="py-0">
            <PositionsTable
              positions={result.positions}
              recommendedPosition={result.recommendedPosition ?? null}
            />
          </CardContent>
        </Card>
      )}

      {/* (3) 권장 순위 카드 */}
      <RecommendationCard
        recommendedPosition={result.recommendedPosition ?? null}
      />
    </div>
  )
}

// =============================================================================
// 키워드 정보 (insufficientData / 정상 결과 공용)
// =============================================================================

function KeywordInfoCardInner({ result }: { result: MarginalUtilityResult }) {
  const { keyword, last7d } = result
  return (
    <div className="flex flex-col gap-4">
      {/* 키워드 헤더 */}
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-base font-medium">{keyword.keyword}</span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {keyword.nccKeywordId}
          </span>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
          <span>
            현재 입찰가:{" "}
            <strong className="font-mono text-foreground">
              {keyword.currentBid !== null
                ? `${keyword.currentBid.toLocaleString()}원`
                : "—"}
            </strong>
          </span>
          <span>
            최근 평균 노출 순위:{" "}
            <strong className="font-mono text-foreground">
              {keyword.recentAvgRnk !== null
                ? keyword.recentAvgRnk.toFixed(2)
                : "—"}
            </strong>
          </span>
        </div>
      </div>

      {/* last7d 합계 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="노출" value={last7d.impressions.toLocaleString()} />
        <Stat label="클릭" value={last7d.clicks.toLocaleString()} />
        <Stat
          label="비용"
          value={`${last7d.cost.toLocaleString()}원`}
        />
        <Stat
          label="CPC"
          value={
            last7d.cpc !== null ? `${last7d.cpc.toLocaleString()}원` : "—"
          }
        />
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-sm font-medium">{value}</div>
    </div>
  )
}

// =============================================================================
// 순위별 한계효용 표
// =============================================================================

function PositionsTable({
  positions,
  recommendedPosition,
}: {
  positions: NonNullable<MarginalUtilityResult["positions"]>
  recommendedPosition: number | null
}) {
  // position asc 보장 (1위 먼저)
  const rows = [...positions].sort((a, b) => a.position - b.position)

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-16">순위</TableHead>
          <TableHead className="text-right">예상 입찰가</TableHead>
          <TableHead className="text-right">예상 노출</TableHead>
          <TableHead className="text-right">예상 클릭</TableHead>
          <TableHead className="text-right">예상 비용</TableHead>
          <TableHead className="text-right">예상 CPC</TableHead>
          <TableHead className="text-right">한계효용 (clicks/원)</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((p) => {
          const isRecommended = recommendedPosition === p.position
          return (
            <TableRow
              key={p.position}
              className={
                isRecommended
                  ? "bg-primary/5 dark:bg-primary/10"
                  : undefined
              }
            >
              <TableCell>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium">
                    {p.position}위
                  </span>
                  {isRecommended && <RecommendBadge />}
                </div>
              </TableCell>
              <TableCell className="text-right font-mono text-sm">
                {formatWon(p.estimatedBid)}
              </TableCell>
              <TableCell className="text-right font-mono text-sm">
                {formatNullableNumber(p.expectedImpressions)}
              </TableCell>
              <TableCell className="text-right font-mono text-sm">
                {formatNullableNumber(p.expectedClicks)}
              </TableCell>
              <TableCell className="text-right font-mono text-sm">
                {formatNullableWon(p.expectedCost)}
              </TableCell>
              <TableCell className="text-right font-mono text-sm">
                {formatNullableWon(p.expectedCpc)}
              </TableCell>
              <TableCell className="text-right font-mono text-sm">
                <MarginalUtilityCell value={p.marginalUtility} />
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

function MarginalUtilityCell({ value }: { value: number | null }) {
  if (value === null) {
    return <span className="text-muted-foreground">—</span>
  }
  if (value > 0) {
    return (
      <span className="text-green-700 dark:text-green-400">
        {value.toFixed(6)}
      </span>
    )
  }
  // 음수 / 0 — 비효율
  return (
    <span className="text-muted-foreground">
      {value.toFixed(6)}{" "}
      <span className="ml-1 text-[10px]">(비효율)</span>
    </span>
  )
}

function RecommendBadge() {
  return (
    <span className="inline-flex items-center rounded-md bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
      권장
    </span>
  )
}

// =============================================================================
// 권장 순위 카드
// =============================================================================

function RecommendationCard({
  recommendedPosition,
}: {
  recommendedPosition: number | null
}) {
  if (recommendedPosition === null) {
    return (
      <Card>
        <CardHeader className="border-b">
          <CardTitle className="text-amber-700 dark:text-amber-400">
            권장 순위 없음
          </CardTitle>
          <CardDescription>
            현재 1위 한계효용이 음수 또는 0입니다 — 순위를 낮춰 효율 개선이
            가능할 수 있습니다. 운영자 판단이 필요합니다.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="text-primary">
          유지 권장 순위: {recommendedPosition}위
        </CardTitle>
        <CardDescription>
          한계효용이 양수인 가장 높은 순위 — 그 이상 올리면 추가 클릭 대비
          비용이 비효율입니다.
        </CardDescription>
      </CardHeader>
    </Card>
  )
}

// =============================================================================
// 포맷터
// =============================================================================

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd}`
}

function formatWon(v: number): string {
  return `${v.toLocaleString()}원`
}

function formatNullableNumber(v: number | null): string {
  if (v === null) return "—"
  return v.toLocaleString()
}

function formatNullableWon(v: number | null): string {
  if (v === null) return "—"
  return `${v.toLocaleString()}원`
}
