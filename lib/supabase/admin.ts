/**
 * Supabase service_role 클라이언트 (서버 전용 / Cron / 시스템 작업)
 *
 * - SUPABASE_SERVICE_ROLE_KEY 사용 → RLS 우회
 * - 일반 Server Action / RSC 에서는 사용 금지. Cron / 시스템 작업 전용
 *
 * 절대 금지:
 *   - 클라이언트 컴포넌트 import
 *   - 응답 객체에 service_role 키 노출
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js"

let _admin: SupabaseClient | null = null

export function getAdminSupabase(): SupabaseClient {
  if (_admin) return _admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceKey) {
    throw new Error(
      "Supabase admin env not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)",
    )
  }

  _admin = createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })
  return _admin
}
