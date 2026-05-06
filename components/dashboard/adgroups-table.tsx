"use client"

/**
 * 광고그룹 목록 + 다중 선택 + 일괄 변경 모달 (F-2.2 / F-2.3 / 6.6 / 11.3)
 *
 * 흐름:
 *   1. RSC 가 advertiserId 한정 prisma.adGroup.findMany 결과를 props 로 전달
 *      (campaign join 으로 광고주 횡단 차단)
 *   2. 사용자가 행을 다중 선택 (체크박스, 헤더 select all)
 *   3. 일괄 액션 버튼 클릭 → 4단계 모달 (SPEC 11.3) — 공통 BulkActionModal 위임
 *   4. 결과 화면 닫기 → router.refresh()
 *
 * F-2.3 리팩터링:
 *   - 기존 자체 모달(input/preview/submit/result + ResultView + Stat)을
 *     `components/forms/bulk-action-modal.tsx` 로 추출.
 *   - 본 파일은 광고그룹 액션별 입력/프리뷰 render prop 만 정의.
 *   - bulkUpdateAdgroups 시그니처 / UX 변경 X.
 *
 * F-2.1 캠페인 테이블과의 차이 (그대로 유지):
 *   - 컬럼 추가: 캠페인명 / 입찰가 / PC / Mobile (+ 상태)
 *   - 다중 액션 4종: ON / OFF / 입찰가 변경 / 채널 변경
 *     (Phase 1 — 광고그룹 일예산 운영 차단 정책으로 "예산 변경" 제거.
 *      DB 컬럼은 Phase 2 까지 보존 — actions.ts 머리 주석 참조.)
 *   - 채널 변경은 backend 가 명시적 throw — UI 에서 "운영 검증 필요" 안내 +
 *     "강제 시도" 버튼으로 ChangeBatch 실패 결과를 운영자가 확인 가능
 *
 * 안티패턴 회피:
 *   - 즉시 적용 X (사용자 확정 거침)
 *   - 미리보기 단계 생략 X (channel "강제 시도" 도 confirm 모달은 거침)
 *   - ChangeBatch ID 결과 화면에 의무 노출 (BulkActionModal 책임)
 *   - TanStack Virtual 도입 X (광고그룹은 수십~수백 row)
 *
 * SPEC 6.2 F-2.2 / 6.6 / 11.3 / 안전장치 1·2.
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
import { AdgroupStatusBadge } from "@/components/dashboard/adgroup-status-badge"
import {
  BulkActionModal,
  type BulkActionResult,
} from "@/components/forms/bulk-action-modal"
import { bulkUpdateAdgroups } from "@/app/(dashboard)/[advertiserId]/adgroups/actions"
import { getScopedHref } from "@/lib/navigation/campaign-scope"
import type { AdGroupStatus } from "@/lib/generated/prisma/client"

// shadcn Select 한글 라벨 매핑 (Base UI Select.Value 가 raw value 를 표시하지 않도록)
const STATUS_LABELS: Record<string, string> = {
  ALL: "상태 (전체)",
  on: "ON",
  off: "OFF",
  deleted: "삭제됨",
}
const CHANNEL_LABELS: Record<string, string> = {
  ALL: "채널 (전체)",
  pcOnly: "PC만",
  mblOnly: "Mobile만",
  both: "PC+Mobile",
  none: "둘 다 OFF",
}

// =============================================================================
// 타입
// =============================================================================

/** RSC → 클라이언트 전달용 광고그룹 행. raw 컬럼 / 시크릿 무관 (광고그룹엔 시크릿 X). */
export type AdgroupRow = {
  id: string
  nccAdgroupId: string
  name: string
  /** 그룹 기본 입찰가 (Decimal → number 직렬화). 미설정 null. */
  bidAmt: number | null
  pcChannelOn: boolean
  mblChannelOn: boolean
  status: AdGroupStatus
  /** ISO 문자열 (RSC 직렬화) */
  updatedAt: string
  /** 부모 캠페인 표시용 */
  campaign: {
    id: string
    name: string
    nccCampaignId: string
  }
}

type Action = "toggleOn" | "toggleOff" | "bid" | "channel"

