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
import { ScopeClearLink } from "@/components/dashboard/scope-clear-link"
import {
  parseAdgroupScopeIds,
  parseCampaignScopeIds,
  type CampaignScopeSearchParams,
} from "@/lib/navigation/campaign-scope"
import { EMPTY_METRICS, parsePeriod } from "@/lib/dashboard/metrics"

type ExtensionsSearchParams = CampaignScopeSearchParams & {
  period?: string | string[]
}

// Server Action 단기 timeout fix — syncExtensions 가 광고그룹 × type 3종 N×3회 listAdExtensions 호출.
// 5종 sync 중 가장 호출량 많음 — 504 위험 가장 높음.
// 장기: ChangeBatch + Chunk Executor (SPEC 3.5) 이관 후 제거.
export const maxDuration = 300

export default async function ExtensionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ advertiserId: string }>
  searchParams: Promise<ExtensionsSearchParams>
}) {
  const { advertiserId } = await params
  const scopeSearchParams = await searchParams
  const campaignScopeIds = parseCampaignScopeIds(scopeSearchParams)
  const adgroupScopeIds = parseAdgroupScopeIds(scopeSearchParams)
  const period = parsePeriod(scopeSearchParams.period)
  const campaignWhere =
    campaignScopeIds.length > 0
      ? { advertiserId, id: { in: campaignScopeIds } }
      : { advertiserId }
  const adgroupWhere =
    adgroupScopeIds.length > 0
      ? { id: { in: adgroupScopeIds }, campaign: campaignWhere }
      : { campaign: campaignWhere }

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

  // 4개 prisma 쿼리 병렬 실행 (서로 독립).
  //   - rows:                메인 확장소재 데이터 (ownerType=adgroup, P1 3종)
  //   - adgroupRows:         F-5.4 추가 모달 광고그룹 옵션 (scope 한정)
  //   - syncCampaignRows:    F-5.1/F-5.2 동기화 / toolbar 캠페인 필터 옵션 (광고주 전체)
  //   - filterAdgroupRows:   toolbar 광고그룹 필터 옵션 (광고주 전체 — scope 무관)
  // raw 컬럼 select 안 함. 광고주 횡단 차단: adgroup.campaign.advertiserId join.
  const [rows, adgroupRows, syncCampaignRows, filterAdgroupRows] =
    await Promise.all([
      prisma.adExtension.findMany({
        where: {
          ownerType: "adgroup",
          adgroup: adgroupWhere,
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
      }),
      prisma.adGroup.findMany({
        where: {
          ...adgroupWhere,
          status: { not: "deleted" },
        },
        select: {
          id: true,
          nccAdgroupId: true,
          name: true,
          campaign: { select: { id: true, name: true } },
        },
        orderBy: [{ campaign: { name: "asc" } }, { name: "asc" }],
      }),
      prisma.campaign.findMany({
        where: { advertiserId, status: { not: "deleted" } },
        select: { id: true, name: true, nccCampaignId: true, status: true },
        orderBy: { name: "asc" },
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
          campaign: { select: { id: true, name: true } },
        },
        orderBy: [{ campaign: { name: "asc" } }, { name: "asc" }],
      }),
    ])

  const adgroups: ExtensionAdgroupOption[] = adgroupRows.map((a) => ({
    id: a.id,
    nccAdgroupId: a.nccAdgroupId,
    name: a.name,
    campaign: { id: a.campaign.id, name: a.campaign.name },
  }))

  const syncCampaigns = syncCampaignRows.map((c) => ({
    id: c.id,
    name: c.name,
    nccCampaignId: c.nccCampaignId,
    status: c.status as "on" | "off" | "deleted",
  }))

  // toolbar 광고그룹 필터 옵션 — 광고주 전체 (scope 무관).
  const filterAdgroups = filterAdgroupRows.map((g) => ({
    id: g.id,
    name: g.name,
    status: g.status as "on" | "off" | "deleted",
    campaignId: g.campaign.id,
    campaignName: g.campaign.name,
  }))

  // stats 호출은 RSC 에서 제외 — 클라이언트(ExtensionsTable) 가 useEffect 로 fetchExtensionsStats 호출 (streaming).

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
      metrics: EMPTY_METRICS,
    }))

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title="확장소재"
        description={
          adgroupScopeIds.length > 0 ? (
            <ScopeClearLink clearHref={`/${advertiserId}/extensions`}>
              {`선택한 광고그룹 ${adgroupScopeIds.length}개에 속한 확장소재만 표시합니다.`}
            </ScopeClearLink>
          ) : campaignScopeIds.length > 0 ? (
            <ScopeClearLink clearHref={`/${advertiserId}/extensions`}>
              {`선택한 캠페인 ${campaignScopeIds.length}개에 속한 확장소재만 표시합니다.`}
            </ScopeClearLink>
          ) : null
        }
        helpText={
          <>
            <p className="font-medium text-foreground">사용 방법</p>
            <ul className="mt-1.5 list-disc pl-4 leading-relaxed">
              <li>지원 유형: 추가제목 / 추가설명 / 이미지</li>
              <li>체크박스 다중 선택 → ON/OFF 일괄. 인라인 편집은 후속 업데이트</li>
            </ul>
          </>
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
            initialCampaignIds={campaignScopeIds}
          />
        }
      />
      <ExtensionsTable
        advertiserId={advertiserId}
        hasKeys={advertiser.hasKeys}
        extensions={extensions}
        adgroups={adgroups}
        filterCampaigns={syncCampaigns}
        filterAdgroups={filterAdgroups}
        selectedCampaignFilterIds={campaignScopeIds}
        selectedAdgroupFilterIds={adgroupScopeIds}
        userRole={userRole}
        period={period}
      />
    </div>
  )
}
