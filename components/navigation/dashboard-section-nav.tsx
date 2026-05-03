"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { KeyStatusBadge } from "@/components/admin/key-status-badge"
import { cn } from "@/lib/utils"

type DashboardSection = {
  href: string
  label: string
}

const sections: DashboardSection[] = [
  { href: "", label: "대시보드" },
  { href: "/campaigns", label: "캠페인" },
  { href: "/adgroups", label: "광고그룹" },
  { href: "/keywords", label: "키워드" },
  { href: "/ads", label: "소재" },
  { href: "/extensions", label: "확장소재" },
  { href: "/bidding-policies", label: "비딩 정책" },
  { href: "/targeting", label: "타게팅" },
  { href: "/marginal-utility", label: "한계효용" },
]

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
  const rootHref = `/${advertiser.id}`
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
          {sections.map((section) => {
            const href = `${rootHref}${section.href}`
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
        </div>
      </nav>
    </div>
  )
}