/** channel 모달 단계에서 사용자가 선택한 PC/Mobile 적용 값. */
type ChannelChoice = {
  pcChannelOn: boolean | null // null = 변경 안 함
  mblChannelOn: boolean | null
}

/** BulkActionModal 의 TInput — 액션별 페이로드 */
type BulkInput =
  | { action: "toggleOn" }
  | { action: "toggleOff" }
  | { action: "bid"; bidAmt: number }
  | { action: "channel"; choice: ChannelChoice }

// =============================================================================
// 메인 컴포넌트
// =============================================================================

export function AdgroupsTable({
  advertiserId,
  hasKeys,
  adgroups,
  initialSelectedAdgroupIds = [],
}: {
  advertiserId: string
  hasKeys: boolean
  adgroups: AdgroupRow[]
  initialSelectedAdgroupIds?: string[]
}) {
  const router = useRouter()

  const [selected, setSelected] = React.useState<Set<string>>(
    () => new Set(initialSelectedAdgroupIds),
  )
  const [modalAction, setModalAction] = React.useState<Action | null>(null)

  // -- 필터 state -----------------------------------------------------------
  const [searchInput, setSearchInput] = React.useState("")
  const [debouncedSearch, setDebouncedSearch] = React.useState("")
  const [statusFilter, setStatusFilter] = React.useState<string>("ALL")
  const [channelFilter, setChannelFilter] = React.useState<string>("ALL")
  // "입찰가 미설정" 단일 토글 — 그룹 기본 입찰가 (bidAmt) 가 null 인 광고그룹만 표시.
  // (이전: "입찰 모드 select" 는 useGroupBidAmt 컬럼이 없어 잘못된 해석이라 제거.)
  // 운영 가치: 입찰가 누락으로 동작 안 하는 광고그룹을 빠르게 찾기 위함.
  const [noBidOnly, setNoBidOnly] = React.useState<boolean>(false)

  // 검색 input debounce 200ms
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput), 200)
    return () => clearTimeout(t)
  }, [searchInput])

  // 클라이언트 필터링 — adgroups 는 수십~수백 row 라 가상 스크롤 X
  const visibleAdgroups = React.useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase()
    return adgroups.filter((g) => {
      if (q !== "" && !g.name.toLowerCase().includes(q)) return false
      if (statusFilter !== "ALL" && g.status !== statusFilter) return false
      if (channelFilter !== "ALL") {
        const pc = g.pcChannelOn
        const mbl = g.mblChannelOn
        if (channelFilter === "pcOnly" && !(pc && !mbl)) return false
        if (channelFilter === "mblOnly" && !(!pc && mbl)) return false
        if (channelFilter === "both" && !(pc && mbl)) return false
        if (channelFilter === "none" && !(!pc && !mbl)) return false
      }
      if (noBidOnly && g.bidAmt !== null) return false
      return true
    })
  }, [adgroups, debouncedSearch, statusFilter, channelFilter, noBidOnly])

  // 가시 행 기준 전체 선택
  const visibleSelectedCount = React.useMemo(
    () => visibleAdgroups.filter((g) => selected.has(g.id)).length,
    [visibleAdgroups, selected],
  )
  const allSelected =
    visibleAdgroups.length > 0 &&
    visibleSelectedCount === visibleAdgroups.length
  const someSelected = visibleSelectedCount > 0 && !allSelected

  const filtersApplied =
    searchInput !== "" ||
    statusFilter !== "ALL" ||
    channelFilter !== "ALL" ||
    noBidOnly

  function resetFilters() {
    setSearchInput("")
    setDebouncedSearch("")
    setStatusFilter("ALL")
    setChannelFilter("ALL")
    setNoBidOnly(false)
  }

  function toggleAll() {
    if (allSelected) {
      // 가시 행만 해제 (선택 set 에 가시 외 항목 보존)
      setSelected((prev) => {
        const next = new Set(prev)
        for (const g of visibleAdgroups) next.delete(g.id)
        return next
      })
    } else {
      setSelected((prev) => {
        const next = new Set(prev)
        for (const g of visibleAdgroups) next.add(g.id)
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
    () => adgroups.filter((g) => selected.has(g.id)),
    [adgroups, selected],
  )
  const selectedCampaignIds = React.useMemo(
    () => Array.from(new Set(selectedRows.map((g) => g.campaign.id))),
    [selectedRows],
  )
  const selectedAdgroupIds = React.useMemo(
    () => selectedRows.map((g) => g.id),
    [selectedRows],
  )
  const scopedHref = React.useCallback(
    (path: string) =>
      getScopedHref(`/${advertiserId}${path}`, {
        campaignIds: selectedCampaignIds,
        adgroupIds: selectedAdgroupIds,
      }),
    [advertiserId, selectedCampaignIds, selectedAdgroupIds],
  )

  function openModal(action: Action) {
    if (selected.size === 0) {
      toast.error("광고그룹을 1개 이상 선택하세요")
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
          : modalAction === "bid"
            ? "그룹 기본 입찰가 변경 (일괄)"
            : "기본 매체 ON/OFF 변경 (일괄)"

    async function onSubmit(input: BulkInput): Promise<BulkActionResult> {
      let payload: Parameters<typeof bulkUpdateAdgroups>[1]
      if (input.action === "toggleOn") {
        payload = {
          action: "toggle",
          items: selectedRows.map((r) => ({
            adgroupId: r.id,
            userLock: false,
          })),
        }
      } else if (input.action === "toggleOff") {
        payload = {
          action: "toggle",
          items: selectedRows.map((r) => ({
            adgroupId: r.id,
            userLock: true,
          })),
        }
      } else if (input.action === "bid") {
        payload = {
          action: "bid",
          items: selectedRows.map((r) => ({
            adgroupId: r.id,
            bidAmt: input.bidAmt,
          })),
        }
      } else {
        // channel — backend 가 명시적 throw 함. 사용자 명시 동의 후 "강제 시도".
        const { choice } = input
        payload = {
          action: "channel",
          items: selectedRows.map((r) => {
            const it: {
              adgroupId: string
              pcChannelOn?: boolean
              mblChannelOn?: boolean
            } = { adgroupId: r.id }
            if (choice.pcChannelOn !== null) it.pcChannelOn = choice.pcChannelOn
            if (choice.mblChannelOn !== null)
              it.mblChannelOn = choice.mblChannelOn
            return it
          }),
        }
      }
      const res = await bulkUpdateAdgroups(advertiserId, payload)
      // BulkActionModal 의 BulkActionResult 형태로 매핑 (adgroupId → id).
      // 결과 화면의 displayName 매칭은 nccAdgroupId 기반.
      return {
        batchId: res.batchId,
        total: res.total,
        success: res.success,
        failed: res.failed,
        items: res.items.map((it) => {
          const row = selectedRows.find((r) => r.id === it.adgroupId)
          return {
            id: row?.nccAdgroupId ?? it.adgroupId,
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
              이 광고주는 API 키 / Secret 키가 입력되지 않았습니다. SA API 호출
              (동기화 / 일괄 변경)이 차단됩니다. admin 권한자가 광고주 상세
              화면에서 키를 입력하면 활성화됩니다.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* 필터 / 검색 toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
        <Input
          placeholder="광고그룹명 검색..."
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
          value={channelFilter}
          onValueChange={(v) => setChannelFilter(v ?? "ALL")}
        >
          <SelectTrigger className="w-36">
            <SelectValue placeholder="채널">
              {(v: string | null) => CHANNEL_LABELS[v ?? "ALL"] ?? "채널 (전체)"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">채널 (전체)</SelectItem>
            <SelectItem value="both">PC+Mobile</SelectItem>
            <SelectItem value="pcOnly">PC만</SelectItem>
            <SelectItem value="mblOnly">Mobile만</SelectItem>
            <SelectItem value="none">둘 다 OFF</SelectItem>
          </SelectContent>
        </Select>
        {/*
          "입찰가 미설정" 단일 토글 — bidAmt === null 인 광고그룹만 빠르게 찾기.
          (이전 "입찰 모드 select" 는 schema 에 useGroupBidAmt 컬럼이 없어 잘못된 해석이라 제거.)
        */}
        <Label
          htmlFor="adgroup-no-bid-only"
          className="flex h-8 cursor-pointer select-none items-center gap-2 rounded-md border bg-background px-3 text-xs font-normal hover:bg-muted"
        >
          <Checkbox
            id="adgroup-no-bid-only"
            checked={noBidOnly}
            onCheckedChange={(v) => setNoBidOnly(v === true)}
            aria-label="입찰가 미설정 광고그룹만 표시"
          />
          입찰가 미설정만
        </Label>
        {filtersApplied && (
          <Button size="sm" variant="ghost" onClick={resetFilters}>
            초기화
          </Button>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          총 {adgroups.length.toLocaleString()}건
          {visibleAdgroups.length !== adgroups.length && (
            <> (필터 후 {visibleAdgroups.length.toLocaleString()}건)</>
          )}
        </span>
      </div>

      {/* 일괄 액션 바 */}
      <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
        <span className="text-sm text-muted-foreground">
          {selected.size > 0
            ? `${selected.size}개 선택됨`
            : "선택된 광고그룹 없음"}
        </span>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <ScopedAdgroupLink
            href={scopedHref("/keywords")}
            disabled={selected.size === 0}
          >
            키워드 보기
          </ScopedAdgroupLink>
          <ScopedAdgroupLink
            href={scopedHref("/ads")}
            disabled={selected.size === 0}
          >
            소재 보기
          </ScopedAdgroupLink>
          <ScopedAdgroupLink
            href={scopedHref("/extensions")}
            disabled={selected.size === 0}
          >
            확장소재 보기
          </ScopedAdgroupLink>
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
            onClick={() => openModal("bid")}
            disabled={selected.size === 0 || !hasKeys}
          >
            입찰가 변경
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => openModal("channel")}
            disabled={selected.size === 0 || !hasKeys}
          >
            채널 변경
          </Button>
        </div>
      </div>

      {/* 테이블 */}
      <div className="rounded-lg border">
        <Table style={{ tableLayout: "fixed" }}>
          {/*
            컬럼 너비 표준화 — 8개 컬럼:
              select / 광고그룹명(auto) / 캠페인 / 입찰가 / PC / Mobile / 상태 / 최근 수정
          */}
          <colgroup>
            <col style={{ width: 44 }} />
            <col style={{ width: 280 }} />
            <col style={{ width: 192 }} />
            <col style={{ width: 110 }} />
            <col style={{ width: 56 }} />
            <col style={{ width: 64 }} />
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
              <TableHead>광고그룹명</TableHead>
              <TableHead>캠페인</TableHead>
              <TableHead className="text-right">입찰가</TableHead>
              <TableHead className="text-center">PC</TableHead>
              <TableHead className="text-center">Mobile</TableHead>
              <TableHead>상태</TableHead>
              <TableHead>최근 수정</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleAdgroups.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="py-8 text-center text-muted-foreground"
                >
                  {adgroups.length === 0 ? (
                    <div className="flex flex-col items-center gap-1.5">
                      <p className="font-medium text-foreground">
                        표시할 광고그룹이 없습니다.
                      </p>
                      <p className="text-xs">
                        우측 상단 동기화 버튼을 눌러 SA 에서 가져오세요.
                        (캠페인을 먼저 동기화해야 합니다.)
                      </p>
                    </div>
                  ) : (
                    <p className="font-medium text-foreground">
                      현재 필터에 일치하는 광고그룹이 없습니다.
                    </p>
                  )}
                </TableCell>
              </TableRow>
            ) : (
              visibleAdgroups.map((g) => {
                const checked = selected.has(g.id)
                return (
                  <TableRow
                    key={g.id}
                    data-state={checked ? "selected" : undefined}
                  >
                    <TableCell>
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleOne(g.id)}
                        aria-label={`${g.name} 선택`}
                      />
                    </TableCell>
                    <TableCell className="max-w-xs truncate font-medium">
                      {g.name}
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {g.nccAdgroupId}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-xs truncate text-xs text-muted-foreground">
                      {g.campaign.name}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {g.bidAmt !== null ? g.bidAmt.toLocaleString() : "—"}
                    </TableCell>
                    <TableCell className="text-center text-xs">
                      <ChannelDot on={g.pcChannelOn} />
                    </TableCell>
                    <TableCell className="text-center text-xs">
                      <ChannelDot on={g.mblChannelOn} />
                    </TableCell>
                    <TableCell>
                      <AdgroupStatusBadge status={g.status} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(g.updatedAt).toLocaleString("ko-KR")}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      {modalProps !== null && (
        <BulkActionModal<AdgroupRow, BulkInput>
          open
          onOpenChange={(o) => {
            if (!o) setModalAction(null)
          }}
          title={modalProps.title}
          itemLabel="광고그룹"
          selectedItems={selectedRows}
          renderInput={(items, onReady) => (
            <AdgroupBulkInput
              action={modalProps.action}
              items={items}
              onReady={onReady}
            />
          )}
          renderPreview={(items, input) => (
            <AdgroupBulkPreview items={items} input={input} />
          )}
          onSubmit={modalProps.onSubmit}
          getItemDisplayName={(g) => g.name}
          getItemId={(g) => g.nccAdgroupId}
          onClosed={handleClosed}
          confirmButtonVariant={
            modalProps.action === "channel" ? "destructive" : "default"
          }
          confirmButtonLabel={
            modalProps.action === "channel"
              ? "강제 시도 (실패 예상)"
              : "확정 적용"
          }
        />
      )}
    </div>
  )
}

function ScopedAdgroupLink({
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

/** PC / Mobile ON/OFF 표시용 작은 점. */
function ChannelDot({ on }: { on: boolean }) {
  if (on) {
    return (
      <span
        className="inline-block h-2 w-2 rounded-full bg-emerald-500"
        title="ON"
        aria-label="ON"
      />
    )
  }
  return (
    <span
      className="inline-block h-2 w-2 rounded-full bg-zinc-300 dark:bg-zinc-700"
      title="OFF"
      aria-label="OFF"
    />
  )
}

// =============================================================================
// 광고그룹 input 단계 — 액션별 폼
// =============================================================================

function AdgroupBulkInput({
  action,
  items,
  onReady,
}: {
  action: Action
  items: AdgroupRow[]
  onReady: (input: BulkInput) => void
}) {
  // toggleOn / toggleOff: 별도 입력 없음 → mount 즉시 onReady 호출
  React.useEffect(() => {
    if (action === "toggleOn") onReady({ action: "toggleOn" })
    else if (action === "toggleOff") onReady({ action: "toggleOff" })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action])

  if (action === "toggleOn" || action === "toggleOff") {
    return (
      <p className="text-sm text-muted-foreground">
        {items.length}개 광고그룹의 ON/OFF 를 변경합니다. 미리보기로 이동
        중...
      </p>
    )
  }

  if (action === "bid") {
    return (
      <NumericInput
        onReady={(n) => onReady({ action: "bid", bidAmt: n })}
      />
    )
  }

  // channel
  return (
    <ChannelInput
      onReady={(choice) => onReady({ action: "channel", choice })}
    />
  )
}

function NumericInput({
  onReady,
}: {
  onReady: (n: number) => void
}) {
  const [valueInput, setValueInput] = React.useState("")
  const trimmed = valueInput.trim()
  const n = trimmed === "" ? null : Number(trimmed)
  const valid =
    n !== null && Number.isFinite(n) && n >= 0 && Number.isInteger(n)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="bulk-value">새 그룹 기본 입찰가 (원)</Label>
        <Input
          id="bulk-value"
          type="number"
          inputMode="numeric"
          min={0}
          step={10}
          value={valueInput}
          onChange={(e) => setValueInput(e.target.value)}
          placeholder="예: 500"
        />
        <p className="text-xs text-muted-foreground">
          선택한 모든 광고그룹에 동일 값이 적용됩니다. 0 이상의 정수.
        </p>
      </div>
      <div className="flex justify-end">
        <Button onClick={() => valid && onReady(n!)} disabled={!valid}>
          미리보기
        </Button>
      </div>
    </div>
  )
}

// =============================================================================
// channel 입력 (운영 검증 필요 안내 + ON/OFF 라디오)
// =============================================================================

function ChannelInput({
  onReady,
}: {
  onReady: (choice: ChannelChoice) => void
}) {
  const [choice, setChoice] = React.useState<ChannelChoice>({
    pcChannelOn: null,
    mblChannelOn: null,
  })

  // PC / Mobile 중 최소 1개 선택해야 preview 가능
  const valid =
    choice.pcChannelOn !== null || choice.mblChannelOn !== null

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
        <p className="font-medium">운영 검증 필요 (SA 필드 미확정)</p>
        <p className="mt-1">
          네이버 SA 의 PC/모바일 매체 ON/OFF 표현이 응답 샘플 마다 달라 본
          기능은 아직 호출 자체를 차단하고 있습니다. 아래 &quot;강제
          시도&quot; 버튼은 변경 작업을 의도적으로 실패 상태로 종료하여
          운영자가 결과를 확인할 수 있도록 합니다 (실제 SA 변경 X).
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <ChannelChoiceCard
          label="PC"
          value={choice.pcChannelOn}
          onChange={(v) => setChoice({ ...choice, pcChannelOn: v })}
        />
        <ChannelChoiceCard
          label="Mobile"
          value={choice.mblChannelOn}
          onChange={(v) => setChoice({ ...choice, mblChannelOn: v })}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        &quot;변경 안 함&quot; 으로 두면 해당 매체는 그대로 유지됩니다
        (페이로드에서 제외).
      </p>
      <div className="flex justify-end">
        <Button onClick={() => valid && onReady(choice)} disabled={!valid}>
          미리보기
        </Button>
      </div>
    </div>
  )
}

function ChannelChoiceCard({
  label,
  value,
  onChange,
}: {
  label: string
  value: boolean | null
  onChange: (v: boolean | null) => void
}) {
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="mb-2 text-xs font-medium">{label}</div>
      <div className="flex gap-1.5">
        <Button
          size="sm"
          variant={value === null ? "default" : "outline"}
          className="flex-1"
          onClick={() => onChange(null)}
        >
          변경 안 함
        </Button>
        <Button
          size="sm"
          variant={value === true ? "default" : "outline"}
          className="flex-1"
          onClick={() => onChange(true)}
        >
          ON
        </Button>
        <Button
          size="sm"
          variant={value === false ? "default" : "outline"}
          className="flex-1"
          onClick={() => onChange(false)}
        >
          OFF
        </Button>
      </div>
    </div>
  )
}

// =============================================================================
// 광고그룹 preview 단계 — 전/후 비교 표
// =============================================================================

function AdgroupBulkPreview({
  items,
  input,
}: {
  items: AdgroupRow[]
  input: BulkInput
}) {
  const valueLabel =
    input.action === "bid"
      ? "입찰가"
      : input.action === "channel"
        ? "PC/Mobile"
        : "ON/OFF"

  return (
    <div className="max-h-72 overflow-y-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>광고그룹</TableHead>
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

function computeBefore(r: AdgroupRow, input: BulkInput): string {
  if (input.action === "bid") {
    return r.bidAmt !== null ? `${r.bidAmt.toLocaleString()}원` : "—"
  }
  if (input.action === "channel") {
    return `PC ${r.pcChannelOn ? "ON" : "OFF"} / M ${r.mblChannelOn ? "ON" : "OFF"}`
  }
  return statusLabel(r.status)
}

function computeAfter(r: AdgroupRow, input: BulkInput): string {
  if (input.action === "toggleOn") return "ON"
  if (input.action === "toggleOff") return "OFF"
  if (input.action === "bid") return `${input.bidAmt.toLocaleString()}원`
  // channel
  const beforePc = r.pcChannelOn ? "ON" : "OFF"
  const beforeMbl = r.mblChannelOn ? "ON" : "OFF"
  const afterPc =
    input.choice.pcChannelOn === null
      ? beforePc
      : input.choice.pcChannelOn
        ? "ON"
        : "OFF"
  const afterMbl =
    input.choice.mblChannelOn === null
      ? beforeMbl
      : input.choice.mblChannelOn
        ? "ON"
        : "OFF"
  return `PC ${afterPc} / M ${afterMbl}`
}

function statusLabel(s: AdGroupStatus): string {
  if (s === "deleted") return "삭제됨"
  if (s === "off") return "OFF"
  return "ON"
}
