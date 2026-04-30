/**
 * 알림 이벤트 피드 (F-7.3 보너스)
 *
 * 광고주 컨텍스트 대시보드에 노출되는 작은 위젯.
 * - props: advertiserId, initial (RSC 단계에서 listAlertEvents({ advertiserId, limit: 5 }) 사전 호출)
 * - 행: severity 점 + 제목 + 시각 + status badge
 * - 0건이면 "최근 알림 없음" 안내
 * - "전체 보기" → /admin/alerts (admin 전용 — props.isAdmin=false 면 숨김)
 *
 * 정책:
 *   - listAlertEvents 자체는 admin 전용. RSC 단계에서 admin 인 경우에만 호출하고,
 *     viewer / operator 에게는 initial=null + isAdmin=false 로 패스 → 위젯이 alert 미사용 안내 분기로 표시.
 *
 * 본 컴포넌트는 RSC 가능 (인터랙션 없음). client 분기 불필요.
 */

import Link from "next/link"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import type { AlertEventRow } from "@/app/admin/alerts/actions"

const TYPE_LABEL: Record<string, string> = {
  budget_burn: "예산 소진",
  bizmoney_low: "비즈머니 부족",
  api_auth_error: "API 인증 실패",
  inspect_rejected: "검수 거절",
}

const STATUS_LABEL: Record<string, string> = {
  pending: "대기",
  sent: "발송",
  failed: "실패",
  muted: "음소거",
}

function formatRelative(iso: string) {
  const t = new Date(iso).getTime()
  const diff = Date.now() - t
  const m = Math.floor(diff / 60000)
  if (m < 1) return "방금"
  if (m < 60) return `${m}분 전`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}시간 전`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}일 전`
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso))
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "sent"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
      : status === "failed"
        ? "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300"
        : status === "muted"
          ? "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          : "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
  return (
    <span
      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${tone}`}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  )
}

function SeverityDot({ severity }: { severity: string | null }) {
  const color =
    severity === "critical"
      ? "bg-rose-500"
      : severity === "warn"
        ? "bg-amber-500"
        : severity === "info"
          ? "bg-sky-500"
          : "bg-zinc-400"
  return (
    <span
      className={`inline-block size-2 shrink-0 rounded-full ${color}`}
      aria-hidden
    />
  )
}

function payloadSeverity(payload: unknown): string | null {
  if (payload == null || typeof payload !== "object") return null
  const v = (payload as Record<string, unknown>).severity
  return typeof v === "string" ? v : null
}

function payloadTitle(payload: unknown, fallback: string): string {
  if (payload == null || typeof payload !== "object") return fallback
  const v = (payload as Record<string, unknown>).title
  return typeof v === "string" && v.length > 0 ? v : fallback
}

export function AlertEventsFeed({
  isAdmin,
  initial,
}: {
  /** admin 만 listAlertEvents 호출 가능. false 면 컴포넌트 자체 hidden. */
  isAdmin: boolean
  /** RSC 사전 호출 결과. 5건 슬라이스. admin 아님 / 미호출 / 0건 시 hidden. */
  initial: AlertEventRow[] | null
}) {
  const items = initial ?? []

  // 컴팩트 정책: admin 이 아니거나 0건이면 영역 자체 hidden (대시보드 노이즈 제거).
  if (!isAdmin || items.length === 0) {
    return null
  }

  return (
    <Card size="sm">
      <CardHeader className="flex-row items-start justify-between gap-3 border-b">
        <div>
          <CardTitle>최근 알림 {items.length}건</CardTitle>
          <CardDescription>
            이 광고주에 적재된 최신 알림 이벤트입니다.
          </CardDescription>
        </div>
        <Button
          size="sm"
          variant="outline"
          render={<Link href="/admin/alerts" />}
        >
          전체 보기
        </Button>
      </CardHeader>
      <CardContent className="px-4 py-3">
        <ul className="flex flex-col gap-2">
          {items.map((row) => {
            const sev = payloadSeverity(row.payload)
            const title = payloadTitle(
              row.payload,
              TYPE_LABEL[row.ruleType] ?? row.ruleType,
            )
            return (
              <li
                key={row.id}
                className="flex items-center gap-3 rounded-md border bg-background px-3 py-2"
              >
                <SeverityDot severity={sev} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{title}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {TYPE_LABEL[row.ruleType] ?? row.ruleType} ·{" "}
                    {formatRelative(row.createdAt)}
                  </div>
                </div>
                <StatusBadge status={row.status} />
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}
