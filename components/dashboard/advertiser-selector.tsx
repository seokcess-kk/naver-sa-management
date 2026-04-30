"use client"

/**
 * 광고주 셀렉터 (F-1.4) — GNB 가운데 위치
 *
 * - URL 패턴 `/[advertiserId]/...` 기반 컨텍스트 전환 (cookie/session 사용 X)
 * - 키 미설정 광고주도 표시 (KeyStatusBadge 로 시각 구분, 정보용)
 * - status='paused' 는 색 구분(회색 + 일시중지 라벨)
 * - 현재 선택된 광고주는 useParams 의 advertiserId 로 판정
 *
 * SPEC 2.2 / 11.1 / F-1.4 (안티패턴: 횡단 뷰 / cookie 컨텍스트 / 키 미설정 완전 숨김)
 */

import * as React from "react"
import { useParams, useRouter } from "next/navigation"
import { ChevronDown, Check } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { KeyStatusBadge } from "@/components/admin/key-status-badge"
import { cn } from "@/lib/utils"
import type { AdvertiserStatus } from "@/lib/generated/prisma/client"

export type SelectorAdvertiser = {
  id: string
  name: string
  customerId: string
  hasKeys: boolean
  status: AdvertiserStatus
}

export function AdvertiserSelector({
  advertisers,
}: {
  advertisers: SelectorAdvertiser[]
}) {
  const router = useRouter()
  const params = useParams<{ advertiserId?: string }>()
  const currentId = params?.advertiserId

  const current = React.useMemo(
    () => advertisers.find((a) => a.id === currentId) ?? null,
    [advertisers, currentId],
  )

  function onSelect(id: string) {
    if (id === currentId) return
    router.push(`/${id}`)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "inline-flex h-8 min-w-56 items-center justify-between gap-2 rounded-md border bg-background px-3 py-1 text-sm",
          "hover:bg-accent hover:text-accent-foreground",
          "data-popup-open:bg-accent",
        )}
      >
        <span className="flex items-center gap-2 truncate">
          {current ? (
            <>
              <span className="truncate font-medium">{current.name}</span>
              <span className="text-xs font-mono text-muted-foreground">
                {current.customerId}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">광고주 선택</span>
          )}
        </span>
        <ChevronDown className="size-4 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>광고주 ({advertisers.length})</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {advertisers.map((a) => {
          const isSelected = a.id === currentId
          const isPaused = a.status === "paused"
          return (
            <DropdownMenuItem
              key={a.id}
              onClick={() => onSelect(a.id)}
              className={cn(
                "flex flex-col items-stretch gap-1 py-2",
                isPaused && "opacity-70",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-sm font-medium">
                    {a.name}
                  </span>
                  {isPaused ? (
                    <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                      일시중지
                    </span>
                  ) : null}
                </span>
                {isSelected ? (
                  <Check className="size-4 shrink-0 text-foreground" />
                ) : null}
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px] text-muted-foreground">
                  {a.customerId}
                </span>
                <KeyStatusBadge
                  hasApiKey={a.hasKeys}
                  hasSecretKey={a.hasKeys}
                />
              </div>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
