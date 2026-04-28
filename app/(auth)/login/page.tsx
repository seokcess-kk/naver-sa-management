"use client"

/**
 * 로그인 페이지 (Supabase Auth 비밀번호 기반)
 *
 * 흐름:
 *   1. 이메일·비밀번호 입력 → react-hook-form + Zod 즉시 검증
 *   2. `loginWithPassword({ email, password })` 호출
 *      - 성공: Server Action 내부에서 `redirect("/admin/advertisers")` — 이 컴포넌트는 도달 X
 *      - 실패: throw Error → toast.error 로 안내
 *
 * 안티패턴:
 *   - 비밀번호 평문 로그 / 콘솔 출력 금지
 *   - 폼 검증 누락 금지 (zodResolver 의무)
 *   - redirect 후 추가 코드 작성 금지 (Server Action 의 redirect 는 throw 와 동일)
 */

import * as React from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import { isRedirectError } from "next/dist/client/components/redirect-error"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { loginWithPassword } from "@/app/(auth)/login/actions"

const schema = z.object({
  email: z.string().email("이메일 형식이 올바르지 않습니다"),
  password: z.string().min(6, "비밀번호는 최소 6자"),
})

type Values = z.infer<typeof schema>

export default function LoginPage() {
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      email: "",
      password: "",
    },
  })

  const [submitting, setSubmitting] = React.useState(false)

  async function onSubmit(values: Values) {
    setSubmitting(true)
    try {
      await loginWithPassword({
        email: values.email,
        password: values.password,
      })
      // 성공 시 Server Action 내부에서 redirect — 이 라인은 도달 X
    } catch (e) {
      // Next.js 의 redirect() 는 내부적으로 특수 에러를 throw 한다.
      // 이를 catch 해 toast 처리하면 redirect 가 무력화되므로 그대로 re-throw.
      if (isRedirectError(e)) {
        throw e
      }
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(msg)
      setSubmitting(false)
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="border-b">
        <CardTitle>로그인</CardTitle>
        <CardDescription>
          네이버 SA 운영 어드민. 등록된 이메일로 로그인하세요.
        </CardDescription>
      </CardHeader>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <CardContent className="flex flex-col gap-4 py-4">
          <Field
            label="이메일"
            error={form.formState.errors.email?.message}
            required
          >
            <Input
              {...form.register("email")}
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              spellCheck={false}
              autoFocus
            />
          </Field>

          <Field
            label="비밀번호"
            error={form.formState.errors.password?.message}
            required
          >
            <Input
              {...form.register("password")}
              type="password"
              autoComplete="current-password"
              spellCheck={false}
            />
          </Field>
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? "로그인 중..." : "로그인"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}

function Field({
  label,
  error,
  required,
  children,
}: {
  label: string
  error?: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>
        {label}
        {required && <span className="text-destructive">*</span>}
      </Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}
