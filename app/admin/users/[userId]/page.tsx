/**
 * 사용자 상세 (RSC) — F-1.6 admin UI
 *
 * - admin 전용 (admin layout 1차 + getUserDetail 내부 assertRole 2차)
 * - getUserDetail(userId) → null 이면 notFound()
 * - 광고주 화이트리스트 부여 모달용으로 전체 광고주 목록(prisma.advertiser)
 *   함께 조회하여 클라이언트로 전달.
 *
 * 권한 / UX 메모:
 *   - admin role 사용자는 화이트리스트가 무관(전체 접근). 단, 데이터로는 부여 가능 →
 *     admin 이 operator 로 강등될 때 즉시 화이트리스트 적용되도록 미리 설정 가능.
 *   - "본인" 인지 식별을 위해 me.id 도 함께 전달 → 클라이언트에서 시각적 안내
 *     (단, 서버 안전장치가 최종 방어선이므로 클라이언트 차단은 하지 않음).
 */

import { notFound, redirect } from "next/navigation"

import {
  AuthorizationError,
  UnauthenticatedError,
  getCurrentUser,
} from "@/lib/auth/access"
import { prisma } from "@/lib/db/prisma"
import { getUserDetail, type UserDetail } from "@/app/admin/users/actions"
import { UserDetailView } from "@/components/admin/user-detail"
import { PageHeader } from "@/components/navigation/page-header"

export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ userId: string }>
}) {
  const { userId } = await params

  // 본인 식별 (UI 안내용. 서버 가드는 actions.ts 가 책임)
  let meId: string
  try {
    const me = await getCurrentUser()
    meId = me.id
  } catch (e) {
    if (e instanceof UnauthenticatedError || e instanceof AuthorizationError) {
      redirect("/")
    }
    throw e
  }

  let user: UserDetail | null
  try {
    user = await getUserDetail(userId)
  } catch (e) {
    if (e instanceof UnauthenticatedError || e instanceof AuthorizationError) {
      redirect("/")
    }
    throw e
  }
  if (!user) notFound()

  // 화이트리스트 부여 모달용 — 전체 광고주(아카이브 제외).
  // status='paused' 도 부여 대상 포함 (운영 일시중지 광고주도 권한 부여 가능해야 함).
  const advertisers = await prisma.advertiser.findMany({
    where: { status: { not: "archived" } },
    select: { id: true, name: true, customerId: true, status: true },
    orderBy: { name: "asc" },
  })

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <PageHeader
        backHref="/admin/users"
        backLabel="사용자 목록"
        breadcrumbs={[
          { label: "관리" },
          { label: "사용자", href: "/admin/users" },
          { label: user.displayName },
        ]}
        title={user.displayName}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{user.id}</span>
            {user.id === meId ? (
              <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                본인
              </span>
            ) : null}
          </span>
        }
      />

      <UserDetailView
        user={user}
        meId={meId}
        advertisers={advertisers.map((a) => ({
          id: a.id,
          name: a.name,
          customerId: a.customerId,
          status: a.status,
        }))}
      />
    </div>
  )
}
