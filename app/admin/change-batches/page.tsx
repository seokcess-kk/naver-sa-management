/**
 * 변경 프리뷰·롤백 — ChangeBatch 목록 (RSC) — F-6.x admin UI
 *
 * - admin 전용 (admin layout 1차 차단 + listChangeBatches 내부 assertRole 2차)
 * - 초기 로드: listChangeBatches({ limit: 50 })
 * - 클라이언트(`ChangeBatchesClient`) 가 필터 폼 / cursor pagination / 행 클릭 라우팅 담당
 *
 * 가상화 미사용:
 *   - 한 페이지 50건(최대 200건). cursor "더 보기" 페이징.
 *
 * 안전장치:
 *   - admin 아님 / 미로그인 → admin layout 이 redirect("/")
 *   - 직접 호출 경로 보호를 위해 actions 내부에 assertRole 중복 가드
 */

import { redirect } from "next/navigation"

import {
  AuthorizationError,
  UnauthenticatedError,
} from "@/lib/auth/access"
import {
  listChangeBatches,
  type ChangeBatchPage,
} from "@/app/admin/change-batches/actions"
import { ChangeBatchesClient } from "@/components/admin/change-batches-client"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export default async function ChangeBatchesPage() {
  let initial: ChangeBatchPage
  try {
    initial = await listChangeBatches({ limit: 50 })
  } catch (e) {
    if (e instanceof UnauthenticatedError || e instanceof AuthorizationError) {
      redirect("/")
    }
    throw e
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-xl font-medium leading-snug">
            변경 이력
          </h1>
          <p className="text-sm text-muted-foreground">
            모든 변경 액션은 ChangeBatch + ChangeItem 으로 적재됩니다. 실패
            항목 재시도 / 변경 롤백을 본 페이지에서 수행하세요.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>ChangeBatch 조회</CardTitle>
          <CardDescription>
            필터 조건은 AND 결합됩니다. 액션 (action) 은 정확 일치
            (예{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              keyword.toggle
            </code>
            ). 한 페이지 기본 50건, 최대 200건 — 더 보기 버튼으로 cursor 페이지
            이어 받기. 행 클릭 시 상세 화면으로 이동.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <ChangeBatchesClient initial={initial} />
        </CardContent>
      </Card>
    </div>
  )
}
