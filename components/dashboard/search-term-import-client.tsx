"use client"

/**
 * F-D.3 검색어 보고서 CSV 업로드 — 클라이언트 컴포넌트.
 *
 * 흐름:
 *   1. 파일 선택 (.csv / .tsv) — 단일 파일
 *   2. "분석" 클릭 → File → text → analyzeSearchTermCsv server action 호출
 *   3. 결과:
 *      - 분류 카운트 카드 (new / exclude / 합계)
 *      - 두 탭("신규 후보" / "제외 후보") — 검색어 / 노출 / 클릭 / 비용 / CPA / 사유
 *      - 정렬 셀렉터 (비용 desc 기본 / 클릭 desc / 노출 desc)
 *   4. (선택) "보고서 저장" → saveSearchTermReport (operator+ 만)
 *      - weekStart 기본값 = RSC 가 계산한 이번 주 월요일
 *
 * 패턴 / 의도:
 *   - shadcn Table + Tabs (가상 스크롤 미적용 — 분류 결과 행 < 1만 가정)
 *     광고주별 검색어 보고서 평균 < 5천 행, 분류 후 < 2천 행 (운영 기준)
 *   - 즉시 SA write 절대 X — 본 컴포넌트는 분석 + (선택)DB 저장만
 *   - 자동 등록 안내 메시지 명시 (사용자가 콘솔에서 직접 등록)
 *
 * 비대상 (후속 PR):
 *   - 광고그룹 매핑 (검색어 → 등록할 adgroupId 사용자 선택)
 *   - ChangeBatch 적재 / SA write
 *   - ApprovalQueue 적재
 *
 * SPEC v0.2.1 F-D.3 + plan(graceful-sparking-graham) Phase D.3
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  UploadIcon,
  FileTextIcon,
  CircleAlertIcon,
  SaveIcon,
  CheckCircle2Icon,
  XCircleIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  analyzeSearchTermCsv,
  saveSearchTermReport,
  enqueueSearchTermPromote,
  type AnalyzeSearchTermCsvResult,
  type ClassificationItem,
} from "@/app/(dashboard)/[advertiserId]/search-term-import/actions"
import { cn } from "@/lib/utils"

export type AdgroupOption = {
  id: string
  name: string
  status: "on" | "off" | "deleted"
  campaignName: string
}

// =============================================================================
// 타입
// =============================================================================

const MAX_FILE_BYTES = 30 * 1024 * 1024 // 30MB
const ALLOWED_EXTS = [".csv", ".tsv", ".txt"] as const
const TAKE_LIMIT = 200

type SortKey = "cost" | "clicks" | "impressions"

type BaselineForDisplay = {
  avgCtr: number | null
  avgCvr: number | null
  avgCpc: number | null
  dataDays: number
  refreshedAt: string
} | null

// =============================================================================
// 메인 컴포넌트
// =============================================================================

export function SearchTermImportClient({
  advertiserId,
  userRole,
  baselineForDisplay,
  defaultWeekStart,
  adgroupOptions,
}: {
  advertiserId: string
  userRole: "admin" | "operator" | "viewer"
  baselineForDisplay: BaselineForDisplay
  defaultWeekStart: string // yyyy-mm-dd
  adgroupOptions: AdgroupOption[]
}) {
  const router = useRouter()
  const canMutate = userRole === "admin" || userRole === "operator"

  // -- 신규 후보 탭 — 행별 광고그룹 매핑 / 선택 / 큐 적재 dimmed --------------
  // searchTerm 키로 (multi-tenant 같은 행이 두 번 표시되지 않음 — classify 가 unique 보장).
  const [adgroupBySearchTerm, setAdgroupBySearchTerm] = React.useState<
    Map<string, string>
  >(new Map())
  const [selectedSearchTerms, setSelectedSearchTerms] = React.useState<
    Set<string>
  >(new Set())
  const [enqueuedSearchTerms, setEnqueuedSearchTerms] = React.useState<
    Set<string>
  >(new Set())
  const [enqueuing, setEnqueuing] = React.useState(false)

  function setAdgroupFor(searchTerm: string, adgroupId: string) {
    setAdgroupBySearchTerm((prev) => {
      const next = new Map(prev)
      next.set(searchTerm, adgroupId)
      return next
    })
  }
  function toggleSelected(searchTerm: string) {
    setSelectedSearchTerms((prev) => {
      const next = new Set(prev)
      if (next.has(searchTerm)) next.delete(searchTerm)
      else next.add(searchTerm)
      return next
    })
  }

  // -- 파일 / 분석 상태 ------------------------------------------------------
  const [file, setFile] = React.useState<File | null>(null)
  const [fileError, setFileError] = React.useState<string | null>(null)
  const [analyzing, setAnalyzing] = React.useState(false)
  const [result, setResult] =
    React.useState<AnalyzeSearchTermCsvResult | null>(null)

  // -- 보고서 저장 상태 ------------------------------------------------------
  const [weekStart, setWeekStart] = React.useState<string>(defaultWeekStart)
  const [saving, setSaving] = React.useState(false)
  const [savedReportId, setSavedReportId] = React.useState<string | null>(null)

  // -- 정렬 / 탭 상태 --------------------------------------------------------
  const [sortKey, setSortKey] = React.useState<SortKey>("cost")
  const [activeTab, setActiveTab] = React.useState<"new" | "exclude">("new")

  // -- 파일 핸들러 ----------------------------------------------------------
  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setFileError(null)
    setResult(null)
    setSavedReportId(null)
    const f = e.target.files?.[0] ?? null
    if (!f) {
      setFile(null)
      return
    }
    // 확장자 검사
    const lower = f.name.toLowerCase()
    if (!ALLOWED_EXTS.some((ext) => lower.endsWith(ext))) {
      setFileError(
        `허용되지 않는 파일 확장자입니다 (${ALLOWED_EXTS.join(", ")})`,
      )
      setFile(null)
      return
    }
    if (f.size > MAX_FILE_BYTES) {
      setFileError(
        `파일이 너무 큽니다 (${(f.size / 1024 / 1024).toFixed(1)}MB > 30MB)`,
      )
      setFile(null)
      return
    }
    setFile(f)
  }

  async function handleAnalyze() {
    if (!file) return
    setAnalyzing(true)
    setSavedReportId(null)
    try {
      const text = await readFileAsUtf8(file)
      const res = await analyzeSearchTermCsv(advertiserId, text)
      if (!res.ok) {
        toast.error(`분석 실패: ${res.error}`)
        setResult(null)
        return
      }
      setResult(res.data)
      toast.success(`분석 완료 — ${res.data.classifications.length}건 후보`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`분석 오류: ${msg}`)
    } finally {
      setAnalyzing(false)
    }
  }

  async function handleEnqueuePromote() {
    if (!result) return
    if (selectedSearchTerms.size === 0) return

    // 광고그룹 미선택 차단
    const items: Array<{
      searchTerm: string
      adgroupId: string
      metrics: ClassificationItem["metrics"]
    }> = []
    const missingAdgroup: string[] = []
    for (const c of result.classifications) {
      if (c.classification !== "new") continue
      if (!selectedSearchTerms.has(c.searchTerm)) continue
      if (enqueuedSearchTerms.has(c.searchTerm)) continue // 이미 dimmed
      const adgroupId = adgroupBySearchTerm.get(c.searchTerm)
      if (!adgroupId) {
        missingAdgroup.push(c.searchTerm)
        continue
      }
      items.push({
        searchTerm: c.searchTerm,
        adgroupId,
        metrics: c.metrics,
      })
    }

    if (missingAdgroup.length > 0) {
      toast.error(
        `광고그룹 미선택 ${missingAdgroup.length}건 — 행별 dropdown 으로 광고그룹을 먼저 지정하세요.`,
      )
      return
    }
    if (items.length === 0) {
      toast.error("적재할 항목이 없습니다 (이미 처리됨 / 미선택).")
      return
    }

    setEnqueuing(true)
    try {
      const res = await enqueueSearchTermPromote(advertiserId, items)
      if (!res.ok) {
        toast.error(`큐 적재 실패: ${res.error}`)
        return
      }
      const { createdCount, blockedCount, skippedCount } = res.data
      toast.success(
        `승인 큐 적재 — 신규 ${createdCount}건` +
          (skippedCount > 0 ? ` · 중복 ${skippedCount}건` : "") +
          (blockedCount > 0 ? ` · 차단 ${blockedCount}건` : ""),
      )
      // 적재 완료 행 dimmed 처리 + 선택 해제
      setEnqueuedSearchTerms((prev) => {
        const next = new Set(prev)
        for (const i of items) next.add(i.searchTerm)
        return next
      })
      setSelectedSearchTerms(new Set())
      router.refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`큐 적재 오류: ${msg}`)
    } finally {
      setEnqueuing(false)
    }
  }

  async function handleSaveReport() {
    if (!result) return
    setSaving(true)
    try {
      const res = await saveSearchTermReport(advertiserId, {
        weekStart,
        rows: result.rows,
        classifications: result.classifications,
      })
      if (!res.ok) {
        toast.error(`저장 실패: ${res.error}`)
        return
      }
      setSavedReportId(res.data.reportId)
      toast.success(
        res.data.upserted
          ? `보고서 갱신 완료 (${res.data.weekStart})`
          : `보고서 저장 완료 (${res.data.weekStart})`,
      )
      router.refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`저장 오류: ${msg}`)
    } finally {
      setSaving(false)
    }
  }

  // -- 분류 통계 + 정렬 ------------------------------------------------------
  const stats = React.useMemo(() => {
    if (!result) return { total: 0, newCount: 0, excludeCount: 0 }
    let newCount = 0
    let excludeCount = 0
    for (const c of result.classifications) {
      if (c.classification === "new") newCount++
      else if (c.classification === "exclude") excludeCount++
    }
    return {
      total: result.classifications.length,
      newCount,
      excludeCount,
    }
  }, [result])

  const sortedNew = React.useMemo(
    () =>
      sortAndLimit(
        result?.classifications.filter((c) => c.classification === "new") ?? [],
        sortKey,
      ),
    [result, sortKey],
  )
  const sortedExclude = React.useMemo(
    () =>
      sortAndLimit(
        result?.classifications.filter((c) => c.classification === "exclude") ??
          [],
        sortKey,
      ),
    [result, sortKey],
  )

  // =============================================================================
  // 렌더
  // =============================================================================

  return (
    <div className="flex flex-col gap-4">
      {/* baseline 안내 카드 */}
      <BaselineCard baseline={baselineForDisplay} />

      {/* 업로드 카드 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">CSV 업로드</CardTitle>
          <CardDescription>
            네이버 SA 콘솔 → 보고서 → 검색어 보고서 → 다운로드 한 CSV 를
            업로드하세요. 한글/영문 헤더 모두 지원합니다 (검색어 / 노출수 /
            클릭수 / 총비용 / 전환수, 또는 expKeyword / impCnt / clkCnt /
            salesAmt / ccnt).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="csv-input" className="text-xs">
                파일 선택
              </Label>
              <Input
                id="csv-input"
                type="file"
                accept=".csv,.tsv,.txt,text/csv"
                onChange={onFileChange}
                disabled={analyzing}
                className="w-80"
              />
            </div>
            <Button
              onClick={handleAnalyze}
              disabled={!file || analyzing}
              size="sm"
            >
              {analyzing ? (
                <>분석 중...</>
              ) : (
                <>
                  <UploadIcon className="size-4" />
                  분석
                </>
              )}
            </Button>
            {file && !analyzing && (
              <span className="text-xs text-muted-foreground">
                <FileTextIcon className="mr-1 inline size-3" />
                {file.name} ({(file.size / 1024).toFixed(1)} KB)
              </span>
            )}
          </div>

          {fileError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
              {fileError}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 분석 결과 */}
      {result && (
        <>
          <ResultStats result={result} stats={stats} />

          {/* 분류 결과 탭 */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
              <div>
                <CardTitle className="text-base">분류 결과</CardTitle>
                <CardDescription>
                  광고주 평균 성과 + 임계 룰 기반. 사유 코드별 분류 근거를
                  표시합니다.
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="sort-key" className="text-xs">
                  정렬
                </Label>
                <Select
                  value={sortKey}
                  onValueChange={(v) => setSortKey(v as SortKey)}
                >
                  <SelectTrigger id="sort-key" className="h-8 w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cost">비용 ↓</SelectItem>
                    <SelectItem value="clicks">클릭 ↓</SelectItem>
                    <SelectItem value="impressions">노출 ↓</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>

            <CardContent>
              <Tabs
                value={activeTab}
                onValueChange={(v) => setActiveTab(v as "new" | "exclude")}
              >
                <TabsList>
                  <TabsTrigger value="new">
                    신규 후보
                    <span className="ml-1.5 rounded-full bg-emerald-100 px-1.5 text-[11px] font-medium text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                      {stats.newCount}
                    </span>
                  </TabsTrigger>
                  <TabsTrigger value="exclude">
                    제외 후보
                    <span className="ml-1.5 rounded-full bg-rose-100 px-1.5 text-[11px] font-medium text-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
                      {stats.excludeCount}
                    </span>
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="new">
                  <NewCandidatesTable
                    rows={sortedNew}
                    adgroupOptions={adgroupOptions}
                    adgroupBySearchTerm={adgroupBySearchTerm}
                    onSetAdgroup={setAdgroupFor}
                    selectedSearchTerms={selectedSearchTerms}
                    onToggleSelected={toggleSelected}
                    onToggleAll={(checked) => {
                      setSelectedSearchTerms((prev) => {
                        const next = new Set(prev)
                        for (const r of sortedNew) {
                          if (enqueuedSearchTerms.has(r.searchTerm)) continue
                          if (checked) next.add(r.searchTerm)
                          else next.delete(r.searchTerm)
                        }
                        return next
                      })
                    }}
                    enqueuedSearchTerms={enqueuedSearchTerms}
                    canMutate={canMutate}
                    enqueuing={enqueuing}
                    onEnqueue={handleEnqueuePromote}
                    emptyMessage="신규 후보가 없습니다 — 트래픽 임계(노출 50+ 클릭 3+) 또는 전환 1+ 기준 미달."
                  />
                </TabsContent>
                <TabsContent value="exclude">
                  <ResultTable
                    rows={sortedExclude}
                    emptyMessage="제외 후보가 없습니다 — 노출 100+ 클릭 0 또는 클릭 10+ 전환 0 + CPA 매우 높음 기준."
                  />
                  <div className="mt-3 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    제외 키워드 등록 흐름은 본 PR 비대상입니다 (네이버 SA endpoint 미확인 — 후속 PR).
                  </div>
                </TabsContent>
              </Tabs>

              {(stats.newCount > TAKE_LIMIT ||
                stats.excludeCount > TAKE_LIMIT) && (
                <div className="mt-3 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  표시 한도 {TAKE_LIMIT}건 — 정렬 기준 상위만 표시됩니다.
                  전체는 보고서 저장 후 후속 화면에서 페이지네이션 (Phase D.4
                  Approval Queue).
                </div>
              )}
            </CardContent>
          </Card>

          {/* 안내 */}
          <Card className="border-amber-300 bg-amber-50/40 dark:border-amber-900/60 dark:bg-amber-950/10">
            <CardContent className="flex items-start gap-3 py-3">
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />
              <div className="space-y-1.5 text-xs leading-relaxed">
                <p className="font-medium text-amber-900 dark:text-amber-200">
                  본 도구는 분석 결과만 보여줍니다.
                </p>
                <p className="text-amber-800 dark:text-amber-300">
                  실제 키워드 등록 / 제외 등록은 SA 콘솔에서 직접 진행하세요.
                  검색어 → 키워드 자동 등록 / 제외 키워드 자동 등록은 후속 PR
                  (Approval Queue) 에서 별도 흐름으로 추가됩니다.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* 보고서 저장 (선택) */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">보고서 저장 (선택)</CardTitle>
              <CardDescription>
                분석 결과를 보고서로 저장합니다. 같은 광고주 · 같은 주차는
                덮어쓰기됩니다. 저장된 보고서는 이후 승인 큐로 자동 전달됩니다.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="week-start" className="text-xs">
                  주 시작 (월요일, KST)
                </Label>
                <Input
                  id="week-start"
                  type="date"
                  value={weekStart}
                  onChange={(e) => setWeekStart(e.target.value)}
                  disabled={saving || !canMutate}
                  className="w-44"
                />
              </div>
              <Button
                onClick={handleSaveReport}
                disabled={!canMutate || saving || !result}
                size="sm"
                variant="outline"
              >
                {saving ? (
                  "저장 중..."
                ) : (
                  <>
                    <SaveIcon className="size-4" />
                    보고서 저장
                  </>
                )}
              </Button>
              {!canMutate && (
                <span className="text-xs text-muted-foreground">
                  (viewer 는 저장 불가)
                </span>
              )}
              {savedReportId && (
                <span className="break-all font-mono text-[11px] text-muted-foreground">
                  saved · {savedReportId}
                </span>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

// =============================================================================
// 보조 컴포넌트
// =============================================================================

function BaselineCard({ baseline }: { baseline: BaselineForDisplay }) {
  if (!baseline) {
    return (
      <Card className="border-amber-300 bg-amber-50/40 dark:border-amber-900/60 dark:bg-amber-950/10">
        <CardContent className="flex items-start gap-3 py-3">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />
          <div className="space-y-1 text-xs">
            <p className="font-medium text-amber-900 dark:text-amber-200">
              광고주 평균 성과 데이터가 아직 없습니다.
            </p>
            <p className="text-amber-800 dark:text-amber-300">
              &quot;CPA 매우 높음&quot; 분기는 비활성화됩니다 — 노출/클릭 기준
              분류만 동작합니다. 평균 성과는 매일 자동 갱신되며, 충분한 데이터가
              누적될 때까지 기다려 주세요.
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  const dt = new Date(baseline.refreshedAt)
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-1.5 py-3 text-xs">
        <span className="font-medium">
          광고주 baseline ({baseline.dataDays}일):
        </span>
        <span>
          평균 CPC{" "}
          <strong className="font-mono">
            {baseline.avgCpc !== null
              ? `${Math.round(baseline.avgCpc).toLocaleString()}원`
              : "—"}
          </strong>
        </span>
        <span>
          평균 CTR{" "}
          <strong className="font-mono">
            {baseline.avgCtr !== null
              ? `${(baseline.avgCtr * 100).toFixed(2)}%`
              : "—"}
          </strong>
        </span>
        <span>
          평균 CVR{" "}
          <strong className="font-mono">
            {baseline.avgCvr !== null
              ? `${(baseline.avgCvr * 100).toFixed(2)}%`
              : "—"}
          </strong>
        </span>
        <span className="text-muted-foreground">
          갱신 {dt.toLocaleString("ko-KR")}
        </span>
      </CardContent>
    </Card>
  )
}

function ResultStats({
  result,
  stats,
}: {
  result: AnalyzeSearchTermCsvResult
  stats: { total: number; newCount: number; excludeCount: number }
}) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <StatCard
        label="검색어"
        value={result.searchTermCount}
        unit="개"
        sublabel={`원본 ${result.rawRowCount}행 (skip ${result.skipped})`}
      />
      <StatCard
        label="신규 후보"
        value={stats.newCount}
        unit="개"
        accent="emerald"
        icon={<CheckCircle2Icon className="size-4" />}
      />
      <StatCard
        label="제외 후보"
        value={stats.excludeCount}
        unit="개"
        accent="rose"
        icon={<XCircleIcon className="size-4" />}
      />
      <StatCard
        label="중립"
        value={result.searchTermCount - stats.total}
        unit="개"
        sublabel="신규/제외 임계 미달"
      />
    </div>
  )
}

function StatCard({
  label,
  value,
  unit,
  sublabel,
  accent,
  icon,
}: {
  label: string
  value: number
  unit: string
  sublabel?: string
  accent?: "emerald" | "rose"
  icon?: React.ReactNode
}) {
  const accentCls =
    accent === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : accent === "rose"
        ? "text-rose-600 dark:text-rose-400"
        : "text-foreground"
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 py-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          {icon ? <span className={accentCls}>{icon}</span> : null}
        </div>
        <span className={cn("font-mono text-2xl font-medium", accentCls)}>
          {value.toLocaleString()}
          <span className="ml-0.5 text-sm font-normal text-muted-foreground">
            {unit}
          </span>
        </span>
        {sublabel ? (
          <span className="text-[11px] text-muted-foreground">{sublabel}</span>
        ) : null}
      </CardContent>
    </Card>
  )
}

function ResultTable({
  rows,
  emptyMessage,
}: {
  rows: ClassificationItem[]
  emptyMessage: string
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border bg-muted/20 px-4 py-12 text-center text-xs text-muted-foreground">
        {emptyMessage}
      </div>
    )
  }
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>검색어</TableHead>
            <TableHead className="w-24 text-right">노출</TableHead>
            <TableHead className="w-24 text-right">클릭</TableHead>
            <TableHead className="w-20 text-right">CTR</TableHead>
            <TableHead className="w-28 text-right">비용</TableHead>
            <TableHead className="w-24 text-right">CPC</TableHead>
            <TableHead className="w-20 text-right">전환</TableHead>
            <TableHead className="w-28 text-right">CPA</TableHead>
            <TableHead className="w-44">사유</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={`${r.classification}-${r.searchTerm}`}>
              <TableCell className="max-w-xs">
                <div
                  className="truncate text-sm font-medium"
                  title={r.searchTerm}
                >
                  {r.searchTerm}
                </div>
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {r.metrics.impressions.toLocaleString()}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {r.metrics.clicks.toLocaleString()}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {r.metrics.ctr !== null ? `${r.metrics.ctr.toFixed(2)}%` : "—"}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {Math.round(r.metrics.cost).toLocaleString()}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {r.metrics.cpc !== null
                  ? r.metrics.cpc.toLocaleString()
                  : "—"}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {r.metrics.conversions !== null
                  ? r.metrics.conversions.toLocaleString()
                  : "—"}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {r.metrics.cpa !== null
                  ? r.metrics.cpa.toLocaleString()
                  : "—"}
              </TableCell>
              <TableCell>
                <ReasonBadge reasonCode={r.reasonCode} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function NewCandidatesTable({
  rows,
  adgroupOptions,
  adgroupBySearchTerm,
  onSetAdgroup,
  selectedSearchTerms,
  onToggleSelected,
  onToggleAll,
  enqueuedSearchTerms,
  canMutate,
  enqueuing,
  onEnqueue,
  emptyMessage,
}: {
  rows: ClassificationItem[]
  adgroupOptions: AdgroupOption[]
  adgroupBySearchTerm: Map<string, string>
  onSetAdgroup: (searchTerm: string, adgroupId: string) => void
  selectedSearchTerms: Set<string>
  onToggleSelected: (searchTerm: string) => void
  onToggleAll: (checked: boolean) => void
  enqueuedSearchTerms: Set<string>
  canMutate: boolean
  enqueuing: boolean
  onEnqueue: () => void
  emptyMessage: string
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border bg-muted/20 px-4 py-12 text-center text-xs text-muted-foreground">
        {emptyMessage}
      </div>
    )
  }

  // 선택 가능 행 (이미 적재된 행 제외)
  const selectableRows = rows.filter(
    (r) => !enqueuedSearchTerms.has(r.searchTerm),
  )
  const allSelectableSelected =
    selectableRows.length > 0 &&
    selectableRows.every((r) => selectedSearchTerms.has(r.searchTerm))
  const someSelectableSelected =
    selectableRows.some((r) => selectedSearchTerms.has(r.searchTerm)) &&
    !allSelectableSelected

  const selectedCount = selectedSearchTerms.size

  return (
    <div className="flex flex-col gap-3">
      {/* 헤더 액션 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground">
          신규 후보 <strong className="text-foreground">{rows.length}</strong>건
          {selectedCount > 0 ? (
            <>
              {" "}/ 선택 <strong className="text-foreground">{selectedCount}</strong>건
            </>
          ) : null}
          {enqueuedSearchTerms.size > 0 ? (
            <>
              {" "}/ 적재 완료{" "}
              <strong className="text-foreground">
                {enqueuedSearchTerms.size}
              </strong>건
            </>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {canMutate ? (
            <Button
              size="sm"
              disabled={selectedCount === 0 || enqueuing}
              onClick={onEnqueue}
            >
              {enqueuing
                ? "적재 중..."
                : `선택한 ${selectedCount}건을 승인 큐로`}
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">
              (viewer 는 큐 적재 불가)
            </span>
          )}
        </div>
      </div>

      {adgroupOptions.length === 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50/40 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
          활성 광고그룹이 없습니다. 광고그룹을 먼저 동기화/생성하세요.
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={allSelectableSelected}
                  indeterminate={someSelectableSelected}
                  onCheckedChange={(v) => onToggleAll(Boolean(v))}
                  disabled={!canMutate || selectableRows.length === 0}
                  aria-label="신규 후보 전체 선택"
                />
              </TableHead>
              <TableHead>검색어</TableHead>
              <TableHead className="w-64">광고그룹</TableHead>
              <TableHead className="w-24 text-right">노출</TableHead>
              <TableHead className="w-24 text-right">클릭</TableHead>
              <TableHead className="w-20 text-right">CTR</TableHead>
              <TableHead className="w-28 text-right">비용</TableHead>
              <TableHead className="w-24 text-right">CPC</TableHead>
              <TableHead className="w-20 text-right">전환</TableHead>
              <TableHead className="w-44">사유</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const enqueued = enqueuedSearchTerms.has(r.searchTerm)
              const selected = selectedSearchTerms.has(r.searchTerm)
              const adgroupId = adgroupBySearchTerm.get(r.searchTerm) ?? ""
              return (
                <TableRow
                  key={`new-${r.searchTerm}`}
                  className={cn(enqueued && "opacity-50")}
                >
                  <TableCell>
                    <Checkbox
                      checked={selected}
                      onCheckedChange={() => onToggleSelected(r.searchTerm)}
                      disabled={!canMutate || enqueued}
                      aria-label="선택"
                    />
                  </TableCell>
                  <TableCell className="max-w-xs">
                    <div
                      className="truncate text-sm font-medium"
                      title={r.searchTerm}
                    >
                      {r.searchTerm}
                    </div>
                    {enqueued && (
                      <span className="text-[10px] text-emerald-700 dark:text-emerald-400">
                        승인 큐 적재됨
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={adgroupId}
                      onValueChange={(v) => {
                        // base-ui Select onValueChange 시그니처: string | null.
                        // SelectItem 만 넣으므로 null 비도달이지만 타입 보호.
                        if (v !== null) onSetAdgroup(r.searchTerm, v)
                      }}
                      disabled={
                        !canMutate || enqueued || adgroupOptions.length === 0
                      }
                    >
                      <SelectTrigger className="h-8 w-full">
                        <SelectValue placeholder="광고그룹 선택" />
                      </SelectTrigger>
                      <SelectContent>
                        {adgroupOptions.map((g) => (
                          <SelectItem key={g.id} value={g.id}>
                            <span className="truncate">
                              {g.campaignName} / {g.name}
                              {g.status === "off" ? " (off)" : ""}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {r.metrics.impressions.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {r.metrics.clicks.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {r.metrics.ctr !== null
                      ? `${r.metrics.ctr.toFixed(2)}%`
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {Math.round(r.metrics.cost).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {r.metrics.cpc !== null
                      ? r.metrics.cpc.toLocaleString()
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {r.metrics.conversions !== null
                      ? r.metrics.conversions.toLocaleString()
                      : "—"}
                  </TableCell>
                  <TableCell>
                    <ReasonBadge reasonCode={r.reasonCode} />
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function ReasonBadge({
  reasonCode,
}: {
  reasonCode: ClassificationItem["reasonCode"]
}) {
  const map: Record<ClassificationItem["reasonCode"], { label: string; cls: string }> =
    {
      conversions_bypass: {
        label: "전환 발생",
        cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
      },
      high_traffic_clicks: {
        label: "트래픽 충족",
        cls: "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300",
      },
      no_clicks_high_impressions: {
        label: "노출↑ 클릭=0",
        cls: "bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300",
      },
      high_cpa_no_conversions: {
        label: "CPA 매우 높음",
        cls: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
      },
      insufficient_data: {
        label: "데이터 부족",
        cls: "bg-muted text-muted-foreground",
      },
      neutral_below_thresholds: {
        label: "임계 미달",
        cls: "bg-muted text-muted-foreground",
      },
    }
  const m = map[reasonCode]
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium",
        m.cls,
      )}
    >
      {m.label}
    </span>
  )
}

// =============================================================================
// 유틸
// =============================================================================

async function readFileAsUtf8(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const decoder = new TextDecoder("utf-8")
  let text = decoder.decode(buf)
  // BOM 제거 (parse-csv.ts 도 한 번 더 제거하나 안전망)
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1)
  }
  return text
}

function sortAndLimit(
  rows: ClassificationItem[],
  key: SortKey,
): ClassificationItem[] {
  const sorted = [...rows].sort((a, b) => {
    const av = a.metrics[key] ?? 0
    const bv = b.metrics[key] ?? 0
    return bv - av
  })
  return sorted.slice(0, TAKE_LIMIT)
}
