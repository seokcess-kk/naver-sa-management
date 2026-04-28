"use client"

/**
 * 광고주 등록·수정 공통 폼 (모델 2: 평면 구조)
 *
 * - mode='create': 모든 필수 필드 입력. 빈 secret 금지.
 * - mode='edit'  : customerId 비활성화. apiKey/secretKey 빈 값 → 변경 안 함.
 *                  기존 시크릿은 절대 화면 / defaultValues 에 포함하지 않음.
 *
 * 검증: react-hook-form + Zod 4.
 * 시크릿 노출 금지: <Input type="password" />, autoComplete="new-password".
 *
 * 안티패턴:
 *   - defaultValues 에 apiKey / secretKey 절대 포함 X
 *   - submit 결과를 받기 전 UI 갱신 X (router.push / refresh 는 성공 시에만)
 *   - ChangeBatch 경유 X — 광고주 등록은 단건 CRUD (Audit Log만 기록)
 */

import * as React from "react"
import { useForm, Controller } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  registerAdvertiser,
  updateAdvertiser,
} from "@/app/admin/advertisers/actions"

// =====================================================================
// Schemas
// =====================================================================

// backend Zod 와 정확히 일치시킴. UI에서도 즉시 피드백을 위해 동일 규칙 복제.
const createSchema = z.object({
  name: z
    .string()
    .min(1, "표시명을 입력하세요")
    .max(100, "표시명은 최대 100자입니다"),
  customerId: z
    .string()
    .regex(/^\d+$/u, "customerId는 숫자만 입력 가능합니다")
    .min(4, "customerId는 최소 4자입니다")
    .max(20, "customerId는 최대 20자입니다"),
  apiKey: z
    .string()
    .min(20, "API 키는 최소 20자입니다")
    .max(512, "API 키는 최대 512자입니다"),
  secretKey: z
    .string()
    .min(20, "Secret 키는 최소 20자입니다")
    .max(2048, "Secret 키는 최대 2048자입니다"),
  bizNo: z.string().max(20, "사업자번호는 최대 20자입니다").optional(),
  category: z.string().max(50, "카테고리는 최대 50자입니다").optional(),
  manager: z.string().max(50, "담당자는 최대 50자입니다").optional(),
  // 쉼표 구분 입력 → 배열 변환은 onSubmit 단계에서 처리
  tags: z.string().max(200, "태그는 최대 200자입니다").optional(),
})

const editSchema = z.object({
  name: z
    .string()
    .min(1, "표시명을 입력하세요")
    .max(100, "표시명은 최대 100자입니다"),
  // edit 모드: 빈 값이면 "변경 안 함" 의도. 입력 시에만 backend 와 동일 길이 검증.
  apiKey: z
    .string()
    .refine((v) => v === "" || (v.length >= 20 && v.length <= 512), {
      message: "API 키는 20~512자여야 합니다",
    }),
  secretKey: z
    .string()
    .refine((v) => v === "" || (v.length >= 20 && v.length <= 2048), {
      message: "Secret 키는 20~2048자여야 합니다",
    }),
  bizNo: z.string().max(20, "사업자번호는 최대 20자입니다").optional(),
  category: z.string().max(50, "카테고리는 최대 50자입니다").optional(),
  manager: z.string().max(50, "담당자는 최대 50자입니다").optional(),
  tags: z.string().max(200, "태그는 최대 200자입니다").optional(),
  status: z.enum(["active", "paused", "archived"]),
})

type CreateValues = z.infer<typeof createSchema>
type EditValues = z.infer<typeof editSchema>

// =====================================================================
// Helpers
// =====================================================================

function parseTags(input?: string): string[] | undefined {
  if (!input) return undefined
  const arr = input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return arr.length > 0 ? arr : []
}

// =====================================================================
// Props
// =====================================================================

type CreateMode = {
  mode: "create"
  // create 모드는 defaultValues 미사용
}

