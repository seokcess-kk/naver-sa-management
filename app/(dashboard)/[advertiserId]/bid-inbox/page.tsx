/**
 * Suggestion Inbox 페이지 (F-11.4 Phase B.3)
 *
 * - RSC. 권한 검증 → BidSuggestion 활성 pending 조회 (engineSource 필터 옵션)
 *   → 클라이언트 테이블 위임
 * - viewer 도 진입 가능 (read 성격). 적용/거부 버튼은 클라이언트에서 role 분기.
 * - 광고주 횡단 차단: BidSuggestion.advertiserId == advertiserId
 * - 키워드 join: keyword.adgroup.campaign — 같은 광고주에 속함 보장됨
 *   (Phase B.2 cron 이 advertiserId 와 일치하는 키워드만 적재)
 *
 * URL 패턴: `/[advertiserId]/bid-inbox` (광고주별 컨텍스트 — SPEC 11.2)
 *
 * SPEC v0.2.1 F-11.4 + plan(graceful-sparking-graham) Phase B.3
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
import { BidSuggestionTable } from "@/components/bidding/bid-suggestion-table"
import type { BidSuggestionRow } from "@/app/(dashboard)/[advertiserId]/bid-inbox/actions"

export default async function BidInboxPage({
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
      // 권한 없음 / 아카이브 → 404 (정보 노출 최소화)
      notFound()
    }
    throw e
  }

  // BidSuggestion 활성 pending — 광고주 한정.
  //   actions.listBidSuggestions 와 동일 정책. RSC 직접 prisma 조회 (권한은 위에서 검증).
  const rows = await prisma.bidSuggestion.findMany({
    where: {
      advertiserId,
      status: "pending",
      expiresAt: { gt: new Date() },
    },
    select: {
      id: true,
      engineSource: true,
      severity: true,
      reason: true,
      action: true,
      createdAt: true,
      expiresAt: true,
      scope: true,
      affectedCount: true,
      targetName: true,
      keyword: {
        select: {
          id: true,
          nccKeywordId: true,
          keyword: true,
          matchType: true,
          bidAmt: true,
          useGroupBidAmt: true,
          userLock: true,
          status: true,
          adgroup: {
            select: {
              name: true,
              campaign: { select: { name: true } },
            },
          },
        },
      },
    },
    orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
    take: 1000,
  })

  const suggestions: BidSuggestionRow[] = rows.map((r) => ({
    id: r.id,
    engineSource: r.engineSource,
    severity: r.severity,
    reason: r.reason,
    // BidSuggestion.action JSON shape = SuggestAction (lib/auto-bidding/marginal-score)
    action: r.action as unknown as BidSuggestionRow["action"],
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    scope: r.scope,
    affectedCount: r.affectedCount,
    targetName: r.targetName,
    keyword: r.keyword
      ? {
          id: r.keyword.id,
          nccKeywordId: r.keyword.nccKeywordId,
          text: r.keyword.keyword,
          matchType: r.keyword.matchType,
          bidAmt: r.keyword.bidAmt,
          useGroupBidAmt: r.keyword.useGroupBidAmt,
          userLock: r.keyword.userLock,
          status: r.keyword.status,
          adgroupName: r.keyword.adgroup.name,
          campaignName: r.keyword.adgroup.campaign.name,
        }
      : null,
  }))

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title="비딩 Inbox"
        helpText={
          <>
            <p className="font-medium text-foreground">사용 방법</p>
            <p className="mt-1.5 leading-relaxed">
              자동 분석이 적재한 입찰가 권고를 검토하고 일괄 적용합니다.
              현재는 입찰가 권고만 적용 가능 — 품질 · 타게팅 · 예산 권고는 후속 업데이트 예정.
            </p>
          </>
        }
        breadcrumbs={[
          { label: advertiser.name, href: `/${advertiserId}` },
          { label: "비딩 Inbox" },
        ]}
      />

      <BidSuggestionTable
        advertiserId={advertiserId}
        suggestions={suggestions}
        userRole={userRole}
      />
    </div>
  )
}
