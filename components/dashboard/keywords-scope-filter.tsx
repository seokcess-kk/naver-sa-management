"use client"

/**
 * 키워드 페이지 toolbar용 캠페인 / 광고그룹 다중 선택 필터 (F-3.1).
 *
 * sync-keywords-with-filter.tsx 의 CampaignMultiSelect 패턴 복제 — 키워드 동기화 범위 선택과는 별개로
 * 키워드 목록 조회 범위(URL `campaignIds` / `adgroupIds`)를 인터랙티브하게 좁히는 용도.
 *
 * 동작:
 *   - CampaignFilterPopover: 캠페인 목록 multi-select → onChange(ids) 호출
 *   - AdgroupFilterPopover:  campaigns 가 선택된 경우 해당 캠페인 산하 광고그룹만 노출.
 *                            campaigns 미선택 시 광고주 전체 광고그룹 노출.
 *   - 선택 결과는 상위(KeywordsTable)가 URL `campaignIds`, `adgroupIds` 콤마 구분으로 갱신
 *
 * UI:
 *   - 데스크탑: DropdownMenu (sm 이상)
 *   - 모바일:   Dialog (sm 미만) — sync-keywords-with-filter 와 동일
 *   - 10개 이상이면 검색 input 노출
 *
 * SPEC v0.2.1 6.2 F-3.1 / 11.2.
 */

import * as React from "react"
import { FilterIcon } from "lucide-react"

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
import { cn } from "@/lib/utils"

// =============================================================================
// 타입
// =============================================================================

export type CampaignFilterOption = {
  id: string
  name: string
  nccCampaignId: string
  status: "on" | "off" | "deleted"
}

export type AdgroupFilterOption = {
  id: string
  name: string
  status: "on" | "off" | "deleted"
  campaignId: string
  campaignName: string
}

// =============================================================================
// 모바일 감지
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

// =============================================================================
// 캠페인 필터 popover
// =============================================================================

export function CampaignFilterPopover({
  campaigns,
  selectedIds,
  onChange,
  disabled,
}: {
  campaigns: CampaignFilterOption[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
}) {
  const visible = React.useMemo(
    () => campaigns.filter((c) => c.status !== "deleted"),
    [campaigns],
  )

  const selectedCount = selectedIds.length

  const trigger = (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled || visible.length === 0}
      className="h-8"
    >
      <FilterIcon />
      <span>캠페인</span>
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
    </Button>
  )

  const body = (
    <MultiSelectList
      items={visible.map((c) => ({
        id: c.id,
        label: c.name,
        secondaryLabel: c.nccCampaignId,
        muted: c.status === "off",
        badge: c.status === "off" ? "OFF" : null,
      }))}
      selectedIds={selectedIds}
      onChange={onChange}
      searchPlaceholder="캠페인 검색..."
      emptyLabel="캠페인 없음"
      footerLabel={(n) =>
        n === 0 ? "선택: 0개 (전체)" : `선택: ${n}개 캠페인`
      }
    />
  )

  return (
    <ResponsivePopover
      trigger={trigger}
      title="캠페인 선택"
      description="선택한 캠페인의 키워드만 표시합니다. 미선택 시 광고주 전체."
      body={body}
    />
  )
}

// =============================================================================
// 광고그룹 필터 popover
// =============================================================================

export function AdgroupFilterPopover({
  adgroups,
  campaignFilterIds,
  selectedIds,
  onChange,
  disabled,
}: {
  adgroups: AdgroupFilterOption[]
  /** 상위 캠페인 필터 선택값 — 0개면 전체 광고그룹 노출, N개면 해당 캠페인 산하만 */
  campaignFilterIds: string[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
}) {
  const visible = React.useMemo(() => {
    const base = adgroups.filter((g) => g.status !== "deleted")
    if (campaignFilterIds.length === 0) return base
    const allow = new Set(campaignFilterIds)
    return base.filter((g) => allow.has(g.campaignId))
  }, [adgroups, campaignFilterIds])

  // 캠페인 필터가 변경되어 더 이상 보이지 않는 광고그룹이 선택되어 있으면
  // 상위에서 onChange 로 정리하지만, popover 표시는 visible 만 기준으로 한다.
  const effectiveSelectedCount = React.useMemo(() => {
    const allow = new Set(visible.map((g) => g.id))
    return selectedIds.filter((id) => allow.has(id)).length
  }, [visible, selectedIds])

  const trigger = (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled || visible.length === 0}
      className="h-8"
    >
      <FilterIcon />
      <span>광고그룹</span>
      {effectiveSelectedCount > 0 ? (
        <span
          className={cn(
            "ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium",
            "bg-foreground/10 text-foreground",
          )}
        >
          {effectiveSelectedCount}
        </span>
      ) : null}
    </Button>
  )

  const body = (
    <MultiSelectList
      items={visible.map((g) => ({
        id: g.id,
        label: g.name,
        secondaryLabel: g.campaignName,
        muted: g.status === "off",
        badge: g.status === "off" ? "OFF" : null,
      }))}
      selectedIds={selectedIds}
      onChange={onChange}
      searchPlaceholder="광고그룹 검색..."
      emptyLabel={
        campaignFilterIds.length > 0
          ? "선택한 캠페인에 광고그룹이 없습니다"
          : "광고그룹 없음"
      }
      footerLabel={(n) =>
        n === 0 ? "선택: 0개 (전체)" : `선택: ${n}개 광고그룹`
      }
    />
  )

  return (
    <ResponsivePopover
      trigger={trigger}
      title="광고그룹 선택"
      description={
        campaignFilterIds.length > 0
          ? "선택한 캠페인 산하 광고그룹 중 일부만 표시합니다."
          : "선택한 광고그룹의 키워드만 표시합니다. 미선택 시 광고주 전체."
      }
      body={body}
    />
  )
}

