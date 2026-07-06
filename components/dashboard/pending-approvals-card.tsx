/**
 * 통합 "승인 대기" 위젯 (대시보드 랜딩)
 *
 * 목적:
 *   운영자가 "오늘 처리할 대기 항목"을 보려면 지금은 두 곳(운영 Inbox / 승인 큐)을
 *   각각 순회해야 한다. 랜딩에서 두 소스의 pending 건수를 합산 + 분해 + 각 링크로
 *   노출해 순회·기억 부담을 줄인다.
 *
 * 물리적 데이터 통합 X:
 *   BidSuggestion 과 ApprovalQueue 는 별개 도메인. join 하지 않고 각각 count 후
 *   표시만 합산한다.
 *
 * count where 는 각 목록 페이지의 findMany where 와 정확히 일치해야 한다
 * (위젯 카운트 == 클릭해서 들어간 목록 수):
 *   - 운영 Inbox 권고: app/(dashboard)/[advertiserId]/bid-inbox/page.tsx:59-64
 *       { advertiserId, status: "pending", expiresAt: { gt: <now> } }
 *   - 승인 큐 검색어: app/(dashboard)/[advertiserId]/approval-queue/page.tsx:63-67
 *       { advertiserId, status: "pending" }
 *
 * async RSC — 두 count 를 Promise.all 병렬 실행. 권한은 페이지 진입 시
 * getCurrentAdvertiser 로 이미 검증됨 (본 위젯은 advertiserId 로 count 만).
 */

import Link from "next/link"
import {
  InboxIcon,
  ClipboardCheckIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  type LucideIcon,
} from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { prisma } from "@/lib/db/prisma"
import { SECTION_LABELS } from "@/lib/navigation/section-labels"
import { cn } from "@/lib/utils"

export async function PendingApprovalsCard({
  advertiserId,
}: {
  advertiserId: string
}) {
  // 병렬 count — 두 도메인 각각. 물리적 통합 없이 표시만 합산.
  const now = new Date()
  const [inboxCount, queueCount] = await Promise.all([
    // 운영 Inbox pending — bid-inbox/page.tsx:59-64 findMany where 와 동일해야 함.
    prisma.bidSuggestion.count({
      where: {
        advertiserId,
        status: "pending",
        expiresAt: { gt: now },
      },
    }),
    // 승인 큐 pending — approval-queue/page.tsx:63-67 findMany where 와 동일해야 함.
    prisma.approvalQueue.count({
      where: {
        advertiserId,
        status: "pending",
      },
    }),
  ])

  const total = inboxCount + queueCount
  const hasPending = total > 0

  return (
    <Card size="sm">
      <CardHeader className="border-b">
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{SECTION_LABELS["approval-queue"]}</CardTitle>
          {hasPending ? (
            <span
              className="inline-flex min-w-6 items-center justify-center rounded-full bg-primary px-2 py-0.5 text-xs font-semibold tabular-nums text-primary-foreground"
              aria-label={`총 대기 ${total}건`}
            >
              {total}
            </span>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="pb-3">
        {hasPending ? (
          <div className="flex flex-col gap-0.5">
            <PendingRow
              href={`/${advertiserId}/bid-inbox`}
              icon={InboxIcon}
              label={`${SECTION_LABELS["bid-inbox"]} 권고`}
              count={inboxCount}
            />
            <PendingRow
              href={`/${advertiserId}/approval-queue`}
              icon={ClipboardCheckIcon}
              label="승인 큐 검색어"
              count={queueCount}
            />
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 py-4 text-center">
            <CheckCircle2Icon
              className="size-6 text-muted-foreground/50"
              aria-hidden
            />
            <p className="text-sm text-muted-foreground">
              처리할 대기 항목이 없습니다
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * 분해 행 — 라벨 + 건수 + 이동. 전체 행이 클릭 가능한 <Link>.
 * count > 0 이면 accent(pill), 0 이면 차분한 muted 표기.
 */
function PendingRow({
  href,
  icon: Icon,
  label,
  count,
}: {
  href: string
  icon: LucideIcon
  label: string
  count: number
}) {
  const active = count > 0
  return (
    <Link
      href={href}
      className="group/row flex items-center gap-2 rounded-md px-2 py-2 transition-colors hover:bg-muted"
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
      <span
        className={cn(
          "inline-flex min-w-8 items-center justify-center rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums",
          active
            ? "bg-primary/10 text-primary"
            : "text-muted-foreground"
        )}
        aria-label={`${label} ${count}건 대기`}
      >
        {count}건
      </span>
      <ChevronRightIcon
        className="size-4 shrink-0 text-muted-foreground/40 transition-colors group-hover/row:text-muted-foreground"
        aria-hidden
      />
    </Link>
  )
}
