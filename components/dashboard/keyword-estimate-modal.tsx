"use client"

/**
 * 키워드 입찰가 시뮬레이터 모달 (F-10.1 / F-10.2 / F-10.3)
 *
 * 키워드 행 액션에서 호출되는 단건 키워드 시뮬레이터.
 * shadcn Dialog + Tabs 기반. 3개 탭 (평균 순위 / 최소 노출 / 성과 시뮬레이터).
 *
 * Server Action 호출 (조회만 — staging 미적용):
 *   - F-10.1 getAveragePositionBid       → 순위 1~5 표
 *   - F-10.2 getExposureMinimumBid       → minBid 단일 카드
 *   - F-10.3 getPerformanceBulk(bids[])  → bid × 성과 표 (1..20 unique positive)
 *
 * 상태 모델:
 *   - 각 탭별 독립 React state (탭 전환 시 결과 보존)
 *   - device(PC/MOBILE) 변경 → 모든 탭 결과 reset (cache key 가 device 별로 다르므로 재조회 필요)
 *   - keyword prop 자체가 바뀌면 (다른 키워드 행에서 재오픈) 호출자가 `key=keyword.id`
 *     로 강제 unmount → 본 컴포넌트는 초기 상태로 깨끗이 재마운트
 *
 * 캐시 표시:
 *   - cachedAll=true 면 "캐시 사용" 배지 (F-10.1/10.2)
 *   - F-10.3 부분 hit/miss 일 때 cachedCount/총 bids 비율 표시
 *
 * 광고주 컨텍스트 격리:
 *   - props 의 advertiserId 를 그대로 Server Action 에 전달.
 *   - Server Action 측에서 keyword 의 광고주 소속 검증 (loadKeywordForAdvertiser).
 *
 * 권한:
 *   - viewer 도 사용 가능 (read 액션). UI 레벨 별도 차단 없음.
 *
 * 미적용 (의도적):
 *   - staging 누적 — 본 모달은 read 전용. 결과를 키워드 행 입찰가로 자동 반영하지 않음.
 *     사용자가 결과 참고 후 셀 인라인 편집으로 수동 입력 (F-3.2 staging 흐름 사용).
 *   - 결과 영구 저장 — Server Action 측 30분 캐시(EstimateCache)만 의존.
 *
 * SPEC 6.2 F-10 / 11.2 / 안전장치 5.
 */

import * as React from "react"
import { CalculatorIcon, SparklesIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import {
  getAveragePositionBid,
  getExposureMinimumBid,
  getPerformanceBulk,
  type EstimateActionResult,
} from "@/app/(dashboard)/[advertiserId]/keywords/estimate-actions"
import type {
  AveragePositionBidRow,
  ExposureMinimumBidRow,
  PerformanceBulkRow,
} from "@/lib/naver-sa/estimate"

// =============================================================================
// 타입
// =============================================================================

type Device = "PC" | "MOBILE"

/** 모달 헤더에 표시할 키워드 식별 정보 — KeywordRow 의존성 차단. */
export type EstimateTargetKeyword = {
  /** 앱 DB Keyword.id (Server Action 페이로드) */
  id: string
  /** SA 키워드 ID (사용자 표시) */
  nccKeywordId: string
  /** 키워드 텍스트 (헤더 + 결과 표시용) */
  keyword: string
}

export type KeywordEstimateModalProps = {
  open: boolean
  onOpenChange: (next: boolean) => void
  advertiserId: string
  /** null 이면 모달 미렌더 (호출자에서 mount/unmount 제어 권장) */
  keyword: EstimateTargetKeyword | null
}

/** 각 탭별 비동기 상태. */
type AsyncState<T> =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "ok"
      data: T
      cachedAll: boolean
      cachedCount: number
      /** F-10.3 — 입력 bids 길이 보존 (응답에 누락된 bid 안내용) */
      requestedCount?: number
    }
  | { kind: "error"; message: string }

// =============================================================================
// chip input 파서 (F-10.3)
// =============================================================================

/**
 * 사용자 입력 텍스트 → 정수 배열.
 *
 * 허용 구분자: 콤마 / 공백 / 줄바꿈 / 탭. 음수 / 0 / 비정수 / NaN 은 invalid.
 * 1..20 개 unique positive 만 허용 (Server Action zod 와 일치).
 *
 * 반환:
 *   - { ok: true, bids } — 검증 통과 (정렬 안 함, 호출부가 그대로 전달; Server Action 이 정렬)
 *   - { ok: false, error } — 사용자 표시용 에러 메시지
 */
