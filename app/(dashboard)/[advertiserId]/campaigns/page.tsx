/**
 * 캠페인 목록 페이지 (F-2.1 / F-2.3)
 *
 * - RSC. 권한 검증 → advertiserId 한정 prisma 쿼리 → 클라이언트 테이블 위임
 * - raw 컬럼은 select 안 함 (큰 JSON. UI 무관 + 직렬화 부담)
 * - 시크릿 컬럼 (apiKeyEnc / secretKeyEnc) 도 select 안 함 (Campaign에는 없음, 안전 추가 방어)
 * - Decimal / Date 필드는 클라이언트로 넘기기 전에 number / string 으로 변환
 *
 * URL 패턴: `/[advertiserId]/campaigns` (광고주별 컨텍스트 — SPEC 11.2)
 *
 * 권한 (F-1.6 / lib/auth/access.ts):
 *   - getCurrentAdvertiser 가 광고주 존재 + 사용자 화이트리스트 검사
 *   - admin 은 전체 접근, operator/viewer 는 UserAdvertiserAccess 한정
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
import { CampaignsTable } from "@/components/dashboard/campaigns-table"
import type { CampaignRow } from "@/components/dashboard/campaigns-table"
import { SyncCampaignsButton } from "@/components/dashboard/sync-campaigns-button"
import { ScopeClearLink } from "@/components/dashboard/scope-clear-link"
import {
  parseAdgroupScopeIds,
  parseCampaignScopeIds,
  type CampaignScopeSearchParams,
} from "@/lib/navigation/campaign-scope"

export default async function CampaignsPage({
  params,
  searchParams,
}: {
  params: Promise<{ advertiserId: string }>
  searchParams: Promise<CampaignScopeSearchParams>
}) {
  const { advertiserId } = await params
  const scopeSearchParams = await searchParams
  const campaignScopeIds = parseCampaignScopeIds(scopeSearchParams)
  const adgroupScopeIds = parseAdgroupScopeIds(scopeSearchParams)

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

  // raw 컬럼 select 안 함. campaign 모델은 advertiserId 외래키로만 조회.
  // userLock / useDailyBudget 은 backend 가 schema 추가 예정 — 추가되면 select 에 두 줄
  // (`userLock: true, useDailyBudget: true,`) 만 더하고 매핑 분기를 제거하면 됨.
  const rows = await prisma.campaign.findMany({
    where: { advertiserId },
    select: {
      id: true,
      nccCampaignId: true,
      name: true,
      campaignType: true,
      dailyBudget: true,
      status: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
  })

  // Decimal / Date → JSON-friendly 직렬화. CampaignRow shape 으로 매핑.
  // userLock / useDailyBudget 은 schema 미존재 — 보수적 기본값 (false / dailyBudget!=null) 처리.
  const campaigns: CampaignRow[] = rows.map((c) => ({
    id: c.id,
    nccCampaignId: c.nccCampaignId,
    name: c.name,
    campaignType: c.campaignType,
    dailyBudget:
      c.dailyBudget !== null ? Number(c.dailyBudget.toString()) : null,
    useDailyBudget: c.dailyBudget !== null,
    userLock: false,
    status: c.status,
    updatedAt: c.updatedAt.toISOString(),
  }))
  let initialSelectedCampaignIds = campaignScopeIds
  if (initialSelectedCampaignIds.length === 0 && adgroupScopeIds.length > 0) {
    const scopedAdgroups = await prisma.adGroup.findMany({
      where: {
        id: { in: adgroupScopeIds },
        campaign: { advertiserId },
      },
      select: { campaignId: true },
    })
    initialSelectedCampaignIds = Array.from(
      new Set(scopedAdgroups.map((g) => g.campaignId)),
    )
  }

  const hasScope =
    campaignScopeIds.length > 0 || adgroupScopeIds.length > 0
  const scopeMessage =
    adgroupScopeIds.length > 0
      ? `선택한 광고그룹 ${adgroupScopeIds.length}개의 부모 캠페인이 자동 선택되었습니다.`
      : campaignScopeIds.length > 0
        ? `선택한 캠페인 ${campaignScopeIds.length}개가 선택된 상태입니다.`
        : null

  return (
    <div className="flex flex-col gap-4 p-6">
      <PageHeader
        title="캠페인"
        description={
          hasScope && scopeMessage ? (
            <ScopeClearLink clearHref={`/${advertiserId}/campaigns`}>
              {scopeMessage}
            </ScopeClearLink>
          ) : (
            "ON/OFF · 일 예산을 다중 선택 후 일괄 변경할 수 있습니다."
          )
        }
        breadcrumbs={[
          { label: advertiser.name, href: `/${advertiserId}` },
          { label: "캠페인" },
        ]}
        actions={
          <SyncCampaignsButton
            advertiserId={advertiserId}
            hasKeys={advertiser.hasKeys}
          />
        }
      />
      <CampaignsTable
        key={initialSelectedCampaignIds.join(",")}
        advertiserId={advertiserId}
        hasKeys={advertiser.hasKeys}
        campaigns={campaigns}
        initialSelectedCampaignIds={initialSelectedCampaignIds}
      />
    </div>
  )
}
