/**
 * 광고주 상세·수정·삭제 페이지 (모델 2)
 *
 * - admin 전용
 * - 시크릿 평문 / Bytes 자체는 절대 화면 / props 로 노출 X.
 *   "키 설정 여부" 판정용 boolean(hasApiKey/hasSecretKey) 만 RSC 에서 파생.
 * - 수정 시에만 새 값 입력. 빈 값은 변경 안 함.
 * - 테스트 연결 / 삭제 버튼 포함
 */

import Link from "next/link"
import { notFound } from "next/navigation"

import { prisma } from "@/lib/db/prisma"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { AdvertiserForm } from "@/components/admin/advertiser-form"
import { TestConnectionButton } from "@/components/admin/test-connection-button"
import { DeleteAdvertiserButton } from "@/components/admin/delete-advertiser-button"
import { KeyStatusBadge } from "@/components/admin/key-status-badge"

function formatDate(d: Date) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d)
}

export default async function AdvertiserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  // 시크릿 자체(apiKeyEnc / secretKeyEnc 의 바이트 값) 는 클라이언트에 노출 X.
  // 단, 키 설정 여부(null 인지) 는 UI 배지·테스트 연결 비활성화에 필요 → 즉시 boolean 으로 변환.
  const row = await prisma.advertiser.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      customerId: true,
      bizNo: true,
      category: true,
      manager: true,
      memo: true,
      tags: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      apiKeyEnc: true,
      secretKeyEnc: true,
      // F-11.5 Guardrail (편집 폼 prefill)
      guardrailEnabled: true,
      guardrailMaxBidChangePct: true,
      guardrailMaxChangesPerKeyword: true,
      guardrailMaxChangesPerDay: true,
    },
  })

  if (!row) notFound()

  const advertiser = {
    id: row.id,
    name: row.name,
    customerId: row.customerId,
    bizNo: row.bizNo,
    category: row.category,
    manager: row.manager,
    memo: row.memo,
    tags: row.tags,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    hasApiKey: row.apiKeyEnc !== null,
    hasSecretKey: row.secretKeyEnc !== null,
    // F-11.5 Guardrail
    guardrailEnabled: row.guardrailEnabled,
    guardrailMaxBidChangePct: row.guardrailMaxBidChangePct,
    guardrailMaxChangesPerKeyword: row.guardrailMaxChangesPerKeyword,
    guardrailMaxChangesPerDay: row.guardrailMaxChangesPerDay,
  }
  const hasKeys = advertiser.hasApiKey && advertiser.hasSecretKey

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-xl font-medium leading-snug">
            {advertiser.name}
          </h1>
          <p className="text-sm text-muted-foreground">
            customerId{" "}
            <span className="font-mono">{advertiser.customerId}</span> · 상태{" "}
            {advertiser.status} · 등록 {formatDate(advertiser.createdAt)}
          </p>
          <div className="mt-2">
            <KeyStatusBadge
              hasApiKey={advertiser.hasApiKey}
              hasSecretKey={advertiser.hasSecretKey}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            render={<Link href="/admin/advertisers" />}
          >
            목록
          </Button>
          <TestConnectionButton
            id={advertiser.id}
            variant="outline"
            size="default"
            hasKeys={hasKeys}
          />
        </div>
      </div>

      {!hasKeys && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="text-amber-700 dark:text-amber-400">
              키 미설정
            </CardTitle>
            <CardDescription>
              API 키 / Secret 키를 입력하면 SA API 호출(테스트 연결, 동기화 등)이
              활성화됩니다. 아래 폼의 “API 키” / “Secret 키” 필드에 입력 후
              저장하세요.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {advertiser.memo ? (
        <Card>
          <CardHeader className="border-b">
            <CardTitle>메모</CardTitle>
            <CardDescription>
              내부 메모. 수정은 아래 폼의 “메모” 필드에서 진행.
            </CardDescription>
          </CardHeader>
          <CardContent className="py-4">
            <p className="whitespace-pre-wrap text-sm text-foreground">
              {advertiser.memo}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <AdvertiserForm
        mode="edit"
        id={advertiser.id}
        defaultValues={{
          name: advertiser.name,
          customerId: advertiser.customerId,
          bizNo: advertiser.bizNo,
          category: advertiser.category,
          manager: advertiser.manager,
          memo: advertiser.memo,
          tags: advertiser.tags,
          status: advertiser.status,
          // F-11.5 Guardrail
          guardrailEnabled: advertiser.guardrailEnabled,
          guardrailMaxBidChangePct: advertiser.guardrailMaxBidChangePct,
          guardrailMaxChangesPerKeyword: advertiser.guardrailMaxChangesPerKeyword,
          guardrailMaxChangesPerDay: advertiser.guardrailMaxChangesPerDay,
        }}
      />

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="text-destructive">위험 영역</CardTitle>
          <CardDescription>
            광고주 삭제는 soft delete (status=archived) 로 처리됩니다.
            연결된 캠페인 / 그룹 / 키워드 동기화가 중단됩니다. 이전 변경 이력 / 감사 로그는 보존됩니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="py-4">
          <DeleteAdvertiserButton
            id={advertiser.id}
            name={advertiser.name}
          />
        </CardContent>
      </Card>
    </div>
  )
}
