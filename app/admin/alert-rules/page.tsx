/**
 * 알림 룰 관리 — 목록 (RSC)
 *
 * F-8.x admin UI:
 *   - admin 전용 (admin layout 1차 차단 + listAlertRules 내부 assertRole 2차)
 *   - listAlertRules() Server Action 호출 → AlertRuleRow 배열
 *   - 광고주 셀렉트(생성/편집 모달)용 active/paused 광고주 목록 동시 로드
 *
 * 가상화 미사용:
 *   - 룰 수 수십 건 가정 (광고주별 최대 4종 × N광고주). shadcn Table 기본.
 *
 * 안전장치:
 *   - listAlertRules / createAlertRule / updateAlertRule / deleteAlertRule 모두 admin 가드
 *   - 시크릿 노출 X — params 는 advertiserId / 임계 등 메타만
 */

import { redirect } from "next/navigation"

import {
  AuthorizationError,
  UnauthenticatedError,
} from "@/lib/auth/access"
import { prisma } from "@/lib/db/prisma"
import {
  listAlertRules,
  type AlertRuleRow,
} from "@/app/admin/alert-rules/actions"
import { AlertRulesClient } from "@/components/admin/alert-rules-client"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export default async function AlertRulesPage() {
  let rules: AlertRuleRow[]
  let advertisers: { id: string; name: string; customerId: string }[]
  try {
    ;[rules, advertisers] = await Promise.all([
      listAlertRules(),
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
            알림 룰 관리
          </h1>
          <p className="text-sm text-muted-foreground">
            P1 4종 알림: 예산 소진(budget_burn) / 비즈머니 부족(bizmoney_low) /
            API 인증 실패(api_auth_error) / 검수 거절(inspect_rejected). 룰은
            광고주별로 등록하며 1시간 음소거 정책이 적용됩니다.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>등록된 룰</CardTitle>
          <CardDescription>
            총 {rules.length}건. 활성/비활성 토글은 즉시 반영되며, 삭제 시 해당
            룰의 AlertEvent 도 함께 삭제됩니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <AlertRulesClient rules={rules} advertisers={advertisers} />
        </CardContent>
      </Card>
    </div>
  )
}
