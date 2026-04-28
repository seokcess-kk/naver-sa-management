/**
 * 광고주 CSV 일괄 등록 페이지 (F-1.2)
 *
 * - admin 전용 (admin layout 권한 차단)
 * - 메타만 받는 흐름. 시크릿(apiKey/secretKey) 컬럼은 정의 X.
 *   시크릿은 등록 후 광고주 상세에서 별도 입력.
 *
 * 흐름: 업로드 → 파싱(Zod) → 미리보기 모달 → 확정 → 결과
 *
 * 본 page.tsx 는 RSC 쉘. 인터랙션은 `<AdvertiserCsvImport />` 클라이언트 컴포넌트에서.
 */

import Link from "next/link"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { AdvertiserCsvImport } from "@/components/admin/advertiser-csv-import"

export default function AdvertiserImportPage() {
  return (
    <div className="flex flex-col gap-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-xl font-medium leading-snug">
            CSV 일괄 등록
          </h1>
          <p className="text-sm text-muted-foreground">
            광고주 메타정보(이름·customerId 등)를 CSV로 일괄 등록합니다. 시크릿은
            등록 후 상세 화면에서 입력하세요.
          </p>
        </div>
        <Button variant="outline" render={<Link href="/admin/advertisers" />}>
          광고주 목록
        </Button>
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>CSV 규격</CardTitle>
          <CardDescription>
            UTF-8 인코딩, 1행 헤더 필수, 컬럼 순서 무관. 시크릿 컬럼은 절대 포함하지
            마세요.
          </CardDescription>
        </CardHeader>
        <CardContent className="py-4 text-sm">
          <ul className="flex flex-col gap-1.5">
            <li>
              <code className="font-mono text-xs">name</code> (필수) — 표시명
              (1~100자)
            </li>
            <li>
              <code className="font-mono text-xs">customerId</code> (필수) —
              네이버 SA 광고주 customerId (숫자 4~20자)
            </li>
            <li>
              <code className="font-mono text-xs">bizNo</code> — 사업자번호
              (선택, ~20자)
            </li>
            <li>
              <code className="font-mono text-xs">category</code> — 카테고리
              (선택, ~50자)
            </li>
            <li>
              <code className="font-mono text-xs">manager</code> — 담당자 (선택,
              ~50자)
            </li>
            <li>
              <code className="font-mono text-xs">tags</code> — 쉼표(,) 또는
              세미콜론(;) 구분. 예: <code>신규,VIP</code>
            </li>
          </ul>
          <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
            보안: <code className="font-mono">apiKey</code> /{" "}
            <code className="font-mono">secretKey</code> 등 시크릿 컬럼이 포함된
            파일은 거부됩니다. 시크릿은 등록 후 광고주 상세에서 입력하세요.
          </p>
        </CardContent>
      </Card>

      <AdvertiserCsvImport />
    </div>
  )
}
