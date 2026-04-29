"use client"

/**
 * 비딩 정책 테이블 (F-11.1) — 클라이언트
 *
 * - shadcn Table 단순 사용 (정책 100개 미만 가정 → TanStack Virtual 불필요)
 * - 정렬: 기본 keyword 가나다 / 부 device. (작은 데이터라 클라이언트 비교 정렬)
 * - enabled toggle: 즉시 updateBiddingPolicy({ enabled }) — staging 미적용 (단건 정책 CRUD)
 * - 편집 / 삭제 액션은 행 우측 버튼 (operator+ 만 표시 — viewer 는 read 전용)
 * - 삭제: 2차 확인 다이얼로그 → deleteBiddingPolicy
 *
 * mutation 흐름 (단건 즉시 반영):
 *   1. 사용자 클릭 → 낙관적 토글 (UI 선반영)
 *   2. Server Action 호출 → 결과 ok 면 router.refresh, 실패면 원복 + toast
 *
 * SPEC 6.11 F-11.1 / 11.2.
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { PencilIcon, TrashIcon, PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  updateBiddingPolicy,
  deleteBiddingPolicy,
  type BiddingPolicyRow,
} from "@/app/(dashboard)/[advertiserId]/bidding-policies/actions"
import { PolicyFormModal } from "@/components/bidding/policy-form-modal"

// =============================================================================
// 정책 테이블
// =============================================================================

export function PolicyTableClient({
  advertiserId,
  policies,
  userRole,
}: {
  advertiserId: string
  policies: BiddingPolicyRow[]
  userRole: "admin" | "operator" | "viewer"
}) {
  const router = useRouter()
  const canMutate = userRole === "admin" || userRole === "operator"

  // 폼 모달 상태 (create / edit 둘 다 본 모달 단일 사용)
  const [formOpen, setFormOpen] = React.useState(false)
  const [editTarget, setEditTarget] = React.useState<BiddingPolicyRow | null>(
    null,
  )

  // 삭제 확인 모달 상태
  const [deleteTarget, setDeleteTarget] =
    React.useState<BiddingPolicyRow | null>(null)
  const [deleting, setDeleting] = React.useState(false)

  // enabled 토글 inflight (행 ID set) — 동일 행 더블 클릭 차단
  const [togglingIds, setTogglingIds] = React.useState<Set<string>>(new Set())

  function openCreate() {
    setEditTarget(null)
    setFormOpen(true)
  }

  function openEdit(row: BiddingPolicyRow) {
    setEditTarget(row)
    setFormOpen(true)
  }

  async function handleToggleEnabled(row: BiddingPolicyRow, next: boolean) {
    if (togglingIds.has(row.id)) return
    setTogglingIds((s) => new Set(s).add(row.id))
    try {
      const res = await updateBiddingPolicy({
        id: row.id,
        advertiserId,
        enabled: next,
      })
      if (!res.ok) {
        toast.error(`토글 실패: ${res.error}`)
      } else {
        toast.success(next ? "정책 활성화됨" : "정책 비활성화됨")
        router.refresh()
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`토글 오류: ${msg}`)
    } finally {
      setTogglingIds((s) => {
        const n = new Set(s)
        n.delete(row.id)
        return n
      })
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const res = await deleteBiddingPolicy({
        id: deleteTarget.id,
        advertiserId,
      })
      if (!res.ok) {
        toast.error(`삭제 실패: ${res.error}`)
      } else {
        toast.success("정책 삭제 완료")
        setDeleteTarget(null)
        router.refresh()
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`삭제 오류: ${msg}`)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 헤더 + 추가 버튼 */}
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          총 <strong className="text-foreground">{policies.length}</strong>건
        </div>
        {canMutate ? (
          <Button onClick={openCreate}>
            <PlusIcon />
            정책 추가
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">
            (viewer 는 정책 추가/편집 불가)
          </span>
        )}
      </div>

      {/* 빈 상태 */}
      {policies.length === 0 ? (
        <div className="rounded-md border bg-muted/20 px-4 py-12 text-center">
          <p className="text-sm font-medium">아직 비딩 정책이 없습니다</p>
          <p className="mt-1 text-xs text-muted-foreground">
            키워드를 선택해 PC / MOBILE 별 목표 노출 순위 정책을 추가하세요.
            자동 조정 cron(F-11.2)이 매시간 정책을 픽업합니다.
          </p>
          {canMutate && (
            <div className="mt-4">
              <Button variant="outline" onClick={openCreate}>
                <PlusIcon />
                첫 정책 추가
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>키워드</TableHead>
                <TableHead className="w-24">device</TableHead>
                <TableHead className="w-20 text-right">목표 순위</TableHead>
                <TableHead className="w-28 text-right">maxBid</TableHead>
                <TableHead className="w-28 text-right">minBid</TableHead>
                <TableHead className="w-24 text-center">활성</TableHead>
                <TableHead className="w-32 text-right">액션</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {policies.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">{p.keyword}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {p.nccKeywordId}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {p.campaignName} / {p.adgroupName}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <DeviceBadge device={p.device} />
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {p.targetRank}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {formatBid(p.maxBid)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {formatBid(p.minBid)}
                  </TableCell>
                  <TableCell className="text-center">
                    <Checkbox
                      checked={p.enabled}
                      disabled={!canMutate || togglingIds.has(p.id)}
                      onCheckedChange={(v) => handleToggleEnabled(p, !!v)}
                      aria-label={p.enabled ? "비활성화" : "활성화"}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    {canMutate ? (
                      <div className="flex justify-end gap-1">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          onClick={() => openEdit(p)}
                          title="편집"
                        >
                          <PencilIcon />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          onClick={() => setDeleteTarget(p)}
                          title="삭제"
                        >
                          <TrashIcon />
                        </Button>
                      </div>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">
                        —
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* 정책 폼 모달 (create / edit) */}
      <PolicyFormModal
        advertiserId={advertiserId}
        mode={editTarget ? "edit" : "create"}
        policy={editTarget}
        open={formOpen}
        onOpenChange={setFormOpen}
        onDone={() => {
          setFormOpen(false)
          router.refresh()
        }}
      />

      {/* 삭제 확인 다이얼로그 */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && !deleting && setDeleteTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>정책 삭제</DialogTitle>
            <DialogDescription>
              이 정책을 삭제하면 해당 키워드의 자동 조정 대상에서 제외됩니다.
              과거 OptimizationRun 로그는 보존됩니다 (감사용).
            </DialogDescription>
          </DialogHeader>

          {deleteTarget && (
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <div>
                <span className="font-medium">{deleteTarget.keyword}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  ({deleteTarget.device})
                </span>
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                목표 순위 {deleteTarget.targetRank} · maxBid{" "}
                {formatBid(deleteTarget.maxBid)} · minBid{" "}
                {formatBid(deleteTarget.minBid)}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
            >
              취소
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmDelete}
              disabled={deleting}
            >
              {deleting ? "삭제 중..." : "삭제"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// =============================================================================
// 보조 컴포넌트
// =============================================================================

function DeviceBadge({ device }: { device: "PC" | "MOBILE" }) {
  const cls =
    device === "PC"
      ? "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300"
      : "bg-violet-100 text-violet-800 dark:bg-violet-950/40 dark:text-violet-300"
  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium ${cls}`}
    >
      {device}
    </span>
  )
}

function formatBid(v: number | null): string {
  if (v === null) return "—"
  return v.toLocaleString()
}
