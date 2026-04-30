/**
 * 광고주 상세 페이지 우측 메타 사이드 (RSC).
 *
 * 4개 카드:
 *   1) 연결 상태  : 비즈머니 + 잠금 (또는 키 미설정)
 *   2) 광고 구조 통계: 5종 카운트, 각 항목 클릭 시 광고주 컨텍스트 페이지 진입
 *   3) 마지막 동기화: 5종 lastSyncAt — kind 별 LastSyncBadge
 *   4) 위험 영역  : DeleteAdvertiserButton
 *
 * 인터랙션 영역 (LastSyncBadge / DeleteAdvertiserButton) 은 자체 'use client'.
 * 본 컴포넌트는 표현 + Link 위주이므로 RSC 로 둠.
 *
 * 시크릿 노출 방지:
 *   - props 에 시크릿 Bytes 없음 (RSC 호출부가 hasKeys boolean 으로만 전달).
 */

import Link from "next/link"
import {
  AlertCircleIcon,
  BanknoteIcon,
  KeyRoundIcon,
  LockIcon,
  MegaphoneIcon,
  LayersIcon,
  TagIcon,
  ImageIcon,
  PlusSquareIcon,
  Trash2Icon,
} from "lucide-react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { LastSyncBadge } from "@/components/dashboard/last-sync-badge"
import { DeleteAdvertiserButton } from "@/components/admin/delete-advertiser-button"
import type { CheckConnectionResult } from "@/app/(dashboard)/[advertiserId]/actions"
import type { AdvertiserStructureStats } from "@/lib/admin/advertiser-stats"

const NUMBER_FMT = new Intl.NumberFormat("ko-KR")

export type AdvertiserDetailMetaProps = {
  advertiser: {
    id: string
    name: string
    customerId: string
    status: "active" | "paused" | "archived"
    hasKeys: boolean
  }
  /** 키 미설정 또는 archived 면 null. 그 외 RSC 가 사전 호출. */
  initialConnection: CheckConnectionResult | null
  stats: AdvertiserStructureStats
  /** 5종 sync kind 별 ISO. 누락 키는 정상 (미동기화). */
  lastSyncAt: Record<string, string>
}

export function AdvertiserDetailMeta({
  advertiser,
  initialConnection,
  stats,
  lastSyncAt,
}: AdvertiserDetailMetaProps) {
  return (
    <div className="flex flex-col gap-4">
      <ConnectionCard
        hasKeys={advertiser.hasKeys}
        initialConnection={initialConnection}
        advertiserId={advertiser.id}
      />
      <StructureStatsCard advertiserId={advertiser.id} stats={stats} />
      <LastSyncCard lastSyncAt={lastSyncAt} />
      <DangerZoneCard advertiserId={advertiser.id} name={advertiser.name} />
    </div>
  )
}

// =============================================================================
// 연결 상태 카드
// =============================================================================

function ConnectionCard({
  hasKeys,
  initialConnection,
  advertiserId,
}: {
  hasKeys: boolean
  initialConnection: CheckConnectionResult | null
  advertiserId: string
}) {
  if (!hasKeys) {
    return (
      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRoundIcon className="size-4 text-rose-600 dark:text-rose-400" />
            연결 상태
          </CardTitle>
        </CardHeader>
        <CardContent className="py-4">
          <div className="flex items-center gap-2 text-sm text-rose-700 dark:text-rose-400">
            <AlertCircleIcon className="size-4" />
            키 미설정
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            아래 폼의 “API 키” / “Secret 키” 필드에 입력 후 저장하면 SA API
            호출이 활성화됩니다.
          </p>
        </CardContent>
      </Card>
    )
  }

  if (!initialConnection) {
    return (
      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2 text-base">
            <BanknoteIcon className="size-4" />
            연결 상태
          </CardTitle>
        </CardHeader>
        <CardContent className="py-4">
          <p className="text-sm text-muted-foreground">
            상태 점검을 건너뛰었습니다 (아카이브된 광고주이거나 사전 점검 비활성).
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            우측 상단{" "}
            <Link
              href={`/admin/advertisers/${advertiserId}`}
              className="underline"
            >
              테스트 연결
            </Link>{" "}
            버튼으로 수동 점검 가능.
          </p>
        </CardContent>
      </Card>
    )
  }

  if (!initialConnection.ok) {
    return (
      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertCircleIcon className="size-4 text-destructive" />
            연결 상태
          </CardTitle>
        </CardHeader>
        <CardContent className="py-4">
          <p className="text-sm text-destructive">{initialConnection.error}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            우측 상단 “테스트 연결” 버튼으로 재시도하세요.
          </p>
        </CardContent>
      </Card>
    )
  }

  const { bizmoney, budgetLock, refundLock, checkedAt } = initialConnection
  const checkedDate = new Date(checkedAt)

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2 text-base">
          <BanknoteIcon className="size-4 text-emerald-600 dark:text-emerald-400" />
          연결 상태
        </CardTitle>
        <CardDescription>RSC 사전 점검 시점의 비즈머니 / 잠금 상태</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-muted-foreground">비즈머니</span>
          <span className="font-mono text-lg font-semibold tabular-nums">
            {NUMBER_FMT.format(Math.round(bizmoney))}{" "}
            <span className="text-xs font-normal text-muted-foreground">
              원
            </span>
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {budgetLock ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-xs text-rose-800 dark:bg-rose-900/30 dark:text-rose-300">
              <LockIcon className="size-3" />
              예산 잠금
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
              예산 정상
            </span>
          )}
          {refundLock ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
              <LockIcon className="size-3" />
              환불 잠금
            </span>
          ) : null}
        </div>

        <p className="text-xs text-muted-foreground">
          마지막 점검: {checkedDate.toLocaleString("ko-KR")}
        </p>
      </CardContent>
    </Card>
  )
}

