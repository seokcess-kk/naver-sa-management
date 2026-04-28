"use client"

/**
 * 광고그룹 목록 + 다중 선택 + 일괄 변경 모달 (F-2.2 / F-2.3 / 6.6 / 11.3)
 *
 * 흐름:
 *   1. RSC 가 advertiserId 한정 prisma.adGroup.findMany 결과를 props 로 전달
 *      (campaign join 으로 광고주 횡단 차단)
 *   2. 사용자가 행을 다중 선택 (체크박스, 헤더 select all)
 *   3. 일괄 액션 버튼 클릭 → 4단계 모달 (SPEC 11.3) — 공통 BulkActionModal 위임
 *   4. 결과 화면 닫기 → router.refresh()
 *
 * F-2.3 리팩터링:
 *   - 기존 자체 모달(input/preview/submit/result + ResultView + Stat)을
 *     `components/forms/bulk-action-modal.tsx` 로 추출.
 *   - 본 파일은 광고그룹 액션별 입력/프리뷰 render prop 만 정의.
 *   - bulkUpdateAdgroups 시그니처 / UX 변경 X.
 *
 * F-2.1 캠페인 테이블과의 차이 (그대로 유지):
 *   - 컬럼 추가: 캠페인명 / 입찰가 / PC / Mobile (+ 일예산 / 상태)
 *   - 다중 액션 5종: ON / OFF / 입찰가 변경 / 예산 변경 / 채널 변경
 *   - 채널 변경은 backend 가 명시적 throw — UI 에서 "운영 검증 필요" 안내 +
 *     "강제 시도" 버튼으로 ChangeBatch 실패 결과를 운영자가 확인 가능
 *
 * 안티패턴 회피:
 *   - 즉시 적용 X (사용자 확정 거침)
 *   - 미리보기 단계 생략 X (channel "강제 시도" 도 confirm 모달은 거침)
 *   - ChangeBatch ID 결과 화면에 의무 노출 (BulkActionModal 책임)
 *   - TanStack Virtual 도입 X (광고그룹은 수십~수백 row)
 *
 * SPEC 6.2 F-2.2 / 6.6 / 11.3 / 안전장치 1·2.
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
import { AdgroupStatusBadge } from "@/components/dashboard/adgroup-status-badge"
import { SyncAdgroupsButton } from "@/components/dashboard/sync-adgroups-button"
import {
  BulkActionModal,
  type BulkActionResult,
} from "@/components/forms/bulk-action-modal"
import { bulkUpdateAdgroups } from "@/app/(dashboard)/[advertiserId]/adgroups/actions"
import type { AdGroupStatus } from "@/lib/generated/prisma/client"

// =============================================================================
// 타입
// =============================================================================

/** RSC → 클라이언트 전달용 광고그룹 행. raw 컬럼 / 시크릿 무관 (광고그룹엔 시크릿 X). */
export type AdgroupRow = {
  id: string
  nccAdgroupId: string
  name: string
  /** 그룹 기본 입찰가 (Decimal → number 직렬화). 미설정 null. */
  bidAmt: number | null
  /** 그룹 일 예산 (Decimal → number 직렬화). 미설정 null. */
  dailyBudget: number | null
  pcChannelOn: boolean
  mblChannelOn: boolean
  status: AdGroupStatus
  /** ISO 문자열 (RSC 직렬화) */
  updatedAt: string
  /** 부모 캠페인 표시용 */
  campaign: {
    id: string
    name: string
    nccCampaignId: string
  }
}

type Action = "toggleOn" | "toggleOff" | "bid" | "budget" | "channel"

/** channel 모달 단계에서 사용자가 선택한 PC/Mobile 적용 값. */
type ChannelChoice = {
  pcChannelOn: boolean | null // null = 변경 안 함
  mblChannelOn: boolean | null
}

/** BulkActionModal 의 TInput — 액션별 페이로드 */
type BulkInput =
  | { action: "toggleOn" }
  | { action: "toggleOff" }
  | { action: "bid"; bidAmt: number }
  | { action: "budget"; dailyBudget: number }
  | { action: "channel"; choice: ChannelChoice }

// =============================================================================
// 메인 컴포넌트
// =============================================================================

