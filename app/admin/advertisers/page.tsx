/**
 * 광고주 목록 (RSC) — 모델 2 (평면 구조)
 *
 * - admin 전용 (admin layout 에서 권한 차단)
 * - 단건 CRUD: 5천 행 X → TanStack Table 미사용. 일반 shadcn Table.
 * - status='archived' 제외 (soft delete)
 * - 시크릿 노출 정책:
 *   · DB의 apiKeyEnc / secretKeyEnc (Bytes) 자체는 클라이언트로 직렬화 X
 *   · 단, "키 미설정 배지" 표시·testConnection 비활성 결정에 null 여부가 필요
 *   → RSC 단계에서 select 후 즉시 boolean(hasApiKey/hasSecretKey)으로 매핑.
 *
 * RSC 사전 호출:
 *   1. prisma.advertiser.findMany (메타)
 *   2. getAdvertiserStructureStats(ids) — 광고 구조 카운트 5종 (캠페인 컬럼 표시용)
 *   3. getLastSyncAt(id) — 5종 sync 시각 (광고주별 병렬 Promise.all)
 *
 * 광고주 100개 가정. 그 이상이면 페이지네이션 후속.
 */

import Link from "next/link"

import { prisma } from "@/lib/db/prisma"
import { Button } from "@/components/ui/button"
import { PageHeader } from "@/components/navigation/page-header"
import { AdvertisersStatsSummary } from "@/components/admin/advertisers-stats-summary"
import {
  AdvertisersListClient,
  type AdvertiserListRow,
} from "@/components/admin/advertisers-list-client"
import { getAdvertiserStructureStats } from "@/lib/admin/advertiser-stats"
import { getLastSyncAt } from "@/lib/sync/last-sync-at"

export default async function AdvertisersPage() {
  // status='archived' 는 soft delete 대상이라 목록에서 제외.
  // 'active' / 'paused' 두 상태만 노출.
  //
  // 시크릿 자체(apiKeyEnc/secretKeyEnc 의 바이트값)는 클라이언트로 보내지 않음.
  // 단, 키 설정 여부(null 인지)는 UI 배지 / testConnection 비활성화 결정에 필요.
  // → DB에서 select 후 즉시 boolean 으로 매핑하고, 원본 Bytes 는 RSC 로컬 변수에서만 사용.
  const rows = await prisma.advertiser.findMany({
    where: { status: { not: "archived" } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      customerId: true,
      category: true,
      manager: true,
      status: true,
      createdAt: true,
      apiKeyEnc: true,
      secretKeyEnc: true,
    },
  })

  const ids = rows.map((r) => r.id)

  // 광고 구조 카운트(5종 한 번에) + 광고주별 lastSyncAt 병렬.
  // getLastSyncAt 은 광고주 1건당 1 select — Promise.all 로 광고주 N개를 묶어 RTT 단축.
  const [statsMap, lastSyncList] = await Promise.all([
    getAdvertiserStructureStats(ids),
    Promise.all(rows.map((r) => getLastSyncAt(r.id))),
  ])

  const tableRows: AdvertiserListRow[] = rows.map((r, idx) => {
    const stat = statsMap.get(r.id)
    return {
      id: r.id,
      name: r.name,
      customerId: r.customerId,
      category: r.category,
      manager: r.manager,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      hasApiKey: r.apiKeyEnc !== null,
      hasSecretKey: r.secretKeyEnc !== null,
      lastSyncAt: lastSyncList[idx] ?? {},
      campaignCount: stat?.campaigns ?? 0,
    }
  })

  // 통계 hero 집계
  const summary = {
    total: tableRows.length,
    active: tableRows.filter((r) => r.status === "active").length,
    paused: tableRows.filter((r) => r.status === "paused").length,
    missingKey: tableRows.filter((r) => !r.hasApiKey || !r.hasSecretKey).length,
  }

  // 카테고리 distinct (null 제외) — 셀렉트 옵션
  const categories = Array.from(
    new Set(
      tableRows
        .map((r) => r.category)
        .filter((c): c is string => typeof c === "string" && c.length > 0),
    ),
  ).sort((a, b) => a.localeCompare(b, "ko"))

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="광고주"
        description="네이버 검색광고 광고주 (customerId + API/Secret 키)"
        actions={
          <>
            <Button
              variant="outline"
              render={<Link href="/admin/advertisers/import" />}
            >
              CSV 일괄 등록
            </Button>
            <Button render={<Link href="/admin/advertisers/new" />}>
              + 새 광고주
            </Button>
          </>
        }
      />

      <AdvertisersStatsSummary
        total={summary.total}
        active={summary.active}
        paused={summary.paused}
        missingKey={summary.missingKey}
      />

      <AdvertisersListClient rows={tableRows} categories={categories} />
    </div>
  )
}
