/**
 * 키워드 목록 페이지 (F-3.1) — 서버 페이지네이션 + 서버 정렬·필터·검색
 *
 * - RSC. 권한 검증 → advertiserId 한정 prisma 쿼리 (Keyword → AdGroup → Campaign join) → 클라이언트 테이블 위임
 * - raw 컬럼 select X (1MB 응답 회피)
 * - Decimal / Date 필드는 클라이언트로 넘기기 전에 number / string 으로 변환
 *
 * 페이지네이션 가정 (이전 5천 행 in-memory 모델 폐기):
 *   - URL `?page=N&pageSize=M&q=...&status=...&sort=...` 로 이동 → RSC 재조회
 *   - 한 광고주 = 키워드 4만+ 가능 → 클라이언트 메모리 5천 행 모델은 한계 부딪힘
 *   - Prisma findMany(skip, take) + count 동시 수행 (Promise.all)
 *   - 정렬·필터·검색 모두 서버 → 클라이언트는 표시만 담당 (manualPagination/Sorting)
 *
 * URL 패턴: `/[advertiserId]/keywords?page=1&pageSize=100&...` (광고주별 컨텍스트 — SPEC 11.2)
 *
 * 권한 (F-1.6 / lib/auth/access.ts):
 *   - getCurrentAdvertiser 가 광고주 존재 + 사용자 화이트리스트 검사
 *   - admin 은 전체 접근, operator/viewer 는 UserAdvertiserAccess 한정
 *
 * 광고주 횡단 차단:
 *   - Keyword 자체는 advertiserId 직접 외래키 없음 → adgroup.campaign join 으로 한정
 *   - `where: { adgroup: { campaign: { advertiserId } } }`
 *
 * SPEC 6.2 F-3.1 / 11.2 / 안전장치 1·5.
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
import { KeywordsTable } from "@/components/dashboard/keywords-table"
import type {
  KeywordRow,
  AdgroupOption,
} from "@/components/dashboard/keywords-table"
import { SyncKeywordsWithFilter } from "@/components/dashboard/sync-keywords-with-filter"
import { LastSyncBadge } from "@/components/dashboard/last-sync-badge"
import { ScopeClearLink } from "@/components/dashboard/scope-clear-link"
import { getLastSyncAt } from "@/lib/sync/last-sync-at"
import {
  parseAdgroupScopeIds,
  parseCampaignScopeIds,
  type CampaignScopeSearchParams,
} from "@/lib/navigation/campaign-scope"
import {
  parseKeywordPageParams,
  type KeywordPageParams,
  type KeywordSort,
} from "@/lib/navigation/keyword-page-params"
import { EMPTY_METRICS, parsePeriod } from "@/lib/dashboard/metrics"
import type * as Prisma from "@/lib/generated/prisma/internal/prismaNamespace"

type KeywordsSearchParams = CampaignScopeSearchParams & {
  period?: string | string[]
  page?: string | string[]
  pageSize?: string | string[]
  q?: string | string[]
  status?: string | string[]
  sort?: string | string[]
}

/**
 * KeywordSort 토큰 → Prisma orderBy 매핑.
 *
 * - recentAvgRnk 는 NULL 후순위 (낮을수록 좋은 지표라도 데이터 없는 행을 위로 올리지 않음).
 * - 그 외 단순 필드는 `{ field: dir }`.
 */
function sortToPrismaOrderBy(
  sort: KeywordSort,
): Prisma.KeywordOrderByWithRelationInput | Prisma.KeywordOrderByWithRelationInput[] {
  switch (sort) {
    case "updatedAt:desc":
      return { updatedAt: "desc" }
    case "updatedAt:asc":
      return { updatedAt: "asc" }
    case "keyword:asc":
      return { keyword: "asc" }
    case "keyword:desc":
      return { keyword: "desc" }
    case "bidAmt:desc":
      return { bidAmt: "desc" }
    case "bidAmt:asc":
      return { bidAmt: "asc" }
    case "recentAvgRnk:asc":
      return [{ recentAvgRnk: { sort: "asc", nulls: "last" } }]
    case "recentAvgRnk:desc":
      return [{ recentAvgRnk: { sort: "desc", nulls: "last" } }]
  }
}