export function AdgroupsTable({
  advertiserId,
  hasKeys,
  adgroups,
}: {
  advertiserId: string
  hasKeys: boolean
  adgroups: AdgroupRow[]
}) {
  const router = useRouter()

  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [modalAction, setModalAction] = React.useState<Action | null>(null)

  const allSelected = adgroups.length > 0 && selected.size === adgroups.length
  const someSelected = selected.size > 0 && !allSelected

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set())
    } else {
      setSelected(new Set(adgroups.map((g) => g.id)))
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
    () => adgroups.filter((g) => selected.has(g.id)),
    [adgroups, selected],
  )

  function openModal(action: Action) {
    if (selected.size === 0) {
      toast.error("광고그룹을 1개 이상 선택하세요")
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
          : modalAction === "bid"
            ? "그룹 기본 입찰가 변경 (일괄)"
            : modalAction === "budget"
              ? "그룹 일 예산 변경 (일괄)"
              : "기본 매체 ON/OFF 변경 (일괄)"

    async function onSubmit(input: BulkInput): Promise<BulkActionResult> {
      let payload: Parameters<typeof bulkUpdateAdgroups>[1]
      if (input.action === "toggleOn") {
        payload = {
          action: "toggle",
          items: selectedRows.map((r) => ({
            adgroupId: r.id,
            userLock: false,
          })),
        }
      } else if (input.action === "toggleOff") {
        payload = {
          action: "toggle",
          items: selectedRows.map((r) => ({
            adgroupId: r.id,
            userLock: true,
          })),
        }
      } else if (input.action === "bid") {
        payload = {
          action: "bid",
          items: selectedRows.map((r) => ({
            adgroupId: r.id,
            bidAmt: input.bidAmt,
          })),
        }
      } else if (input.action === "budget") {
        payload = {
          action: "budget",
          items: selectedRows.map((r) => ({
            adgroupId: r.id,
            dailyBudget: input.dailyBudget,
          })),
        }
      } else {
        // channel — backend 가 명시적 throw 함. 사용자 명시 동의 후 "강제 시도".
        const { choice } = input
        payload = {
          action: "channel",
          items: selectedRows.map((r) => {
            const it: {
              adgroupId: string
              pcChannelOn?: boolean
              mblChannelOn?: boolean
            } = { adgroupId: r.id }
            if (choice.pcChannelOn !== null) it.pcChannelOn = choice.pcChannelOn
            if (choice.mblChannelOn !== null)
              it.mblChannelOn = choice.mblChannelOn
            return it
          }),
        }
      }
      const res = await bulkUpdateAdgroups(advertiserId, payload)
      // BulkActionModal 의 BulkActionResult 형태로 매핑 (adgroupId → id).
      // 결과 화면의 displayName 매칭은 nccAdgroupId 기반.
      return {
        batchId: res.batchId,
        total: res.total,
        success: res.success,
        failed: res.failed,
        items: res.items.map((it) => {
          const row = selectedRows.find((r) => r.id === it.adgroupId)
          return {
            id: row?.nccAdgroupId ?? it.adgroupId,
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
            광고그룹
          </h1>
          <p className="text-sm text-muted-foreground">
            ON/OFF · 입찰가 · 예산 · 기본 매체를 다중 선택 후 일괄 변경할 수
            있습니다.
          </p>
        </div>
        <SyncAdgroupsButton advertiserId={advertiserId} hasKeys={hasKeys} />
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
            : "선택된 광고그룹 없음"}
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
            onClick={() => openModal("bid")}
            disabled={selected.size === 0 || !hasKeys}
          >
            입찰가 변경
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => openModal("budget")}
            disabled={selected.size === 0 || !hasKeys}
          >
            예산 변경
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => openModal("channel")}
            disabled={selected.size === 0 || !hasKeys}
          >
            채널 변경
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
              <TableHead>광고그룹명</TableHead>
              <TableHead>캠페인</TableHead>
              <TableHead className="text-right">입찰가</TableHead>
              <TableHead className="text-right">일 예산</TableHead>
              <TableHead className="text-center">PC</TableHead>
              <TableHead className="text-center">Mobile</TableHead>
              <TableHead>상태</TableHead>
              <TableHead>최근 수정</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {adgroups.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className="py-8 text-center text-muted-foreground"
                >
                  표시할 광고그룹이 없습니다. 우측 상단{" "}
                  <span className="font-medium">광고주에서 동기화</span>{" "}
                  버튼으로 SA 에서 가져오세요. (캠페인을 먼저 동기화해야
                  합니다.)
                </TableCell>
              </TableRow>
            ) : (
              adgroups.map((g) => {
                const checked = selected.has(g.id)
                return (
                  <TableRow
                    key={g.id}
                    data-state={checked ? "selected" : undefined}
                  >
                    <TableCell>
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleOne(g.id)}
                        aria-label={`${g.name} 선택`}
                      />
                    </TableCell>
                    <TableCell className="max-w-xs truncate font-medium">
                      {g.name}
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {g.nccAdgroupId}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-xs truncate text-xs text-muted-foreground">
                      {g.campaign.name}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {g.bidAmt !== null ? g.bidAmt.toLocaleString() : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {g.dailyBudget !== null
                        ? g.dailyBudget.toLocaleString()
                        : "—"}
                    </TableCell>
                    <TableCell className="text-center text-xs">
                      <ChannelDot on={g.pcChannelOn} />
                    </TableCell>
                    <TableCell className="text-center text-xs">
                      <ChannelDot on={g.mblChannelOn} />
                    </TableCell>
                    <TableCell>
                      <AdgroupStatusBadge status={g.status} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(g.updatedAt).toLocaleString("ko-KR")}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      {modalProps !== null && (
        <BulkActionModal<AdgroupRow, BulkInput>
          open
          onOpenChange={(o) => {
            if (!o) setModalAction(null)
          }}
          title={modalProps.title}
          itemLabel="광고그룹"
          selectedItems={selectedRows}
          renderInput={(items, onReady) => (
            <AdgroupBulkInput
              action={modalProps.action}
              items={items}
              onReady={onReady}
            />
          )}
          renderPreview={(items, input) => (
            <AdgroupBulkPreview items={items} input={input} />
          )}
          onSubmit={modalProps.onSubmit}
          getItemDisplayName={(g) => g.name}
          getItemId={(g) => g.nccAdgroupId}
          onClosed={handleClosed}
          confirmButtonVariant={
            modalProps.action === "channel" ? "destructive" : "default"
          }
          confirmButtonLabel={
            modalProps.action === "channel"
              ? "강제 시도 (실패 예상)"
              : "확정 적용"
          }
        />
      )}
    </div>
  )
}

/** PC / Mobile ON/OFF 표시용 작은 점. */
function ChannelDot({ on }: { on: boolean }) {
  if (on) {
    return (
      <span
        className="inline-block h-2 w-2 rounded-full bg-emerald-500"
        title="ON"
        aria-label="ON"
      />
    )
  }
  return (
    <span
      className="inline-block h-2 w-2 rounded-full bg-zinc-300 dark:bg-zinc-700"
      title="OFF"
      aria-label="OFF"
    />
  )
}

// =============================================================================
// 광고그룹 input 단계 — 액션별 폼
// =============================================================================

function AdgroupBulkInput({
  action,
  items,
  onReady,
}: {
  action: Action
  items: AdgroupRow[]
  onReady: (input: BulkInput) => void
}) {
  // toggleOn / toggleOff: 별도 입력 없음 → mount 즉시 onReady 호출
  React.useEffect(() => {
    if (action === "toggleOn") onReady({ action: "toggleOn" })
    else if (action === "toggleOff") onReady({ action: "toggleOff" })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action])

  if (action === "toggleOn" || action === "toggleOff") {
    return (
      <p className="text-sm text-muted-foreground">
        {items.length}개 광고그룹의 ON/OFF 를 변경합니다. 미리보기로 이동
        중...
      </p>
    )
  }

  if (action === "bid" || action === "budget") {
    return (
      <NumericInput
        action={action}
        onReady={(n) =>
          onReady(
            action === "bid"
              ? { action: "bid", bidAmt: n }
              : { action: "budget", dailyBudget: n },
          )
        }
      />
    )
  }

  // channel
  return (
    <ChannelInput
      onReady={(choice) => onReady({ action: "channel", choice })}
    />
  )
}

function NumericInput({
  action,
  onReady,
}: {
  action: "bid" | "budget"
  onReady: (n: number) => void
}) {
  const [valueInput, setValueInput] = React.useState("")
  const trimmed = valueInput.trim()
  const n = trimmed === "" ? null : Number(trimmed)
  const valid =
    n !== null && Number.isFinite(n) && n >= 0 && Number.isInteger(n)

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Label htmlFor="bulk-value">
          {action === "bid" ? "새 그룹 기본 입찰가 (원)" : "새 일 예산 (원)"}
        </Label>
        <Input
          id="bulk-value"
          type="number"
          inputMode="numeric"
          min={0}
          step={action === "bid" ? 10 : 1000}
          value={valueInput}
          onChange={(e) => setValueInput(e.target.value)}
          placeholder={action === "bid" ? "예: 500" : "예: 50000"}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          선택한 모든 광고그룹에 동일 값이 적용됩니다. 0 이상의 정수.
        </p>
      </div>
      <div className="flex justify-end">
        <Button onClick={() => valid && onReady(n!)} disabled={!valid}>
          미리보기
        </Button>
      </div>
    </div>
  )
}

// =============================================================================
// channel 입력 (운영 검증 필요 안내 + ON/OFF 라디오)
// =============================================================================

function ChannelInput({
  onReady,
}: {
  onReady: (choice: ChannelChoice) => void
}) {
  const [choice, setChoice] = React.useState<ChannelChoice>({
    pcChannelOn: null,
    mblChannelOn: null,
  })

  // PC / Mobile 중 최소 1개 선택해야 preview 가능
  const valid =
    choice.pcChannelOn !== null || choice.mblChannelOn !== null

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
        <p className="font-medium">운영 검증 필요 (SA 필드 미확정)</p>
        <p className="mt-1">
          네이버 SA 의 PC/모바일 매체 ON/OFF 표현이 응답 샘플 마다 달라 본
          기능은 아직 호출 자체를 차단하고 있습니다. 아래 &quot;강제
          시도&quot; 버튼은 ChangeBatch 를 의도적으로 실패 상태로 종료하여
          운영자가 결과를 확인할 수 있도록 합니다 (실제 SA 변경 X).
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <ChannelChoiceCard
          label="PC"
          value={choice.pcChannelOn}
          onChange={(v) => setChoice({ ...choice, pcChannelOn: v })}
        />
        <ChannelChoiceCard
          label="Mobile"
          value={choice.mblChannelOn}
          onChange={(v) => setChoice({ ...choice, mblChannelOn: v })}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        &quot;변경 안 함&quot; 으로 두면 해당 매체는 그대로 유지됩니다
        (페이로드에서 제외).
      </p>
      <div className="flex justify-end">
        <Button onClick={() => valid && onReady(choice)} disabled={!valid}>
          미리보기
        </Button>
      </div>
    </div>
  )
}

function ChannelChoiceCard({
  label,
  value,
  onChange,
}: {
  label: string
  value: boolean | null
  onChange: (v: boolean | null) => void
}) {
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="mb-2 text-xs font-medium">{label}</div>
      <div className="flex gap-1.5">
        <Button
          size="sm"
          variant={value === null ? "default" : "outline"}
          className="flex-1"
          onClick={() => onChange(null)}
        >
          변경 안 함
        </Button>
        <Button
          size="sm"
          variant={value === true ? "default" : "outline"}
          className="flex-1"
          onClick={() => onChange(true)}
        >
          ON
        </Button>
        <Button
          size="sm"
          variant={value === false ? "default" : "outline"}
          className="flex-1"
          onClick={() => onChange(false)}
        >
          OFF
        </Button>
      </div>
    </div>
  )
}

// =============================================================================
// 광고그룹 preview 단계 — 전/후 비교 표
// =============================================================================

function AdgroupBulkPreview({
  items,
  input,
}: {
  items: AdgroupRow[]
  input: BulkInput
}) {
  const valueLabel =
    input.action === "bid"
      ? "입찰가"
      : input.action === "budget"
        ? "일 예산"
        : input.action === "channel"
          ? "PC/Mobile"
          : "ON/OFF"

  return (
    <div className="max-h-72 overflow-y-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>광고그룹</TableHead>
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

function computeBefore(r: AdgroupRow, input: BulkInput): string {
  if (input.action === "bid") {
    return r.bidAmt !== null ? `${r.bidAmt.toLocaleString()}원` : "—"
  }
  if (input.action === "budget") {
    return r.dailyBudget !== null ? `${r.dailyBudget.toLocaleString()}원` : "—"
  }
  if (input.action === "channel") {
    return `PC ${r.pcChannelOn ? "ON" : "OFF"} / M ${r.mblChannelOn ? "ON" : "OFF"}`
  }
  return statusLabel(r.status)
}

function computeAfter(r: AdgroupRow, input: BulkInput): string {
  if (input.action === "toggleOn") return "ON"
  if (input.action === "toggleOff") return "OFF"
  if (input.action === "bid") return `${input.bidAmt.toLocaleString()}원`
  if (input.action === "budget") return `${input.dailyBudget.toLocaleString()}원`
  // channel
  const beforePc = r.pcChannelOn ? "ON" : "OFF"
  const beforeMbl = r.mblChannelOn ? "ON" : "OFF"
  const afterPc =
    input.choice.pcChannelOn === null
      ? beforePc
      : input.choice.pcChannelOn
        ? "ON"
        : "OFF"
  const afterMbl =
    input.choice.mblChannelOn === null
      ? beforeMbl
      : input.choice.mblChannelOn
        ? "ON"
        : "OFF"
  return `PC ${afterPc} / M ${afterMbl}`
}

function statusLabel(s: AdGroupStatus): string {
  if (s === "deleted") return "삭제됨"
  if (s === "off") return "OFF"
  return "ON"
}
