/**
 * 광고주 컨텍스트 대시보드 (placeholder — F-7.1 에서 본격 구현)
 *
 * - 권한: getCurrentAdvertiser 가 admin 또는 화이트리스트 검증을 처리
 * - 키 미설정 시 안내 카드 (testConnection / 동기화 / SA API 호출 차단됨)
 * - KPI 카드 자리 표시 (F-7.1 에서 채움)
 * - 캠페인 / 광고그룹 / 키워드 진입 링크 (소재 / 확장소재는 후속 단계)
 *
 * SPEC 6.7 F-7.1 / 11.2 대시보드.
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

      <Card>
        <CardHeader className="border-b">
          <CardTitle>대시보드</CardTitle>
          <CardDescription>
            준비 중 — F-7.1 에서 본격 구현됩니다 (오늘·어제·7일·30일 KPI 카드 +
            트렌드 차트 + 최근 알림 피드 + TOP 캠페인/키워드).
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 py-4 md:grid-cols-4">
          <KpiPlaceholder label="노출" />
          <KpiPlaceholder label="클릭" />
          <KpiPlaceholder label="비용" />
          <KpiPlaceholder label="CTR" />
        </CardContent>
      </Card>

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
          <Button variant="outline" disabled>
            소재 (준비 중)
          </Button>
          <Button variant="outline" disabled>
            확장소재 (준비 중)
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

function KpiPlaceholder({ label }: { label: string }) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-lg text-muted-foreground">—</div>
    </div>
  )
}
