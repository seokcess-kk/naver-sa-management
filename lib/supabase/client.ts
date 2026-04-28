/**
 * Supabase 브라우저 클라이언트 (클라이언트 컴포넌트 전용)
 *
 * - @supabase/ssr 의 createBrowserClient
 * - 쿠키 기반 세션 자동 복원
 *
 * 사용처:
 *   "use client"
 *   import { getBrowserSupabase } from "@/lib/supabase/client"
 *
 * 주의:
 *   - service_role / DATABASE_URL / ENCRYPTION_KEY 등 서버 전용 시크릿 절대 노출 금지
 */

import { createBrowserClient } from "@supabase/ssr"

let _client: ReturnType<typeof createBrowserClient> | null = null

export function getBrowserSupabase() {
  if (_client) return _client
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !anonKey) {
    throw new Error(
      "Supabase env not configured (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY)",
    )
  }

  _client = createBrowserClient(url, anonKey)
  return _client
}