function parseBidsInput(
  raw: string,
): { ok: true; bids: number[] } | { ok: false; error: string } {
  const trimmed = raw.trim()
  if (trimmed === "") {
    return { ok: false, error: "입찰가를 1개 이상 입력하세요" }
  }
  // 콤마 / 공백 / 줄바꿈 / 탭 분리
  const tokens = trimmed
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  if (tokens.length === 0) {
    return { ok: false, error: "입찰가를 1개 이상 입력하세요" }
  }
  if (tokens.length > 20) {
    return {
      ok: false,
      error: `최대 20개까지 입력 가능합니다 (현재 ${tokens.length}개)`,
    }
  }
  const bids: number[] = []
  for (const tok of tokens) {
    const n = Number(tok)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      return {
        ok: false,
        error: `잘못된 입찰가: "${tok}" — 양의 정수만 허용`,
      }
    }
    if (n > 100_000) {
      return { ok: false, error: `입찰가는 100,000 이하여야 합니다 (${n})` }
    }
    bids.push(n)
  }
  if (new Set(bids).size !== bids.length) {
    return { ok: false, error: "중복된 입찰가가 있습니다" }
  }
  return { ok: true, bids }
}

// =============================================================================
// 캐시 배지 (시각 보조)
// =============================================================================

function CacheBadge({
  cachedAll,
  cachedCount,
  total,
}: {
  cachedAll: boolean
  cachedCount: number
  /** F-10.3 — 부분 hit 비율 표시용. F-10.1/10.2 는 생략 (1 entry). */
  total?: number
}) {
  if (cachedAll) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
        <SparklesIcon className="size-3" />
        캐시 사용
      </span>
    )
  }
  if (cachedCount > 0 && typeof total === "number" && total > 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-medium text-sky-800 dark:bg-sky-900/30 dark:text-sky-300">
        <SparklesIcon className="size-3" />
        부분 캐시 ({cachedCount}/{total})
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
      신규 호출
    </span>
  )
}

// =============================================================================
// 에러 표시 (shadcn Alert 미존재 → destructive 풍 div)
// =============================================================================

function ErrorAlert({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
    >
      {message}
    </div>
  )
}

// =============================================================================
// 메인 모달
// =============================================================================

