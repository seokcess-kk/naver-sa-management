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
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title="한계효용 분석"
        description="최근 7일 · 디바이스별 1~5위 입찰 한계효용 비교"
        helpText={
          <>
            <p className="font-medium text-foreground">읽는 방법</p>
            <p className="mt-1.5 leading-relaxed">
              순위가 1위에 가까울수록 클릭은 늘지만 클릭당 비용(CPC)도 비례해
              오릅니다. 본 화면은 <strong>CPC 기준</strong>이며 (단위: 클릭/원),
              매출 기반 ROI/ROAS 분석은 지원 예정입니다. 네이버 SA 입찰가
              예상치(1~5위)를 활용해 직전 순위 대비 추가 클릭 1건당 비용을
              계산합니다.
            </p>
            <p className="mt-2 font-medium text-foreground">참고</p>
            <ul className="mt-1.5 list-disc space-y-1 pl-4 leading-relaxed">
              <li>
                최근 7일 합계 클릭이 50회 미만인 키워드는 분석에서 제외됩니다
                (표본 부족).
              </li>
              <li>
                한계효용 = 직전 순위 대비 (Δ클릭 / Δ비용). 양수일수록 추가 클릭
                비용이 효율적입니다.
              </li>
              <li>
                권장 순위는 한계효용이 양수인 가장 높은(숫자가 낮은) 순위.
                운영자 판단이 우선합니다.
              </li>
            </ul>
          </>
        }
        breadcrumbs={[
          { label: advertiser.name, href: `/${advertiserId}` },
          { label: "한계효용 분석" },
        ]}
      />

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

    </div>
  )
}
