"use client"

/**
 * 대시보드 Hero (페이지 헤더 — 1행 컴팩트)
 *
 * 책임:
 *   - 좌: 광고주명 + cid (작게)
 *   - 중: 비즈머니 + 잠금 상태 (인라인)
 *   - 우: API 키 미설정 배지(있을 때) + 구조 데이터 동기화 상태 + 글로벌 새로고침 버튼
 *
 * 새로고침 버튼:
 *   - router.refresh() 만 호출 → RSC 전체 재호출 → KPI / 차트 / TOP / 비즈머니 모두 갱신.
 *   - 별도 Server Action 호출 X (단순화).
 *   - useTransition pending 으로 RSC 재구성 중 spinner 표시.
 *
 * 구조 데이터 동기화 표시:
 *   - 헤더는 5종(campaigns/adgroups/keywords/ads/extensions) 중 가장 오래된 시각을 요약.
 *   - 드롭다운에서 5종 동기화 시간을 모두 표시해 "화면 새로고침" 과 "구조 동기화" 를 분리.
 *
 * 비즈머니:
 *   - initialConnection.ok 일 때만 잔액 + 잠금 노출.
 *   - 실패면 "비즈머니 조회 실패" 라벨 (재시도는 글로벌 새로고침으로).
 *   - hasKeys=false 면 "API 키 미설정" 노출 + 광고주 편집 페이지 링크.
 *
 * SPEC 11.2 / 안전장치 5(권한)·7(횡단 뷰 금지).
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import {
  RefreshCwIcon,
  BanknoteIcon,
  LockIcon,
  AlertCircleIcon,
  ClockIcon,
  ChevronDownIcon,
  AlertTriangleIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { CheckConnectionResult } from "@/app/(dashboard)/[advertiserId]/actions"

const NUMBER_FMT = new Intl.NumberFormat("ko-KR")

export type DashboardHeroProps = {
  advertiser: {
    id: string
    name: string
    customerId: string
    hasKeys: boolean
  }
  /** RSC 사전 점검 결과. hasKeys=false 또는 점검 실패 시 null. */
  initialConnection: CheckConnectionResult | null
  /** getLastSyncAt 결과 — sync kind 별 ISO. 누락 키는 정상. */
  lastSyncAt: Record<string, string>
}

const SYNC_KINDS = [
  { kind: "campaigns", label: "캠페인" },
  { kind: "adgroups", label: "광고그룹" },
  { kind: "keywords", label: "키워드" },
  { kind: "ads", label: "소재" },
  { kind: "extensions", label: "확장소재" },
] as const

type SyncTone = "none" | "fresh" | "warn" | "danger"

type SyncDisplay = {
  tone: SyncTone
  label: string
  title?: string
}

/**
 * 5종 sync kind 중 가장 오래된 ISO 반환.
 * 일부만 동기화된 경우(누락 있음)에도 가장 오래된 시각을 표시 — 사용자가 갓 동기화한
 * 결과가 화면에 즉시 반영되어야 하므로 "1개라도 누락이면 undefined" 정책 폐기.
 * 5종 모두 누락(첫 진입)일 때만 undefined → "동기화 이력 없음" 표시.
 */
function pickOldestSync(map: Record<string, string>): string | undefined {
  let oldestTs: number | null = null
  let oldestIso: string | undefined
  for (const k of SYNC_KINDS) {
    const iso = map[k.kind]
    if (!iso) continue
    const t = Date.parse(iso)
    if (Number.isNaN(t)) continue
    if (oldestTs === null || t < oldestTs) {
      oldestTs = t
      oldestIso = iso
    }
  }
  return oldestIso
}

function formatSyncDisplay(
  syncedAt: string | undefined,
  now: number,
  staleMinutes = 60,
): SyncDisplay {
  if (!syncedAt) {
    return { tone: "none", label: "이력 없음" }
  }

  const ts = Date.parse(syncedAt)
  if (Number.isNaN(ts)) {
    return { tone: "none", label: "시각 알 수 없음" }
  }

  const diffMin = Math.floor((now - ts) / 60_000)
  const rtf = new Intl.RelativeTimeFormat("ko", { numeric: "auto" })
  const title = new Date(ts).toLocaleString("ko-KR")

  if (diffMin < 1) {
    return { tone: "fresh", label: "방금 전", title }
  }

  if (diffMin < 60) {
    return {
      tone: "fresh",
      label: rtf.format(-diffMin, "minute"),
      title,
    }
  }

  if (diffMin < 24 * 60) {
    const tone: SyncTone = diffMin >= staleMinutes ? "warn" : "fresh"
    return {
      tone,
      label: rtf.format(-Math.floor(diffMin / 60), "hour"),
      title,
    }
  }

  return {
    tone: "danger",
    label: rtf.format(-Math.floor(diffMin / (24 * 60)), "day"),
    title,
  }
}

const SYNC_TONE_STYLES: Record<SyncTone, string> = {
  none: "text-muted-foreground",
  fresh: "text-muted-foreground",
  warn: "text-amber-700 dark:text-amber-400",
  danger: "text-destructive",
}

