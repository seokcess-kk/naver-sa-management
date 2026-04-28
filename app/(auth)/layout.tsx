/**
 * Auth 영역 공통 레이아웃 (로그인 등 미인증 사용자가 접근하는 페이지)
 *
 * - 권한 체크 X (이 영역에 도달한 시점에는 보통 미인증 상태)
 * - 단순 중앙 정렬 카드 형태의 컨테이너 제공
 *
 * SPEC 6.1 F-1.6 / 11.x.
 */

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen flex flex-1 items-center justify-center bg-slate-50 px-4">
      {children}
    </div>
  )
}
