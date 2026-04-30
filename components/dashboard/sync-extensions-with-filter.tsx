"use client"

/**
 * 확장소재 동기화 + 캠페인 필터 (F-5.1 / F-5.2)
 *
 * 기존 `sync-extensions-button.tsx` 의 확장 — 캠페인 multi-select Popover/Dialog 추가.
 *
 * 동작:
 * - 캠페인 0개 선택 → 광고주 전체 동기화 (기본 동작 유지)
 * - 캠페인 N개 선택 → `syncAdExtensions(advertiserId, { campaignIds })` 로 부분 동기화
 * - 사용자가 dropdown 닫고 sync 버튼 누르면 호출 (드롭다운 안에서는 누적만)
 * - sync 버튼 라벨에 선택 개수 배지 (0개 = "전체")
 *
 * 키 미설정(`hasKeys=false`) → 비활성화 + 안내 tooltip (sync-extensions-button 동일)
 *
 * UX 디테일:
 * - 캠페인 1개뿐 → multi-select 표시 안 하고 일반 sync 버튼 (기존 sync-extensions-button 동등)
 * - 캠페인 status='off' → 회색 글씨 (선택은 가능)
 * - 캠페인 ≥ 10 → 검색 input 노출
 * - 모바일(<sm) → Popover/Dropdown 대신 Dialog 사용 (좁은 폭 호환)
 *
 * toast.promise 패턴은 sync-extensions-button 그대로 (페이지 이동 후에도 결과 토스트 유지).
 *
 * 본 컴포넌트는 ExtensionsPage 만 사용. sync-extensions-button.tsx 는 무변경 (다른 페이지 영향 X).
 *
 * SPEC 6.2 F-5.1 / F-5.2 / 11.2.
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { RefreshCwIcon, FilterIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { syncAdExtensions } from "@/app/(dashboard)/[advertiserId]/extensions/actions"
import { cn } from "@/lib/utils"

// =============================================================================
// 타입
// =============================================================================

type CampaignOption = {
  id: string
  name: string
  nccCampaignId: string
  status: "on" | "off" | "deleted"
}

export type SyncExtensionsWithFilterProps = {
  advertiserId: string
  hasKeys: boolean
  campaigns: CampaignOption[]
}

// =============================================================================
// 본체
// =============================================================================

export function SyncExtensionsWithFilter({
  advertiserId,
  hasKeys,
  campaigns,
}: SyncExtensionsWithFilterProps) {
  const router = useRouter()

  // status='deleted' 는 옵션에서 제외 (props 로 들어와도 한 번 더 방어)
  const visibleCampaigns = React.useMemo(
    () => campaigns.filter((c) => c.status !== "deleted"),
    [campaigns],
  )

  // 캠페인 1개뿐 → 필터 UI 미노출, 단순 sync 버튼
  const showFilter = visibleCampaigns.length > 1

  const [selectedIds, setSelectedIds] = React.useState<string[]>([])
  const [running, setRunning] = React.useState(false)

  // 동기화 호출 핸들러 — sync-extensions-button 의 toast.promise 패턴 그대로.
  const handleSync = React.useCallback(() => {
    if (!hasKeys) {
      toast.error("키 미설정 — API 키 / Secret 키를 먼저 입력하세요")
      return
    }
    if (running) return
    setRunning(true)

    const ids = selectedIds.filter((id) =>
      visibleCampaigns.some((c) => c.id === id),
    )
    const useFilter = ids.length > 0
    const loadingMsg = useFilter
      ? `확장소재 동기화 중... (선택 ${ids.length}개 캠페인)`
      : "확장소재 동기화 중..."

    toast.promise(
      (async () => {
        const res = await syncAdExtensions(
          advertiserId,
          useFilter ? { campaignIds: ids } : undefined,
        )
        if (!res.ok) throw new Error(res.error)
        return res
      })(),
      {
        loading: loadingMsg,
        success: (res) => {
          const seconds = (res.durationMs / 1000).toFixed(1)
          const skippedNote =
            res.skipped > 0
              ? ` / ${res.skipped}건 스킵 (광고그룹 매핑 누락)`
              : ""
          const unsupportedNote =
            res.unsupportedAdgroupTypes > 0
              ? ` / ${res.unsupportedAdgroupTypes}건 미지원 type 스킵`
              : ""
          router.refresh()
          return (
            `확장소재 ${res.synced}개 동기화 완료 ` +
            `(${res.scannedAdgroups}개 그룹${skippedNote}${unsupportedNote} / ${seconds}s)`
          )
        },
        error: (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err)
          return `동기화 실패: ${msg}`
        },
        finally: () => {
          setRunning(false)
        },
      },
    )
  }, [advertiserId, hasKeys, running, router, selectedIds, visibleCampaigns])

  // 캠페인 1개뿐 — 필터 없는 단순 sync 버튼
  if (!showFilter) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={handleSync}
        disabled={!hasKeys || running}
        title={
          !hasKeys ? "키 미설정 — 먼저 API 키 / Secret 키 입력" : undefined
        }
      >
        <RefreshCwIcon />
        동기화
      </Button>
    )
  }

  return (
    <SyncExtensionsWithFilterInner
      hasKeys={hasKeys}
      running={running}
      campaigns={visibleCampaigns}
      selectedIds={selectedIds}
      onSelectedIdsChange={setSelectedIds}
      onSync={handleSync}
    />
  )
}

// =============================================================================
// Inner — 모바일 분기 + 필터 UI
// =============================================================================

function SyncExtensionsWithFilterInner({
  hasKeys,
  running,
  campaigns,
  selectedIds,
  onSelectedIdsChange,
  onSync,
}: {
  hasKeys: boolean
  running: boolean
  campaigns: CampaignOption[]
  selectedIds: string[]
  onSelectedIdsChange: (ids: string[]) => void
  onSync: () => void
}) {
  const isMobile = useIsMobile()

  const selectedCount = selectedIds.length

  // sync 버튼 라벨 — 0개 = 전체, N개 = 배지로 N 표시
  const syncButton = (
    <Button
      variant="outline"
      size="sm"
      onClick={onSync}
      disabled={!hasKeys || running}
      title={!hasKeys ? "키 미설정 — 먼저 API 키 / Secret 키 입력" : undefined}
    >
      <RefreshCwIcon />
      {selectedCount > 0 ? (
        <>
          선택 동기화
          <span
            className={cn(
              "ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium",
              "bg-foreground/10 text-foreground",
            )}
          >
            {selectedCount}
          </span>
        </>
      ) : (
        "동기화"
      )}
    </Button>
  )

  // 필터 트리거 (작은 아이콘 버튼)
  const filterTriggerProps = {
    "aria-label": "캠페인 필터",
    title: "캠페인 선택 (미선택=전체)",
    children: (
      <>
        <FilterIcon />
        {selectedCount > 0 ? (
          <span
            className={cn(
              "ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium",
              "bg-foreground/10 text-foreground",
            )}
          >
            {selectedCount}
          </span>
        ) : null}
      </>
    ),
  }

  if (isMobile) {
    // 모바일: Dialog
    return (
      <div className="inline-flex items-center gap-1.5">
        <Dialog>
          <DialogTrigger
            render={
              <Button variant="outline" size="sm" disabled={!hasKeys} />
            }
            {...filterTriggerProps}
          />
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>캠페인 선택</DialogTitle>
              <DialogDescription>
                선택한 캠페인 산하 광고그룹만 동기화합니다. 미선택 시 광고주
                전체.
              </DialogDescription>
            </DialogHeader>
            <CampaignMultiSelect
              campaigns={campaigns}
              selectedIds={selectedIds}
              onSelectedIdsChange={onSelectedIdsChange}
            />
            <DialogFooter showCloseButton />
          </DialogContent>
        </Dialog>
        {syncButton}
      </div>
    )
  }

  // 데스크톱: Dropdown
  return (
    <div className="inline-flex items-center gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="sm" disabled={!hasKeys} />}
          {...filterTriggerProps}
        />
        <DropdownMenuContent align="end" className="w-80 p-0">
          <div className="border-b px-3 py-2 text-sm font-medium">
            캠페인 선택
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              (미선택=전체)
            </span>
          </div>
          <CampaignMultiSelect
            campaigns={campaigns}
            selectedIds={selectedIds}
            onSelectedIdsChange={onSelectedIdsChange}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      {syncButton}
    </div>
  )
}

// =============================================================================
// 캠페인 multi-select (Popover/Dialog 공용 본문)
// =============================================================================

const SEARCH_THRESHOLD = 10

function CampaignMultiSelect({
  campaigns,
  selectedIds,
  onSelectedIdsChange,
}: {
  campaigns: CampaignOption[]
  selectedIds: string[]
  onSelectedIdsChange: (ids: string[]) => void
}) {
  const [query, setQuery] = React.useState("")

  const showSearch = campaigns.length >= SEARCH_THRESHOLD

  const filtered = React.useMemo(() => {
    if (!showSearch) return campaigns
    const q = query.trim().toLowerCase()
    if (!q) return campaigns
    return campaigns.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.nccCampaignId.toLowerCase().includes(q),
    )
  }, [campaigns, query, showSearch])

  const allSelected =
    campaigns.length > 0 && selectedIds.length === campaigns.length

  function toggleAll() {
    if (allSelected) {
      onSelectedIdsChange([])
    } else {
      onSelectedIdsChange(campaigns.map((c) => c.id))
    }
  }

  function toggle(id: string) {
    if (selectedIds.includes(id)) {
      onSelectedIdsChange(selectedIds.filter((x) => x !== id))
    } else {
      onSelectedIdsChange([...selectedIds, id])
    }
  }

  return (
    <div className="flex flex-col">
      {showSearch ? (
        <div className="border-b p-2">
          <Input
            placeholder="캠페인 검색..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-7 text-xs"
          />
        </div>
      ) : null}

      {/* 전체 선택 / 해제 토글 */}
      <label
        className={cn(
          "flex cursor-pointer items-center gap-2 border-b px-3 py-2 text-sm",
          "hover:bg-accent hover:text-accent-foreground",
        )}
      >
        <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
        <span className="flex-1 font-medium">
          {allSelected ? "전체 해제" : "전체 선택"}
        </span>
        <span className="text-xs text-muted-foreground">
          {selectedIds.length} / {campaigns.length}
        </span>
      </label>

      {/* 캠페인 목록 */}
      <div className="max-h-72 overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
            검색 결과 없음
          </div>
        ) : (
          filtered.map((c) => {
            const checked = selectedIds.includes(c.id)
            const isOff = c.status === "off"
            return (
              <label
                key={c.id}
                className={cn(
                  "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm",
                  "hover:bg-accent hover:text-accent-foreground",
                )}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => toggle(c.id)}
                />
                <span
                  className={cn(
                    "flex-1 truncate",
                    isOff && "text-muted-foreground",
                  )}
                  title={c.name}
                >
                  {c.name}
                </span>
                {isOff ? (
                  <span className="text-[10px] font-medium text-muted-foreground">
                    OFF
                  </span>
                ) : null}
              </label>
            )
          })
        )}
      </div>

      {/* 푸터: 선택 카운트 */}
      <div className="border-t px-3 py-2 text-xs text-muted-foreground">
        {selectedIds.length === 0
          ? "선택: 0개 (전체 동기화)"
          : `선택: ${selectedIds.length}개 캠페인`}
      </div>
    </div>
  )
}

// =============================================================================
// useIsMobile — sm 브레이크포인트(640px) 미만 감지
// =============================================================================

const MOBILE_BREAKPOINT = 640

function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState(false)

  React.useEffect(() => {
    if (typeof window === "undefined") return
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => setIsMobile(mql.matches)
    onChange()
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return isMobile
}
