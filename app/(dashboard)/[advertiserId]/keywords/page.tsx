/**
 * 키워드 목록 페이지 (F-3.1)
 *
 * - RSC. 권한 검증 → advertiserId 한정 prisma 쿼리 (Keyword → AdGroup → Campaign join) → 클라이언트 테이블 위임
 * - raw 컬럼 select X (1MB 응답 회피 — 5천 행 페이로드 절감)
 * - Decimal / Date 필드는 클라이언트로 넘기기 전에 number / string 으로 변환
 * - take: 5000 — F-3.1 가상 스크롤 5천 행 안전 상한
 *
 * URL 패턴: `/[advertiserId]/keywords` (광고주별 컨텍스트 — SPEC 11.2)
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
import { getStatsChunked } from "@/lib/naver-sa/stats"
import { NaverSaError } from "@/lib/naver-sa/errors"
import { EMPTY_METRICS, parsePeriod } from "@/lib/dashboard/metrics"

type KeywordsSearchParams = CampaignScopeSearchParams & {
  period?: string | string[]
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

  // 마지막 동기화 시각 — UI 배지 표시용. 헬퍼는 read-only / 광고주 권한 검증은 위 getCurrentAdvertiser 가 담당.
  const lastSync = await getLastSyncAt(advertiserId)
  const keywordsLastSync = lastSync.keywords

  // raw 컬럼 select 안 함. Keyword 는 advertiserId 직접 외래키 X
  //   → adgroup.campaign.advertiserId join 으로 한정.
  const rows = await prisma.keyword.findMany({
    where: { adgroup: adgroupWhere },
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
    orderBy: { updatedAt: "desc" },
    take: 5000, // F-3.1 가상 스크롤 5천 행 안전 상한
  })

  // F-3.6 키워드 추가 모달 — 광고그룹 옵션 (status='deleted' 제외, 광고주 한정).
  //
  // KeywordsTable 의 필터바 광고그룹 select 는 "현재 키워드 데이터 안의 광고그룹"
  // 만 노출 (= keywords 배열에서 unique 추출) — 필터링 대상 한정 유지.
  // 본 adgroupRows 는 그와 분리된 "추가 가능한 모든 광고그룹 목록" 으로,
  // 키워드가 0건인 광고주에서도 키워드 추가 모달이 정상 동작하도록 별도 조회한다.
  //
  // 광고주 횡단 차단: where: { campaign: { advertiserId } }
  const adgroupRows = await prisma.adGroup.findMany({
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
  })

  const adgroups: AdgroupOption[] = adgroupRows.map((a) => ({
    id: a.id,
    nccAdgroupId: a.nccAdgroupId,
    name: a.name,
    campaign: { id: a.campaign.id, name: a.campaign.name },
  }))

  // F-3.1 동기화 캠페인 필터 — 광고주 산하 캠페인 prefetch.
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

  // 키워드별 stats 조회 — ads/page.tsx 와 동일 패턴.
  // graceful degrade — 실패 시 metrics 0 + statsError 안내.
  const nccKeywordIds = rows.map((k) => k.nccKeywordId)
  const metricsMap = new Map<
    string,
    { impCnt: number; clkCnt: number; ctr: number; cpc: number; salesAmt: number }
  >()
  let statsError: string | null = null
  if (advertiser.hasKeys && nccKeywordIds.length > 0) {
    try {
      const statsRows = await getStatsChunked(advertiser.customerId, {
        ids: nccKeywordIds,
        fields: ["impCnt", "clkCnt", "ctr", "cpc", "salesAmt"],
        datePreset: period,
      })
      for (const r of statsRows) {
        if (typeof r.id !== "string") continue
        metricsMap.set(r.id, {
          impCnt: typeof r.impCnt === "number" ? r.impCnt : 0,
          clkCnt: typeof r.clkCnt === "number" ? r.clkCnt : 0,
          ctr: typeof r.ctr === "number" ? r.ctr : 0,
          cpc: typeof r.cpc === "number" ? r.cpc : 0,
          salesAmt: typeof r.salesAmt === "number" ? r.salesAmt : 0,
        })
      }
    } catch (e) {
      statsError =
        e instanceof NaverSaError ? e.message : e instanceof Error ? e.message : "알 수 없는 오류"
      console.warn("[keywords/page] getStatsChunked failed:", e)
    }
  }

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
    metrics: metricsMap.get(k.nccKeywordId) ?? EMPTY_METRICS,
  }))

  return (
    <div className="flex flex-col gap-4 p-6">
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
          ) : (
            "셀을 클릭해 인라인 편집하거나, 체크박스로 다중 선택 후 ON/OFF · 입찰가 일괄 변경. CSV 가져오기로 일괄 생성·수정·OFF 가능."
          )
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
        adgroups={adgroups}
        userRole={userRole}
        period={period}
        statsError={statsError}
      />
    </div>
  )
}
