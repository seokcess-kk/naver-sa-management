"use client"

/**
 * 캠페인 목록 + 다중 선택 + 일괄 변경 모달 (F-2.1 / F-2.3 / 6.6 / 11.3)
 *
 * 흐름:
 *   1. RSC 가 advertiserId 한정 prisma.campaign.findMany 결과를 props 로 전달
 *   2. 사용자가 행을 다중 선택 (체크박스, 헤더 select all)
 *   3. 일괄 액션 버튼 클릭 → 4단계 모달 (SPEC 11.3)
 *      step "input"   : 선택 카운트 + 액션별 입력 (예산일 때)
 *      step "preview" : 전/후 비교 표 (계산은 클라이언트 — 실제 적용은 확정 후)
 *      step "submit"  : Server Action 진행 중
 *      step "result"  : 성공·실패 분리 + ChangeBatch ID 노출
 *   4. 결과 화면에서 "닫고 새로고침" → router.refresh()
 *
 * 안티패턴 회피:
 *   - 즉시 적용 X (사용자 확정 거침)
 *   - 미리보기 단계 생략 X
 *   - ChangeBatch ID 결과 화면에 의무 노출
 *   - TanStack Virtual 도입 X (캠페인은 수십 row, 일반 Table 충분)
 *
 * SPEC 6.2 F-2.1·F-2.3 / 6.6 / 11.3 공통 패턴 / 안전장치 1·2.
 *
 * 참고: 캠페인 단건 작업은 staging 패턴이 아닌 다중 선택 모달이 staging 역할.
 *       (키워드 인라인 편집 F-3.2 만 staging 누적 패턴 — 셀 편집 즉시 반영 X)
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { CopyIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { CampaignStatusBadge } from "@/components/dashboard/campaign-status-badge"
import { SyncCampaignsButton } from "@/components/dashboard/sync-campaigns-button"
import { bulkUpdateCampaigns } from "@/app/(dashboard)/[advertiserId]/campaigns/actions"
import type { CampaignStatus } from "@/lib/generated/prisma/client"

// =============================================================================
// 타입
// =============================================================================

/** RSC → 클라이언트 전달용 캠페인 행. raw 컬럼 / 시크릿 무관 (캠페인엔 시크릿 X). */
export type CampaignRow = {
  id: string
  nccCampaignId: string
  name: string
  /** schema의 campaignType. SA API 응답 필드명은 campaignTp 인 경우도 있음. */
  campaignType: string | null
  /** Decimal → number 직렬화 (RSC 단계에서 변환) */
  dailyBudget: number | null
  /** 일 예산 사용 여부 (없으면 dailyBudget !== null 로 추정) */
  useDailyBudget: boolean
  /** 사용자가 명시적으로 OFF 잠금 */
  userLock: boolean
  status: CampaignStatus
  /** ISO 문자열 (RSC 직렬화) */
  updatedAt: string
}

type Action = "toggleOn" | "toggleOff" | "budget"

type Step = "input" | "preview" | "submit" | "result"

type BulkResult = Awaited<ReturnType<typeof bulkUpdateCampaigns>>

// =============================================================================
// 메인 컴포넌트
// =============================================================================

