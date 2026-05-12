"use client"

/**
 * 캠페인 목록 + 다중 선택 + 일괄 변경 모달 (F-2.1 / F-2.3 / 6.6 / 11.3)
 *
 * 흐름:
 *   1. RSC 가 advertiserId 한정 prisma.campaign.findMany 결과를 props 로 전달
 *   2. 사용자가 행을 다중 선택 (체크박스, 헤더 select all)
 *   3. 일괄 액션 버튼 클릭 → 4단계 모달 (SPEC 11.3) — 공통 BulkActionModal 위임
 *   4. 결과 화면 닫기 → router.refresh()
 *
 * F-2.3 리팩터링:
 *   - 기존 자체 모달(input/preview/submit/result + ResultView + Stat)을
 *     `components/forms/bulk-action-modal.tsx` 로 추출.
 *   - 본 파일은 캠페인 액션별 입력/프리뷰 render prop 만 정의.
 *   - bulkUpdateCampaigns 시그니처 / UX 변경 X.
 *
 * 안티패턴 회피:
 *   - 즉시 적용 X (사용자 확정 거침)
 *   - 미리보기 단계 생략 X
 *   - ChangeBatch ID 결과 화면에 의무 노출 (BulkActionModal 책임)
 *   - TanStack Virtual 도입 X (캠페인은 수십 row)
 *
 * SPEC 6.2 F-2.1·F-2.3 / 6.6 / 11.3 / 안전장치 1·2.
 */

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Card,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { CampaignStatusBadge } from "@/components/dashboard/campaign-status-badge"
import { EmptyState } from "@/components/dashboard/empty-state"
import {
  BulkActionModal,
  type BulkActionResult,
} from "@/components/forms/bulk-action-modal"
import { bulkUpdateCampaigns } from "@/app/(dashboard)/[advertiserId]/campaigns/actions"
import { getCampaignScopedHref } from "@/lib/navigation/campaign-scope"
import type { CampaignStatus } from "@/lib/generated/prisma/client"

// shadcn Select 한글 라벨 매핑 (Base UI Select.Value 가 raw value 를 표시하지 않도록)
const STATUS_LABELS: Record<string, string> = {
  ALL: "상태 (전체)",
  on: "ON",
  off: "OFF",
  deleted: "삭제됨",
}

// =============================================================================
// 타입
// =============================================================================

/** RSC → 클라이언트 전달용 캠페인 행. raw 컬럼 / 시크릿 무관 (캠페인엔 시크릿 X). */
export type CampaignRow = {
  id: string
  nccCampaignId: string
  name: string
  /** schema의 campaignType. SA API 응답 필드명은 campaignTp 인 경우도 있음. */
  campaignType: string | null
  /** Decimal → number 직렬화 (RSC 단계에서 변환) */
  dailyBudget: number | null
  /** 일 예산 사용 여부 (없으면 dailyBudget !== null 로 추정) */
  useDailyBudget: boolean
  /** 사용자가 명시적으로 OFF 잠금 */
  userLock: boolean
  status: CampaignStatus
  /** ISO 문자열 (RSC 직렬화) */
  updatedAt: string
}

type Action = "toggleOn" | "toggleOff" | "budget"

/** BulkActionModal 의 TInput — 액션별 페이로드 */
type BulkInput =
  | { action: "toggleOn" }
  | { action: "toggleOff" }
  | { action: "budget"; dailyBudget: number }

// =============================================================================
// 메인 컴포넌트
// =============================================================================

