/**
 * 임시 진단 엔드포인트 — 텔레그램 dispatch 즉시 발사 + 결과 반환.
 *
 * 사용:
 *   admin 로그인 상태에서 GET /api/admin/_test-telegram
 *
 * 검증 끝나면 본 라우트 삭제 + 재배포.
 *
 * 보안:
 *   - assertRole("admin") — admin 만
 *   - 응답에 시크릿 토큰/평문 포함 X (env 존재 여부 boolean 만)
 */

import { NextResponse } from "next/server"

import { assertRole, AuthorizationError, UnauthenticatedError } from "@/lib/auth/access"
import { dispatch } from "@/lib/notifier"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    await assertRole("admin")
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 })
    }
    if (e instanceof AuthorizationError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 })
    }
    throw e
  }

  const envSnapshot = {
    TELEGRAM_BOT_TOKEN_set: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    TELEGRAM_CHAT_ID_set: Boolean(process.env.TELEGRAM_CHAT_ID),
    TELEGRAM_BOT_TOKEN_length: process.env.TELEGRAM_BOT_TOKEN?.length ?? 0,
    TELEGRAM_CHAT_ID_value: process.env.TELEGRAM_CHAT_ID ?? null, // chat_id 는 시크릿 아님
  }

  const result = await dispatch({
    ruleType: "test_diagnostic",
    severity: "info",
    title: "[진단] 텔레그램 채널 테스트",
    body: `${new Date().toISOString()} — 이 메시지가 텔레그램에 도착하면 outbound 정상.`,
  })

  return NextResponse.json({
    env: envSnapshot,
    dispatch: result,
  })
}
