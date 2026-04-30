/**
 * F-11.3 — 한계효용 분석 페이지 (RSC 진입점)
 *
 * 책임:
 *   - getCurrentAdvertiser(advertiserId) 권한 검증 (admin / 화이트리스트)
 *   - 헤더(광고주 이름 + 안내) + 클라이언트 컴포넌트 마운트
 *   - hasKeys=false 안내 카드
 *
 * viewer 가능 (read-only — Server Action 모두 viewer 허용).
 * staging 미적용 — 조회 즉시 호출.
 *
 * SPEC: SPEC v0.2.1 F-11.3
 */

import { redirect, notFound } from "next/navigation"

import {
  getCurrentAdvertiser,
  AdvertiserNotFoundError,
  AuthorizationError,
  UnauthenticatedError,
} from "@/lib/auth/access"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { MarginalUtilityClient } from "@/components/bidding/marginal-utility-client"
import { PageHeader } from "@/components/navigation/page-header"

export default async function MarginalUtilityPage({
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
      <PageHeader
        title="한계효용 분석"
        description="분석 기간 last 7일 (기본) · device 별 1~5위 입찰 한계효용 비교"
        breadcrumbs={[
          { label: advertiser.name, href: `/${advertiserId}` },
          { label: "한계효용 분석" },
        ]}
      />

      {/* 안내 박스 — 본 분석은 CPC 기반 (P2 매출 조인 후 ROAS/ROI 표시) */}
      <Card size="sm">
        <CardHeader className="border-b">
          <CardTitle className="text-sky-700 dark:text-sky-400">
            분석 기준 안내
          </CardTitle>
          <CardDescription>
            본 분석은 <strong>CPC 기반</strong>입니다 (단위: 클릭/원). ROI/ROAS는
            P2 매출 조인 후 표시됩니다. Estimate API 의 1~5위 예상치를 활용해
            순위별 한계효용(직전 순위 대비 추가 클릭 1당 비용)을 계산합니다.
          </CardDescription>
        </CardHeader>
      </Card>

      {!advertiser.hasKeys ? (
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="text-amber-700 dark:text-amber-400">
              API 키 미설정
            </CardTitle>
            <CardDescription>
              본 광고주의 API 키 / Secret 키가 입력되지 않아 Estimate API 호출이
              차단됩니다. admin 권한자가 광고주 상세 화면에서 키를 입력하면
              활성화됩니다.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <MarginalUtilityClient advertiserId={advertiser.id} />
      )}

      <Card size="sm">
        <CardHeader className="border-b">
          <CardTitle>참고</CardTitle>
        </CardHeader>
        <CardContent className="py-3 text-xs text-muted-foreground">
          <ul className="list-disc space-y-1 pl-4">
            <li>
              최근 7일 합계 클릭이 50회 미만인 키워드는 분석 대상에서 제외됩니다
              (표본 부족).
            </li>
            <li>
              한계효용 = 직전 순위 대비 (Δ클릭 / Δ비용). 양수일수록 추가 클릭
              비용이 효율적임을 의미합니다.
            </li>
            <li>
              권장 순위는 한계효용이 양수인 가장 높은(낮은 숫자) 순위입니다.
              운영자 판단이 우선합니다.
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
