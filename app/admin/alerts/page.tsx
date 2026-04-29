/**
 * 알림 이벤트 — 목록 (RSC)
 *
 * F-8.x admin UI:
 *   - admin 전용 (admin layout 1차 차단 + listAlertEvents 내부 assertRole 2차)
 *   - 초기 로드: listAlertEvents({ limit: 100 })
 *   - 클라이언트(`AlertsClient`) 가 필터 / cursor pagination / 상세 모달 담당
 *
 * 룰 / 광고주 셀렉트 옵션:
 *   - 활성 룰 목록 + 광고주 목록을 동시 prefetch (필터 select 채움)
 *
 * 안전장치:
 *   - assertRole 실패 → redirect("/")
 *   - 시크릿 평문은 평가기·dispatch 단계에서 사전 배제 가정 (본 페이지는 raw 표시)
 */

import { redirect } from "next/navigation"

import {
  AuthorizationError,
  UnauthenticatedError,
} from "@/lib/auth/access"
import { prisma } from "@/lib/db/prisma"
import {
  listAlertEvents,
  type AlertEventPage,
} from "@/app/admin/alerts/actions"
import { AlertsClient } from "@/components/admin/alerts-client"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

const INITIAL_LIMIT = 100

export default async function AlertsPage() {
  let initial: AlertEventPage
  let rules: { id: string; type: string }[]
  let advertisers: { id: string; name: string; customerId: string }[]
  try {
    ;[initial, rules, advertisers] = await Promise.all([
      listAlertEvents({ limit: INITIAL_LIMIT }),
      prisma.alertRule.findMany({
        orderBy: { createdAt: "desc" },
        select: { id: true, type: true },
      }),
      prisma.advertiser.findMany({
        where: { status: { not: "archived" } },
        orderBy: { name: "asc" },
        select: { id: true, name: true, customerId: true },
      }),
    ])
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
            알림 이벤트
          </h1>
          <p className="text-sm text-muted-foreground">
            평가기가 적재한 알림 후보입니다. status 는 pending(적재만)
            / sent(채널 발송 완료) / failed / muted(1시간 음소거 적용) 4종.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>이벤트 조회</CardTitle>
          <CardDescription>
            룰 / 상태 / 광고주 / 날짜 범위로 필터합니다. 한 페이지 기본{" "}
            {INITIAL_LIMIT}건, “더 보기” 로 cursor 페이지를 이어 받습니다. 행
            클릭 시 payload JSON 전체가 표시됩니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <AlertsClient
            initial={initial}
            initialLimit={INITIAL_LIMIT}
            rules={rules}
            advertisers={advertisers}
          />
        </CardContent>
      </Card>
    </div>
  )
}
