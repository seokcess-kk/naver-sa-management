/**
 * Admin 영역 공통 레이아웃
 *
 * - LNB: 설정 영역 사이드바 (광고주 / 사용자 / 감사 로그)
 * - 권한: admin 전용. 그 외 role 또는 미로그인은 `/`로 redirect.
 *
 * SPEC 11.1 LNB · 11.2 설정 페이지 / F-1.6 권한 모델.
 * 모델 2: 마스터 계정 폐기. 광고주별 API 키 직접 발급.
 */

import Link from "next/link"
import { redirect } from "next/navigation"

import {
  getCurrentUser,
  AuthorizationError,
  UnauthenticatedError,
} from "@/lib/auth/access"
import { logout } from "@/app/(auth)/login/actions"
import { Button } from "@/components/ui/button"

const adminNav = [
  { href: "/admin/advertisers", label: "광고주" },
  { href: "/admin/users", label: "사용자" },
  { href: "/admin/change-batches", label: "변경 이력" },
  { href: "/admin/audit-logs", label: "감사 로그" },
  { href: "/admin/alert-rules", label: "알림 룰" },
  { href: "/admin/alerts", label: "알림 이벤트" },
  { href: "/admin/bidding/automation-config", label: "비딩 자동화 설정" },
]

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  let me
  try {
    me = await getCurrentUser()
  } catch (e) {
    if (e instanceof UnauthenticatedError || e instanceof AuthorizationError) {
      redirect("/")
    }
    throw e
  }

  // admin 이 아닌 경우 접근 차단
  if (me.role !== "admin") {
    redirect("/")
  }

  return (
    <div className="flex flex-1 min-h-0">
      {/* LNB */}
      <aside className="w-56 shrink-0 border-r bg-sidebar text-sidebar-foreground">
        <div className="px-4 py-4 border-b">
          <Link
            href="/"
            className="font-heading text-base font-medium leading-snug"
          >
            SA 운영 어드민
          </Link>
          <div className="mt-1 text-xs text-muted-foreground">
            설정
          </div>
        </div>
        <nav className="flex flex-col gap-0.5 p-2">
          {adminNav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md px-3 py-2 text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>

      {/* Main */}
      <div className="flex flex-1 flex-col min-w-0">
        <header className="flex h-12 shrink-0 items-center justify-between border-b px-6">
          <div className="text-sm text-muted-foreground">
            관리자 — {me.displayName}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              role: {me.role}
            </span>
            <Button variant="outline" size="sm" render={<Link href="/" />}>
              광고운영
            </Button>
            <form action={logout}>
              <Button type="submit" variant="ghost" size="sm">
                로그아웃
              </Button>
            </form>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  )
}