export function CampaignsTable({
  advertiserId,
  hasKeys,
  campaigns,
  initialSelectedCampaignIds = [],
}: {
  advertiserId: string
  hasKeys: boolean
  campaigns: CampaignRow[]
  initialSelectedCampaignIds?: string[]
}) {
  const router = useRouter()

  const [selected, setSelected] = React.useState<Set<string>>(
    () => new Set(initialSelectedCampaignIds),
  )
  const [modalAction, setModalAction] = React.useState<Action | null>(null)

  // -- 필터 state -----------------------------------------------------------
  const [searchInput, setSearchInput] = React.useState("")
  const [debouncedSearch, setDebouncedSearch] = React.useState("")
  const [statusFilter, setStatusFilter] = React.useState<string>("ALL")
  const [typeFilter, setTypeFilter] = React.useState<string>("ALL")

  // 검색 input debounce 200ms
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput), 200)
    return () => clearTimeout(t)
  }, [searchInput])

  // 캠페인 type 셀렉트 옵션 — 현재 데이터에 등장하는 타입만 distinct
  const typeOptions = React.useMemo(() => {
    const set = new Set<string>()
    for (const c of campaigns) {
      if (c.campaignType) set.add(c.campaignType)
    }
    return Array.from(set).sort()
  }, [campaigns])

  // 클라이언트 필터링 — campaigns 는 수십 row 라 가상 스크롤 / TanStack 도입 X
  const visibleCampaigns = React.useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase()
    return campaigns.filter((c) => {
      if (q !== "" && !c.name.toLowerCase().includes(q)) return false
      if (statusFilter !== "ALL" && c.status !== statusFilter) return false
      if (typeFilter !== "ALL" && c.campaignType !== typeFilter) return false
      return true
    })
  }, [campaigns, debouncedSearch, statusFilter, typeFilter])

  // 가시 행 기준 전체 선택 (선택 set 은 globally 유지 — 필터 변경해도 보존)
  const visibleSelectedCount = React.useMemo(
    () => visibleCampaigns.filter((c) => selected.has(c.id)).length,
    [visibleCampaigns, selected],
  )
  const allSelected =
    visibleCampaigns.length > 0 &&
    visibleSelectedCount === visibleCampaigns.length
  const someSelected = visibleSelectedCount > 0 && !allSelected

  const filtersApplied =
    searchInput !== "" || statusFilter !== "ALL" || typeFilter !== "ALL"

  function resetFilters() {
    setSearchInput("")
    setDebouncedSearch("")
    setStatusFilter("ALL")
    setTypeFilter("ALL")
  }

  function toggleAll() {
    if (allSelected) {
      // 가시 행만 해제 (선택 set 에 가시 외 항목 있어도 보존)
      setSelected((prev) => {
        const next = new Set(prev)
        for (const c of visibleCampaigns) next.delete(c.id)
        return next
      })
    } else {
      setSelected((prev) => {
        const next = new Set(prev)
        for (const c of visibleCampaigns) next.add(c.id)
        return next
      })
    }
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectedRows = React.useMemo(
    () => campaigns.filter((c) => selected.has(c.id)),
    [campaigns, selected],
  )
  const selectedCampaignIds = React.useMemo(
    () => selectedRows.map((c) => c.id),
    [selectedRows],
  )
  const scopedHref = React.useCallback(
    (path: string) =>
      getCampaignScopedHref(`/${advertiserId}${path}`, selectedCampaignIds),
    [advertiserId, selectedCampaignIds],
  )

  function openModal(action: Action) {
    if (selected.size === 0) {
      toast.error("캠페인을 1개 이상 선택하세요")
      return
    }
    if (!hasKeys) {
      toast.error("키 미설정 — 일괄 변경 불가")
      return
    }
    setModalAction(action)
  }

  function handleClosed(didApply: boolean) {
    setModalAction(null)
    if (didApply) {
      setSelected(new Set())
      router.refresh()
    }
  }

  // -- 액션별 onSubmit / 모달 props 구성 -------------------------------------
  const modalProps = React.useMemo(() => {
    if (modalAction === null) return null

    const title =
      modalAction === "toggleOn"
        ? "ON으로 변경 (일괄)"
        : modalAction === "toggleOff"
          ? "OFF로 변경 (일괄)"
          : "일 예산 변경 (일괄)"

    async function onSubmit(input: BulkInput): Promise<BulkActionResult> {
      let payload: Parameters<typeof bulkUpdateCampaigns>[1]
      if (input.action === "toggleOn") {
        payload = {
          action: "toggle",
          items: selectedRows.map((r) => ({
            campaignId: r.id,
            userLock: false,
          })),
        }
      } else if (input.action === "toggleOff") {
        payload = {
          action: "toggle",
          items: selectedRows.map((r) => ({
            campaignId: r.id,
            userLock: true,
          })),
        }
      } else {
        payload = {
          action: "budget",
          items: selectedRows.map((r) => ({
            campaignId: r.id,
            dailyBudget: input.dailyBudget,
          })),
        }
      }
      const res = await bulkUpdateCampaigns(advertiserId, payload)
      // BulkActionModal 의 BulkActionResult 형태로 매핑 (campaignId → id).
      // 결과 화면의 displayName 매칭은 nccCampaignId 기반.
      return {
        batchId: res.batchId,
        total: res.total,
        success: res.success,
        failed: res.failed,
        items: res.items.map((it) => {
          const row = selectedRows.find((r) => r.id === it.campaignId)
          return {
            id: row?.nccCampaignId ?? it.campaignId,
            ok: it.ok,
            error: it.error,
          }
        }),
      }
    }

    return { title, onSubmit, action: modalAction }
  }, [modalAction, selectedRows, advertiserId])

  return (
    <div className="flex flex-col gap-4">
      {!hasKeys && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="text-amber-700 dark:text-amber-400">
              API 키 미설정
            </CardTitle>
            <CardDescription>
              이 광고주는 API 키 / Secret 키가 입력되지 않았습니다. 네이버 SA 호출
              (동기화 / 일괄 변경)이 차단됩니다. admin 권한자가 광고주 상세
              화면에서 키를 입력하면 활성화됩니다.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* 필터 / 검색 toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
        <Input
          placeholder="캠페인명 검색..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="h-8 w-56"
        />
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v ?? "ALL")}
        >
          <SelectTrigger className="w-32">
            <SelectValue placeholder="상태">
              {(v: string | null) => STATUS_LABELS[v ?? "ALL"] ?? "상태 (전체)"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">상태 (전체)</SelectItem>
            <SelectItem value="on">ON</SelectItem>
            <SelectItem value="off">OFF</SelectItem>
            <SelectItem value="deleted">삭제됨</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={typeFilter}
          onValueChange={(v) => setTypeFilter(v ?? "ALL")}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder="타입">
              {(v: string | null) =>
                !v || v === "ALL" ? "타입 (전체)" : v
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">타입 (전체)</SelectItem>
            {typeOptions.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filtersApplied && (
          <Button size="sm" variant="ghost" onClick={resetFilters}>
            초기화
          </Button>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          총 {campaigns.length.toLocaleString()}건
          {visibleCampaigns.length !== campaigns.length && (
            <> (필터 후 {visibleCampaigns.length.toLocaleString()}건)</>
          )}
        </span>
      </div>

      {/* 일괄 액션 바 */}
      <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
        <span className="text-sm text-muted-foreground">
          {selected.size > 0
            ? `${selected.size}개 선택됨`
            : "선택된 캠페인 없음"}
        </span>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <ScopedCampaignLink
            href={scopedHref("/adgroups")}
            disabled={selected.size === 0}
          >
            광고그룹 보기
          </ScopedCampaignLink>
          <ScopedCampaignLink
            href={scopedHref("/keywords")}
            disabled={selected.size === 0}
          >
            키워드 보기
          </ScopedCampaignLink>
          <ScopedCampaignLink
            href={scopedHref("/ads")}
            disabled={selected.size === 0}
          >
            소재 보기
          </ScopedCampaignLink>
          <ScopedCampaignLink
            href={scopedHref("/extensions")}
            disabled={selected.size === 0}
          >
            확장소재 보기
          </ScopedCampaignLink>
          <Button
            size="sm"
            variant="outline"
            onClick={() => openModal("toggleOn")}
            disabled={selected.size === 0 || !hasKeys}
          >
            ON으로 변경
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => openModal("toggleOff")}
            disabled={selected.size === 0 || !hasKeys}
          >
            OFF로 변경
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => openModal("budget")}
            disabled={selected.size === 0 || !hasKeys}
          >
            예산 변경
          </Button>
        </div>
      </div>

      {/* 테이블 */}
      <div className="rounded-lg border">
        <Table style={{ tableLayout: "fixed" }}>
          {/*
            컬럼 너비 표준화 — 6개 컬럼 (select / 이름(auto) / 타입 / 일 예산 / 상태 / 마지막 동기화).
          */}
          <colgroup>
            <col style={{ width: 44 }} />
            <col style={{ width: 320 }} />
            <col style={{ width: 100 }} />
            <col style={{ width: 132 }} />
            <col style={{ width: 96 }} />
            <col style={{ width: 168 }} />
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Checkbox
                  checked={allSelected}
                  indeterminate={someSelected}
                  onCheckedChange={toggleAll}
                  aria-label="전체 선택"
                />
              </TableHead>
              <TableHead>이름</TableHead>
              <TableHead>타입</TableHead>
              <TableHead className="text-right">일 예산</TableHead>
              <TableHead>상태</TableHead>
              <TableHead>마지막 동기화</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleCampaigns.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="p-0">
                  <EmptyState
                    title={
                      campaigns.length === 0
                        ? "표시할 캠페인이 없습니다."
                        : "현재 필터에 일치하는 캠페인이 없습니다."
                    }
                    description={
                      campaigns.length === 0
                        ? "우측 상단 동기화 버튼을 눌러 SA에서 가져오세요."
                        : undefined
                    }
                    className="h-32"
                  />
                </TableCell>
              </TableRow>
            ) : (
              visibleCampaigns.map((c) => {
                const checked = selected.has(c.id)
                return (
                  <TableRow
                    key={c.id}
                    data-state={checked ? "selected" : undefined}
                  >
                    <TableCell>
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleOne(c.id)}
                        aria-label={`${c.name} 선택`}
                      />
                    </TableCell>
                    <TableCell className="max-w-xs truncate font-medium">
                      {c.name}
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {c.nccCampaignId}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {c.campaignType ?? "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {c.useDailyBudget && c.dailyBudget !== null
                        ? c.dailyBudget.toLocaleString()
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <CampaignStatusBadge
                        status={c.status}
                        userLock={c.userLock}
                      />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(c.updatedAt).toLocaleString("ko-KR")}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      {modalProps !== null && (
        <BulkActionModal<CampaignRow, BulkInput>
          open
          onOpenChange={(o) => {
            if (!o) setModalAction(null)
          }}
          title={modalProps.title}
          itemLabel="캠페인"
          selectedItems={selectedRows}
          renderInput={(items, onReady) => (
            <CampaignBulkInput
              action={modalProps.action}
              items={items}
              onReady={onReady}
            />
          )}
          renderPreview={(items, input) => (
            <CampaignBulkPreview items={items} input={input} />
          )}
          onSubmit={modalProps.onSubmit}
          getItemDisplayName={(c) => c.name}
          getItemId={(c) => c.nccCampaignId}
          onClosed={handleClosed}
        />
      )}
    </div>
  )
}

function ScopedCampaignLink({
  href,
  disabled,
  children,
}: {
  href: string
  disabled: boolean
  children: React.ReactNode
}) {
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={disabled}
      render={disabled ? undefined : <Link href={href} />}
    >
      {children}
    </Button>
  )
}

// =============================================================================
// 캠페인 input 단계 — 액션별 폼
// =============================================================================

function CampaignBulkInput({
  action,
  items,
  onReady,
}: {
  action: Action
  items: CampaignRow[]
  onReady: (input: BulkInput) => void
}) {
  // toggleOn / toggleOff: 별도 입력 없음 → mount 즉시 onReady 호출
  React.useEffect(() => {
    if (action === "toggleOn") onReady({ action: "toggleOn" })
    else if (action === "toggleOff") onReady({ action: "toggleOff" })
    // budget 은 사용자 입력 대기
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action])

  const [budgetInput, setBudgetInput] = React.useState("")

  if (action !== "budget") {
    // mount 즉시 preview 로 진입하므로 짧은 안내만
    return (
      <p className="text-sm text-muted-foreground">
        {items.length}개 캠페인의 ON/OFF 를 변경합니다. 미리보기로 이동
        중...
      </p>
    )
  }

  const trimmed = budgetInput.trim()
  const n = trimmed === "" ? null : Number(trimmed)
  const valid =
    n !== null && Number.isFinite(n) && n >= 0 && Number.isInteger(n)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="bulk-budget">새 일 예산 (원)</Label>
        <Input
          id="bulk-budget"
          type="number"
          inputMode="numeric"
          min={0}
          step={1000}
          value={budgetInput}
          onChange={(e) => setBudgetInput(e.target.value)}
          placeholder="예: 50000"
        />
        <p className="text-xs text-muted-foreground">
          선택한 모든 캠페인에 동일 예산이 적용됩니다. 0 이상의 정수.
        </p>
      </div>
      <div className="flex justify-end">
        <Button
          onClick={() => valid && onReady({ action: "budget", dailyBudget: n! })}
          disabled={!valid}
        >
          미리보기
        </Button>
      </div>
    </div>
  )
}

// =============================================================================
// 캠페인 preview 단계 — 전/후 비교 표
// =============================================================================

function CampaignBulkPreview({
  items,
  input,
}: {
  items: CampaignRow[]
  input: BulkInput
}) {
  const valueLabel = input.action === "budget" ? "일 예산" : "ON/OFF"
  return (
    <div className="max-h-72 overflow-y-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>캠페인</TableHead>
            <TableHead>{valueLabel} (현재)</TableHead>
            <TableHead>→ (적용 후)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((r) => {
            const before = computeBefore(r, input)
            const after = computeAfter(r, input)
            return (
              <TableRow key={r.id}>
                <TableCell className="max-w-xs truncate font-medium">
                  {r.name}
                </TableCell>
                <TableCell className="text-muted-foreground">{before}</TableCell>
                <TableCell className="font-medium">{after}</TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function computeBefore(r: CampaignRow, input: BulkInput): string {
  if (input.action === "budget") {
    return r.useDailyBudget && r.dailyBudget !== null
      ? `${r.dailyBudget.toLocaleString()}원`
      : "—"
  }
  return r.userLock ? "OFF" : "ON"
}

function computeAfter(r: CampaignRow, input: BulkInput): string {
  if (input.action === "toggleOn") return "ON"
  if (input.action === "toggleOff") return "OFF"
  return `${input.dailyBudget.toLocaleString()}원`
}
