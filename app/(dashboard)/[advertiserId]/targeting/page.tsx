/**
 * F-11.4 — 시간대·디바이스·지역 타게팅 페이지 (RSC 진입점)
 *
 * 책임:
 *   - getCurrentAdvertiser(advertiserId) 권한 검증 (admin / 화이트리스트)
 *   - getTargetingRule(advertiserId) lazy upsert + 초기 데이터
 *   - 헤더(광고주 이름 + 안내) + 클라이언트 컴포넌트 마운트
 *
 * viewer 가능 (read-only — input disabled / 저장 버튼 미표시).
 *
 * URL 패턴: `/[advertiserId]/targeting`
 *
 * SPEC: SPEC v0.2.1 F-11.4
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
import { TargetingClient } from "@/components/bidding/targeting-client"
import { getTargetingRule } from "@/app/(dashboard)/[advertiserId]/targeting/actions"
import { PageHeader } from "@/components/navigation/page-header"

export default async function TargetingPage({
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

  // lazy upsert — 광고주 첫 진입 시 default 룰 생성. 실패 시 page 자체 fallback X (폼 비활성화).
  const ruleRes = await getTargetingRule(advertiser.id)
  if (!ruleRes.ok) {
    return (
      <div className="flex flex-col gap-6 p-4 md:p-6">
        <PageHeader
          title="시간대·지역 타게팅"
          breadcrumbs={[
            { label: advertiser.name, href: `/${advertiserId}` },
            { label: "타게팅" },
          ]}
        />
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="text-amber-700 dark:text-amber-400">
              룰 조회 실패
            </CardTitle>
            <CardDescription>{ruleRes.error}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title="시간대·지역 타게팅"
        helpText={
          <>
            <p className="font-medium text-foreground">사용 방법</p>
            <p className="mt-1.5 leading-relaxed">
              7×24 시간 가중치, 디바이스 가중치, 지역 가중치를 룰로 등록하면
              자동 입찰가 계산에 반영됩니다. 본 페이지의 변경은 자동 비딩이 켜진
              키워드에만 영향을 미칩니다.
            </p>
            <p className="mt-2 font-medium text-foreground">적용 흐름</p>
            <p className="mt-1.5 leading-relaxed">
              매시간 자동 입찰가 계산 시 <strong>기본 입찰가 × 시간대 가중치
              × 디바이스 가중치</strong> 로 곱해 적용됩니다. 룰을 비활성화하면
              가중치 1.0 (효과 없음), 빈 셀은 기본 가중치가 적용됩니다.
            </p>
          </>
        }
        breadcrumbs={[
          { label: advertiser.name, href: `/${advertiserId}` },
          { label: "타게팅" },
        ]}
      />

      {/* 항상 알아야 할 상태 1개만 카드로 — 분석 설명은 도움말로 합침. */}
      <Card size="sm">
        <CardHeader className="border-b">
          <CardTitle className="text-amber-700 dark:text-amber-400">
            지역 가중치는 아직 자동 적용되지 않습니다
          </CardTitle>
          <CardDescription>
            네이버 SA API 응답에 키워드별 노출 지역 정보가 분리되어 오지 않아
            매칭이 어렵습니다. 모델과 입력 UI 는 보존하며, SA 응답이 확장되는
            시점에 자동 적용으로 전환됩니다.
          </CardDescription>
        </CardHeader>
      </Card>

      <TargetingClient initialData={ruleRes.data} userRole={userRole} />
    </div>
  )
}
