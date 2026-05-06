"use client"

/**
 * 비딩 자동화 설정 — 클라이언트 (Phase B.4)
 *
 * 구조:
 *   - 테이블: 광고주 / customerId / mode / 페이싱 / CPC 기준 / 전환 기준 / 마지막 변경 / 편집
 *   - 행 클릭 또는 "편집" 버튼 → BidAutomationConfigModal
 *   - 모달: mode select / budgetPacingMode select / targetCpa·targetRoas input → 저장
 *
 * 정합성:
 *   - 권한은 Server Action(`assertRole("admin")`) 가 강제 — 클라이언트는 UX 표시만
 *   - 저장 후 router.refresh() 로 RSC 데이터 재로드
 *   - 미설정 광고주는 mode="off" 기본값으로 모달 진입
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { PencilIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

import {
  upsertBidAutomationConfig,
  type BidAutomationConfigRow,
  type BidAutomationMode,
  type BudgetPacingMode,
} from "@/app/admin/bidding/automation-config/actions"

// =============================================================================
// 라벨 헬퍼
// =============================================================================

const MODE_LABEL: Record<BidAutomationMode, string> = {
  inbox: "Inbox 권고",
  auto_policy_only: "정책 자동만",
  off: "자동화 끔",
}

const PACING_LABEL: Record<BudgetPacingMode, string> = {
  focus: "전환집중",
  explore: "학습탐색",
  protect: "예산보호",
}

const PACING_DESCRIPTION: Record<BudgetPacingMode, string> = {
  focus:
    "전환 가능성이 높은 시간대와 키워드에 예산을 더 빠르게 쓰는 공격적인 운영 모드입니다.",
  explore:
    "성과 신호가 부족한 광고주나 신규 캠페인에서 데이터를 고르게 모으는 학습 모드입니다.",
  protect:
    "예산 소진 속도를 늦추고 급격한 입찰 확대를 줄이는 보수적인 보호 모드입니다.",
}

const MODE_DESCRIPTION: Record<BidAutomationMode, string> = {
  inbox:
    "자동 분석이 입찰가 권고를 만들고, 운영자가 운영 Inbox에서 승인해야 실제 변경됩니다.",
  auto_policy_only:
    "비딩 정책에 등록된 키워드만 정해진 상한/하한 안에서 자동 조정합니다.",
  off: "권고 생성과 자동 조정을 모두 끕니다. 가장 안전한 대기 상태입니다.",
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso))
}

function formatNullableNumber(value: string | number | null | undefined) {
  if (value == null || value === "") return "-"
  const n = Number(value)
  return Number.isFinite(n) ? new Intl.NumberFormat("ko-KR").format(n) : "-"
}

function openOnKeyboard(
  e: React.KeyboardEvent,
  open: () => void,
): void {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault()
    open()
  }
}

// =============================================================================
// 메인 컴포넌트
// =============================================================================

export function BidAutomationConfigClient({
  rows,
}: {
  rows: BidAutomationConfigRow[]
}) {
  const [editing, setEditing] = React.useState<BidAutomationConfigRow | null>(
    null,
  )

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>광고주</TableHead>
            <TableHead>customerId</TableHead>
            <TableHead>모드</TableHead>
            <TableHead>예산 페이싱</TableHead>
            <TableHead>CPC 기준</TableHead>
            <TableHead>전환 기준</TableHead>
            <TableHead>마지막 변경</TableHead>
            <TableHead className="w-[80px]">편집</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-muted-foreground">
                등록된 광고주가 없습니다.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((r) => (
              <TableRow
                key={r.advertiserId}
                className="cursor-pointer"
                onClick={() => setEditing(r)}
                onKeyDown={(e) => openOnKeyboard(e, () => setEditing(r))}
                role="button"
                tabIndex={0}
              >
                <TableCell className="font-medium">
                  {r.advertiserName}
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {r.customerId}
                </TableCell>
                <TableCell>
                  {r.config ? (
                    <span
                      data-mode={r.config.mode}
                      className="inline-flex items-center rounded px-2 py-0.5 text-xs data-[mode=inbox]:bg-blue-100 data-[mode=inbox]:text-blue-800 data-[mode=auto_policy_only]:bg-amber-100 data-[mode=auto_policy_only]:text-amber-800 data-[mode=off]:bg-gray-100 data-[mode=off]:text-gray-700"
                    >
                      {MODE_LABEL[r.config.mode]}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      미설정
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  {r.config ? (
                    PACING_LABEL[r.config.budgetPacingMode]
                  ) : (
                    <span className="text-xs text-muted-foreground">-</span>
                  )}
                </TableCell>
                <TableCell className="text-xs tabular-nums">
                  {r.config ? (
                    <div className="space-y-0.5">
                      <div>목표 {formatNullableNumber(r.config.targetCpc)}원</div>
                      <div className="text-muted-foreground">
                        상한 {formatNullableNumber(r.config.maxCpc)}원 · CTR{" "}
                        {r.config.minCtr != null ? `${r.config.minCtr}%` : "-"}
                      </div>
                    </div>
                  ) : (
                    "-"
                  )}
                </TableCell>
                <TableCell className="text-xs tabular-nums">
                  {r.config ? (
                    <div className="space-y-0.5">
                      <div>
                        CPA{" "}
                        {r.config.targetCpa != null
                          ? `${formatNullableNumber(r.config.targetCpa)}원`
                          : "-"}
                      </div>
                      <div className="text-muted-foreground">
                        ROAS{" "}
                        {r.config.targetRoas != null
                          ? `${(Number(r.config.targetRoas) * 100).toFixed(0)}%`
                          : "-"}{" "}
                        · 순위 {r.config.targetAvgRank ?? "-"}
                      </div>
                    </div>
                  ) : (
                    "-"
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {r.config ? formatDate(r.config.updatedAt) : "-"}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`${r.advertiserName} 자동화 설정 편집`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditing(r)
                    }}
                  >
                    <PencilIcon aria-hidden="true" className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {editing != null && (
        <BidAutomationConfigModal
          row={editing}
          open
          onClose={() => setEditing(null)}
        />
      )}
    </>
  )
}

// =============================================================================
// 편집 모달
// =============================================================================

function BidAutomationConfigModal({
  row,
  open,
  onClose,
}: {
  row: BidAutomationConfigRow
  open: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const [mode, setMode] = React.useState<BidAutomationMode>(
    row.config?.mode ?? "off",
  )
  const [pacing, setPacing] = React.useState<BudgetPacingMode>(
    row.config?.budgetPacingMode ?? "focus",
  )
  const [targetCpc, setTargetCpc] = React.useState<string>(
    row.config?.targetCpc != null ? String(row.config.targetCpc) : "",
  )
  const [maxCpc, setMaxCpc] = React.useState<string>(
    row.config?.maxCpc != null ? String(row.config.maxCpc) : "",
  )
  const [minCtr, setMinCtr] = React.useState<string>(
    row.config?.minCtr != null ? row.config.minCtr : "",
  )
  const [targetAvgRank, setTargetAvgRank] = React.useState<string>(
    row.config?.targetAvgRank != null ? row.config.targetAvgRank : "",
  )
  const [targetCpa, setTargetCpa] = React.useState<string>(
    row.config?.targetCpa != null ? String(row.config.targetCpa) : "",
  )
  const [targetRoas, setTargetRoas] = React.useState<string>(
    row.config?.targetRoas != null ? row.config.targetRoas : "",
  )
  const [submitting, setSubmitting] = React.useState(false)

  async function handleSubmit() {
    setSubmitting(true)
    try {
      const targetCpcNum =
        targetCpc.trim() === "" ? null : Number(targetCpc)
      const maxCpcNum = maxCpc.trim() === "" ? null : Number(maxCpc)
      const minCtrNum = minCtr.trim() === "" ? null : Number(minCtr)
      const targetAvgRankNum =
        targetAvgRank.trim() === "" ? null : Number(targetAvgRank)
      const cpaNum = targetCpa.trim() === "" ? null : Number(targetCpa)
      const roasNum = targetRoas.trim() === "" ? null : Number(targetRoas)
      if (
        targetCpcNum != null &&
        (!Number.isFinite(targetCpcNum) || targetCpcNum < 10)
      ) {
        toast.error("목표 CPC 는 10원 이상의 정수여야 합니다")
        return
      }
      if (
        maxCpcNum != null &&
        (!Number.isFinite(maxCpcNum) || maxCpcNum < 10)
      ) {
        toast.error("최대 CPC 는 10원 이상의 정수여야 합니다")
        return
      }
      if (
        targetCpcNum != null &&
        maxCpcNum != null &&
        maxCpcNum < targetCpcNum
      ) {
        toast.error("최대 CPC 는 목표 CPC 이상이어야 합니다")
        return
      }
      if (
        minCtrNum != null &&
        (!Number.isFinite(minCtrNum) || minCtrNum <= 0 || minCtrNum > 100)
      ) {
        toast.error("CTR 하한은 0보다 크고 100 이하인 값이어야 합니다")
        return
      }
      if (
        targetAvgRankNum != null &&
        (!Number.isFinite(targetAvgRankNum) ||
          targetAvgRankNum < 1 ||
          targetAvgRankNum > 50)
      ) {
        toast.error("목표 평균 순위는 1~50 사이여야 합니다")
        return
      }
      if (cpaNum != null && (!Number.isFinite(cpaNum) || cpaNum < 100)) {
        toast.error("목표 CPA 는 100원 이상의 정수여야 합니다")
        return
      }
      if (roasNum != null && (!Number.isFinite(roasNum) || roasNum <= 0)) {
        toast.error("목표 ROAS 는 0 보다 큰 비율(예: 4.5 = 450%)이어야 합니다")
        return
      }

      const r = await upsertBidAutomationConfig({
        advertiserId: row.advertiserId,
        mode,
        budgetPacingMode: pacing,
        targetCpc: targetCpcNum != null ? Math.round(targetCpcNum) : null,
        maxCpc: maxCpcNum != null ? Math.round(maxCpcNum) : null,
        minCtr: minCtrNum,
        targetAvgRank: targetAvgRankNum,
        targetCpa: cpaNum != null ? Math.round(cpaNum) : null,
        targetRoas: roasNum,
      })

      if (r.ok) {
        toast.success("자동화 설정이 저장되었습니다")
        router.refresh()
        onClose()
      } else {
        toast.error(r.error)
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="max-h-[min(88vh,54rem)] w-[min(60rem,calc(100vw-2rem))] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>자동화 설정 — {row.advertiserName}</DialogTitle>
          <DialogDescription>
            customerId {row.customerId}. 자동화 수준과 예산 사용 성향, 목표 성과
            기준을 설정합니다.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mode">자동화 모드</Label>
                <Select
                  value={mode}
                  onValueChange={(v) => setMode(v as BidAutomationMode)}
                >
                  <SelectTrigger id="mode" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inbox">Inbox 권고</SelectItem>
                    <SelectItem value="auto_policy_only">정책 자동만</SelectItem>
                    <SelectItem value="off">자동화 끔</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {MODE_DESCRIPTION[mode]}
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pacing">예산 페이싱 모드</Label>
                <Select
                  value={pacing}
                  onValueChange={(v) => setPacing(v as BudgetPacingMode)}
                >
                  <SelectTrigger id="pacing" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="focus">전환집중</SelectItem>
                    <SelectItem value="explore">학습탐색</SelectItem>
                    <SelectItem value="protect">예산보호</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {PACING_DESCRIPTION[pacing]}
                </p>
              </div>
            </div>

            <div className="rounded-lg border p-3">
              <div className="mb-3">
                <p className="text-sm font-medium">CPC 운영 기준</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  파워링크/검색광고의 기본 권고 기준입니다.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="targetCpc">목표 CPC</Label>
                  <Input
                    id="targetCpc"
                    name="targetCpc"
                    type="number"
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="예: 700…"
                    value={targetCpc}
                    onChange={(e) => setTargetCpc(e.target.value)}
                    min={10}
                    max={1_000_000}
                    step={10}
                  />
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    클릭 1회에 기대하는 기준 비용입니다.
                  </p>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="maxCpc">최대 CPC</Label>
                  <Input
                    id="maxCpc"
                    name="maxCpc"
                    type="number"
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="예: 1500…"
                    value={maxCpc}
                    onChange={(e) => setMaxCpc(e.target.value)}
                    min={10}
                    max={1_000_000}
                    step={10}
                  />
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    권고 입찰가가 넘지 않아야 하는 상한입니다.
                  </p>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="minCtr">CTR 하한 (%)</Label>
                  <Input
                    id="minCtr"
                    name="minCtr"
                    type="number"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="예: 0.3…"
                    value={minCtr}
                    onChange={(e) => setMinCtr(e.target.value)}
                    min={0.01}
                    max={100}
                    step={0.01}
                  />
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    이보다 낮으면 입찰 하향 또는 소재 개선 후보로 봅니다.
                  </p>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="targetAvgRank">목표 평균 순위</Label>
                  <Input
                    id="targetAvgRank"
                    name="targetAvgRank"
                    type="number"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="예: 3…"
                    value={targetAvgRank}
                    onChange={(e) => setTargetAvgRank(e.target.value)}
                    min={1}
                    max={50}
                    step={0.1}
                  />
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    순위 기반 정책 권고에 사용할 기준입니다.
                  </p>
                </div>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="targetCpa">목표 CPA</Label>
                <Input
                  id="targetCpa"
                  name="targetCpa"
                  type="number"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="예: 5000…"
                  value={targetCpa}
                  onChange={(e) => setTargetCpa(e.target.value)}
                  min={100}
                  max={1_000_000}
                  step={100}
                />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  전환 1건을 얻기 위해 허용할 최대 비용입니다. 단위는 원이며 VAT
                  별도입니다.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="targetRoas">목표 ROAS</Label>
                <Input
                  id="targetRoas"
                  name="targetRoas"
                  type="number"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="예: 4.5…"
                  value={targetRoas}
                  onChange={(e) => setTargetRoas(e.target.value)}
                  min={0.1}
                  max={99.99}
                  step={0.1}
                />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  광고비 대비 매출 목표입니다. 4.5는 450%를 의미합니다.
                </p>
              </div>
            </div>
          </div>

          <aside className="rounded-lg border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
            <p className="font-medium text-foreground">목표 지표 기준</p>
            <p className="mt-2">
              CPC/CTR/순위는 검색광고 운영의 기본 기준입니다. CPA와 ROAS는
              전환·매출 데이터가 안정적으로 들어올 때 추가로 사용합니다.
            </p>
            <p className="mt-2">
              권고 우선순위는 ROAS, CPA, CPC, CTR, 광고주 평균 CPC 순입니다.
              목표 평균 순위는 자동 적용보다 정책 등록/수정 권고에 먼저
              활용하는 쪽이 안전합니다.
            </p>
          </aside>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            취소
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? "저장 중…" : "저장"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
