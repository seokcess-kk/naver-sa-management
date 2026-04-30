"use client"

/**
 * 대시보드 Hero (페이지 헤더 — 1행 컴팩트)
 *
 * 책임:
 *   - 좌: 광고주명 + cid (작게)
 *   - 중: 비즈머니 + 잠금 상태 (인라인)
 *   - 우: API 키 미설정 배지(있을 때) + 마지막 동기화 배지 + 글로벌 새로고침 버튼
 *
 * 새로고침 버튼:
 *   - router.refresh() 만 호출 → RSC 전체 재호출 → KPI / 차트 / TOP / 비즈머니 모두 갱신.
 *   - 별도 Server Action 호출 X (단순화).
 *   - useTransition pending 으로 RSC 재구성 중 spinner 표시.
 *
 * lastSyncAt 표시:
 *   - 5종(campaigns/adgroups/keywords/ads/extensions) 중 가장 오래된 시각을 채택.
 *   - 1개라도 누락이면 "동기화 이력 없음" 표시(LastSyncBadge 분기).
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
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { LastSyncBadge } from "@/components/dashboard/last-sync-badge"
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
  "campaigns",
  "adgroups",
  "keywords",
  "ads",
  "extensions",
] as const

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
    const iso = map[k]
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

  const oldestSyncIso = pickOldestSync(lastSyncAt)

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

        <LastSyncBadge syncedAt={oldestSyncIso} showHint={false} />

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
