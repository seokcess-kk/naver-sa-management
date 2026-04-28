/**
 * 감사 로그 뷰어 — 목록 (RSC)
 *
 * F-1.7 admin UI:
 *   - admin 전용 (admin layout 1차 차단 + listAuditLogs 내부 assertRole 2차)
 *   - 초기 로드: listAuditLogs({ limit: 50 }) + listAuditFilterOptions
 *   - 클라이언트(`AuditLogsClient`) 가 필터 폼 / cursor pagination / 상세 모달 담당
 *
 * 가상화 미사용:
 *   - 한 페이지 50건(최대 200건) 기준. cursor "더 보기" 페이징 방식.
 *
 * 안전장치:
 *   - admin 아님 / 미로그인 → admin layout 이 redirect("/")
 *   - 직접 호출 경로 보호를 위해 actions 내부에 assertRole 중복 가드
 */

import { redirect } from "next/navigation"

import {
  AuthorizationError,
  UnauthenticatedError,
} from "@/lib/auth/access"
import {
  listAuditLogs,
  listAuditFilterOptions,
  type AuditLogPage,
  type AuditFilterOptions,
} from "@/app/admin/audit/actions"
import { AuditLogsClient } from "@/components/admin/audit-logs-client"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export default async function AuditLogsPage() {
  let initial: AuditLogPage
  let filterOptions: AuditFilterOptions
  try {
    ;[initial, filterOptions] = await Promise.all([
      listAuditLogs({ limit: 50 }),
      listAuditFilterOptions(),
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
            감사 로그
          </h1>
          <p className="text-sm text-muted-foreground">
            모든 변경 액션은 before / after 형태로 기록됩니다. 시크릿 컬럼은
            적재 시 마스킹 처리되어 안전하게 노출됩니다.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>로그 조회</CardTitle>
          <CardDescription>
            필터 조건은 AND 결합됩니다. 광고주 ID 는 before / after JSON 의{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              advertiserId
            </code>{" "}
            키 또는 (Advertiser, advertiserId) 타겟에 매칭됩니다. 한 페이지
            기본 50건, 최대 200건 — 더 보기 버튼으로 cursor 페이지 이어 받기.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <AuditLogsClient
            initial={initial}
            filterOptions={filterOptions}
          />
        </CardContent>
      </Card>
    </div>
  )
}
