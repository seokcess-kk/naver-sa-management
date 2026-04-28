/**
 * 광고주 목록 (RSC) — 모델 2 (평면 구조)
 *
 * - admin 전용 (admin layout 에서 권한 차단)
 * - 단건 CRUD: 5천 행 X → TanStack Table 미사용. 일반 shadcn Table.
 * - status='archived' 제외 (soft delete)
 * - 시크릿 노출 정책:
 *   · DB의 apiKeyEnc / secretKeyEnc (Bytes) 자체는 클라이언트로 직렬화 X
 *   · 단, "키 미설정 배지" 표시·testConnection 비활성 결정에 null 여부가 필요
 *   → RSC 단계에서 select 후 즉시 boolean(hasApiKey/hasSecretKey)으로 매핑.
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
import { KeyStatusBadge } from "@/components/admin/key-status-badge"

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
  //
  // 시크릿 자체(apiKeyEnc/secretKeyEnc 의 바이트값)는 클라이언트로 보내지 않음.
  // 단, 키 설정 여부(null 인지)는 UI 배지 / testConnection 비활성화 결정에 필요.
  // → DB에서 select 후 즉시 boolean 으로 매핑하고, 원본 Bytes 는 RSC 로컬 변수에서만 사용.
  const rows = await prisma.advertiser.findMany({
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
      apiKeyEnc: true,
      secretKeyEnc: true,
    },
  })

  // RSC 단계에서 Bytes → boolean 변환. JSX 로 시크릿이 직렬화되어 내려가지 않도록 방어.
  const advertisers = rows.map((r) => ({
    id: r.id,
    name: r.name,
    customerId: r.customerId,
    category: r.category,
    manager: r.manager,
    status: r.status,
    createdAt: r.createdAt,
    hasApiKey: r.apiKeyEnc !== null,
    hasSecretKey: r.secretKeyEnc !== null,
  }))

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
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            render={<Link href="/admin/advertisers/import" />}
          >
            CSV 일괄 등록
          </Button>
          <Button render={<Link href="/admin/advertisers/new" />}>
            새 광고주 등록
          </Button>
        </div>
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
                <TableHead>키 상태</TableHead>
                <TableHead>등록일</TableHead>
                <TableHead className="px-4 text-right">액션</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {advertisers.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={8}
                    className="px-4 py-10 text-center text-sm text-muted-foreground"
                  >
                    등록된 광고주가 없습니다. 우측 상단 “새 광고주 등록” 또는
                    “CSV 일괄 등록” 버튼으로 등록하세요.
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
                  <TableCell>
                    <KeyStatusBadge
                      hasApiKey={a.hasApiKey}
                      hasSecretKey={a.hasSecretKey}
                    />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(a.createdAt)}
                  </TableCell>
                  <TableCell className="px-4">
                    <div className="flex items-center justify-end gap-2">
                      <TestConnectionButton
                        id={a.id}
                        hasKeys={a.hasApiKey && a.hasSecretKey}
                      />
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
