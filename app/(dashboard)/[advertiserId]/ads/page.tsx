/**
 * 소재 목록 페이지 (F-4.1)
 *
 * - RSC. 권한 검증 → advertiserId 한정 prisma 쿼리 (Ad → AdGroup → Campaign join) → 클라이언트 테이블 위임
 * - raw 컬럼 select X (1MB 응답 회피 — 5천 행 페이로드 절감)
 * - fields(Json?) / inspectMemo(String?) / adType(String?) 는 select 로 가져옴 (미리보기 / 검수 메모 / 타입 표시)
 * - Decimal / Date 필드는 클라이언트로 넘기기 전에 string 으로 변환
 * - take: 5000 — F-4.1 가상 스크롤 5천 행 안전 상한
 *
 * URL 패턴: `/[advertiserId]/ads` (광고주별 컨텍스트 — SPEC 11.2)
 *
 * 권한 (F-1.6 / lib/auth/access.ts):
 *   - getCurrentAdvertiser 가 광고주 존재 + 사용자 화이트리스트 검사
 *   - admin 은 전체 접근, operator/viewer 는 UserAdvertiserAccess 한정
 *
 * 광고주 횡단 차단:
 *   - Ad 자체는 advertiserId 직접 외래키 없음 → adgroup.campaign join 으로 한정
 *   - `where: { adgroup: { campaign: { advertiserId } } }`
 *
 * SPEC 6.2 F-4.1 / 11.2 / 안전장치 1·5.
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
import { AdsTable } from "@/components/dashboard/ads-table"
import type {
  AdRow,
  AdAdgroupOption,
} from "@/components/dashboard/ads-table"
import { SyncAdsWithFilter } from "@/components/dashboard/sync-ads-with-filter"
import { ScopeClearLink } from "@/components/dashboard/scope-clear-link"
import {
  parseAdgroupScopeIds,
  parseCampaignScopeIds,
  type CampaignScopeSearchParams,
} from "@/lib/navigation/campaign-scope"
import { EMPTY_METRICS, parsePeriod } from "@/lib/dashboard/metrics"

type AdsSearchParams = CampaignScopeSearchParams & {
  period?: string | string[]
}

// Server Action 단기 timeout fix — syncAds 가 광고그룹 N회 listAds 호출.
// 장기: ChangeBatch + Chunk Executor (SPEC 3.5) 이관 후 제거.
export const maxDuration = 300

export default async function AdsPage({
  params,
  searchParams,
}: {
  params: Promise<{ advertiserId: string }>
  searchParams: Promise<AdsSearchParams>
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

  // 3개 prisma 쿼리 병렬 실행 (서로 독립).
  //   - rows:             메인 소재 데이터 (5천행 상한)
  //   - adgroupRows:      F-4.6 추가 모달 광고그룹 옵션
  //   - syncCampaignRows: F-4.1 동기화 캠페인 필터
  // raw 컬럼 select 안 함. 광고주 횡단 차단: adgroup.campaign.advertiserId join.
  const [rows, adgroupRows, syncCampaignRows] = await Promise.all([
    prisma.ad.findMany({
      where: { adgroup: adgroupWhere },
      select: {
        id: true,
        nccAdId: true,
        adType: true,
        fields: true,
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
      take: 5000, // F-4.1 가상 스크롤 5천 행 안전 상한
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
  ])

  const adgroups: AdAdgroupOption[] = adgroupRows.map((a) => ({
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

  // stats 호출은 RSC 에서 제외 — 클라이언트(AdsTable) 가 useEffect 로 fetchAdsStats 호출 (streaming).
  // 페이지 진입 시 metrics 모두 EMPTY_METRICS → 표 즉시 표시 → 도착 시 점진 채움.

  // Date → ISO 직렬화. AdRow shape 으로 매핑.
  // fields 는 Prisma Json 그대로 통과 (클라이언트에서 extractAdPreview 가 휴리스틱 추출).
  const ads: AdRow[] = rows.map((a) => ({
    id: a.id,
    nccAdId: a.nccAdId,
    adType: a.adType,
    fields: a.fields,
    inspectStatus: a.inspectStatus,
    inspectMemo: a.inspectMemo,
    status: a.status,
    updatedAt: a.updatedAt.toISOString(),
    adgroup: {
      id: a.adgroup.id,
      name: a.adgroup.name,
      nccAdgroupId: a.adgroup.nccAdgroupId,
      campaign: {
        id: a.adgroup.campaign.id,
        name: a.adgroup.campaign.name,
      },
    },
    metrics: EMPTY_METRICS,
  }))

  return (
    <div className="flex flex-col gap-4 p-6">
      <PageHeader
        title="소재"
        description={
          adgroupScopeIds.length > 0 ? (
            <ScopeClearLink clearHref={`/${advertiserId}/ads`}>
              {`선택한 광고그룹 ${adgroupScopeIds.length}개에 속한 소재만 표시합니다.`}
            </ScopeClearLink>
          ) : campaignScopeIds.length > 0 ? (
            <ScopeClearLink clearHref={`/${advertiserId}/ads`}>
              {`선택한 캠페인 ${campaignScopeIds.length}개에 속한 소재만 표시합니다.`}
            </ScopeClearLink>
          ) : (
            "광고그룹별 소재 목록. 체크박스로 다중 선택 후 ON/OFF 일괄 변경 가능. (인라인 편집·CSV 는 후속 PR)"
          )
        }
        breadcrumbs={[
          { label: advertiser.name, href: `/${advertiserId}` },
          { label: "소재" },
        ]}
        actions={
          <SyncAdsWithFilter
            advertiserId={advertiserId}
            hasKeys={advertiser.hasKeys}
            campaigns={syncCampaigns}
            initialCampaignIds={campaignScopeIds}
          />
        }
      />
      <AdsTable
        advertiserId={advertiserId}
        hasKeys={advertiser.hasKeys}
        ads={ads}
        adgroups={adgroups}
        userRole={userRole}
        period={period}
      />
    </div>
  )
}
