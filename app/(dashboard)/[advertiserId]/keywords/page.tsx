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
import { KeywordsTable } from "@/components/dashboard/keywords-table"
import type { KeywordRow } from "@/components/dashboard/keywords-table"

export default async function KeywordsPage({
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
      // 권한 없음 / 아카이브 → 404 (정보 노출 최소화)
      notFound()
    }
    throw e
  }

  // raw 컬럼 select 안 함. Keyword 는 advertiserId 직접 외래키 X
  //   → adgroup.campaign.advertiserId join 으로 한정.
  const rows = await prisma.keyword.findMany({
    where: { adgroup: { campaign: { advertiserId } } },
    select: {
      id: true,
      nccKeywordId: true,
      keyword: true,
      matchType: true,
      bidAmt: true,
      useGroupBidAmt: true,
      userLock: true,
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

  // Decimal / Date → JSON-friendly 직렬화. KeywordRow shape 으로 매핑.
  const keywords: KeywordRow[] = rows.map((k) => ({
    id: k.id,
    nccKeywordId: k.nccKeywordId,
    keyword: k.keyword,
    matchType: k.matchType,
    bidAmt: k.bidAmt,
    useGroupBidAmt: k.useGroupBidAmt,
    userLock: k.userLock,
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
  }))

  return (
    <KeywordsTable
      advertiserId={advertiserId}
      hasKeys={advertiser.hasKeys}
      keywords={keywords}
    />
  )
}
