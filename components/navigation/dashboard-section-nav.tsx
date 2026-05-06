"use client"

import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { ChevronDownIcon } from "lucide-react"

import { KeyStatusBadge } from "@/components/admin/key-status-badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  getScopedHref,
  parseAdgroupScopeIds,
  parseCampaignScopeIds,
} from "@/lib/navigation/campaign-scope"
import { cn } from "@/lib/utils"

type DashboardSection = {
  href: string
  label: string
}

// 1차 — 매일 사용하는 6개 운영 화면. sticky 탭으로 항상 노출.
const primarySections: DashboardSection[] = [
  { href: "", label: "대시보드" },
  { href: "/campaigns", label: "캠페인" },
  { href: "/adgroups", label: "광고그룹" },
  { href: "/keywords", label: "키워드" },
  { href: "/ads", label: "소재" },
  { href: "/extensions", label: "확장소재" },
]

// 2차 — 주간/이벤트성으로 쓰는 6개. "더보기" 드롭다운으로 접되 그룹 라벨로 분리.
// 활성 페이지가 이 그룹에 있으면 트리거가 active 스타일 + 라벨로 어떤 항목인지 표시.
type AdvancedGroup = {
  label: string
  sections: DashboardSection[]
}

const advancedGroups: AdvancedGroup[] = [
  {
    label: "비딩",
    sections: [
      { href: "/bidding-policies", label: "비딩 정책" },
      { href: "/bid-inbox", label: "비딩 Inbox" },
      { href: "/targeting", label: "타게팅" },
    ],
  },
  {
    label: "분석",
    sections: [
      { href: "/marginal-utility", label: "한계효용" },
      { href: "/search-term-import", label: "검색어 분석" },
    ],
  },
  {
    label: "승인",
    sections: [{ href: "/approval-queue", label: "승인 큐" }],
  },
]

// flat 라벨 lookup 용 — 활성 페이지의 항목 라벨을 트리거에 표시.
const advancedSectionsFlat: DashboardSection[] = advancedGroups.flatMap(
  (g) => g.sections,
)

export function DashboardSectionNav({
  advertiser,
}: {
  advertiser: {
    id: string
    name: string
    customerId: string
    hasKeys: boolean
    status: string
  }
}) {
  const pathname = usePathname().replace(/\/+$/, "")
  const searchParams = useSearchParams()
  const rootHref = `/${advertiser.id}`
  const scopedCampaignIds = parseCampaignScopeIds({
    campaignIds: searchParams.get("campaignIds") ?? undefined,
  })
  const scopedAdgroupIds = parseAdgroupScopeIds({
    adgroupIds: searchParams.get("adgroupIds") ?? undefined,
  })
  const pathnameSegments = pathname.split("/").filter(Boolean)
  const advertiserSegmentIndex = pathnameSegments.findIndex(
    (segment) => segment === advertiser.id,
  )
  const activeSectionHref =
    advertiserSegmentIndex === -1
      ? ""
      : pathnameSegments[advertiserSegmentIndex + 1]
        ? `/${pathnameSegments[advertiserSegmentIndex + 1]}`
        : ""

  return (
    <div className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium leading-none">
              {advertiser.name}
            </span>
            <KeyStatusBadge
              hasApiKey={advertiser.hasKeys}
              hasSecretKey={advertiser.hasKeys}
            />
            {advertiser.status !== "active" ? (
              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {advertiser.status}
              </span>
            ) : null}
          </div>
          <div className="mt-1 font-mono text-xs text-muted-foreground">
            {advertiser.customerId}
          </div>
        </div>
      </div>

      <nav aria-label="광고주 섹션" className="overflow-x-auto px-2 pb-2">
        <div className="flex min-w-max items-center gap-1">
          {primarySections.map((section) => {
            const baseHref = `${rootHref}${section.href}`
            const href =
              (scopedCampaignIds.length > 0 ||
                scopedAdgroupIds.length > 0) &&
              section.href !== ""
                ? getScopedHref(baseHref, {
                    campaignIds: scopedCampaignIds,
                    adgroupIds: scopedAdgroupIds,
                  })
                : baseHref
            const active = section.href === activeSectionHref
            return (
              <Link
                key={section.label}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-8 items-center rounded-md px-3 text-sm transition",
                  active
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {section.label}
              </Link>
            )
          })}
          <AdvancedSectionsDropdown
            rootHref={rootHref}
            scopedCampaignIds={scopedCampaignIds}
            scopedAdgroupIds={scopedAdgroupIds}
            activeSectionHref={activeSectionHref}
          />
        </div>
      </nav>
    </div>
  )
}

/**
 * 2차 섹션(비딩/분석/승인) 6개를 담은 "더보기" 드롭다운.
 *
 * - 활성 페이지가 advancedSections 안에 있으면 트리거가 active 스타일 + 라벨에
 *   현재 항목 표시 (예: "비딩 정책 ▾"). 그 외엔 "더보기 ▾".
 * - 광고주 scope(`campaignIds` / `adgroupIds`) 는 1차 탭과 동일하게 보존.
 */
function AdvancedSectionsDropdown({
  rootHref,
  scopedCampaignIds,
  scopedAdgroupIds,
  activeSectionHref,
}: {
  rootHref: string
  scopedCampaignIds: string[]
  scopedAdgroupIds: string[]
  activeSectionHref: string
}) {
  const router = useRouter()
  const activeAdvanced = advancedSectionsFlat.find(
    (s) => s.href === activeSectionHref,
  )
  const triggerActive = activeAdvanced != null
  const triggerLabel = activeAdvanced?.label ?? "더보기"

  const buildHref = (segment: string) => {
    const baseHref = `${rootHref}${segment}`
    return scopedCampaignIds.length > 0 || scopedAdgroupIds.length > 0
      ? getScopedHref(baseHref, {
          campaignIds: scopedCampaignIds,
          adgroupIds: scopedAdgroupIds,
        })
      : baseHref
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "inline-flex h-8 items-center gap-1 rounded-md px-3 text-sm transition outline-none",
          triggerActive
            ? "bg-foreground text-background"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
          "focus-visible:ring-2 focus-visible:ring-ring",
        )}
        aria-current={triggerActive ? "page" : undefined}
      >
        {triggerLabel}
        <ChevronDownIcon className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {advancedGroups.map((group, gi) => (
          <DropdownMenuGroup key={group.label}>
            {gi > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {group.label}
            </DropdownMenuLabel>
            {group.sections.map((section) => {
              const active = section.href === activeSectionHref
              const href = buildHref(section.href)
              return (
                <DropdownMenuItem
                  key={section.label}
                  onClick={() => router.push(href)}
                  className={cn(
                    active && "bg-muted font-medium text-foreground",
                  )}
                >
                  {section.label}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
