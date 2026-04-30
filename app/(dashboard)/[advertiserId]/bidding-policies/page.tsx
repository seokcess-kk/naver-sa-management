/**
 * 비딩 정책 페이지 (F-11.1) + Kill Switch UI (F-11.6)
 *
 * - RSC. 권한 검증 → BiddingPolicy 목록 조회 (광고주 한정) → 클라이언트 테이블 위임
 * - Kill Switch 상태(biddingKillSwitch / At / By) 별도 select — getCurrentAdvertiser 의
 *   AccessibleAdvertiser 에는 없는 필드 (시크릿 노출 안전선 유지) → page 단계에서 직접 조회
 * - viewer 도 진입 가능 (read 성격). mutation UI 는 클라이언트에서 role 분기 차단.
 *
 * URL 패턴: `/[advertiserId]/bidding-policies` (광고주별 컨텍스트 — SPEC 11.2)
 *
 * 본 페이지 비대상 (별도 PR):
 *   - F-11.2 자동 조정 cron 결과 / OptimizationRun 로그 표시
 *   - F-11.5 Guardrail 추가 설정 UI
 *   - GNB 항상 표시 Kill Switch 배너 (현 PR 은 본 페이지 상단만)
 *
 * SPEC 6.11 F-11.1 / F-11.6 / 11.2.
 */

import { redirect, notFound } from "next/navigation"

import {
  getCurrentAdvertiser,
  AdvertiserNotFoundError,
  AuthorizationError,
  UnauthenticatedError,
} from "@/lib/auth/access"
import { prisma } from "@/lib/db/prisma"
import { listBiddingPolicies } from "@/app/(dashboard)/[advertiserId]/bidding-policies/actions"
import { PolicyTableClient } from "@/components/bidding/policy-table-client"
import { KillSwitchBanner } from "@/components/bidding/kill-switch-banner"
import { PageHeader } from "@/components/navigation/page-header"

export default async function BiddingPoliciesPage({
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

  // Kill Switch 메타 + 정책 목록 병렬 조회.
  //   biddingKillSwitch / At / By 는 AccessibleAdvertiser 에 없으니 Advertiser 직접 조회.
  //   listBiddingPolicies 는 진입부에서 다시 getCurrentAdvertiser 호출 — 권한 재검증
  //   (Server Action 다른 호출자에게도 안전).
  const [killSwitchMeta, policies, toggledByUser] = await Promise.all([
    prisma.advertiser.findUniqueOrThrow({
      where: { id: advertiserId },
      select: {
        biddingKillSwitch: true,
        biddingKillSwitchAt: true,
        biddingKillSwitchBy: true,
      },
    }),
    listBiddingPolicies(advertiserId),
    // 토글한 사용자 displayName 표시용. nullable.
    prisma.advertiser
      .findUnique({
        where: { id: advertiserId },
        select: { biddingKillSwitchBy: true },
      })
      .then(async (a) => {
        if (!a?.biddingKillSwitchBy) return null
        const u = await prisma.userProfile.findUnique({
          where: { id: a.biddingKillSwitchBy },
          select: { displayName: true },
        })
        return u
      }),
  ])

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="비딩 정책"
        description="키워드 단위 목표 노출 순위 정책 (F-11.1) — 자동 조정 cron(F-11.2)이 매시간 입찰가를 조정합니다."
        breadcrumbs={[
          { label: advertiser.name, href: `/${advertiserId}` },
          { label: "비딩 정책" },
        ]}
      />

      <KillSwitchBanner
        advertiserId={advertiserId}
        enabled={killSwitchMeta.biddingKillSwitch}
        toggledAt={
          killSwitchMeta.biddingKillSwitchAt
            ? killSwitchMeta.biddingKillSwitchAt.toISOString()
            : null
        }
        toggledByName={toggledByUser?.displayName ?? null}
        userRole={userRole}
      />

      <PolicyTableClient
        advertiserId={advertiserId}
        policies={policies}
        userRole={userRole}
      />
    </div>
  )
}
