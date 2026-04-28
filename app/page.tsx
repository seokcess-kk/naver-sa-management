import Link from "next/link"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export default function Home() {
  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 p-8 dark:bg-black">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>네이버 SA 운영 어드민</CardTitle>
          <CardDescription>
            네이버 검색광고 다계정 운영 어드민. P1 운영 효율 — MCC 통합 / 일괄 변경 / CSV
            / 변경 프리뷰·롤백.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Button render={<Link href="/login" />}>로그인</Button>
          <Button
            variant="outline"
            render={<Link href="/admin/advertisers" />}
          >
            광고주 관리 (admin)
          </Button>
          <p className="text-xs text-muted-foreground">
            로그인 / 권한이 필요합니다. 미로그인 또는 비-admin 사용자는 이
            페이지로 돌아옵니다.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
