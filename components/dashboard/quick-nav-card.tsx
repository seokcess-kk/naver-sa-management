/**
 * 빠른 진입 카드 (사이드 1/3)
 *
 * section-nav(components/navigation/dashboard-section-nav.tsx) 와 동일한 항목·라벨을
 * 노출한다. 라벨은 lib/navigation/section-labels(단일 진실 원천)을 참조 —
 * nav / quick-nav 간 명칭 불일치를 제거하기 위함.
 *
 * 구성 (section-nav 그룹과 1:1 대응):
 *   - 광고 구조 5종 (캠페인 / 광고그룹 / 키워드 / 소재 / 확장소재)
 *   - 비딩 3종 (비딩 정책 / 운영 Inbox / 타게팅)
 *   - 분석 2종 (한계효용 / 검색어 분석)
 *   - 승인 1종 (승인 대기)
 *
 * RSC. 인터랙션 없음 — 단순 Link 묶음 (Next.js prefetch 적용).
 *
 * URL 패턴: `/[advertiserId]/{segment}` (광고주별 컨텍스트 — SPEC 11.2 / 안전장치 7).
 */

import Link from "next/link"
import {
  MegaphoneIcon,
  FolderIcon,
  KeyboardIcon,
  ImageIcon,
  MessageSquareIcon,
  TrendingUpIcon,
  InboxIcon,
  ClockIcon,
  BarChart3Icon,
  SearchIcon,
  ClipboardCheckIcon,
  type LucideIcon,
} from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  SECTION_LABELS,
  type SectionSegment,
} from "@/lib/navigation/section-labels"

type NavLink = {
  /** 광고주 컨텍스트 경로의 마지막 segment (예: "campaigns"). 라벨은 SECTION_LABELS 참조. */
  segment: SectionSegment
  icon: LucideIcon
}

const STRUCTURE_LINKS: NavLink[] = [
  { segment: "campaigns", icon: MegaphoneIcon },
  { segment: "adgroups", icon: FolderIcon },
  { segment: "keywords", icon: KeyboardIcon },
  { segment: "ads", icon: ImageIcon },
  { segment: "extensions", icon: MessageSquareIcon },
]

const BIDDING_LINKS: NavLink[] = [
  { segment: "bidding-policies", icon: TrendingUpIcon },
  { segment: "bid-inbox", icon: InboxIcon },
  { segment: "targeting", icon: ClockIcon },
]

const ANALYSIS_LINKS: NavLink[] = [
  { segment: "marginal-utility", icon: BarChart3Icon },
  { segment: "search-term-import", icon: SearchIcon },
]

const APPROVAL_LINKS: NavLink[] = [
  { segment: "approval-queue", icon: ClipboardCheckIcon },
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
          title="비딩"
          links={BIDDING_LINKS}
          advertiserId={advertiserId}
        />
        <div className="border-t" aria-hidden />
        <NavSection
          title="분석"
          links={ANALYSIS_LINKS}
          advertiserId={advertiserId}
        />
        <div className="border-t" aria-hidden />
        <NavSection
          title="승인"
          links={APPROVAL_LINKS}
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
              <span className="truncate">{SECTION_LABELS[l.segment]}</span>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
