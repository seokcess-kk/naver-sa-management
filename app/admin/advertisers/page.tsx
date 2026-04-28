/**
 * 광고주 목록 (RSC) — 모델 2 (평면 구조)
 *
 * - admin 전용 (admin layout 에서 권한 차단)
 * - 단건 CRUD: 5천 행 X → TanStack Table 미사용. 일반 shadcn Table.
 * - status='archived' 제외 (soft delete)
 * - 시크릿(apiKeyEnc/secretKeyEnc)은 select 에서 반드시 제외 — 화면 노출 X.
 */

import Link from "next/link"

import { prisma } from "@/lib/db/prisma"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { TestConnectionButton } from "@/components/admin/test-connection-button"

function formatDate(d: Date) {
  // YYYY-MM-DD HH:mm (KST) 표기
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d)
}

export default async function AdvertisersPage() {
  // status='archived' 는 soft delete 대상이라 목록에서 제외.
  // 'active' / 'paused' 두 상태만 노출.
  // 시크릿(apiKeyEnc/secretKeyEnc)은 select 에서 명시적으로 제외 — 화면에 가져오지 않음.
  const advertisers = await prisma.advertiser.findMany({
    where: { status: { not: "archived" } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      customerId: true,
      category: true,
      manager: true,
      status: true,
      createdAt: true,
    },
  })

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-xl font-medium leading-snug">
            광고주
          </h1>
          <p className="text-sm text-muted-foreground">
            네이버 검색광고 광고주 (customerId + API/Secret 키)
          </p>
        </div>
        <Button render={<Link href="/admin/advertisers/new" />}>
          새 광고주 등록
        </Button>
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>등록된 광고주</CardTitle>
          <CardDescription>
            총 {advertisers.length}개. 시크릿 키는 화면에 노출되지 않습니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-4">표시명</TableHead>
                <TableHead>customerId</TableHead>
                <TableHead>카테고리</TableHead>
                <TableHead>담당자</TableHead>
                <TableHead>상태</TableHead>
                <TableHead>등록일</TableHead>
                <TableHead className="px-4 text-right">액션</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {advertisers.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="px-4 py-10 text-center text-sm text-muted-foreground"
                  >
                    등록된 광고주가 없습니다. 우측 상단 “새 광고주 등록” 버튼으로
                    등록하세요.
                  </TableCell>
                </TableRow>
              )}
              {advertisers.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="px-4 font-medium">
                    <Link
                      href={`/admin/advertisers/${a.id}`}
                      className="hover:underline"
                    >
                      {a.name}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {a.customerId}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {a.category ?? "-"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {a.manager ?? "-"}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={a.status} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(a.createdAt)}
                  </TableCell>
                  <TableCell className="px-4">
                    <div className="flex items-center justify-end gap-2">
                      <TestConnectionButton id={a.id} />
                      <Button
                        variant="outline"
                        size="sm"
                        render={
                          <Link href={`/admin/advertisers/${a.id}`} />
                        }
                      >
                        상세
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "active"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
      : status === "paused"
        ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
        : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
  const label =
    status === "active"
      ? "활성"
      : status === "paused"
        ? "일시중지"
        : status === "archived"
          ? "아카이브"
          : status
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {label}
    </span>
  )
}
