"use client"

/**
 * 동기화 + 캠페인 필터 (제네릭) — F-2.2 / F-3.1 / F-4.1 / F-5.1·F-5.2 공통 병합
 *
 * 기존 4개 컴포넌트(sync-adgroups / sync-ads / sync-extensions / sync-keywords-with-filter)를
 * 하나로 병합. 엔티티별 차이는 `entity` 디스크리미네이터 prop 으로 분기.
 *   - 서버 페이지(RSC)는 직렬화 가능한 props 만 전달 가능 → 함수(server action / 메시지 매퍼)를
 *     prop 으로 넘길 수 없으므로, 엔티티 선택 로직은 본 클라이언트 모듈 내부에서 `entity` 로 해석.
 *
 * 공통 골격 (4종 동일):
 * - 캠페인 0개 선택 → 광고주 전체 동기화 (기본 동작)
 * - 캠페인 N개 선택 → 해당 캠페인 부분 동기화 (`{ campaignIds }`)
 * - 캠페인 1개뿐 → multi-select 미노출, 단순 sync 버튼
 * - 캠페인 status='off' → 회색 글씨 (선택 가능)
 * - 캠페인 ≥ 10 → 검색 input 노출
 * - 모바일(<sm) → Dropdown 대신 Dialog
 * - 키 미설정(`hasKeys=false`) → 비활성화 + 안내 tooltip
 *
 * 엔티티별 차이 (분기):
 * - adgroups / ads / extensions : `toast.promise` 패턴 (동기 결과 → 성공 메시지 매핑)
 * - keywords                    : `useSyncBatchPolling` (ChangeBatch 진행률 polling)
 *
 * SPEC 6.2 F-2.2 / F-3.1 / F-4.1 / F-5.1 / F-5.2 / 11.2 / 3.5.
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
import {
  syncAdgroups,
  type SyncAdgroupsResult,
} from "@/app/(dashboard)/[advertiserId]/adgroups/actions"
import {
  syncAds,
  type SyncAdsResult,
} from "@/app/(dashboard)/[advertiserId]/ads/actions"
import {
  syncAdExtensions,
  type SyncExtensionsResult,
} from "@/app/(dashboard)/[advertiserId]/extensions/actions"
import { syncKeywords } from "@/app/(dashboard)/[advertiserId]/keywords/actions"
import { useSyncBatchPolling } from "@/lib/sync/use-batch-polling"
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

/** 동기화 대상 엔티티 — 서버 페이지에서 전달되는 직렬화 가능 디스크리미네이터. */
export type SyncEntity = "adgroups" | "ads" | "extensions" | "keywords"

/** toast.promise 모드 엔티티 (batch polling 인 keywords 제외). */
type ToastSyncEntity = "adgroups" | "ads" | "extensions"

export type SyncWithCampaignFilterProps = {
  /** 동기화 대상 엔티티. 엔티티별 action / 라벨 / 실행 모드를 결정. */
  entity: SyncEntity
  advertiserId: string
  hasKeys: boolean
  campaigns: CampaignOption[]
  /**
   * URL `?campaignIds=...` scope 진입 시 자동 프리셀렉트 (페이지에서 prop 전달).
   * 미지정 → 빈 배열 (기존 동작 유지). 사용자는 멀티셀렉트로 추가/제거 자유.
   */
  initialCampaignIds?: string[]
}

// =============================================================================
// 엔티티 메타 — 렌더/토스트 라벨 + 다이얼로그 문구 + 실행 모드 (순수 데이터)
// =============================================================================

type EntityMeta = {
  /** 토스트/진행률 메시지 라벨. useSyncBatchPolling.kind 와 호환되는 리터럴. */
  label: "광고그룹" | "소재" | "확장소재" | "키워드"
  /** 모바일 Dialog 설명 (엔티티별 전체 문장). */
  dialogDescription: string
  /** 실행 모드: toast.promise vs ChangeBatch polling. */
  mode: "toast" | "batch"
}

const ENTITY_META: Record<SyncEntity, EntityMeta> = {
  adgroups: {
    label: "광고그룹",
    dialogDescription:
      "선택한 캠페인의 광고그룹만 동기화합니다. 미선택 시 광고주 전체.",
    mode: "toast",
  },
  ads: {
    label: "소재",
    dialogDescription:
      "선택한 캠페인 산하 광고그룹의 소재만 동기화합니다. 미선택 시 광고주 전체.",
    mode: "toast",
  },
  extensions: {
    label: "확장소재",
    dialogDescription:
      "선택한 캠페인 산하 광고그룹만 동기화합니다. 미선택 시 광고주 전체.",
    mode: "toast",
  },
  keywords: {
    label: "키워드",
    dialogDescription:
      "선택한 캠페인 산하 광고그룹의 키워드만 동기화합니다. 미선택 시 광고주 전체.",
    mode: "batch",
  },
}

// =============================================================================
// 엔티티별 실행 헬퍼 (toast 모드) — 정확한 결과 타입 유지
// =============================================================================

/** toast 모드 엔티티의 sync server action 호출. */
function runToastSync(
  entity: ToastSyncEntity,
  advertiserId: string,
  options: { campaignIds: string[] } | undefined,
): Promise<SyncAdgroupsResult | SyncAdsResult | SyncExtensionsResult> {
  switch (entity) {
    case "adgroups":
      return syncAdgroups(advertiserId, options)
    case "ads":
      return syncAds(advertiserId, options)
    case "extensions":
      return syncAdExtensions(advertiserId, options)
  }
}