// =============================================================================
// 공용 popover/dialog 컨테이너
// =============================================================================

function ResponsivePopover({
  trigger,
  title,
  description,
  body,
}: {
  trigger: React.ReactElement
  title: string
  description: string
  body: React.ReactNode
}) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return (
      <Dialog>
        <DialogTrigger render={trigger} />
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {body}
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align="start" className="w-80 p-0">
        <div className="border-b px-3 py-2 text-sm font-medium">
          {title}
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            (미선택=전체)
          </span>
        </div>
        {body}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// =============================================================================
// 다중 선택 본문 (campaign / adgroup 공용)
// =============================================================================

const SEARCH_THRESHOLD = 10

type MultiSelectItem = {
  id: string
  label: string
  secondaryLabel?: string | null
  muted?: boolean
  badge?: string | null
}

function MultiSelectList({
  items,
  selectedIds,
  onChange,
  searchPlaceholder,
  emptyLabel,
  footerLabel,
}: {
  items: MultiSelectItem[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
  searchPlaceholder: string
  emptyLabel: string
  footerLabel: (n: number) => string
}) {
  const [query, setQuery] = React.useState("")
  const showSearch = items.length >= SEARCH_THRESHOLD

  const filtered = React.useMemo(() => {
    if (!showSearch) return items
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (it) =>
        it.label.toLowerCase().includes(q) ||
        (it.secondaryLabel?.toLowerCase().includes(q) ?? false),
    )
  }, [items, query, showSearch])

  const visibleIds = React.useMemo(() => items.map((it) => it.id), [items])
  const allSelected =
    items.length > 0 &&
    visibleIds.every((id) => selectedIds.includes(id)) &&
    selectedIds.length >= items.length

  function toggleAll() {
    if (allSelected) {
      // 현재 보이는 목록만 해제 (다른 캠페인의 광고그룹이 선택되어 있으면 보존)
      onChange(selectedIds.filter((id) => !visibleIds.includes(id)))
    } else {
      // 보이는 목록 전부 + 기존 다른 항목 합치기
      const merged = new Set([...selectedIds, ...visibleIds])
      onChange(Array.from(merged))
    }
  }

  function toggle(id: string) {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id))
    } else {
      onChange([...selectedIds, id])
    }
  }

  return (
    <div className="flex flex-col">
      {showSearch ? (
        <div className="border-b p-2">
          <Input
            placeholder={searchPlaceholder}
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
          {selectedIds.filter((id) => visibleIds.includes(id)).length} /{" "}
          {items.length}
        </span>
      </label>

      <div className="max-h-72 overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
            {items.length === 0 ? emptyLabel : "검색 결과 없음"}
          </div>
        ) : (
          filtered.map((it) => {
            const checked = selectedIds.includes(it.id)
            return (
              <label
                key={it.id}
                className={cn(
                  "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm",
                  "hover:bg-accent hover:text-accent-foreground",
                )}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => toggle(it.id)}
                />
                <span
                  className={cn(
                    "flex-1 truncate",
                    it.muted && "text-muted-foreground",
                  )}
                  title={it.label}
                >
                  {it.label}
                  {it.secondaryLabel ? (
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      · {it.secondaryLabel}
                    </span>
                  ) : null}
                </span>
                {it.badge ? (
                  <span className="text-[10px] font-medium text-muted-foreground">
                    {it.badge}
                  </span>
                ) : null}
              </label>
            )
          })
        )}
      </div>

      <div className="border-t px-3 py-2 text-xs text-muted-foreground">
        {footerLabel(selectedIds.length)}
      </div>
    </div>
  )
}
