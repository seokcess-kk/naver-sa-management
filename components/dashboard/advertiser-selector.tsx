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
import { ChevronDown, Check, SearchIcon } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
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

// 광고주 수가 임계 이상일 때만 검색 input 노출 (소수일 땐 군더더기).
const SEARCH_THRESHOLD = 10

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

  // 검색 query — 드롭다운 닫혔을 땐 보존되어도 무방하지만 다음 열림 시 초기 상태가
  // 자연스러우니 트리거 클릭(open 변경)에서 초기화. uncontrolled DropdownMenu 라
  // open state 직접 관찰 어려움 → key 변경 트릭 대신 단순 useState 유지 (다음 열림에서
  // 사용자가 backspace 로 지울 수 있음 — 비용 낮음).
  const [query, setQuery] = React.useState("")

  const showSearch = advertisers.length >= SEARCH_THRESHOLD

  const filtered = React.useMemo(() => {
    if (!showSearch) return advertisers
    const q = query.trim().toLowerCase()
    if (q.length === 0) return advertisers
    return advertisers.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.customerId.toLowerCase().includes(q),
    )
  }, [advertisers, query, showSearch])

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
              <span className="hidden font-mono text-xs text-muted-foreground sm:inline">
                {current.customerId}
              </span>
              {/* 키 미설정 시에만 트리거에 노출 — 정상 광고주에 "정상" 배지는 잡소리. */}
              {!current.hasKeys ? (
                <KeyStatusBadge hasApiKey={false} hasSecretKey={false} />
              ) : null}
            </>
          ) : (
            <span className="text-muted-foreground">광고주 선택</span>
          )}
        </span>
        <ChevronDown className="size-4 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80 p-0">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-3 py-2">
            광고주 ({advertisers.length})
            {showSearch && query.trim().length > 0 ? (
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                (검색 후 {filtered.length})
              </span>
            ) : null}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        {showSearch ? (
          <div className="border-t border-b px-2 py-2">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="광고주명 / customerId 검색..."
                className="h-7 pl-7 text-xs"
                // dropdown 의 키보드 네비게이션이 input 입력을 가로채지 않도록 stopPropagation
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
          </div>
        ) : (
          <DropdownMenuSeparator />
        )}
        <div className="max-h-[60vh] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              검색 결과 없음
            </div>
          ) : (
            filtered.map((a) => {
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
            })
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
