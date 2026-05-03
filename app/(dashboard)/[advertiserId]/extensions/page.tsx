/**
 * 확장소재 목록 페이지 (F-5.x — P1 텍스트 2종)
 *
 * - RSC. 권한 검증 → advertiserId 한정 prisma 쿼리 (AdExtension → AdGroup → Campaign join)
 *   → 클라이언트 테이블 위임
 * - raw 컬럼 select X (1MB 응답 회피 — 5천 행 페이로드 절감)
 * - payload(Json) / inspectMemo(String?) 는 select 로 가져옴 (텍스트 추출 / 검수 메모)
 * - Date 필드는 클라이언트로 넘기기 전에 string 으로 변환
 * - take: 5000 — F-5.x 가상 스크롤 5천 행 안전 상한
 *
 * URL 패턴: `/[advertiserId]/extensions` (광고주별 컨텍스트 — SPEC 11.2)
 *
 * 권한 (F-1.6 / lib/auth/access.ts):
 *   - getCurrentAdvertiser 가 광고주 존재 + 사용자 화이트리스트 검사
 *   - admin 은 전체 접근, operator/viewer 는 UserAdvertiserAccess 한정
 *
 * 광고주 횡단 차단:
 *   - AdExtension 자체는 advertiserId 직접 외래키 없음 → adgroup.campaign join 으로 한정
 *   - `where: { ownerType: "adgroup", adgroup: { campaign: { advertiserId } } }`
 *
 * type 화이트리스트 (P1):
 *   - F-5.3 후속: headline / description / image 노출.
 *   - `where.type: { in: ["headline", "description", "image"] }`
 *
 * SPEC 6.2 F-5.x / 11.2 / 안전장치 1·5.
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
import { ExtensionsTable } from "@/components/dashboard/extensions-table"
import type {
  ExtensionRow,
  ExtensionAdgroupOption,
} from "@/components/dashboard/extensions-table"
import { SyncExtensionsWithFilter } from "@/components/dashboard/sync-extensions-with-filter"
import {
  parseCampaignScopeIds,
  type CampaignScopeSearchParams,
} from "@/lib/navigation/campaign-scope"

export default async function ExtensionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ advertiserId: string }>
  searchParams: Promise<CampaignScopeSearchParams>
}) {
  const { advertiserId } = await params
  const campaignScopeIds = parseCampaignScopeIds(await searchParams)
  const campaignWhere =
    campaignScopeIds.length > 0
      ? { advertiserId, id: { in: campaignScopeIds } }
      : { advertiserId }

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

  // raw 컬럼 select 안 함. ownerType=adgroup 한정 + adgroup.campaign.advertiserId join.
  // type 화이트리스트는 P1 3종 (headline / description / image — F-5.3 추가).
  const rows = await prisma.adExtension.findMany({
    where: {
      ownerType: "adgroup",
      adgroup: { campaign: campaignWhere },
      type: { in: ["headline", "description", "image"] },
    },
    select: {
      id: true,
      nccExtId: true,
      ownerId: true,
      type: true,
      payload: true,
      inspectStatus: true,
      inspectMemo: true,
      status: true,
      updatedAt: true,
      adgroup: {
        select: {
          id: true,
          name: true,
          nccAdgroupId: true,
          campaign: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: 5000, // F-5.x 가상 스크롤 5천 행 안전 상한
  })

  // F-5.4 추가 모달 — 광고그룹 옵션 (status='deleted' 제외, 광고주 한정).
  // 광고주 횡단 차단: where: { campaign: { advertiserId } }
  const adgroupRows = await prisma.adGroup.findMany({
    where: {
      campaign: campaignWhere,
      status: { not: "deleted" },
    },
    select: {
      id: true,
      nccAdgroupId: true,
      name: true,
      campaign: { select: { id: true, name: true } },
    },
    orderBy: [{ campaign: { name: "asc" } }, { name: "asc" }],
  })

  const adgroups: ExtensionAdgroupOption[] = adgroupRows.map((a) => ({
    id: a.id,
    nccAdgroupId: a.nccAdgroupId,
    name: a.name,
    campaign: { id: a.campaign.id, name: a.campaign.name },
  }))

  // F-5.1 / F-5.2 동기화 캠페인 필터 — 광고주 산하 캠페인 prefetch.
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
    // status 는 prisma enum (on/off/deleted). 컴포넌트와 동일 union.
    status: c.status as "on" | "off" | "deleted",
  }))

  // RSC → 클라이언트 직렬화. Date → ISO 문자열. ExtensionRow shape 매핑.
  // adgroup 은 항상 동반 (where 에서 ownerType=adgroup + adgroup join 필수 통과).
  // 그럼에도 prisma 가 relation 을 nullable 로 추론하면 fallback 처리.
  const extensions: ExtensionRow[] = rows
    .filter((e) => e.adgroup !== null)
    .map((e) => ({
      id: e.id,
      nccExtId: e.nccExtId,
      ownerId: e.ownerId,
      type: e.type,
      payload: e.payload,
      inspectStatus: e.inspectStatus,
      inspectMemo: e.inspectMemo,
      status: e.status,
      updatedAt: e.updatedAt.toISOString(),
      adgroup: {
        id: e.adgroup!.id,
        name: e.adgroup!.name,
        nccAdgroupId: e.adgroup!.nccAdgroupId,
        campaign: {
          id: e.adgroup!.campaign.id,
          name: e.adgroup!.campaign.name,
        },
      },
    }))

  return (
    <div className="flex flex-col gap-4 p-6">
      <PageHeader
        title="확장소재"
        description={
          campaignScopeIds.length > 0
            ? `선택한 캠페인 ${campaignScopeIds.length}개에 속한 확장소재만 표시합니다.`
            : "추가제목 / 추가설명 / 이미지. 체크박스로 다중 선택 후 ON/OFF 일괄 변경 가능. (인라인 편집은 후속 PR)"
        }
        breadcrumbs={[
          { label: advertiser.name, href: `/${advertiserId}` },
          { label: "확장소재" },
        ]}
        actions={
          <SyncExtensionsWithFilter
            advertiserId={advertiser.id}
            hasKeys={advertiser.hasKeys}
            campaigns={syncCampaigns}
          />
        }
      />
      <ExtensionsTable
        advertiserId={advertiserId}
        hasKeys={advertiser.hasKeys}
        extensions={extensions}
        adgroups={adgroups}
        userRole={userRole}
      />
    </div>
  )
}
