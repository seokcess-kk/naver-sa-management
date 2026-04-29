"use client"

/**
 * 알림 룰 관리 — 클라이언트 (F-8.x)
 *
 * 구조:
 *   - 헤더: "새 룰 추가" 버튼
 *   - 테이블: type / 광고주 / 임계 요약 / channelHint / enabled toggle / 24h 카운트 / 액션
 *   - enabled 토글: inline 즉시 updateAlertRule 호출 (router.refresh)
 *   - 편집 / 삭제: 행 액션 버튼 → AlertRuleFormModal 또는 confirm 후 deleteAlertRule
 *
 * 광고주 표시:
 *   - params.advertiserId 를 advertisers prop 으로 받은 맵에서 매핑
 *   - 매칭 안 되는 경우 (archive 등) "(N/A)" 표시
 *
 * 안전장치:
 *   - 권한은 backend Server Action 내부 assertRole 가 보장
 *   - 삭제는 confirm() 1차 확인
 *   - enabled 토글 중에는 동일 행 다시 토글 차단 (pendingId 추적)
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { PencilIcon, Trash2Icon, PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  deleteAlertRule,
  updateAlertRule,
  type AlertRuleRow,
} from "@/app/admin/alert-rules/actions"
import { AlertRuleFormModal } from "@/components/admin/alert-rule-form-modal"

// =============================================================================
// 헬퍼
// =============================================================================

function formatDate(iso: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso))
}

const TYPE_LABEL: Record<string, string> = {
  budget_burn: "예산 소진",
  bizmoney_low: "비즈머니 부족",
  api_auth_error: "API 인증 실패",
  inspect_rejected: "검수 거절",
}

function paramsSummary(type: string, params: unknown): string {
  if (params == null || typeof params !== "object") return "-"
  const p = params as Record<string, unknown>
  if (type === "budget_burn") {
    const t = Array.isArray(p.thresholds) ? p.thresholds : null
    return t && t.length > 0 ? `${t.join(" / ")}%` : "50 / 80 / 100% (기본)"
  }
  if (type === "bizmoney_low") {
    return typeof p.days === "number" ? `${p.days}일` : "3일 (기본)"
  }
  if (type === "inspect_rejected") {
    const within = typeof p.withinMinutes === "number" ? p.withinMinutes : 60
    const max =
      typeof p.maxCandidates === "number" ? p.maxCandidates : 20
    return `${within}분 / 최대 ${max}건`
  }
  return "-"
}

function advertiserIdFromParams(params: unknown): string | null {
  if (params == null || typeof params !== "object") return null
  const v = (params as Record<string, unknown>).advertiserId
  return typeof v === "string" ? v : null
}

// =============================================================================
// 메인
// =============================================================================

export function AlertRulesClient({
  rules,
  advertisers,
}: {
  rules: AlertRuleRow[]
  advertisers: { id: string; name: string; customerId: string }[]
}) {
  const router = useRouter()
  const advertiserMap = React.useMemo(
    () => new Map(advertisers.map((a) => [a.id, a])),
    [advertisers],
  )

  const [modalOpen, setModalOpen] = React.useState(false)
  const [editingRule, setEditingRule] = React.useState<AlertRuleRow | null>(
    null,
  )

  // toggle / delete in-flight 추적 (행별)
  const [pendingId, setPendingId] = React.useState<string | null>(null)

  function openCreate() {
    setEditingRule(null)
    setModalOpen(true)
  }

  function openEdit(rule: AlertRuleRow) {
    setEditingRule(rule)
    setModalOpen(true)
  }

  async function handleToggleEnabled(rule: AlertRuleRow, next: boolean) {
    if (pendingId) return
    setPendingId(rule.id)
    try {
      const res = await updateAlertRule({ id: rule.id, enabled: next })
      if (!res.ok) {
        toast.error(`토글 실패: ${res.error}`)
        return
      }
      toast.success(next ? "활성화" : "비활성화")
      router.refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`오류: ${msg}`)
    } finally {
      setPendingId(null)
    }
  }

  async function handleDelete(rule: AlertRuleRow) {
    if (pendingId) return
    if (
      !window.confirm(
        `정말 삭제하시겠습니까?\n\n[${TYPE_LABEL[rule.type] ?? rule.type}] ${rule.id}\n관련 AlertEvent 도 함께 삭제됩니다.`,
      )
    ) {
      return
    }
    setPendingId(rule.id)
    try {
      const res = await deleteAlertRule(rule.id)
      if (!res.ok) {
        toast.error(`삭제 실패: ${res.error}`)
        return
      }
      toast.success("알림 룰을 삭제했습니다")
      router.refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`오류: ${msg}`)
    } finally {
      setPendingId(null)
    }
  }

  return (
    <div className="flex flex-col">
      {/* 헤더 */}
      <div className="flex items-center justify-end gap-2 px-4 py-3 border-b">
        <Button onClick={openCreate}>
          <PlusIcon />새 룰 추가
        </Button>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="px-4">type</TableHead>
            <TableHead>광고주</TableHead>
            <TableHead>파라미터</TableHead>
            <TableHead>channelHint</TableHead>
            <TableHead className="text-center">활성</TableHead>
            <TableHead className="text-right">최근 24h</TableHead>
            <TableHead>등록일</TableHead>
            <TableHead className="px-4 text-right">액션</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rules.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={8}
                className="px-4 py-10 text-center text-sm text-muted-foreground"
              >
                등록된 알림 룰이 없습니다. 우측 상단 “새 룰 추가” 버튼으로
                추가하세요.
              </TableCell>
            </TableRow>
          ) : (
            rules.map((r) => {
              const advId = advertiserIdFromParams(r.params)
              const adv = advId ? advertiserMap.get(advId) : null
              const rowPending = pendingId === r.id
              return (
                <TableRow key={r.id}>
                  <TableCell className="px-4">
                    <div className="flex flex-col">
                      <span className="font-medium text-sm">
                        {TYPE_LABEL[r.type] ?? r.type}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {r.type}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">
                    {adv ? (
                      <div className="flex flex-col">
                        <span>{adv.name}</span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {adv.customerId}
                        </span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground italic">
                        {advId
                          ? `(아카이브?: ${advId.slice(0, 8)}…)`
                          : "(N/A)"}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {paramsSummary(r.type, r.params)}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {r.channelHint ?? "-"}
                  </TableCell>
                  <TableCell className="text-center">
                    <Checkbox
                      checked={r.enabled}
                      disabled={rowPending}
                      onCheckedChange={(next) =>
                        handleToggleEnabled(r, next === true)
                      }
                    />
                  </TableCell>
                  <TableCell className="tabular-nums text-right text-sm">
                    {r.recentEventsCount}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(r.createdAt)}
                  </TableCell>
                  <TableCell className="px-4">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={rowPending}
                        onClick={() => openEdit(r)}
                      >
                        <PencilIcon />
                        편집
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={rowPending}
                        onClick={() => handleDelete(r)}
                      >
                        <Trash2Icon />
                        삭제
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })
          )}
        </TableBody>
      </Table>

      <AlertRuleFormModal
        mode={editingRule ? "edit" : "create"}
        rule={editingRule}
        open={modalOpen}
        onOpenChange={setModalOpen}
        advertisers={advertisers}
        onDone={() => router.refresh()}
      />
    </div>
  )
}
