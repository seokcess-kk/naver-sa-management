/**
 * 광고주 상세·수정·삭제 페이지 (모델 2)
 *
 * - admin 전용
 * - 시크릿(apiKeyEnc/secretKeyEnc)은 절대 화면 / props 로 노출 X (DB 에서 가져오지도 않음).
 *   수정 시에만 새 값 입력. 빈 값은 변경 안 함.
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

  // 시크릿 컬럼(apiKeyEnc/secretKeyEnc/apiKeyVersion/secretKeyVersion)은
  // select 에서 명시적으로 제외 — UI 로 가져오지 않음.
  const advertiser = await prisma.advertiser.findUnique({
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
    },
  })

  if (!advertiser) notFound()

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
          />
        </div>
      </div>

      <AdvertiserForm
        mode="edit"
        id={advertiser.id}
        defaultValues={{
          name: advertiser.name,
          customerId: advertiser.customerId,
          bizNo: advertiser.bizNo,
          category: advertiser.category,
          manager: advertiser.manager,
          tags: advertiser.tags,
          status: advertiser.status,
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
