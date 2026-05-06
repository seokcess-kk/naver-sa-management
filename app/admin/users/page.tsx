/**
 * 사용자 / 권한 관리 — 목록 (RSC)
 *
 * F-1.6 admin UI:
 *   - admin 전용 (admin layout 에서 1차 차단 + listUsers 내부 assertRole 2차)
 *   - listUsers() Server Action 호출 → UserRow 배열 → UsersTable 클라이언트 컴포넌트로 전달
 *   - 사용자 직접 생성 / 삭제 UI 없음 (Supabase Auth 회원가입 흐름이 책임)
 *
 * 가상화 미사용:
 *   - 사용자 수 수십 명 가정. TanStack Table v8 정렬·필터만 사용.
 *
 * 안전장치:
 *   - assertRole 실패 (admin 아님) → catch 후 redirect("/")
 *     (admin layout 도 차단하지만, 직접 actions 호출 경로 보호 일관성)
 */

import { redirect } from "next/navigation"

import {
  AuthorizationError,
  UnauthenticatedError,
} from "@/lib/auth/access"
import { listUsers, type UserRow } from "@/app/admin/users/actions"
import { UsersTable } from "@/components/admin/users-table"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { PageHeader } from "@/components/navigation/page-header"

export default async function UsersPage() {
  let users: UserRow[]
  try {
    users = await listUsers()
  } catch (e) {
    if (e instanceof UnauthenticatedError || e instanceof AuthorizationError) {
      redirect("/")
    }
    throw e
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="사용자 / 권한 관리"
        helpText={
          <p className="leading-relaxed">
            사용자 직접 생성·삭제는 지원하지 않습니다. 회원가입은 Supabase Auth
            가 담당하며, 첫 로그인 시 자동으로 뷰어 권한으로 등록됩니다. 본
            화면에서는 권한 변경 / 광고주 접근 권한 부여를 수행합니다.
          </p>
        }
      />

      <Card>
        <CardHeader className="border-b">
          <CardTitle>등록된 사용자</CardTitle>
          <CardDescription>
            총 {users.length}명. 역할(role) / 상태(status) 변경 및 광고주
            화이트리스트 관리는 “상세 보기” 에서 진행합니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <UsersTable users={users} />
        </CardContent>
      </Card>
    </div>
  )
}
