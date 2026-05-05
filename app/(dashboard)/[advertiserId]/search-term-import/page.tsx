/**
 * F-D.3 검색어 보고서 CSV 업로드 페이지 (RSC).
 *
 * 책임:
 *   - 권한 검증 (getCurrentAdvertiser)
 *   - KPP baseline 조회 (UI 안내용 — 실제 분류는 클라이언트가 server action 호출 시 다시 조회)
 *   - 클라이언트 컴포넌트(SearchTermImportClient) 위임
 *
 * 본 PR 단순화:
 *   - 분석 결과만 화면에 표시 (DB 적재 옵션 — saveSearchTermReport)
 *   - 자동 SA write 절대 X (안내 문구 명시)
 *   - 광고그룹 매핑 / ApprovalQueue 적재 / 자동 등록은 후속 PR
 *
 * URL 패턴: /[advertiserId]/search-term-import
 * SPEC v0.2.1 F-D.3 + plan(graceful-sparking-graham) Phase D.3
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
import { SearchTermImportClient } from "@/components/dashboard/search-term-import-client"

export default async function SearchTermImportPage({
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

  // -- KPP baseline + 광고그룹 옵션 병렬 조회 --------------------------------
  // 광고그룹 옵션: D.4 신규 후보 row 별 dropdown 채우기용.
  //   - 광고주 한정 (campaign.advertiserId == advertiserId)
  //   - 활성만 (status != 'deleted'). off 도 노출 — 캠페인 일시 정지 중에도 검색어 매핑 가능.
  //   - 캠페인명도 prop 으로 전달 (UI label "캠페인 / 광고그룹" 노출용)
  const [kpp, adgroupOptionsRaw] = await Promise.all([
    prisma.keywordPerformanceProfile.findUnique({
      where: { advertiserId },
      select: {
        avgCtr: true,
        avgCvr: true,
        avgCpc: true,
        dataDays: true,
        refreshedAt: true,
      },
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

  const adgroupOptions = adgroupOptionsRaw.map((g) => ({
    id: g.id,
    name: g.name,
    status: g.status,
    campaignName: g.campaign.name,
  }))

  const baselineForDisplay = kpp
    ? {
        avgCtr: kpp.avgCtr !== null ? Number(kpp.avgCtr) : null,
        avgCvr: kpp.avgCvr !== null ? Number(kpp.avgCvr) : null,
        avgCpc: kpp.avgCpc !== null ? Number(kpp.avgCpc) : null,
        dataDays: kpp.dataDays,
        refreshedAt: kpp.refreshedAt.toISOString(),
      }
    : null

  // -- "이번 주 월요일" (KST) — saveSearchTermReport 기본값 ------------------
  // 운영 정책: 사용자 다운로드 시점이 "어떤 주의 보고서" 인지는 사용자가 알기 때문에
  // 기본값만 제공 (UI 에서 수정 가능하게).
  const todayMondayKst = computeMondayOfWeekKst(new Date())

  return (
    <div className="flex flex-col gap-4 p-6">
      <PageHeader
        title="검색어 보고서 분석"
        description="네이버 SA 콘솔에서 다운로드한 검색어 보고서 CSV 를 업로드하면, 광고주 baseline 기반으로 신규 후보 / 제외 후보를 자동 분류합니다. 본 도구는 분석 결과만 보여줍니다 — 실제 키워드 등록 / 제외 등록은 SA 콘솔에서 직접 수행하세요."
        breadcrumbs={[
          { label: advertiser.name, href: `/${advertiserId}` },
          { label: "검색어 분석" },
        ]}
      />

      <SearchTermImportClient
        advertiserId={advertiserId}
        userRole={userRole}
        baselineForDisplay={baselineForDisplay}
        defaultWeekStart={todayMondayKst}
        adgroupOptions={adgroupOptions}
      />
    </div>
  )
}

// =============================================================================
// 유틸 — KST 기준 이번 주 월요일 yyyy-mm-dd
// =============================================================================
//
// 운영 단순화: KST(UTC+9) 기준 월요일 계산.
//   - new Date() 는 서버 시각 (UTC) — KST 변환 후 요일 계산 후 UTC 자정으로 환산
//   - 정확한 timezone DB 라이브러리 도입 회피 (단순 산술로 충분 — ±1일 어긋날 위험 미미)

function computeMondayOfWeekKst(now: Date): string {
  // KST = UTC + 9h
  const kstMs = now.getTime() + 9 * 60 * 60 * 1000
  const kst = new Date(kstMs)
  // getUTC* 로 KST 표현을 추출 (kstMs 가 이미 시프트됐으므로)
  const dow = kst.getUTCDay() // 0=일 ... 6=토
  // 월요일 = dow === 1. 일=0 → 6일 전, 그 외 dow-1 일 전
  const diff = dow === 0 ? 6 : dow - 1
  const monday = new Date(kstMs - diff * 24 * 60 * 60 * 1000)
  const y = monday.getUTCFullYear()
  const m = String(monday.getUTCMonth() + 1).padStart(2, "0")
  const d = String(monday.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}