type ToastSyncSuccess =
  | Extract<SyncAdgroupsResult, { ok: true }>
  | Extract<SyncAdsResult, { ok: true }>
  | Extract<SyncExtensionsResult, { ok: true }>

/** toast 모드 성공 메시지 — 엔티티별 결과 필드가 달라 분기 (원본 문구 100% 보존). */
function formatToastSuccess(
  entity: ToastSyncEntity,
  res: ToastSyncSuccess,
): string {
  const seconds = (res.durationMs / 1000).toFixed(1)
  switch (entity) {
    case "adgroups": {
      const r = res as Extract<SyncAdgroupsResult, { ok: true }>
      const skippedNote =
        r.skipped > 0 ? ` (${r.skipped}건 스킵 — 캠페인 미동기화)` : ""
      return `광고그룹 ${r.synced}개 동기화 완료${skippedNote} (${seconds}s)`
    }
    case "ads": {
      const r = res as Extract<SyncAdsResult, { ok: true }>
      const skippedNote =
        r.skipped > 0 ? ` / ${r.skipped}건 스킵 (광고그룹 매핑 누락)` : ""
      return (
        `소재 ${r.syncedAds}개 동기화 완료 ` +
        `(${r.scannedAdgroups}개 그룹${skippedNote} / ${seconds}s)`
      )
    }
    case "extensions": {
      const r = res as Extract<SyncExtensionsResult, { ok: true }>
      const skippedNote =
        r.skipped > 0 ? ` / ${r.skipped}건 스킵 (광고그룹 매핑 누락)` : ""
      const unsupportedNote =
        r.unsupportedAdgroupTypes > 0
          ? ` / ${r.unsupportedAdgroupTypes}건 미지원 type 스킵`
          : ""
      return (
        `확장소재 ${r.synced}개 동기화 완료 ` +
        `(${r.scannedAdgroups}개 그룹${skippedNote}${unsupportedNote} / ${seconds}s)`
      )
    }
  }
}

// =============================================================================
// 본체
// =============================================================================

export function SyncWithCampaignFilter({
  entity,
  advertiserId,
  hasKeys,
  campaigns,
  initialCampaignIds = [],
}: SyncWithCampaignFilterProps) {
  const router = useRouter()
  const meta = ENTITY_META[entity]

  // batch polling — keywords 만 사용. 다른 엔티티는 start() 미호출 (무해).
  // rules-of-hooks 준수를 위해 항상 호출 (mode 로 running 선택).
  const { start: batchStart, running: batchRunning } = useSyncBatchPolling({
    kind: meta.label,
    onDone: () => router.refresh(),
  })
  const [toastRunning, setToastRunning] = React.useState(false)
  const running = meta.mode === "batch" ? batchRunning : toastRunning

  // status='deleted' 는 옵션에서 제외 (props 로 들어와도 한 번 더 방어)
  const visibleCampaigns = React.useMemo(
    () => campaigns.filter((c) => c.status !== "deleted"),
    [campaigns],
  )

  // 캠페인 1개뿐 → 필터 UI 미노출, 단순 sync 버튼
  const showFilter = visibleCampaigns.length > 1

  const [selectedIds, setSelectedIds] = React.useState<string[]>(
    initialCampaignIds,
  )

  const handleSync = React.useCallback(async () => {
    if (!hasKeys) {
      toast.error("키 미설정 — API 키 / Secret 키를 먼저 입력하세요")
      return
    }
    if (running) return

    const ids = selectedIds.filter((id) =>
      visibleCampaigns.some((c) => c.id === id),
    )
    const useFilter = ids.length > 0
    const options = useFilter ? { campaignIds: ids } : undefined

    // -- batch polling 모드 (keywords) --------------------------------------
    if (entity === "keywords") {
      try {
        const res = await syncKeywords(advertiserId, options)
        batchStart(res)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        toast.error(`${meta.label} 동기화 실패: ${msg}`)
      }
      return
    }

    // -- toast.promise 모드 (adgroups / ads / extensions) -------------------
    setToastRunning(true)
    const loadingMsg = useFilter
      ? `${meta.label} 동기화 중... (선택 ${ids.length}개 캠페인)`
      : `${meta.label} 동기화 중...`

    toast.promise(
      (async () => {
        const res = await runToastSync(entity, advertiserId, options)
        if (!res.ok) throw new Error(res.error)
        return res
      })(),
      {
        loading: loadingMsg,
        success: (res) => {
          router.refresh()
          return formatToastSuccess(entity, res)
        },
        error: (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err)
          return `동기화 실패: ${msg}`
        },
        finally: () => {
          setToastRunning(false)
        },
      },
    )
  }, [
    entity,
    advertiserId,
    hasKeys,
    running,
    router,
    selectedIds,
    visibleCampaigns,
    batchStart,
    meta.label,
  ])

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
    <SyncWithCampaignFilterInner
      hasKeys={hasKeys}
      running={running}
      campaigns={visibleCampaigns}
      selectedIds={selectedIds}
      onSelectedIdsChange={setSelectedIds}
      onSync={handleSync}
      dialogDescription={meta.dialogDescription}
    />
  )
}

// =============================================================================
// Inner — 모바일 분기 + 필터 UI
// =============================================================================

function SyncWithCampaignFilterInner({
  hasKeys,
  running,
  campaigns,
  selectedIds,
  onSelectedIdsChange,
  onSync,
  dialogDescription,
}: {
  hasKeys: boolean
  running: boolean
  campaigns: CampaignOption[]
  selectedIds: string[]
  onSelectedIdsChange: (ids: string[]) => void
  onSync: () => void
  dialogDescription: string
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
              <DialogDescription>{dialogDescription}</DialogDescription>
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
