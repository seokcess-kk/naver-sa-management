/**
 * 광고주 상세·수정·삭제 페이지 (모델 2)
 *
 * - admin 전용
 * - 시크릿 평문 / Bytes 자체는 절대 화면 / props 로 노출 X.
 *   "키 설정 여부" 판정용 boolean(hasApiKey/hasSecretKey) 만 RSC 에서 파생.
 * - 수정 시에만 새 값 입력. 빈 값은 변경 안 함.
 * - 테스트 연결 / 삭제 버튼 포함
 *
 * 레이아웃:
 *   - HERO: PageHeader (브레드크럼 + 표시명 + cid + 액션 [테스트 연결] [광고주 진입])
 *   - lg+ 2-col 그리드:
 *     · 좌(2/3): AdvertiserForm 4개 카드
 *     · 우(1/3): AdvertiserDetailMeta — 연결/구조/동기화/위험
 *
 * RSC 사전 호출 (병렬):
 *   - prisma.advertiser.findUnique (단건 메타)
 *   - getAdvertiserStructureStat(id)
 *   - getLastSyncAt(id)
 *   - checkConnection(id)  — hasKeys=true && status='active' 일 때만. archived 면 SKIP (Auth Error 회피).
 */

import { notFound } from "next/navigation"
import Link from "next/link"
import { ExternalLinkIcon } from "lucide-react"

import { prisma } from "@/lib/db/prisma"
import { Button } from "@/components/ui/button"
import { PageHeader } from "@/components/navigation/page-header"
import { AdvertiserForm } from "@/components/admin/advertiser-form"
import { TestConnectionButton } from "@/components/admin/test-connection-button"
import { AdvertiserDetailMeta } from "@/components/admin/advertiser-detail-meta"
import { getAdvertiserStructureStat } from "@/lib/admin/advertiser-stats"
import { getLastSyncAt } from "@/lib/sync/last-sync-at"
import { checkConnection } from "@/app/(dashboard)/[advertiserId]/actions"

function StatusBadge({ status }: { status: "active" | "paused" | "archived" }) {
  const tone =
    status === "active"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
      : status === "paused"
        ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
        : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
  const label =
    status === "active"
      ? "활성"
      : status === "paused"
        ? "일시중지"
        : "아카이브"
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {label}
    </span>
  )
}

export default async function AdvertiserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  // 시크릿 자체(apiKeyEnc / secretKeyEnc 의 바이트 값) 는 클라이언트에 노출 X.
  // 단, 키 설정 여부(null 인지) 는 UI 배지·테스트 연결 비활성화에 필요 → 즉시 boolean 으로 변환.
  const row = await prisma.advertiser.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      customerId: true,
      bizNo: true,
      category: true,
      manager: true,
      memo: true,
      tags: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      apiKeyEnc: true,
      secretKeyEnc: true,
      // F-11.5 Guardrail (편집 폼 prefill)
      guardrailEnabled: true,
      guardrailMaxBidChangePct: true,
      guardrailMaxChangesPerKeyword: true,
      guardrailMaxChangesPerDay: true,
    },
  })

  if (!row) notFound()

  const advertiser = {
    id: row.id,
    name: row.name,
    customerId: row.customerId,
    bizNo: row.bizNo,
    category: row.category,
    manager: row.manager,
    memo: row.memo,
    tags: row.tags,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    hasApiKey: row.apiKeyEnc !== null,
    hasSecretKey: row.secretKeyEnc !== null,
    // F-11.5 Guardrail
    guardrailEnabled: row.guardrailEnabled,
    guardrailMaxBidChangePct: row.guardrailMaxBidChangePct,
    guardrailMaxChangesPerKeyword: row.guardrailMaxChangesPerKeyword,
    guardrailMaxChangesPerDay: row.guardrailMaxChangesPerDay,
  }
  const hasKeys = advertiser.hasApiKey && advertiser.hasSecretKey
  const canCheckConnection = hasKeys && advertiser.status === "active"

  // 메타 사이드용 사전 호출 — Promise.all 병렬.
  // - getAdvertiserStructureStat: DB only (광고주 무관)
  // - getLastSyncAt: DB only
  // - checkConnection: SA API 호출 — 키 + active 광고주만. archived/paused 는 SKIP.
  //
  // archived 광고주: getCurrentAdvertiser 가 AuthorizationError throw → catch 로 null 폴백.
  //                  paused: 광고주 객체는 가져오지만 SA 호출은 했었음. 안전상 active 만 호출.
  const [stats, lastSyncAt, connection] = await Promise.all([
    getAdvertiserStructureStat(id),
    getLastSyncAt(id),
    canCheckConnection
      ? checkConnection(id).catch(() => null)
      : Promise.resolve(null),
  ])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        backHref="/admin/advertisers"
        backLabel="광고주 목록"
        breadcrumbs={[
          { label: "관리" },
          { label: "광고주", href: "/admin/advertisers" },
          { label: advertiser.name },
        ]}
        title={advertiser.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span>
              customerId{" "}
              <span className="font-mono">{advertiser.customerId}</span>
            </span>
            <span className="text-muted-foreground">·</span>
            <StatusBadge status={advertiser.status} />
            <span className="text-muted-foreground">
              · 등록 {advertiser.createdAt.toLocaleString("ko-KR")}
            </span>
          </span>
        }
        actions={
          <>
            <TestConnectionButton
              id={advertiser.id}
              variant="outline"
              size="default"
              hasKeys={hasKeys}
            />
            <Button
              variant="outline"
              render={
                <Link
                  href={`/${advertiser.id}`}
                  aria-label={`${advertiser.name} 광고주 컨텍스트 진입`}
                />
              }
            >
              <ExternalLinkIcon className="size-3.5" />
              광고주 진입
            </Button>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <AdvertiserForm
            mode="edit"
            id={advertiser.id}
            defaultValues={{
              name: advertiser.name,
              customerId: advertiser.customerId,
              bizNo: advertiser.bizNo,
              category: advertiser.category,
              manager: advertiser.manager,
              memo: advertiser.memo,
              tags: advertiser.tags,
              status: advertiser.status,
              // F-11.5 Guardrail
              guardrailEnabled: advertiser.guardrailEnabled,
              guardrailMaxBidChangePct: advertiser.guardrailMaxBidChangePct,
              guardrailMaxChangesPerKeyword:
                advertiser.guardrailMaxChangesPerKeyword,
              guardrailMaxChangesPerDay: advertiser.guardrailMaxChangesPerDay,
            }}
          />
        </div>

        <aside className="lg:col-span-1">
          <AdvertiserDetailMeta
            advertiser={{
              id: advertiser.id,
              name: advertiser.name,
              customerId: advertiser.customerId,
              status: advertiser.status,
              hasKeys,
            }}
            initialConnection={connection}
            stats={stats}
            lastSyncAt={lastSyncAt}
          />
        </aside>
      </div>
    </div>
  )
}
