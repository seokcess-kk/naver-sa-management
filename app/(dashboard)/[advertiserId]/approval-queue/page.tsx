/**
 * F-D.4 ApprovalQueue 페이지 (RSC).
 *
 * 책임:
 *   - getCurrentAdvertiser 권한 검증
 *   - ApprovalQueue.findMany ({ advertiserId, status: 'pending' }) — 시간순
 *   - 광고주 활성 광고그룹 목록 동시 조회 (UI dropdown / 표시용)
 *   - 클라이언트 컴포넌트(ApprovalQueueTable) 위임
 *
 * 본 PR 범위:
 *   - search_term_promote 만 일괄 승인 흐름 (search_term_exclude 는 후속 PR)
 *   - kind 컬럼 / 검색어 / 광고그룹 / 메트릭 / 적재 시각 표시
 *
 * URL 패턴: /[advertiserId]/approval-queue
 * SPEC v0.2.1 F-12 + plan(graceful-sparking-graham) Phase D.4
 */

import { redirect, notFound } from "next/navigation"

import {
  getCurrentAdvertiser,
  AdvertiserNotFoundError,
  AuthorizationError,
  UnauthenticatedError,
} from "@/lib/auth/access"
import { prisma } from "@/lib/db/prisma"
import { PageHeader } from "@/components/navigation/page-header"
import {
  ApprovalQueueTable,
  type ApprovalQueueRow,
  type AdgroupOption,
} from "@/components/dashboard/approval-queue-table"

export default async function ApprovalQueuePage({
  params,
}: {
  params: Promise<{ advertiserId: string }>
}) {
  const { advertiserId } = await params

  let advertiser
  let userRole: "admin" | "operator" | "viewer"
  try {
    const ctx = await getCurrentAdvertiser(advertiserId)
    advertiser = ctx.advertiser
    userRole = ctx.user.role
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      redirect("/login")
    }
    if (e instanceof AdvertiserNotFoundError) {
      notFound()
    }
    if (e instanceof AuthorizationError) {
      notFound()
    }
    throw e
  }

  // -- 큐 + 광고그룹 병렬 조회 ----------------------------------------------
  const [queueRowsRaw, adgroupOptionsRaw] = await Promise.all([
    prisma.approvalQueue.findMany({
      where: {
        advertiserId,
        status: "pending",
      },
      select: {
        id: true,
        kind: true,
        payload: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 2000,
    }),
    prisma.adGroup.findMany({
      where: {
        campaign: { advertiserId },
        status: { not: "deleted" },
      },
      select: {
        id: true,
        name: true,
        status: true,
        campaign: { select: { name: true } },
      },
      orderBy: [{ campaign: { name: "asc" } }, { name: "asc" }],
      take: 1000,
    }),
  ])

  // payload Json passthrough — 클라이언트가 kind 별 shape 해석
  const rows: ApprovalQueueRow[] = queueRowsRaw.map((r) => ({
    id: r.id,
    kind: r.kind,
    payload: r.payload as ApprovalQueueRow["payload"],
    createdAt: r.createdAt.toISOString(),
  }))

  const adgroupOptions: AdgroupOption[] = adgroupOptionsRaw.map((g) => ({
    id: g.id,
    name: g.name,
    status: g.status,
    campaignName: g.campaign.name,
  }))

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title="승인 큐"
        helpText={
          <>
            <p className="font-medium text-foreground">사용 방법</p>
            <p className="mt-1.5 leading-relaxed">
              검색어 분석에서 적재된 신규 키워드 후보를 검토하고 일괄 승인합니다.
              승인하면 백그라운드에서 키워드 등록이 진행됩니다 (수 분 내 반영).
            </p>
          </>
        }
        breadcrumbs={[
          { label: advertiser.name, href: `/${advertiserId}` },
          { label: "승인 큐" },
        ]}
      />

      <ApprovalQueueTable
        advertiserId={advertiserId}
        rows={rows}
        adgroupOptions={adgroupOptions}
        userRole={userRole}
      />
    </div>
  )
}
