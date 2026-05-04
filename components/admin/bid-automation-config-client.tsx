"use client"

/**
 * 비딩 자동화 설정 — 클라이언트 (Phase B.4)
 *
 * 구조:
 *   - 테이블: 광고주 / customerId / mode / 페이싱 / 목표 CPA · ROAS / 마지막 변경 / 편집
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
  off: "Off",
}

const PACING_LABEL: Record<BudgetPacingMode, string> = {
  focus: "전환집중",
  explore: "학습탐색",
  protect: "예산보호",
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
            <TableHead>목표 CPA</TableHead>
            <TableHead>목표 ROAS</TableHead>
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
                <TableCell className="tabular-nums">
                  {r.config?.targetCpa != null
                    ? `${r.config.targetCpa.toLocaleString()}원`
                    : "-"}
                </TableCell>
                <TableCell className="tabular-nums">
                  {r.config?.targetRoas != null
                    ? `${(Number(r.config.targetRoas) * 100).toFixed(0)}%`
                    : "-"}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {r.config ? formatDate(r.config.updatedAt) : "-"}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditing(r)
                    }}
                  >
                    <PencilIcon className="size-4" />
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
      const cpaNum = targetCpa.trim() === "" ? null : Number(targetCpa)
      const roasNum = targetRoas.trim() === "" ? null : Number(targetRoas)
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
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>자동화 설정 — {row.advertiserName}</DialogTitle>
          <DialogDescription>
            customerId {row.customerId}. 본 광고주의 비딩 자동화 모드, 예산
            페이싱, 목표 지표를 설정합니다.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mode">자동화 모드</Label>
            <Select
              value={mode}
              onValueChange={(v) => setMode(v as BidAutomationMode)}
            >
              <SelectTrigger id="mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inbox">
                  Inbox 권고 — bid-suggest cron 이 BidSuggestion 적재
                </SelectItem>
                <SelectItem value="auto_policy_only">
                  정책 자동만 — Inbox 비활성, BiddingPolicy 키워드만 자동
                </SelectItem>
                <SelectItem value="off">Off — 자동화 전체 비활성</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pacing">예산 페이싱 모드</Label>
            <Select
              value={pacing}
              onValueChange={(v) => setPacing(v as BudgetPacingMode)}
            >
              <SelectTrigger id="pacing">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="focus">
                  전환집중 — 균등배분 OFF + 시간대 가중
                </SelectItem>
                <SelectItem value="explore">
                  학습탐색 — 균등배분 ON, 신규 캠페인용
                </SelectItem>
                <SelectItem value="protect">
                  예산보호 — 균등배분 ON + 시간대 가중 약화
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="targetCpa">
              목표 CPA (원, VAT 별도)
              <span className="ml-2 text-xs text-muted-foreground">
                선택 — 미설정 시 ROAS 또는 baseline 폴백
              </span>
            </Label>
            <Input
              id="targetCpa"
              type="number"
              placeholder="예: 5000"
              value={targetCpa}
              onChange={(e) => setTargetCpa(e.target.value)}
              min={100}
              max={1_000_000}
              step={100}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="targetRoas">
              목표 ROAS (비율)
              <span className="ml-2 text-xs text-muted-foreground">
                예: 4.5 = 450%. 미설정 시 CPA 또는 baseline 폴백
              </span>
            </Label>
            <Input
              id="targetRoas"
              type="number"
              placeholder="예: 4.5"
              value={targetRoas}
              onChange={(e) => setTargetRoas(e.target.value)}
              min={0.1}
              max={99.99}
              step={0.1}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            취소
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? "저장 중..." : "저장"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