type EditMode = {
  mode: "edit"
  id: string
  defaultValues: {
    name: string
    customerId: string
    bizNo?: string | null
    category?: string | null
    manager?: string | null
    tags?: string[]
    status: "active" | "paused" | "archived"
  }
}

export type AdvertiserFormProps = CreateMode | EditMode

// =====================================================================
// Component
// =====================================================================

export function AdvertiserForm(props: AdvertiserFormProps) {
  if (props.mode === "create") return <CreateForm />
  return <EditForm {...props} />
}

function CreateForm() {
  const router = useRouter()
  const form = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      name: "",
      customerId: "",
      apiKey: "",
      secretKey: "",
      bizNo: "",
      category: "",
      manager: "",
      tags: "",
    },
  })

  const [submitting, setSubmitting] = React.useState(false)

  async function onSubmit(values: CreateValues) {
    setSubmitting(true)
    try {
      const tags = parseTags(values.tags)
      const result = await registerAdvertiser({
        name: values.name,
        customerId: values.customerId,
        apiKey: values.apiKey,
        secretKey: values.secretKey,
        bizNo: values.bizNo || undefined,
        category: values.category || undefined,
        manager: values.manager || undefined,
        ...(tags ? { tags } : {}),
      })
      toast.success(`광고주 등록 완료 (${result.id})`)
      router.push("/admin/advertisers")
      router.refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`등록 실패: ${msg}`)
      setSubmitting(false)
    }
  }

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>새 광고주 등록</CardTitle>
        <CardDescription>
          네이버 검색광고 광고주의 customerId, API 키, Secret 키를 입력하세요.
          시크릿은 AES-256-GCM 으로 암호화되어 저장됩니다.
        </CardDescription>
      </CardHeader>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <CardContent className="flex flex-col gap-4 py-4">
          <Field
            label="표시명"
            error={form.formState.errors.name?.message}
            required
          >
            <Input
              {...form.register("name")}
              placeholder="예: 본사 검색광고"
              autoComplete="off"
            />
          </Field>

          <Field
            label="customerId"
            error={form.formState.errors.customerId?.message}
            required
            hint="네이버 검색광고 광고주 customerId (숫자)"
          >
            <Input
              {...form.register("customerId")}
              placeholder="1234567"
              autoComplete="off"
              inputMode="numeric"
            />
          </Field>

          <Field
            label="API 키"
            error={form.formState.errors.apiKey?.message}
            required
          >
            <Input
              {...form.register("apiKey")}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
            />
          </Field>

          <Field
            label="Secret 키"
            error={form.formState.errors.secretKey?.message}
            required
            hint="저장 후에는 화면에 다시 표시되지 않습니다."
          >
            <Input
              {...form.register("secretKey")}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
            />
          </Field>

          <Field
            label="사업자번호"
            error={form.formState.errors.bizNo?.message}
            hint="선택"
          >
            <Input
              {...form.register("bizNo")}
              placeholder="예: 123-45-67890"
              autoComplete="off"
            />
          </Field>

          <Field
            label="카테고리"
            error={form.formState.errors.category?.message}
            hint="선택 (예: 패션, 뷰티, 가전)"
          >
            <Input {...form.register("category")} autoComplete="off" />
          </Field>

          <Field
            label="담당자"
            error={form.formState.errors.manager?.message}
            hint="선택"
          >
            <Input {...form.register("manager")} autoComplete="off" />
          </Field>

          <Field
            label="태그"
            error={form.formState.errors.tags?.message}
            hint="쉼표(,) 로 구분. 예: 신규,VIP,2026"
          >
            <Input {...form.register("tags")} autoComplete="off" />
          </Field>
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push("/admin/advertisers")}
            disabled={submitting}
          >
            취소
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? "등록 중..." : "등록"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}