// Server Action 단기 timeout fix — syncKeywords 가 광고그룹 N회 listKeywords 호출.
// 광고그룹 100개+ 일 때 60s 기본값으로 504 발생 → 300s 로 상향.
// 장기: ChangeBatch + Chunk Executor (SPEC 3.5) 이관 후 제거.
export const maxDuration = 300

export default async function KeywordsPage({
  params,
  searchParams,
}: {
  params: Promise<{ advertiserId: string }>
  searchParams: Promise<KeywordsSearchParams>
}) {
  const { advertiserId } = await params
  const scopeSearchParams = await searchParams
  const campaignScopeIds = parseCampaignScopeIds(scopeSearchParams)
  const adgroupScopeIds = parseAdgroupScopeIds(scopeSearchParams)
  const period = parsePeriod(scopeSearchParams.period)
  const pageParams: KeywordPageParams = parseKeywordPageParams(scopeSearchParams)
  const campaignWhere =
    campaignScopeIds.length > 0
      ? { advertiserId, id: { in: campaignScopeIds } }
      : { advertiserId }
  const adgroupWhere =
    adgroupScopeIds.length > 0
      ? { id: { in: adgroupScopeIds }, campaign: campaignWhere }
      : { campaign: campaignWhere }

  // Keyword where — 광고주 횡단 차단(adgroup.campaign join) + status / 검색어 필터.
  // q 는 case-insensitive contains. 빈 문자열이면 필터 미적용.
  const keywordWhere: Prisma.KeywordWhereInput = {
    adgroup: adgroupWhere,
    ...(adgroupScopeIds.length > 0 ? { adgroupId: { in: adgroupScopeIds } } : {}),
    ...(pageParams.status !== "all" ? { status: pageParams.status } : {}),
    ...(pageParams.q
      ? { keyword: { contains: pageParams.q, mode: "insensitive" as const } }
      : {}),
  }
  const orderBy = sortToPrismaOrderBy(pageParams.sort)
  const skip = (pageParams.page - 1) * pageParams.pageSize

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

  // 6개 호출 병렬 실행 (서로 독립).
  //   - lastSync:           마지막 동기화 시각 배지
  //   - rows:               현재 페이지 키워드 (skip / take = pageSize)
  //   - total:              서버 페이지네이션 — 전체 건수(필터 적용 후)
  //   - adgroupRows:        F-3.6 추가 모달 광고그룹 옵션 (scope 한정)
  //   - syncCampaignRows:   F-3.1 동기화 / 키워드 페이지 캠페인 필터 옵션 (광고주 전체)
  //   - filterAdgroupRows:  키워드 페이지 광고그룹 필터 옵션 (광고주 전체 — scope 무관)
  // raw 컬럼 select 안 함. 광고주 횡단 차단: adgroup.campaign.advertiserId join.
  const [
    lastSync,
    rows,
    total,
    adgroupRows,
    syncCampaignRows,
    filterAdgroupRows,
  ] = await Promise.all([
    getLastSyncAt(advertiserId),
    prisma.keyword.findMany({
      where: keywordWhere,
      select: {
        id: true,
        nccKeywordId: true,
        keyword: true,
        matchType: true,
        bidAmt: true,
        useGroupBidAmt: true,
        userLock: true,
        externalId: true, // F-3.5 CSV 내보내기 — UPDATE 행에 함께 출력 (재업로드 멱등키 보존)
        status: true,
        statusReason: true,
        inspectStatus: true,
        recentAvgRnk: true,
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
      orderBy,
      skip,
      take: pageParams.pageSize,
    }),
    prisma.keyword.count({ where: keywordWhere }),
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

  const totalPages = Math.max(1, Math.ceil(total / pageParams.pageSize))

  const keywordsLastSync = lastSync.keywords

  const adgroups: AdgroupOption[] = adgroupRows.map((a) => ({
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

  // 키워드 페이지 광고그룹 필터 옵션 — 광고주 전체 (캠페인/광고그룹 scope 무관).
  // 캠페인 필터 선택 변화에 따라 클라이언트에서 동적으로 추려짐.
  const filterAdgroups = filterAdgroupRows.map((g) => ({
    id: g.id,
    name: g.name,
    status: g.status as "on" | "off" | "deleted",
    campaignId: g.campaign.id,
    campaignName: g.campaign.name,
  }))

  // stats 호출은 RSC 에서 제외 — 클라이언트(KeywordsTable) 가 useEffect 로 fetchKeywordsStats 호출 (streaming).
  // Decimal / Date → JSON-friendly 직렬화. KeywordRow shape 으로 매핑.
  const keywords: KeywordRow[] = rows.map((k) => ({
    id: k.id,
    nccKeywordId: k.nccKeywordId,
    keyword: k.keyword,
    matchType: k.matchType,
    bidAmt: k.bidAmt,
    useGroupBidAmt: k.useGroupBidAmt,
    userLock: k.userLock,
    externalId: k.externalId,
    status: k.status,
    statusReason: k.statusReason,
    inspectStatus: k.inspectStatus,
    recentAvgRnk:
      k.recentAvgRnk !== null ? Number(k.recentAvgRnk.toString()) : null,
    updatedAt: k.updatedAt.toISOString(),
    adgroup: {
      id: k.adgroup.id,
      name: k.adgroup.name,
      nccAdgroupId: k.adgroup.nccAdgroupId,
      campaign: {
        id: k.adgroup.campaign.id,
        name: k.adgroup.campaign.name,
      },
    },
    metrics: EMPTY_METRICS,
  }))

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title="키워드"
        description={
          adgroupScopeIds.length > 0 ? (
            <ScopeClearLink clearHref={`/${advertiserId}/keywords`}>
              {`선택한 광고그룹 ${adgroupScopeIds.length}개에 속한 키워드만 표시합니다.`}
            </ScopeClearLink>
          ) : campaignScopeIds.length > 0 ? (
            <ScopeClearLink clearHref={`/${advertiserId}/keywords`}>
              {`선택한 캠페인 ${campaignScopeIds.length}개에 속한 키워드만 표시합니다.`}
            </ScopeClearLink>
          ) : null
        }
        helpText={
          <>
            <p className="font-medium text-foreground">사용 방법</p>
            <ul className="mt-1.5 list-disc pl-4 leading-relaxed">
              <li>셀 클릭 → 인라인 편집 (변경은 미리보기 후 일괄 적용)</li>
              <li>체크박스 다중 선택 → 상단 액션바에서 ON/OFF · 입찰가 일괄 변경</li>
              <li>CSV 가져오기로 일괄 생성 · 수정 · OFF</li>
            </ul>
          </>
        }
        breadcrumbs={[
          { label: advertiser.name, href: `/${advertiserId}` },
          { label: "키워드" },
        ]}
        actions={
          <>
            <LastSyncBadge syncedAt={keywordsLastSync} />
            <SyncKeywordsWithFilter
              advertiserId={advertiserId}
              hasKeys={advertiser.hasKeys}
              campaigns={syncCampaigns}
              initialCampaignIds={campaignScopeIds}
            />
          </>
        }
      />
      <KeywordsTable
        advertiserId={advertiserId}
        hasKeys={advertiser.hasKeys}
        keywords={keywords}
        total={total}
        pagination={{
          page: pageParams.page,
          pageSize: pageParams.pageSize,
          totalPages,
        }}
        filters={{
          q: pageParams.q,
          status: pageParams.status,
          sort: pageParams.sort,
          campaignIds: campaignScopeIds,
          adgroupIds: adgroupScopeIds,
        }}
        adgroups={adgroups}
        filterCampaigns={syncCampaigns}
        filterAdgroups={filterAdgroups}
        userRole={userRole}
        period={period}
      />
    </div>
  )
}