// =============================================================================
// 광고 구조 통계 카드
// =============================================================================

const STRUCTURE_LINKS: {
  key: keyof Omit<AdvertiserStructureStats, "advertiserId">
  label: string
  path: string
  icon: React.ReactNode
}[] = [
  {
    key: "campaigns",
    label: "캠페인",
    path: "campaigns",
    icon: <MegaphoneIcon className="size-4" />,
  },
  {
    key: "adgroups",
    label: "광고그룹",
    path: "adgroups",
    icon: <LayersIcon className="size-4" />,
  },
  {
    key: "keywords",
    label: "키워드",
    path: "keywords",
    icon: <TagIcon className="size-4" />,
  },
  {
    key: "ads",
    label: "소재",
    path: "ads",
    icon: <ImageIcon className="size-4" />,
  },
  {
    key: "extensions",
    label: "확장소재",
    path: "extensions",
    icon: <PlusSquareIcon className="size-4" />,
  },
]

function StructureStatsCard({
  advertiserId,
  stats,
}: {
  advertiserId: string
  stats: AdvertiserStructureStats
}) {
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="text-base">광고 구조</CardTitle>
        <CardDescription>
          항목 클릭 시 광고주 컨텍스트로 진입합니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="py-2">
        <ul className="flex flex-col">
          {STRUCTURE_LINKS.map((it) => {
            const count = stats[it.key]
            return (
              <li key={it.key}>
                <Link
                  href={`/${advertiserId}/${it.path}`}
                  className="flex items-center justify-between rounded-md px-2 py-2 text-sm transition-colors hover:bg-muted"
                >
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <span className="text-foreground">{it.icon}</span>
                    {it.label}
                  </span>
                  <span className="font-mono text-sm font-medium tabular-nums">
                    {NUMBER_FMT.format(count)}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}

// =============================================================================
// 마지막 동기화 카드
// =============================================================================

const SYNC_KIND_LABELS: { kind: string; label: string }[] = [
  { kind: "campaigns", label: "캠페인" },
  { kind: "adgroups", label: "광고그룹" },
  { kind: "keywords", label: "키워드" },
  { kind: "ads", label: "소재" },
  { kind: "extensions", label: "확장소재" },
]

function LastSyncCard({ lastSyncAt }: { lastSyncAt: Record<string, string> }) {
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="text-base">마지막 동기화</CardTitle>
        <CardDescription>5종 sync 종류별 시각</CardDescription>
      </CardHeader>
      <CardContent className="py-3">
        <ul className="flex flex-col gap-1.5">
          {SYNC_KIND_LABELS.map((it) => (
            <li
              key={it.kind}
              className="flex items-center justify-between gap-2"
            >
              <span className="text-xs text-muted-foreground">{it.label}</span>
              <LastSyncBadge syncedAt={lastSyncAt[it.kind]} showHint={false} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

// =============================================================================
// 위험 영역 카드
// =============================================================================

function DangerZoneCard({
  advertiserId,
  name,
}: {
  advertiserId: string
  name: string
}) {
  return (
    <Card className="border-destructive/40">
      <CardHeader className="border-b border-destructive/40">
        <CardTitle className="flex items-center gap-2 text-base text-destructive">
          <Trash2Icon className="size-4" />
          위험 영역
        </CardTitle>
        <CardDescription>
          광고주를 아카이브합니다 (soft delete). 동기화가 중단되며 변경 이력 /
          감사 로그는 보존됩니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="py-4">
        <DeleteAdvertiserButton id={advertiserId} name={name} />
      </CardContent>
    </Card>
  )
}