function EditForm({ id, defaultValues }: EditMode) {
  const router = useRouter()
  const form = useForm<EditValues>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      name: defaultValues.name,
      // 시크릿은 절대 미리 채우지 않음 (DB 값을 UI 로 가져오지 않음)
      apiKey: "",
      secretKey: "",
      bizNo: defaultValues.bizNo ?? "",
      category: defaultValues.category ?? "",
      manager: defaultValues.manager ?? "",
      tags: (defaultValues.tags ?? []).join(", "),
      status: defaultValues.status,
    },
  })

  const [submitting, setSubmitting] = React.useState(false)

  async function onSubmit(values: EditValues) {
    setSubmitting(true)
    try {
      const tags = parseTags(values.tags)
      const payload: Parameters<typeof updateAdvertiser>[1] = {
        name: values.name,
        bizNo: values.bizNo || undefined,
        category: values.category || undefined,
        manager: values.manager || undefined,
        status: values.status,
      }
      // 빈 시크릿은 backend 시그니처상 "변경 안 함" — 굳이 보내지 않음
      if (values.apiKey) payload.apiKey = values.apiKey
      if (values.secretKey) payload.secretKey = values.secretKey
      if (tags) payload.tags = tags

      await updateAdvertiser(id, payload)
      toast.success("광고주 수정 완료")
      // 시크릿 입력 필드 초기화 (두 번째 저장에서 재입력 강제)
      form.reset({
        name: values.name,
        apiKey: "",
        secretKey: "",
        bizNo: values.bizNo ?? "",
        category: values.category ?? "",
        manager: values.manager ?? "",
        tags: values.tags ?? "",
        status: values.status,
      })
      router.refresh()
      setSubmitting(false)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`수정 실패: ${msg}`)
      setSubmitting(false)
    }
  }

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>광고주 수정</CardTitle>
        <CardDescription>
          customerId 는 변경할 수 없습니다. 시크릿은 빈 값이면 변경되지 않습니다.
        </CardDescription>
      </CardHeader>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <CardContent className="flex flex-col gap-4 py-4">
          <Field
            label="표시명"
            error={form.formState.errors.name?.message}
            required
          >
            <Input {...form.register("name")} autoComplete="off" />
          </Field>

          <Field label="customerId" hint="변경 불가">
            <Input value={defaultValues.customerId} disabled readOnly />
          </Field>

          <Field
            label="API 키 (변경 시에만 입력)"
            error={form.formState.errors.apiKey?.message}
            hint="비워두면 기존 키 유지"
          >
            <Input
              {...form.register("apiKey")}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              placeholder="(변경 안 함)"
            />
          </Field>

          <Field
            label="Secret 키 (변경 시에만 입력)"
            error={form.formState.errors.secretKey?.message}
            hint="비워두면 기존 키 유지"
          >
            <Input
              {...form.register("secretKey")}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              placeholder="(변경 안 함)"
            />
          </Field>

          <Field
            label="사업자번호"
            error={form.formState.errors.bizNo?.message}
          >
            <Input {...form.register("bizNo")} autoComplete="off" />
          </Field>

          <Field
            label="카테고리"
            error={form.formState.errors.category?.message}
          >
            <Input {...form.register("category")} autoComplete="off" />
          </Field>

          <Field
            label="담당자"
            error={form.formState.errors.manager?.message}
          >
            <Input {...form.register("manager")} autoComplete="off" />
          </Field>

          <Field
            label="태그"
            error={form.formState.errors.tags?.message}
            hint="쉼표(,) 로 구분"
          >
            <Input {...form.register("tags")} autoComplete="off" />
          </Field>

          <Field
            label="상태"
            error={form.formState.errors.status?.message}
            required
          >
            <Controller
              control={form.control}
              name="status"
              render={({ field }) => (
                <Select
                  value={field.value}
                  onValueChange={(v) =>
                    field.onChange(v as "active" | "paused" | "archived")
                  }
                >
                  <SelectTrigger className="w-48">
                    <SelectValue placeholder="상태 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">활성</SelectItem>
                    <SelectItem value="paused">일시중지</SelectItem>
                    <SelectItem value="archived">아카이브</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push("/admin/advertisers")}
            disabled={submitting}
          >
            목록으로
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? "저장 중..." : "저장"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}

// =====================================================================
// Field 헬퍼
// =====================================================================

function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string
  hint?: string
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
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}
