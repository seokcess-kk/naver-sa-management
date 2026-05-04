/**
 * 비딩 자동화 설정 admin — 목록 (RSC)
 *
 * Phase B.4 admin UI:
 *   - admin 전용 (admin layout 1차 차단 + listBidAutomationConfigs 내부 assertRole 2차)
 *   - 광고주 전체 목록 + 각 광고주의 BidAutomationConfig 1행 join
 *   - 클라이언트 컴포넌트(`BidAutomationConfigClient`)가 행 클릭 → 편집 모달
 *
 * 가상화 미사용 — 광고주 수십 건 가정.
 *
 * 안전장치:
 *   - listBidAutomationConfigs / upsertBidAutomationConfig 모두 admin 가드
 *   - 시크릿 노출 X — 본 페이지는 자동화 모드 / 페이싱 / 목표만 다룸
 */

import { redirect } from "next/navigation"

import {
  AuthorizationError,
  UnauthenticatedError,
} from "@/lib/auth/access"
import {
  listBidAutomationConfigs,
  type BidAutomationConfigRow,
} from "@/app/admin/bidding/automation-config/actions"
import { BidAutomationConfigClient } from "@/components/admin/bid-automation-config-client"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export default async function BidAutomationConfigPage() {
  let rows: BidAutomationConfigRow[]
  try {
    rows = await listBidAutomationConfigs()
  } catch (e) {
    if (e instanceof UnauthenticatedError || e instanceof AuthorizationError) {
      redirect("/")
    }
    throw e
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-xl font-medium leading-snug">
            비딩 자동화 설정
          </h1>
          <p className="text-sm text-muted-foreground">
            광고주별 자동화 모드(Inbox / 정책 자동만 / Off) · 예산 페이싱 모드 ·
            목표 CPA/ROAS. 신규 등록 광고주는 기본 off — 운영자가 명시적으로
            inbox 또는 auto_policy_only 로 전환해야 cron 이 동작합니다.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>광고주 목록</CardTitle>
          <CardDescription>
            총 {rows.length}건. 행을 클릭하면 모드 / 페이싱 / 목표를 편집할 수
            있습니다. 미설정 광고주는 cron 처리 대상에서 제외됩니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <BidAutomationConfigClient rows={rows} />
        </CardContent>
      </Card>
    </div>
  )
}
