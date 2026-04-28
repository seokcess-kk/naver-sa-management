/**
 * 루트 라우트 (/) — 자동 라우팅 + 안내 (F-1.4)
 *
 * 흐름:
 *   1. 미인증              → /login
 *   2. 인증 + 광고주 0개 + admin   → /admin/advertisers (등록 유도)
 *   3. 인증 + 광고주 0개 + 일반    → 안내 카드 + 로그아웃 (이 페이지에서 직접 렌더)
 *   4. 인증 + 광고주 1개 이상     → /[firstId] (status='active' 우선)
 *
 * 안티패턴 회피:
 *   - cookie/session 컨텍스트 X (URL 기반 의무)
 *   - 비-admin + 0광고주 케이스를 /login 으로 보내면 무한 루프 위험 → 본 페이지에서 정적 카드 처리
 */

import { redirect } from "next/navigation"

import {
  getCurrentUser,
  listAccessibleAdvertisers,
  AuthorizationError,
  UnauthenticatedError,
} from "@/lib/auth/access"
import { logout } from "@/app/(auth)/login/actions"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export default async function Home() {
  // 인증 체크
  let me
  try {
    me = await getCurrentUser()
  } catch (e) {
    if (e instanceof UnauthenticatedError || e instanceof AuthorizationError) {
      redirect("/login")
    }
    throw e
  }

  // 접근 가능한 광고주 조회
  const advertisers = await listAccessibleAdvertisers()

  if (advertisers.length === 0) {
    if (me.role === "admin") {
      redirect("/admin/advertisers")
    }
    // 일반 사용자 + 0광고주 — 정적 안내
    return (
      <div className="flex flex-1 items-center justify-center bg-zinc-50 p-8 dark:bg-black">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>접근 가능한 광고주 없음</CardTitle>
            <CardDescription>
              계정에 연결된 광고주가 없습니다. 관리자에게 광고주 접근 권한 부여를
              요청하세요. 권한 부여 후 다시 로그인하면 자동으로 셀렉터가
              활성화됩니다.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              현재 사용자: {me.displayName} · {me.role}
            </p>
            <form action={logout}>
              <Button type="submit" variant="outline" className="w-full">
                로그아웃
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    )
  }

  // 광고주 1개 이상 — status='active' 우선, 없으면 첫 번째
  const firstActive = advertisers.find((a) => a.status === "active")
  const target = firstActive ?? advertisers[0]
  redirect(`/${target.id}`)
}
