/**
 * ChangeBatch 상세 (RSC) — F-6.x admin UI
 *
 * - admin 전용 (admin layout 1차 + getChangeBatchDetail 내부 assertRole 2차)
 * - getChangeBatchDetail(batchId) → null 이면 notFound()
 *
 * 클라이언트(`ChangeBatchDetail`) 가 다음 책임:
 *   - 헤더 카드 (기본 정보 + summary JSON 접이식)
 *   - 액션 영역 (실패 항목 재시도 / 롤백 모달)
 *   - items 테이블 (필터 + before/after JSON 모달)
 */

import { notFound, redirect } from "next/navigation"

import {
  AuthorizationError,
  UnauthenticatedError,
} from "@/lib/auth/access"
import {
  getChangeBatchDetail,
  type ChangeBatchDetail as TChangeBatchDetail,
} from "@/app/admin/change-batches/actions"
import { ChangeBatchDetail } from "@/components/admin/change-batch-detail"
import { PageHeader } from "@/components/navigation/page-header"

export default async function ChangeBatchDetailPage({
  params,
}: {
  params: Promise<{ batchId: string }>
}) {
  const { batchId } = await params

  let batch: TChangeBatchDetail | null
  try {
    batch = await getChangeBatchDetail(batchId)
  } catch (e) {
    if (e instanceof UnauthenticatedError || e instanceof AuthorizationError) {
      redirect("/")
    }
    throw e
  }
  if (!batch) notFound()

  return (
    <div className="flex flex-col gap-6 max-w-5xl">
      <PageHeader
        backHref="/admin/change-batches"
        backLabel="변경 이력"
        breadcrumbs={[
          { label: "관리" },
          { label: "변경 이력", href: "/admin/change-batches" },
          { label: "ChangeBatch 상세" },
        ]}
        title="ChangeBatch 상세"
        description={<span className="font-mono text-xs">{batch.id}</span>}
      />

      <ChangeBatchDetail batch={batch} />
    </div>
  )
}
