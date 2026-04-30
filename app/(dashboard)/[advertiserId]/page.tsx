/**
 * 광고주 컨텍스트 대시보드 (F-7.1 KPI + F-7.2 트렌드 + F-7.4 TOP) — 컴팩트 재구성
 *
 * - 권한: getCurrentAdvertiser 가 admin 또는 화이트리스트 검증
 * - HERO 1행: 광고주명 / cid / 비즈머니+잠금 / 마지막 동기화 / 글로벌 새로고침
 * - md+ 2-col 그리드: KPI(2/3) + Quick Nav(1/3) → 트렌드(2/3) + TOP(1/3)
 * - 알림 피드: admin + 1건 이상일 때만 (그 외 영역 hidden)
 * - 새로고침은 router.refresh() — RSC 전체 재호출 → KPI/차트/TOP/비즈머니/lastSync 모두 갱신
 *
 * RSC 사전 호출:
 *   checkConnection / getDashboardKpi / getStatsTimeSeries / getTopCampaigns / getLastSyncAt 병렬.
 *   hasKeys=false 면 SA 호출 차단 → null 패스. lastSyncAt 은 키 무관 항상 호출.
 *
 * SPEC 6.7 F-7.1 / F-7.2 / F-7.4 / 11.2 대시보드.
 */

import { redirect, notFound } from "next/navigation"

import {
  getCurrentAdvertiser,
  getCurrentUser,
  AdvertiserNotFoundError,
  AuthorizationError,
  UnauthenticatedError,
} from "@/lib/auth/access"
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { DashboardHero } from "@/components/dashboard/dashboard-hero"
import { QuickNavCard } from "@/components/dashboard/quick-nav-card"
import { KpiCardsSection } from "@/components/dashboard/kpi-cards-section"
import { TrendChartSection } from "@/components/dashboard/trend-chart-section"
import { TopListSection } from "@/components/dashboard/top-list-section"
import { AlertEventsFeed } from "@/components/dashboard/alert-events-feed"
import { checkConnection } from "@/app/(dashboard)/[advertiserId]/actions"
import {
  getDashboardKpi,
  getStatsTimeSeries,
  getTopCampaigns,
} from "@/app/(dashboard)/[advertiserId]/dashboard/actions"
import { listAlertEvents } from "@/app/admin/alerts/actions"
import { getLastSyncAt } from "@/lib/sync/last-sync-at"

export default async function AdvertiserDashboardPage({
  params,
}: {
  params: Promise<{ advertiserId: string }>
}) {
  const { advertiserId } = await params

  let advertiser
  let isAdmin = false
  try {
    const ctx = await getCurrentAdvertiser(advertiserId)
    advertiser = ctx.advertiser
    // F-7.3 보너스 — 알림 피드는 admin 만 listAlertEvents 호출 가능.
    const me = await getCurrentUser()
    isAdmin = me.role === "admin"
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      redirect("/login")
    }
    if (e instanceof AdvertiserNotFoundError) {
      notFound()
    }
    if (e instanceof AuthorizationError) {
      // 권한 없음 / 아카이브된 광고주 → 404 (정보 노출 최소화)
      notFound()
    }
    throw e
  }

  // RSC 사전 호출 — 키 있으면 병렬 (waterfall 방지). 없으면 모두 null (외부 호출 차단).
  // lastSyncAt 은 DB 조회만이라 키 무관 항상 호출.
  const [
    connectionInitial,
    kpiInitial,
    trendInitial,
    topCampaignsInitial,
    alertsInitial,
    lastSyncAtInitial,
  ] = await Promise.all([
    advertiser.hasKeys ? checkConnection(advertiser.id) : Promise.resolve(null),
    advertiser.hasKeys ? getDashboardKpi(advertiser.id) : Promise.resolve(null),
    advertiser.hasKeys
      ? getStatsTimeSeries(advertiser.id, { grain: "daily", days: 7 })
      : Promise.resolve(null),
    advertiser.hasKeys
      ? getTopCampaigns(advertiser.id, {
          metric: "impCnt",
          period: "last7days",
          limit: 5,
          order: "desc",
        })
      : Promise.resolve(null),
    isAdmin
      ? listAlertEvents({ advertiserId: advertiser.id, limit: 5 })
          .then((p) => p.items)
          .catch(() => null)
      : Promise.resolve(null),
    getLastSyncAt(advertiser.id),
  ])

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      {/* HERO — 1행 컴팩트 헤더 (광고주명 / 비즈머니 / 마지막 동기화 / 글로벌 새로고침) */}
      <DashboardHero
        advertiser={advertiser}
        initialConnection={connectionInitial}
        lastSyncAt={lastSyncAtInitial}
      />

      {/* API 키 미설정 안내 — Hero 의 빨간 배지와 별개로 자세한 설명 카드. */}
      {!advertiser.hasKeys && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="text-amber-700 dark:text-amber-400">
              API 키 미설정
            </CardTitle>
            <CardDescription>
              이 광고주는 API 키 / Secret 키가 입력되지 않았습니다. SA API 호출
              (테스트 연결 / 광고 구조 동기화 / 성과 조회 등)이 차단됩니다.
              admin 권한자가 광고주 상세 화면에서 키를 입력하면 활성화됩니다.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* 1행: KPI(2/3) + Quick Nav(1/3) — md 부터 2-col 그리드 */}
      <div className="grid gap-4 md:grid-cols-3">
        <div className="md:col-span-2">
          <KpiCardsSection
            advertiserId={advertiser.id}
            hasKeys={advertiser.hasKeys}
            initial={kpiInitial}
          />
        </div>
        <div className="md:col-span-1">
          <QuickNavCard advertiserId={advertiser.id} />
        </div>
      </div>

      {/* 2행: 트렌드(2/3) + TOP(1/3) */}
      <div className="grid gap-4 md:grid-cols-3">
        <div className="md:col-span-2">
          <TrendChartSection
            advertiserId={advertiser.id}
            hasKeys={advertiser.hasKeys}
            initial={trendInitial}
          />
        </div>
        <div className="md:col-span-1">
          <TopListSection
            advertiserId={advertiser.id}
            hasKeys={advertiser.hasKeys}
            initial={topCampaignsInitial}
          />
        </div>
      </div>

      {/* 3행: 알림 피드 — admin + 1건 이상일 때만 자체 렌더, 그 외 null */}
      <AlertEventsFeed isAdmin={isAdmin} initial={alertsInitial} />
    </div>
  )
}
