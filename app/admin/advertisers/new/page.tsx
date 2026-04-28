/**
 * 광고주 신규 등록 페이지
 *
 * - admin 전용 (admin layout 권한 차단)
 * - AdvertiserForm 의 mode='create' 사용
 */

import Link from "next/link"

import { Button } from "@/components/ui/button"
import { AdvertiserForm } from "@/components/admin/advertiser-form"

export default function NewAdvertiserPage() {
  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-xl font-medium leading-snug">
            새 광고주
          </h1>
          <p className="text-sm text-muted-foreground">
            네이버 SA 광고주 등록 (모델 2: 광고주별 API 키)
          </p>
        </div>
        <Button
          variant="outline"
          render={<Link href="/admin/advertisers" />}
        >
          목록
        </Button>
      </div>

      <AdvertiserForm mode="create" />
    </div>
  )
}
