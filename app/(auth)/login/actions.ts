"use server"

/**
 * 로그인 / 로그아웃 Server Action (F-AUTH.1)
 *
 * 책임 (SPEC 6.1 / F-1.6):
 *   - Supabase Auth 비밀번호 기반 로그인 (Auth 가 인증만 담당)
 *   - 권한·광고주 화이트리스트는 lib/auth/access.ts (UserProfile 자동 생성) 가 처리
 *
 * 보안 메모:
 *   - error.message 는 그대로 노출하지 않는다 (이메일 존재 여부 누설 방지)
 *   - "Invalid login credentials" 류는 단일 일반화 메시지로 매핑
 *   - 로그인 성공 후 redirect 로 명시적 페이지 전환 (세션 쿠키만 설정하고 멈추는 UX 방지)
 *
 * UI 호출 시그니처 (ui-engineer 약속):
 *   - loginWithPassword({ email, password }): Promise<void>
 *   - logout(): Promise<void>
 */

import { redirect } from "next/navigation"
import { z } from "zod"

import { getServerSupabase } from "@/lib/supabase/server"

const loginSchema = z.object({
  email: z.string().email("이메일 형식이 올바르지 않습니다"),
  password: z.string().min(6, "비밀번호는 최소 6자"),
})

export async function loginWithPassword(input: {
  email: string
  password: string
}): Promise<void> {
  const parsed = loginSchema.parse(input)
  const supabase = await getServerSupabase()
  const { error } = await supabase.auth.signInWithPassword(parsed)

  if (error) {
    // 에러 메시지 일반화. Supabase 의 "Invalid login credentials" 등을
    // 그대로 노출하면 이메일 존재 여부 등 부수 정보가 새어나갈 수 있음.
    const isInvalidCreds = error.message === "Invalid login credentials"
    throw new Error(
      isInvalidCreds
        ? "로그인 실패: 이메일 또는 비밀번호가 올바르지 않습니다"
        : "로그인 실패: 다시 시도해주세요",
    )
  }

  // 성공 시 admin 영역으로 이동.
  // viewer 권한이라면 admin layout 진입 시 / 로 다시 redirect 되도록
  // (admin) layout 측 가드가 처리.
  redirect("/admin/advertisers")
}

export async function logout(): Promise<void> {
  const supabase = await getServerSupabase()
  await supabase.auth.signOut()
  redirect("/")
}