function StructureSyncStatus({
  lastSyncAt,
}: {
  lastSyncAt: Record<string, string>
}) {
  const [now, setNow] = React.useState<number>(() => Date.now())

  React.useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now())
    }, 60_000)
    return () => clearInterval(id)
  }, [])

  const oldestSyncIso = pickOldestSync(lastSyncAt)
  const summary = formatSyncDisplay(oldestSyncIso, now)
  const SummaryIcon =
    summary.tone === "warn" || summary.tone === "danger"
      ? AlertTriangleIcon
      : ClockIcon

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "group/button inline-flex h-7 max-w-full shrink-0 items-center justify-center gap-1 rounded-[min(var(--radius-md),12px)] rounded-lg border border-border bg-background bg-clip-padding px-2.5 text-[0.8rem] font-medium whitespace-nowrap transition-all outline-none select-none hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        )}
        aria-label={`광고 구조 동기화 상태: ${summary.label}`}
      >
        <SummaryIcon
          className={cn("size-3.5", SYNC_TONE_STYLES[summary.tone])}
        />
        <span className="truncate text-xs">
          구조 데이터: <span className="font-medium">{summary.label}</span>
        </span>
        <ChevronDownIcon className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-72 p-2"
        sideOffset={6}
      >
        <div className="px-1.5 py-1">
          <div className="text-sm font-medium">광고 구조 동기화</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            헤더 상태는 가장 오래된 항목 기준입니다.
          </div>
        </div>
        <div className="mt-1 space-y-0.5 rounded-md border bg-muted/30 p-1">
          {SYNC_KINDS.map((item) => {
            const display = formatSyncDisplay(lastSyncAt[item.kind], now)
            return (
              <div
                key={item.kind}
                className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-2 rounded px-1.5 py-1 text-xs"
              >
                <span className="text-muted-foreground">{item.label}</span>
                <span
                  className={cn(
                    "min-w-0 truncate text-right font-medium",
                    SYNC_TONE_STYLES[display.tone],
                  )}
                  title={display.title}
                >
                  {display.label}
                </span>
              </div>
            )
          })}
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 px-1.5 pb-0.5 text-[11px] text-muted-foreground">
          <span>정기 동기화</span>
          <span className="font-medium text-foreground/80">매시간 15분</span>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function DashboardHero({
  advertiser,
  initialConnection,
  lastSyncAt,
}: DashboardHeroProps) {
  const router = useRouter()
  const [pending, startTransition] = React.useTransition()

  function handleRefresh() {
    startTransition(() => {
      router.refresh()
    })
  }

  const conn =
    initialConnection && initialConnection.ok ? initialConnection : null
  const connError =
    initialConnection && !initialConnection.ok ? initialConnection.error : null

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3 ring-1 ring-foreground/10">
      {/* 좌: 광고주 식별 + 비즈머니 (인라인) */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
        <div className="min-w-0">
          <h1 className="font-heading truncate text-lg font-semibold leading-tight">
            {advertiser.name}
          </h1>
          <p className="text-xs text-muted-foreground">
            cid: <span className="font-mono">{advertiser.customerId}</span>
          </p>
        </div>

        {/* 비즈머니 인라인 */}
        {advertiser.hasKeys ? (
          conn ? (
            <div className="flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-xs">
              <BanknoteIcon className="size-3.5 text-emerald-600" />
              <span className="font-mono font-medium">
                {NUMBER_FMT.format(Math.round(conn.bizmoney))} 원
              </span>
              <span className="mx-1 text-muted-foreground">·</span>
              {conn.budgetLock ? (
                <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400">
                  <LockIcon className="size-3" />
                  예산 잠금
                </span>
              ) : (
                <span className="text-emerald-700 dark:text-emerald-400">
                  정상
                </span>
              )}
              {conn.refundLock ? (
                <span className="ml-1 inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                  <LockIcon className="size-3" />
                  환불 잠금
                </span>
              ) : null}
            </div>
          ) : connError ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/5 px-2.5 py-1 text-xs text-destructive">
              <AlertCircleIcon className="size-3.5" />
              비즈머니 조회 실패
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border bg-muted px-2.5 py-1 text-xs text-muted-foreground">
              <BanknoteIcon className="size-3.5" />
              비즈머니 미조회
            </span>
          )
        ) : null}
      </div>

      {/* 우: 키 상태 + 마지막 동기화 + 새로고침 */}
      <div className="flex flex-wrap items-center gap-2">
        {!advertiser.hasKeys ? (
          <Link
            href={`/admin/advertisers/${advertiser.id}`}
            className="inline-flex items-center gap-1 rounded-full border border-rose-300 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-800 hover:bg-rose-100 dark:border-rose-900/60 dark:bg-rose-900/20 dark:text-rose-300"
          >
            <AlertCircleIcon className="size-3.5" />
            API 키 미설정
          </Link>
        ) : null}

        <StructureSyncStatus lastSyncAt={lastSyncAt} />

        <Button
          size="sm"
          variant="outline"
          onClick={handleRefresh}
          disabled={pending}
          aria-label="새로고침"
        >
          <RefreshCwIcon
            className={cn("size-3.5", pending && "animate-spin")}
          />
          {pending ? "새로고침 중..." : "새로고침"}
        </Button>
      </div>
    </div>
  )
}
