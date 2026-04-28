/**
 * 광고주 컨텍스트 대시보드 (F-7.1 KPI + F-7.4 TOP)
 *
 * - 권한: getCurrentAdvertiser 가 admin 또는 화이트리스트 검증을 처리
 * - 키 미설정 시 안내 카드 (testConnection / 동기화 / SA API 호출 차단됨)
 * - F-1.5 연결 상태 카드 (비즈머니 잔액 + 잠금 상태)
 * - F-7.1 KPI: 오늘 / 어제 / 7일 / 30일 (4 기간 × 4 지표)
 * - F-7.4 TOP: 캠페인 / 키워드 (지표·기간·정렬·limit 가변)
 * - 캠페인 / 광고그룹 / 키워드 / 소재 / 확장소재 진입 링크
 *
 * RSC 사전 호출:
 *   checkConnection / getDashboardKpi / getTopCampaigns 를 Promise.all 로 병렬.
 *   hasKeys=false 시 모두 null 로 패스 (외부 호출 차단).
 *
 * SPEC 6.7 F-7.1 / F-7.4 / 11.2 대시보드.
 */

import Link from "next/link"
import { redirect, notFound } from "next/navigation"

import {
  getCurrentAdvertiser,
  AdvertiserNotFoundError,
  AuthorizationError,
  UnauthenticatedError,
} from "@/lib/auth/access"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { KeyStatusBadge } from "@/components/admin/key-status-badge"
import { ConnectionStatusCard } from "@/components/dashboard/connection-status-card"
import { KpiCardsSection } from "@/components/dashboard/kpi-cards-section"
import { TopListSection } from "@/components/dashboard/top-list-section"
import { checkConnection } from "@/app/(dashboard)/[advertiserId]/actions"
import {
  getDashboardKpi,
  getTopCampaigns,
} from "@/app/(dashboard)/[advertiserId]/dashboard/actions"

export default async function AdvertiserDashboardPage({
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
      // 권한 없음 / 아카이브된 광고주 → 404 (정보 노출 최소화)
      notFound()
    }
    throw e
  }

  // RSC 사전 호출 — 키 있으면 병렬 (waterfall 방지). 없으면 모두 null (외부 호출 차단).
  // checkConnection / getDashboardKpi / getTopCampaigns 는 모두 advertiserId 권한 재검증 포함.
  const [connectionInitial, kpiInitial, topCampaignsInitial] =
    advertiser.hasKeys
      ? await Promise.all([
          checkConnection(advertiser.id),
          getDashboardKpi(advertiser.id),
          getTopCampaigns(advertiser.id, {
            metric: "impCnt",
            period: "recent7d",
            limit: 5,
            order: "desc",
          }),
        ])
      : [null, null, null]

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-xl font-medium leading-snug">
            {advertiser.name}
          </h1>
          <p className="text-sm text-muted-foreground">
            customerId{" "}
            <span className="font-mono">{advertiser.customerId}</span> · 상태{" "}
            {advertiser.status}
          </p>
          <div className="mt-2">
            <KeyStatusBadge
              hasApiKey={advertiser.hasKeys}
              hasSecretKey={advertiser.hasKeys}
            />
          </div>
        </div>
      </div>

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

      {/* F-1.5 / F-7.1 / F-7.4 — RSC 단계에서 Promise.all 병렬 호출 후 props 전달.
          hasKeys=false 면 SA 호출 차단 → null. 클라이언트는 새로고침만 제공.
          Stats 응답은 stats.ts 자체 캐시 (오늘 5분 / 과거 1시간) 적용. */}
      <ConnectionStatusCard
        advertiserId={advertiser.id}
        hasKeys={advertiser.hasKeys}
        initial={connectionInitial}
      />

      <KpiCardsSection
        advertiserId={advertiser.id}
        hasKeys={advertiser.hasKeys}
        initial={kpiInitial}
      />

      <TopListSection
        advertiserId={advertiser.id}
        hasKeys={advertiser.hasKeys}
        initial={topCampaignsInitial}
      />

      <Card>
        <CardHeader className="border-b">
          <CardTitle>광고 구조</CardTitle>
          <CardDescription>
            캠페인 / 광고그룹 / 키워드 / 소재 / 확장소재. P1 후속 단계에서
            구현됩니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 py-4">
          <Button
            variant="outline"
            render={<Link href={`/${advertiser.id}/campaigns`} />}
          >
            캠페인
          </Button>
          <Button
            variant="outline"
            render={<Link href={`/${advertiser.id}/adgroups`} />}
          >
            광고그룹
          </Button>
          <Button
            variant="outline"
            render={<Link href={`/${advertiser.id}/keywords`} />}
          >
            키워드
          </Button>
          <Button
            variant="outline"
            render={<Link href={`/${advertiser.id}/ads`} />}
          >
            소재
          </Button>
          <Button
            variant="outline"
            render={<Link href={`/${advertiser.id}/extensions`} />}
          >
            확장소재
          </Button>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        다른 광고주로 전환은 상단 셀렉터로. 권한 점검은{" "}
        <Link href="/admin/advertisers" className="underline">
          광고주 관리
        </Link>{" "}
        (admin) 에서.
      </p>
    </div>
  )
}
