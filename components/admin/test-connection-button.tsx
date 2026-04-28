"use client"

/**
 * 광고주 연결 테스트 버튼 (모델 2)
 *
 * - server action `testConnection(id)` 호출
 *   - 응답: { ok: true; bizmoney: number; customerId: string } | { ok: false; error: string }
 * - 결과를 toast 로 표시 (성공: 비즈머니 / 실패: 에러 메시지)
 * - 에러 catch: 알 수 없는 예외도 toast 로 표면화
 */

import * as React from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { testConnection } from "@/app/admin/advertisers/actions"

export function TestConnectionButton({
  id,
  variant = "outline",
  size = "sm",
  hasKeys = true,
}: {
  id: string
  variant?: "default" | "outline" | "secondary" | "ghost"
  size?: "default" | "sm" | "lg"
  /** 키 미설정 광고주는 SA API 호출 자체가 의미 없음 → 클릭 시 토스트만 (disable 대신 안내) */
  hasKeys?: boolean
}) {
  const [pending, startTransition] = React.useTransition()

  function handleClick() {
    if (!hasKeys) {
      toast.error("키 미설정 — API 키 / Secret 키를 먼저 입력하세요")
      return
    }
    startTransition(async () => {
      try {
        const res = await testConnection(id)
        if (res.ok) {
          toast.success(
            `연결 OK · 비즈머니 ${res.bizmoney.toLocaleString()}원`,
          )
        } else {
          toast.error(`연결 실패: ${res.error}`)
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        toast.error(`연결 테스트 오류: ${msg}`)
      }
    })
  }

  return (
    <Button
      variant={variant}
      size={size}
      onClick={handleClick}
      disabled={pending || !hasKeys}
      title={!hasKeys ? "키 미설정 — 먼저 API 키 / Secret 키 입력" : undefined}
    >
      {pending ? "확인 중..." : "테스트 연결"}
    </Button>
  )
}
