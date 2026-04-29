/**
 * 확장소재 목록 페이지 (F-5.x — P1 텍스트 2종)
 *
 * - RSC. 권한 검증 → advertiserId 한정 prisma 쿼리 (AdExtension → AdGroup → Campaign join)
 *   → 클라이언트 테이블 위임
 * - raw 컬럼 select X (1MB 응답 회피 — 5천 행 페이로드 절감)
 * - payload(Json) / inspectMemo(String?) 는 select 로 가져옴 (텍스트 추출 / 검수 메모)
 * - Date 필드는 클라이언트로 넘기기 전에 string 으로 변환
 * - take: 5000 — F-5.x 가상 스크롤 5천 행 안전 상한
 *
 * URL 패턴: `/[advertiserId]/extensions` (광고주별 컨텍스트 — SPEC 11.2)
 *
 * 권한 (F-1.6 / lib/auth/access.ts):
 *   - getCurrentAdvertiser 가 광고주 존재 + 사용자 화이트리스트 검사
 *   - admin 은 전체 접근, operator/viewer 는 UserAdvertiserAccess 한정
 *
 * 광고주 횡단 차단:
 *   - AdExtension 자체는 advertiserId 직접 외래키 없음 → adgroup.campaign join 으로 한정
 *   - `where: { ownerType: "adgroup", adgroup: { campaign: { advertiserId } } }`
 *
 * type 화이트리스트 (P1):
 *   - F-5.3 후속: headline / description / image 노출.
 *   - `where.type: { in: ["headline", "description", "image"] }`
 *
 * SPEC 6.2 F-5.x / 11.2 / 안전장치 1·5.
 */

import { redirect, notFound } from "next/navigation"

import {
  getCurrentAdvertiser,
  AdvertiserNotFoundError,
  AuthorizationError,
  UnauthenticatedError,
} from "@/lib/auth/access"
import { prisma } from "@/lib/db/prisma"
import { ExtensionsTable } from "@/components/dashboard/extensions-table"
import type {
  ExtensionRow,
  ExtensionAdgroupOption,
} from "@/components/dashboard/extensions-table"

export default async function ExtensionsPage({
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

  // raw 컬럼 select 안 함. ownerType=adgroup 한정 + adgroup.campaign.advertiserId join.
  // type 화이트리스트는 P1 3종 (headline / description / image — F-5.3 추가).
  const rows = await prisma.adExtension.findMany({
    where: {
      ownerType: "adgroup",
      adgroup: { campaign: { advertiserId } },
      type: { in: ["headline", "description", "image"] },
    },
    select: {
      id: true,
      nccExtId: true,
      ownerId: true,
      type: true,
      payload: true,
      inspectStatus: true,
      inspectMemo: true,
      status: true,
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
    take: 5000, // F-5.x 가상 스크롤 5천 행 안전 상한
  })

  // F-5.4 추가 모달 — 광고그룹 옵션 (status='deleted' 제외, 광고주 한정).
  // 광고주 횡단 차단: where: { campaign: { advertiserId } }
  const adgroupRows = await prisma.adGroup.findMany({
    where: {
      campaign: { advertiserId },
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

  const adgroups: ExtensionAdgroupOption[] = adgroupRows.map((a) => ({
    id: a.id,
    nccAdgroupId: a.nccAdgroupId,
    name: a.name,
    campaign: { id: a.campaign.id, name: a.campaign.name },
  }))

  // RSC → 클라이언트 직렬화. Date → ISO 문자열. ExtensionRow shape 매핑.
  // adgroup 은 항상 동반 (where 에서 ownerType=adgroup + adgroup join 필수 통과).
  // 그럼에도 prisma 가 relation 을 nullable 로 추론하면 fallback 처리.
  const extensions: ExtensionRow[] = rows
    .filter((e) => e.adgroup !== null)
    .map((e) => ({
      id: e.id,
      nccExtId: e.nccExtId,
      ownerId: e.ownerId,
      type: e.type,
      payload: e.payload,
      inspectStatus: e.inspectStatus,
      inspectMemo: e.inspectMemo,
      status: e.status,
      updatedAt: e.updatedAt.toISOString(),
      adgroup: {
        id: e.adgroup!.id,
        name: e.adgroup!.name,
        nccAdgroupId: e.adgroup!.nccAdgroupId,
        campaign: {
          id: e.adgroup!.campaign.id,
          name: e.adgroup!.campaign.name,
        },
      },
    }))

  return (
    <ExtensionsTable
      advertiserId={advertiserId}
      hasKeys={advertiser.hasKeys}
      extensions={extensions}
      adgroups={adgroups}
      userRole={userRole}
    />
  )
}
