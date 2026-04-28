"use client"

/**
 * 캠페인 목록 + 다중 선택 + 일괄 변경 모달 (F-2.1 / F-2.3 / 6.6 / 11.3)
 *
 * 흐름:
 *   1. RSC 가 advertiserId 한정 prisma.campaign.findMany 결과를 props 로 전달
 *   2. 사용자가 행을 다중 선택 (체크박스, 헤더 select all)
 *   3. 일괄 액션 버튼 클릭 → 4단계 모달 (SPEC 11.3) — 공통 BulkActionModal 위임
 *   4. 결과 화면 닫기 → router.refresh()
 *
 * F-2.3 리팩터링:
 *   - 기존 자체 모달(input/preview/submit/result + ResultView + Stat)을
 *     `components/forms/bulk-action-modal.tsx` 로 추출.
 *   - 본 파일은 캠페인 액션별 입력/프리뷰 render prop 만 정의.
 *   - bulkUpdateCampaigns 시그니처 / UX 변경 X.
 *
 * 안티패턴 회피:
 *   - 즉시 적용 X (사용자 확정 거침)
 *   - 미리보기 단계 생략 X
 *   - ChangeBatch ID 결과 화면에 의무 노출 (BulkActionModal 책임)
 *   - TanStack Virtual 도입 X (캠페인은 수십 row)
 *
 * SPEC 6.2 F-2.1·F-2.3 / 6.6 / 11.3 / 안전장치 1·2.
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
import {
  BulkActionModal,
  type BulkActionResult,
} from "@/components/forms/bulk-action-modal"
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

/** BulkActionModal 의 TInput — 액션별 페이로드 */
type BulkInput =
  | { action: "toggleOn" }
  | { action: "toggleOff" }
  | { action: "budget"; dailyBudget: number }

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

  function handleClosed(didApply: boolean) {
    setModalAction(null)
    if (didApply) {
      setSelected(new Set())
      router.refresh()
    }
  }

  // -- 액션별 onSubmit / 모달 props 구성 -------------------------------------
  const modalProps = React.useMemo(() => {
    if (modalAction === null) return null

    const title =
      modalAction === "toggleOn"
        ? "ON으로 변경 (일괄)"
        : modalAction === "toggleOff"
          ? "OFF로 변경 (일괄)"
          : "일 예산 변경 (일괄)"

    async function onSubmit(input: BulkInput): Promise<BulkActionResult> {
      let payload: Parameters<typeof bulkUpdateCampaigns>[1]
      if (input.action === "toggleOn") {
        payload = {
          action: "toggle",
          items: selectedRows.map((r) => ({
            campaignId: r.id,
            userLock: false,
          })),
        }
      } else if (input.action === "toggleOff") {
        payload = {
          action: "toggle",
          items: selectedRows.map((r) => ({
            campaignId: r.id,
            userLock: true,
          })),
        }
      } else {
        payload = {
          action: "budget",
          items: selectedRows.map((r) => ({
            campaignId: r.id,
            dailyBudget: input.dailyBudget,
          })),
        }
      }
      const res = await bulkUpdateCampaigns(advertiserId, payload)
      // BulkActionModal 의 BulkActionResult 형태로 매핑 (campaignId → id).
      // 결과 화면의 displayName 매칭은 nccCampaignId 기반.
      return {
        batchId: res.batchId,
        total: res.total,
        success: res.success,
        failed: res.failed,
        items: res.items.map((it) => {
          const row = selectedRows.find((r) => r.id === it.campaignId)
          return {
            id: row?.nccCampaignId ?? it.campaignId,
            ok: it.ok,
            error: it.error,
          }
        }),
      }
    }

    return { title, onSubmit, action: modalAction }
  }, [modalAction, selectedRows, advertiserId])

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

      {modalProps !== null && (
        <BulkActionModal<CampaignRow, BulkInput>
          open
          onOpenChange={(o) => {
            if (!o) setModalAction(null)
          }}
          title={modalProps.title}
          itemLabel="캠페인"
          selectedItems={selectedRows}
          renderInput={(items, onReady) => (
            <CampaignBulkInput
              action={modalProps.action}
              items={items}
              onReady={onReady}
            />
          )}
          renderPreview={(items, input) => (
            <CampaignBulkPreview items={items} input={input} />
          )}
          onSubmit={modalProps.onSubmit}
          getItemDisplayName={(c) => c.name}
          getItemId={(c) => c.nccCampaignId}
          onClosed={handleClosed}
        />
      )}
    </div>
  )
}

// =============================================================================
// 캠페인 input 단계 — 액션별 폼
// =============================================================================

function CampaignBulkInput({
  action,
  items,
  onReady,
}: {
  action: Action
  items: CampaignRow[]
  onReady: (input: BulkInput) => void
}) {
  // toggleOn / toggleOff: 별도 입력 없음 → mount 즉시 onReady 호출
  React.useEffect(() => {
    if (action === "toggleOn") onReady({ action: "toggleOn" })
    else if (action === "toggleOff") onReady({ action: "toggleOff" })
    // budget 은 사용자 입력 대기
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action])

  const [budgetInput, setBudgetInput] = React.useState("")

  if (action !== "budget") {
    // mount 즉시 preview 로 진입하므로 짧은 안내만
    return (
      <p className="text-sm text-muted-foreground">
        {items.length}개 캠페인의 ON/OFF 를 변경합니다. 미리보기로 이동
        중...
      </p>
    )
  }

  const trimmed = budgetInput.trim()
  const n = trimmed === "" ? null : Number(trimmed)
  const valid =
    n !== null && Number.isFinite(n) && n >= 0 && Number.isInteger(n)

  return (
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
      <div className="flex justify-end">
        <Button
          onClick={() => valid && onReady({ action: "budget", dailyBudget: n! })}
          disabled={!valid}
        >
          미리보기
        </Button>
      </div>
    </div>
  )
}

// =============================================================================
// 캠페인 preview 단계 — 전/후 비교 표
// =============================================================================

function CampaignBulkPreview({
  items,
  input,
}: {
  items: CampaignRow[]
  input: BulkInput
}) {
  const valueLabel = input.action === "budget" ? "일 예산" : "ON/OFF"
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
          {items.map((r) => {
            const before = computeBefore(r, input)
            const after = computeAfter(r, input)
            return (
              <TableRow key={r.id}>
                <TableCell className="max-w-xs truncate font-medium">
                  {r.name}
                </TableCell>
                <TableCell className="text-muted-foreground">{before}</TableCell>
                <TableCell className="font-medium">{after}</TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function computeBefore(r: CampaignRow, input: BulkInput): string {
  if (input.action === "budget") {
    return r.useDailyBudget && r.dailyBudget !== null
      ? `${r.dailyBudget.toLocaleString()}원`
      : "—"
  }
  return r.userLock ? "OFF" : "ON"
}

function computeAfter(r: CampaignRow, input: BulkInput): string {
  if (input.action === "toggleOn") return "ON"
  if (input.action === "toggleOff") return "OFF"
  return `${input.dailyBudget.toLocaleString()}원`
}