export function CampaignsTable({
  advertiserId,
  hasKeys,
  campaigns,
}: {
  advertiserId: string
  hasKeys: boolean
  campaigns: CampaignRow[]
}) {
  const router = useRouter()

  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [modalAction, setModalAction] = React.useState<Action | null>(null)

  const allSelected =
    campaigns.length > 0 && selected.size === campaigns.length
  const someSelected = selected.size > 0 && !allSelected

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set())
    } else {
      setSelected(new Set(campaigns.map((c) => c.id)))
    }
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectedRows = React.useMemo(
    () => campaigns.filter((c) => selected.has(c.id)),
    [campaigns, selected],
  )

  function openModal(action: Action) {
    if (selected.size === 0) {
      toast.error("캠페인을 1개 이상 선택하세요")
      return
    }
    if (!hasKeys) {
      toast.error("키 미설정 — 일괄 변경 불가")
      return
    }
    setModalAction(action)
  }

  function closeModal(refresh: boolean) {
    setModalAction(null)
    if (refresh) {
      setSelected(new Set())
      router.refresh()
    }
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-xl font-medium leading-snug">
            캠페인
          </h1>
          <p className="text-sm text-muted-foreground">
            ON/OFF · 일 예산을 다중 선택 후 일괄 변경할 수 있습니다.
          </p>
        </div>
        <SyncCampaignsButton advertiserId={advertiserId} hasKeys={hasKeys} />
      </header>

      {!hasKeys && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="text-amber-700 dark:text-amber-400">
              API 키 미설정
            </CardTitle>
            <CardDescription>
              이 광고주는 API 키 / Secret 키가 입력되지 않았습니다. SA API 호출
              (동기화 / 일괄 변경)이 차단됩니다. admin 권한자가 광고주 상세
              화면에서 키를 입력하면 활성화됩니다.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* 일괄 액션 바 */}
      <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
        <span className="text-sm text-muted-foreground">
          {selected.size > 0
            ? `${selected.size}개 선택됨`
            : "선택된 캠페인 없음"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => openModal("toggleOn")}
            disabled={selected.size === 0 || !hasKeys}
          >
            ON으로 변경
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => openModal("toggleOff")}
            disabled={selected.size === 0 || !hasKeys}
          >
            OFF로 변경
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => openModal("budget")}
            disabled={selected.size === 0 || !hasKeys}
          >
            예산 변경
          </Button>
        </div>
      </div>

      {/* 테이블 */}
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={allSelected}
                  indeterminate={someSelected}
                  onCheckedChange={toggleAll}
                  aria-label="전체 선택"
                />
              </TableHead>
              <TableHead>이름</TableHead>
              <TableHead>타입</TableHead>
              <TableHead className="text-right">일 예산</TableHead>
              <TableHead>상태</TableHead>
              <TableHead>마지막 동기화</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaigns.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="py-8 text-center text-muted-foreground"
                >
                  표시할 캠페인이 없습니다. 우측 상단{" "}
                  <span className="font-medium">광고주에서 동기화</span>{" "}
                  버튼으로 SA에서 가져오세요.
                </TableCell>
              </TableRow>
            ) : (
              campaigns.map((c) => {
                const checked = selected.has(c.id)
                return (
                  <TableRow
                    key={c.id}
                    data-state={checked ? "selected" : undefined}
                  >
                    <TableCell>
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleOne(c.id)}
                        aria-label={`${c.name} 선택`}
                      />
                    </TableCell>
                    <TableCell className="max-w-xs truncate font-medium">
                      {c.name}
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {c.nccCampaignId}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {c.campaignType ?? "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {c.useDailyBudget && c.dailyBudget !== null
                        ? c.dailyBudget.toLocaleString()
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <CampaignStatusBadge
                        status={c.status}
                        userLock={c.userLock}
                      />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(c.updatedAt).toLocaleString("ko-KR")}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      {modalAction !== null && (
        <BulkActionModal
          advertiserId={advertiserId}
          action={modalAction}
          rows={selectedRows}
          onClose={closeModal}
        />
      )}
    </div>
  )
}

// =============================================================================
// 4단계 일괄 액션 모달 (SPEC 11.3)
// =============================================================================

function BulkActionModal({
  advertiserId,
  action,
  rows,
  onClose,
}: {
  advertiserId: string
  action: Action
  rows: CampaignRow[]
  onClose: (refresh: boolean) => void
}) {
  // toggleOn / toggleOff 는 별도 입력 없음 → 시작부터 preview 단계로 진입.
  // budget 만 input 단계에서 새 예산값을 받음.
  const [step, setStep] = React.useState<Step>(
    action === "budget" ? "input" : "preview",
  )
  const [budgetInput, setBudgetInput] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const [result, setResult] = React.useState<BulkResult | null>(null)

  const title = React.useMemo(() => {
    if (action === "toggleOn") return "ON으로 변경 (일괄)"
    if (action === "toggleOff") return "OFF로 변경 (일괄)"
    return "일 예산 변경 (일괄)"
  }, [action])

  // budget 입력 검증 (preview 진입 차단)
  const parsedBudget = React.useMemo(() => {
    if (action !== "budget") return null
    const trimmed = budgetInput.trim()
    if (trimmed === "") return null
    const n = Number(trimmed)
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null
    return n
  }, [action, budgetInput])

  const previewItems = React.useMemo(
    () => buildPreview(action, rows, parsedBudget),
    [action, rows, parsedBudget],
  )

  async function handleConfirm() {
    setStep("submit")
    setSubmitting(true)
    try {
      let payload:
        | {
            action: "toggle"
            items: Array<{ campaignId: string; userLock: boolean }>
          }
        | {
            action: "budget"
            items: Array<{ campaignId: string; dailyBudget: number }>
          }

      if (action === "toggleOn") {
        payload = {
          action: "toggle",
          items: rows.map((r) => ({ campaignId: r.id, userLock: false })),
        }
      } else if (action === "toggleOff") {
        payload = {
          action: "toggle",
          items: rows.map((r) => ({ campaignId: r.id, userLock: true })),
        }
      } else {
        if (parsedBudget === null) {
          toast.error("유효한 일 예산을 입력하세요 (0 이상의 정수)")
          setStep("input")
          setSubmitting(false)
          return
        }
        payload = {
          action: "budget",
          items: rows.map((r) => ({
            campaignId: r.id,
            dailyBudget: parsedBudget,
          })),
        }
      }

      const res = await bulkUpdateCampaigns(advertiserId, payload)
      setResult(res)
      setStep("result")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`일괄 변경 오류: ${msg}`)
      setStep("preview")
    } finally {
      setSubmitting(false)
    }
  }

  function handleClose() {
    // result 단계에서는 갱신, 그 외는 그냥 닫기
    onClose(step === "result")
  }

  return (
    <Dialog open onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {rows.length}개 캠페인 선택됨. 변경은 미리보기 확인 후 적용됩니다.
          </DialogDescription>
        </DialogHeader>

        {step === "input" && action === "budget" && (
          <div className="flex flex-col gap-3">
            <div>
              <Label htmlFor="bulk-budget">새 일 예산 (원)</Label>
              <Input
                id="bulk-budget"
                type="number"
                inputMode="numeric"
                min={0}
                step={1000}
                value={budgetInput}
                onChange={(e) => setBudgetInput(e.target.value)}
                placeholder="예: 50000"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                선택한 모든 캠페인에 동일 예산이 적용됩니다. 0 이상의 정수.
              </p>
            </div>
          </div>
        )}

        {step === "preview" && (
          <PreviewTable items={previewItems} action={action} />
        )}

        {step === "submit" && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            적용 중... ({rows.length}건)
          </div>
        )}

        {step === "result" && result && <ResultView result={result} />}

        <DialogFooter>
          {step === "input" && (
            <>
              <Button variant="outline" onClick={handleClose}>
                취소
              </Button>
              <Button
                onClick={() => setStep("preview")}
                disabled={action === "budget" && parsedBudget === null}
              >
                미리보기
              </Button>
            </>
          )}
          {step === "preview" && (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  // budget 은 input 단계로 복귀해 값 수정. toggle 은 input 단계 없음 → 모달 닫기.
                  if (action === "budget") setStep("input")
                  else handleClose()
                }}
                disabled={submitting}
              >
                {action === "budget" ? "뒤로" : "취소"}
              </Button>
              <Button onClick={handleConfirm} disabled={submitting}>
                확정 적용
              </Button>
            </>
          )}
          {step === "result" && (
            <Button onClick={handleClose}>닫고 새로고침</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// =============================================================================
// 미리보기 표 (전/후 비교)
// =============================================================================

type PreviewItem = {
  id: string
  name: string
  beforeLabel: string
  afterLabel: string
}

function buildPreview(
  action: Action,
  rows: CampaignRow[],
  parsedBudget: number | null,
): PreviewItem[] {
  return rows.map((r) => {
    if (action === "toggleOn") {
      return {
        id: r.id,
        name: r.name,
        beforeLabel: r.userLock ? "OFF" : "ON",
        afterLabel: "ON",
      }
    }
    if (action === "toggleOff") {
      return {
        id: r.id,
        name: r.name,
        beforeLabel: r.userLock ? "OFF" : "ON",
        afterLabel: "OFF",
      }
    }
    return {
      id: r.id,
      name: r.name,
      beforeLabel:
        r.useDailyBudget && r.dailyBudget !== null
          ? `${r.dailyBudget.toLocaleString()}원`
          : "—",
      afterLabel:
        parsedBudget !== null ? `${parsedBudget.toLocaleString()}원` : "—",
    }
  })
}

function PreviewTable({
  items,
  action,
}: {
  items: PreviewItem[]
  action: Action
}) {
  const valueLabel = action === "budget" ? "일 예산" : "ON/OFF"
  return (
    <div className="max-h-72 overflow-y-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>캠페인</TableHead>
            <TableHead>{valueLabel} (현재)</TableHead>
            <TableHead>→ (적용 후)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((it) => (
            <TableRow key={it.id}>
              <TableCell className="max-w-xs truncate font-medium">
                {it.name}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {it.beforeLabel}
              </TableCell>
              <TableCell className="font-medium">{it.afterLabel}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

// =============================================================================
// 결과 뷰 (성공/실패 분리 + ChangeBatch ID)
// =============================================================================

function ResultView({ result }: { result: BulkResult }) {
  const successItems = result.items.filter((i) => i.ok)
  const failedItems = result.items.filter((i) => !i.ok)

  function copyBatchId() {
    navigator.clipboard
      .writeText(result.batchId)
      .then(() => toast.success("ChangeBatch ID 복사됨"))
      .catch(() => toast.error("복사 실패"))
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="요청" value={result.total} />
        <Stat label="성공" value={result.success} accent="emerald" />
        <Stat label="실패" value={result.failed} accent="destructive" />
      </div>

      <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
        <span className="text-xs text-muted-foreground">ChangeBatch ID</span>
        <code className="flex-1 truncate font-mono text-xs">
          {result.batchId}
        </code>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={copyBatchId}
          title="ID 복사"
        >
          <CopyIcon />
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        롤백 페이지(F-6.4)에서 본 ID 로 변경 이력을 조회·되돌릴 수 있습니다.
      </p>

      {failedItems.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5">
          <div className="border-b border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive">
            실패 {failedItems.length}건
          </div>
          <ul className="max-h-40 overflow-y-auto px-3 py-2 text-xs">
            {failedItems.map((it) => (
              <li
                key={it.campaignId}
                className="border-b border-destructive/10 py-1 last:border-0"
              >
                <span className="font-mono text-muted-foreground">
                  {it.campaignId}
                </span>
                <span className="ml-2 text-destructive">
                  {it.error ?? "원인 미상"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {successItems.length > 0 && failedItems.length === 0 && (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-900/20 dark:text-emerald-300">
          모든 변경이 성공적으로 적용되었습니다.
        </p>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string
  value: number
  accent?: "emerald" | "destructive"
}) {
  const valueClass =
    accent === "emerald"
      ? "text-emerald-700 dark:text-emerald-400"
      : accent === "destructive"
        ? "text-destructive"
        : "text-foreground"
  return (
    <div className="rounded-md border bg-background p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-0.5 font-mono text-lg font-medium ${valueClass}`}>
        {value}
      </div>
    </div>
  )
}
