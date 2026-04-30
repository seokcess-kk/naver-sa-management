/**
 * 광고그룹 목록 페이지 (F-2.2)
 *
 * - RSC. 권한 검증 → advertiserId 한정 prisma 쿼리 (campaign join) → 클라이언트 테이블 위임
 * - raw 컬럼은 select 안 함 (큰 JSON. UI 무관 + 직렬화 부담)
 * - 시크릿 컬럼 (apiKeyEnc / secretKeyEnc) 도 select 안 함 (AdGroup 에는 없음, 안전 추가 방어)
 * - Decimal / Date 필드는 클라이언트로 넘기기 전에 number / string 으로 변환
 *
 * URL 패턴: `/[advertiserId]/adgroups` (광고주별 컨텍스트 — SPEC 11.2)
 *
 * 권한 (F-1.6 / lib/auth/access.ts):
 *   - getCurrentAdvertiser 가 광고주 존재 + 사용자 화이트리스트 검사
 *   - admin 은 전체 접근, operator/viewer 는 UserAdvertiserAccess 한정
 *
 * 광고주 횡단 차단:
 *   - AdGroup 자체는 advertiserId 직접 외래키가 없으므로
 *     `where: { campaign: { advertiserId } }` 로 join 한정 (backend actions 와 동일 패턴)
 *
 * SPEC 6.2 / 11.2 / 안전장치 1·5.
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
import { AdgroupsTable } from "@/components/dashboard/adgroups-table"
import type { AdgroupRow } from "@/components/dashboard/adgroups-table"
import { SyncAdgroupsWithFilter } from "@/components/dashboard/sync-adgroups-with-filter"

export default async function AdgroupsPage({
  params,
}: {
  params: Promise<{ advertiserId: string }>
}) {
  const { advertiserId } = await params

  let advertiser
  try {
    const ctx = await getCurrentAdvertiser(advertiserId)
    advertiser = ctx.advertiser
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

  // raw 컬럼 select 안 함. AdGroup 은 advertiserId 직접 외래키 X → campaign join 으로 한정.
  const rows = await prisma.adGroup.findMany({
    where: { campaign: { advertiserId } },
    select: {
      id: true,
      nccAdgroupId: true,
      name: true,
      bidAmt: true,
      dailyBudget: true,
      pcChannelOn: true,
      mblChannelOn: true,
      status: true,
      updatedAt: true,
      campaign: {
        select: {
          id: true,
          name: true,
          nccCampaignId: true,
        },
      },
    },
    orderBy: { updatedAt: "desc" },
  })

  // F-2.2 동기화 캠페인 필터 — 광고주 산하 캠페인 prefetch.
  // status='deleted' 는 옵션에서 제외 (인라인 동기화 의미 없음).
  const syncCampaignRows = await prisma.campaign.findMany({
    where: { advertiserId, status: { not: "deleted" } },
    select: { id: true, name: true, nccCampaignId: true, status: true },
    orderBy: { name: "asc" },
  })
  const syncCampaigns = syncCampaignRows.map((c) => ({
    id: c.id,
    name: c.name,
    nccCampaignId: c.nccCampaignId,
    status: c.status as "on" | "off" | "deleted",
  }))

  // Decimal / Date → JSON-friendly 직렬화. AdgroupRow shape 으로 매핑.
  // bidAmt 는 Int? (Decimal 아님) — 추가 변환 불필요.
  // dailyBudget 는 Decimal(14,2) — Number() 로 변환.
  const adgroups: AdgroupRow[] = rows.map((g) => ({
    id: g.id,
    nccAdgroupId: g.nccAdgroupId,
    name: g.name,
    bidAmt: g.bidAmt,
    dailyBudget:
      g.dailyBudget !== null ? Number(g.dailyBudget.toString()) : null,
    pcChannelOn: g.pcChannelOn,
    mblChannelOn: g.mblChannelOn,
    status: g.status,
    updatedAt: g.updatedAt.toISOString(),
    campaign: {
      id: g.campaign.id,
      name: g.campaign.name,
      nccCampaignId: g.campaign.nccCampaignId,
    },
  }))

  return (
    <div className="flex flex-col gap-4 p-6">
      <PageHeader
        title="광고그룹"
        description="ON/OFF · 입찰가 · 예산 · 기본 매체를 다중 선택 후 일괄 변경할 수 있습니다."
        breadcrumbs={[
          { label: advertiser.name, href: `/${advertiserId}` },
          { label: "광고그룹" },
        ]}
        actions={
          <SyncAdgroupsWithFilter
            advertiserId={advertiserId}
            hasKeys={advertiser.hasKeys}
            campaigns={syncCampaigns}
          />
        }
      />
      <AdgroupsTable
        advertiserId={advertiserId}
        hasKeys={advertiser.hasKeys}
        adgroups={adgroups}
      />
    </div>
  )
}