export function KeywordEstimateModal({
  open,
  onOpenChange,
  advertiserId,
  keyword,
}: KeywordEstimateModalProps) {
  // device 토글 — 변경 시 모든 탭 결과 reset (캐시 키가 device 별이므로).
  const [device, setDevice] = React.useState<Device>("PC")
  // 각 탭별 결과 상태
  const [avgState, setAvgState] = React.useState<
    AsyncState<AveragePositionBidRow[]>
  >({ kind: "idle" })
  const [minState, setMinState] = React.useState<
    AsyncState<ExposureMinimumBidRow>
  >({ kind: "idle" })
  const [perfState, setPerfState] = React.useState<
    AsyncState<PerformanceBulkRow[]>
  >({ kind: "idle" })

  // F-10.3 입찰가 입력 (chip input — 텍스트 파싱)
  const [bidsInput, setBidsInput] = React.useState<string>("100, 200, 500")

  // 활성 탭 (Tabs 의 controlled value)
  const [tab, setTab] = React.useState<string>("average")

  // 주: keyword 변경 시 reset 은 호출자가 `key=keyword.id` 로 강제 unmount/remount.
  // 본 컴포넌트 안에서 useEffect+setState 로 keyword?.id 변동을 감지하면 React
  // Compiler 가 cascading render 경고 (set-state-in-effect) — key 패턴이 더 깨끗.

  // -- device 변경 시 결과 reset (입력값은 보존) -------------------------------
  function handleDeviceChange(next: Device) {
    if (next === device) return
    setDevice(next)
    setAvgState({ kind: "idle" })
    setMinState({ kind: "idle" })
    setPerfState({ kind: "idle" })
  }

  // -- F-10.1 평균 순위 -------------------------------------------------------
  async function handleFetchAverage() {
    if (!keyword) return
    setAvgState({ kind: "loading" })
    const res: EstimateActionResult<AveragePositionBidRow[]> =
      await getAveragePositionBid({
        advertiserId,
        keywordId: keyword.id,
        device,
      })
    if (!res.ok) {
      setAvgState({ kind: "error", message: res.error })
      return
    }
    setAvgState({
      kind: "ok",
      data: res.data,
      cachedAll: res.cachedAll,
      cachedCount: res.cachedCount,
    })
  }

  // -- F-10.2 최소 노출 -------------------------------------------------------
  async function handleFetchMinimum() {
    if (!keyword) return
    setMinState({ kind: "loading" })
    const res: EstimateActionResult<ExposureMinimumBidRow> =
      await getExposureMinimumBid({
        advertiserId,
        keywordId: keyword.id,
        device,
      })
    if (!res.ok) {
      setMinState({ kind: "error", message: res.error })
      return
    }
    setMinState({
      kind: "ok",
      data: res.data,
      cachedAll: res.cachedAll,
      cachedCount: res.cachedCount,
    })
  }

  // -- F-10.3 성과 시뮬레이터 --------------------------------------------------
  async function handleFetchPerformance() {
    if (!keyword) return
    const parsed = parseBidsInput(bidsInput)
    if (!parsed.ok) {
      setPerfState({ kind: "error", message: parsed.error })
      return
    }
    setPerfState({ kind: "loading" })
    const res: EstimateActionResult<PerformanceBulkRow[]> =
      await getPerformanceBulk({
        advertiserId,
        keywordId: keyword.id,
        device,
        bids: parsed.bids,
      })
    if (!res.ok) {
      setPerfState({ kind: "error", message: res.error })
      return
    }
    setPerfState({
      kind: "ok",
      data: res.data,
      cachedAll: res.cachedAll,
      cachedCount: res.cachedCount,
      requestedCount: parsed.bids.length,
    })
  }

  // keyword null 이면 모달 미렌더 — 호출자에서 보통 mount 제어. 안전망.
  if (!keyword) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalculatorIcon className="size-4" />
            <span>입찰가 시뮬레이터 — </span>
            <span className="font-medium">{keyword.keyword}</span>
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            <span className="font-mono text-[11px]">{keyword.nccKeywordId}</span>
            <span className="text-muted-foreground/60">·</span>
            <span className="text-xs text-muted-foreground">
              조회 결과는 30분간 캐시됩니다. device 변경 시 재조회 필요.
            </span>
          </DialogDescription>
        </DialogHeader>

        {/* device 토글 */}
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">디바이스</Label>
          <div className="inline-flex rounded-md border bg-muted/30 p-0.5">
            <button
              type="button"
              onClick={() => handleDeviceChange("PC")}
              className={cn(
                "rounded px-3 py-1 text-xs font-medium transition-colors",
                device === "PC"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              PC
            </button>
            <button
              type="button"
              onClick={() => handleDeviceChange("MOBILE")}
              className={cn(
                "rounded px-3 py-1 text-xs font-medium transition-colors",
                device === "MOBILE"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              MOBILE
            </button>
          </div>
        </div>

        <Tabs
          value={tab}
          onValueChange={(v) => {
            if (typeof v === "string") setTab(v)
          }}
        >
          <TabsList>
            <TabsTrigger value="average">평균 순위</TabsTrigger>
            <TabsTrigger value="minimum">최소 노출</TabsTrigger>
            <TabsTrigger value="performance">성과 시뮬레이터</TabsTrigger>
          </TabsList>

          {/* Tab 1 — F-10.1 평균 순위 입찰가 */}
          <TabsContent value="average" className="pt-3">
            <AveragePositionPanel
              state={avgState}
              onFetch={handleFetchAverage}
            />
          </TabsContent>

          {/* Tab 2 — F-10.2 최소 노출 입찰가 */}
          <TabsContent value="minimum" className="pt-3">
            <ExposureMinimumPanel
              state={minState}
              onFetch={handleFetchMinimum}
            />
          </TabsContent>

          {/* Tab 3 — F-10.3 성과 시뮬레이터 */}
          <TabsContent value="performance" className="pt-3">
            <PerformanceBulkPanel
              state={perfState}
              bidsInput={bidsInput}
              onBidsInputChange={setBidsInput}
              onFetch={handleFetchPerformance}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

// =============================================================================
// Tab 1 — 평균 순위 입찰가 (F-10.1)
// =============================================================================

function AveragePositionPanel({
  state,
  onFetch,
}: {
  state: AsyncState<AveragePositionBidRow[]>
  onFetch: () => void | Promise<void>
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          순위 1위 ~ 5위에 노출되기 위해 필요한 추정 입찰가입니다.
        </p>
        <Button
          size="sm"
          onClick={onFetch}
          disabled={state.kind === "loading"}
        >
          {state.kind === "loading" ? "조회 중..." : "조회"}
        </Button>
      </div>

      {state.kind === "error" && <ErrorAlert message={state.message} />}

      {state.kind === "ok" && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <CacheBadge
              cachedAll={state.cachedAll}
              cachedCount={state.cachedCount}
            />
            {state.data.length === 0 && (
              <span className="text-xs text-muted-foreground">
                응답 데이터 없음
              </span>
            )}
          </div>
          {state.data.length > 0 && (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-24">순위</TableHead>
                    <TableHead className="text-right">추정 입찰가</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...state.data]
                    .sort((a, b) => a.position - b.position)
                    .map((r) => (
                      <TableRow key={r.position}>
                        <TableCell className="font-medium">
                          {r.position}위
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {r.bid.toLocaleString()}원
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      {state.kind === "idle" && (
        <p className="rounded-md border border-dashed bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
          조회 버튼을 눌러 평균 순위 입찰가를 가져오세요.
        </p>
      )}
    </div>
  )
}

// =============================================================================
// Tab 2 — 최소 노출 입찰가 (F-10.2)
// =============================================================================

function ExposureMinimumPanel({
  state,
  onFetch,
}: {
  state: AsyncState<ExposureMinimumBidRow>
  onFetch: () => void | Promise<void>
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          이 키워드가 최소한 노출되기 위해 필요한 추정 입찰가입니다.
        </p>
        <Button
          size="sm"
          onClick={onFetch}
          disabled={state.kind === "loading"}
        >
          {state.kind === "loading" ? "조회 중..." : "조회"}
        </Button>
      </div>

      {state.kind === "error" && <ErrorAlert message={state.message} />}

      {state.kind === "ok" && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <CacheBadge
              cachedAll={state.cachedAll}
              cachedCount={state.cachedCount}
            />
          </div>
          <div className="flex flex-col items-center gap-1 rounded-md border bg-muted/30 px-4 py-6">
            <span className="text-xs text-muted-foreground">최소 노출 입찰가</span>
            <span className="font-mono text-2xl font-medium">
              {state.data.minBid.toLocaleString()}원
            </span>
          </div>
        </div>
      )}

      {state.kind === "idle" && (
        <p className="rounded-md border border-dashed bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
          조회 버튼을 눌러 최소 노출 입찰가를 가져오세요.
        </p>
      )}
    </div>
  )
}

// =============================================================================
// Tab 3 — 성과 시뮬레이터 (F-10.3)
// =============================================================================

function PerformanceBulkPanel({
  state,
  bidsInput,
  onBidsInputChange,
  onFetch,
}: {
  state: AsyncState<PerformanceBulkRow[]>
  bidsInput: string
  onBidsInputChange: (next: string) => void
  onFetch: () => void | Promise<void>
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor="estimate-bids" className="text-xs text-muted-foreground">
          입찰가 후보 (콤마/공백 구분, 1~20개, 양의 정수)
        </Label>
        <div className="flex items-center gap-2">
          <Input
            id="estimate-bids"
            value={bidsInput}
            onChange={(e) => onBidsInputChange(e.target.value)}
            placeholder="예: 100, 200, 500, 1000"
            className="font-mono"
            disabled={state.kind === "loading"}
          />
          <Button
            size="sm"
            onClick={onFetch}
            disabled={state.kind === "loading"}
          >
            {state.kind === "loading" ? "조회 중..." : "조회"}
          </Button>
        </div>
      </div>

      {state.kind === "error" && <ErrorAlert message={state.message} />}

      {state.kind === "ok" && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <CacheBadge
              cachedAll={state.cachedAll}
              cachedCount={state.cachedCount}
              total={state.requestedCount}
            />
            {typeof state.requestedCount === "number" &&
              state.data.length < state.requestedCount && (
                <span className="text-xs text-amber-700 dark:text-amber-400">
                  요청 {state.requestedCount}건 중 {state.data.length}건만 응답
                  — 나머지 입찰가는 데이터 부족으로 누락
                </span>
              )}
          </div>
          {state.data.length > 0 ? (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-right">입찰가</TableHead>
                    <TableHead className="text-right">노출 (impr.)</TableHead>
                    <TableHead className="text-right">클릭</TableHead>
                    <TableHead className="text-right">비용</TableHead>
                    <TableHead className="text-right">CPC</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...state.data]
                    .sort((a, b) => a.bid - b.bid)
                    .map((r) => (
                      <TableRow key={r.bid}>
                        <TableCell className="text-right font-mono font-medium">
                          {r.bid.toLocaleString()}원
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatMaybeNumber(r.impressions)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatMaybeNumber(r.clicks)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatMaybeNumber(r.cost, "원")}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatMaybeNumber(r.cpc, "원")}
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="rounded-md border border-dashed bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
              응답 데이터가 없습니다 (네이버 측 데이터 부족 — 다른 입찰가 시도)
            </p>
          )}
        </div>
      )}

      {state.kind === "idle" && (
        <p className="rounded-md border border-dashed bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
          입찰가 후보를 입력하고 조회 버튼을 눌러 성과 추정치를 가져오세요.
        </p>
      )}
    </div>
  )
}

/**
 * nullable 숫자 포맷 — null/undefined 면 "—". 천 단위 콤마 + 옵션 단위.
 */
function formatMaybeNumber(
  v: number | null | undefined,
  unit?: string,
): string {
  if (v === null || v === undefined) return "—"
  const text = v.toLocaleString()
  return unit ? `${text}${unit}` : text
}
