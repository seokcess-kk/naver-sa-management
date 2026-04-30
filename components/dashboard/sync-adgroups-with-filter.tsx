"use client"

/**
 * 광고그룹 동기화 + 캠페인 필터 (F-2.2)
 *
 * sync-extensions-with-filter.tsx 패턴 복제. server action `syncAdgroups(advertiserId, options?)` 호출.
 *   options: { campaignIds?: string[] }
 *
 * 동작:
 * - 캠페인 0개 선택 → 광고주 전체 동기화 (기본 동작 유지)
 * - 캠페인 N개 선택 → `syncAdgroups(advertiserId, { campaignIds })` 로 부분 동기화
 * - 응답: { ok: true; synced; skipped; durationMs } | { ok: false; error }
 *
 * 키 미설정(`hasKeys=false`) → 비활성화 + 안내 tooltip (sync-adgroups-button 동일).
 *
 * UX 디테일 (extensions 와 동일):
 * - 캠페인 1개뿐 → multi-select 표시 안 하고 일반 sync 버튼
 * - 캠페인 status='off' → 회색 글씨 (선택은 가능)
 * - 캠페인 ≥ 10 → 검색 input 노출
 * - 모바일(<sm) → Popover/Dropdown 대신 Dialog 사용
 *
 * 본 컴포넌트는 AdgroupsPage 만 사용. sync-adgroups-button.tsx 는 무변경 (다른 페이지 영향 X).
 *
 * SPEC 6.2 F-2.2 / 11.2.
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
import { syncAdgroups } from "@/app/(dashboard)/[advertiserId]/adgroups/actions"
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

export type SyncAdgroupsWithFilterProps = {
  advertiserId: string
  hasKeys: boolean
  campaigns: CampaignOption[]
}

// =============================================================================
// 본체
// =============================================================================

export function SyncAdgroupsWithFilter({
  advertiserId,
  hasKeys,
  campaigns,
}: SyncAdgroupsWithFilterProps) {
  const router = useRouter()

  // status='deleted' 는 옵션에서 제외 (props 로 들어와도 한 번 더 방어)
  const visibleCampaigns = React.useMemo(
    () => campaigns.filter((c) => c.status !== "deleted"),
    [campaigns],
  )

  const showFilter = visibleCampaigns.length > 1

  const [selectedIds, setSelectedIds] = React.useState<string[]>([])
  const [running, setRunning] = React.useState(false)

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
      ? `광고그룹 동기화 중... (선택 ${ids.length}개 캠페인)`
      : "광고그룹 동기화 중..."

    toast.promise(
      (async () => {
        const res = await syncAdgroups(
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
            res.skipped > 0 ? ` (${res.skipped}건 스킵 — 캠페인 미동기화)` : ""
          router.refresh()
          return `광고그룹 ${res.synced}개 동기화 완료${skippedNote} (${seconds}s)`
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
    <SyncAdgroupsWithFilterInner
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

function SyncAdgroupsWithFilterInner({
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
                선택한 캠페인의 광고그룹만 동기화합니다. 미선택 시 광고주 전체.
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
