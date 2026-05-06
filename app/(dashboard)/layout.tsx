/**
 * Dashboard 영역 공통 레이아웃 (F-1.4)
 *
 * - 권한: 인증 사용자만 진입. 미인증 → /login redirect.
 * - GNB: 좌측 프로젝트명 / 가운데 광고주 셀렉터 / 우측 admin 링크 + 로그아웃
 * - 본문: children
 *
 * SPEC 11.1 GNB / 11.2 / F-1.4. 모델 2(광고주별 키 모음).
 *
 * 광고주 셀렉터 정책:
 *   - 키 미설정 광고주도 표시 (KeyStatusBadge 로 시각 구분, 사용자 정보용)
 *   - status='paused' 도 표시 (단 시각 구분)
 *   - status='archived' 는 listAccessibleAdvertisers 에서 제외됨
 *
 * 광고주 0개 분기:
 *   - admin       : "광고주 등록" 안내 + /admin/advertisers/new 링크
 *   - operator/viewer: "접근 가능한 광고주 없음" + 로그아웃 버튼 (관리자 문의 안내)
 */

import Link from "next/link"
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
import { AdvertiserSelector } from "@/components/dashboard/advertiser-selector"

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  let me
  try {
    me = await getCurrentUser()
  } catch (e) {
    if (e instanceof UnauthenticatedError || e instanceof AuthorizationError) {
      redirect("/login")
    }
    throw e
  }

  const advertisers = await listAccessibleAdvertisers()

  // 광고주 0개 분기 — 권한별 안내 카드만 표시 (children 미렌더)
  if (advertisers.length === 0) {
    const isAdmin = me.role === "admin"
    return (
      <div className="flex flex-1 items-center justify-center bg-zinc-50 p-8 dark:bg-black">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>
              {isAdmin ? "등록된 광고주가 없습니다" : "접근 가능한 광고주 없음"}
            </CardTitle>
            <CardDescription>
              {isAdmin
                ? "광고주를 먼저 등록하세요. 등록 후 GNB 셀렉터에서 컨텍스트를 전환해 운영을 시작합니다."
                : "관리자에게 광고주 접근 권한을 요청하세요. 권한 부여 후 다시 로그인하면 셀렉터가 활성화됩니다."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {isAdmin ? (
              <Button render={<Link href="/admin/advertisers/new" />}>
                광고주 등록
              </Button>
            ) : null}
            {isAdmin ? (
              <Button
                variant="outline"
                render={<Link href="/admin/advertisers" />}
              >
                광고주 관리 (admin)
              </Button>
            ) : null}
            <form action={logout}>
              <Button
                type="submit"
                variant={isAdmin ? "ghost" : "outline"}
                className="w-full"
              >
                로그아웃
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {/* GNB — 모바일에서 좌측 프로젝트명 / 우측 사용자명·role / "광고주 관리" 버튼은 숨김 */}
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b bg-background px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          <Link
            href="/"
            className="hidden font-heading text-sm font-medium leading-none whitespace-nowrap sm:inline-block"
          >
            네이버 SA 어드민
          </Link>
          <AdvertiserSelector advertisers={advertisers} />
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {me.displayName} · {me.role}
          </span>
          {me.role === "admin" ? (
            <Button
              variant="outline"
              size="sm"
              className="hidden sm:inline-flex"
              render={<Link href="/admin/advertisers" />}
            >
              광고주 관리
            </Button>
          ) : null}
          <form action={logout}>
            <Button type="submit" variant="ghost" size="sm">
              로그아웃
            </Button>
          </form>
        </div>
      </header>

      <main className="flex flex-1 flex-col overflow-y-auto">{children}</main>
    </div>
  )
}
