/**
 * Supabase 서버 사이드 클라이언트 (Server Action / RSC / Route Handler 용)
 *
 * - @supabase/ssr 의 createServerClient + Next.js 16 cookies() 기반
 * - Auth 세션을 쿠키에서 자동 복원·갱신
 * - 권한 모델: 인증만 담당 (앱 권한은 prisma UserProfile/UserAdvertiserAccess)
 *
 * 사용처:
 *   import { getServerSupabase } from "@/lib/supabase/server"
 *   const supabase = await getServerSupabase()
 *   const { data: { user } } = await supabase.auth.getUser()
 *
 * 주의:
 *   - 클라이언트 컴포넌트에서 import 금지 (cookies() 사용 → 서버 전용)
 *   - service_role 키는 절대 import 금지 (admin.ts 별도)
 */

import { createServerClient, type CookieOptions } from "@supabase/ssr"
import { cookies } from "next/headers"

export async function getServerSupabase() {
  const cookieStore = await cookies()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !anonKey) {
    throw new Error(
      "Supabase env not configured (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY)",
    )
  }

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options)
          }
        } catch {
          // RSC(Server Component) 안에서 호출되었을 때 cookieStore.set 이 throw 되는 케이스를 무시.
          // Server Action / Route Handler 에서는 정상 동작하며, 미들웨어로 세션이 갱신됨.
        }
      },
    },
  })
}
