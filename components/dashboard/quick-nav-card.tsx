/**
 * 빠른 진입 카드 (사이드 1/3)
 *
 * - 광고 구조 5종(캠페인 / 광고그룹 / 키워드 / 소재 / 확장소재)
 * - 비딩 최적화 (P2) 3종(비딩 정책 / 한계효용 분석 / 시간대 타게팅)
 *
 * RSC. 인터랙션 없음 — 단순 Link 묶음 (Next.js prefetch 적용).
 *
 * URL 패턴: `/[advertiserId]/{feature}` (광고주별 컨텍스트 — SPEC 11.2 / 안전장치 7).
 */

import Link from "next/link"
import {
  MegaphoneIcon,
  FolderIcon,
  KeyboardIcon,
  ImageIcon,
  MessageSquareIcon,
  TrendingUpIcon,
  BarChart3Icon,
  ClockIcon,
  type LucideIcon,
} from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

type NavLink = {
  /** 광고주 컨텍스트 경로의 마지막 segment (예: "campaigns"). */
  segment: string
  icon: LucideIcon
  label: string
}

const STRUCTURE_LINKS: NavLink[] = [
  { segment: "campaigns", icon: MegaphoneIcon, label: "캠페인" },
  { segment: "adgroups", icon: FolderIcon, label: "광고그룹" },
  { segment: "keywords", icon: KeyboardIcon, label: "키워드" },
  { segment: "ads", icon: ImageIcon, label: "소재" },
  { segment: "extensions", icon: MessageSquareIcon, label: "확장소재" },
]

const P2_LINKS: NavLink[] = [
  { segment: "bidding-policies", icon: TrendingUpIcon, label: "비딩 정책" },
  { segment: "marginal-utility", icon: BarChart3Icon, label: "한계효용 분석" },
  { segment: "targeting", icon: ClockIcon, label: "시간대 타게팅" },
]

export function QuickNavCard({ advertiserId }: { advertiserId: string }) {
  return (
    <Card size="sm" className="h-full">
      <CardHeader>
        <CardTitle>빠른 진입</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pb-3">
        <NavSection
          title="광고 구조"
          links={STRUCTURE_LINKS}
          advertiserId={advertiserId}
        />
        <div className="border-t" aria-hidden />
        <NavSection
          title="비딩 최적화 (P2)"
          links={P2_LINKS}
          advertiserId={advertiserId}
        />
      </CardContent>
    </Card>
  )
}

function NavSection({
  title,
  links,
  advertiserId,
}: {
  title: string
  links: NavLink[]
  advertiserId: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div className="flex flex-col gap-0.5">
        {links.map((l) => {
          const Icon = l.icon
          return (
            <Link
              key={l.segment}
              href={`/${advertiserId}/${l.segment}`}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted"
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{l.label}</span>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
