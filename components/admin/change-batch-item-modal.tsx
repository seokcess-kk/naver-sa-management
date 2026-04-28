"use client"

/**
 * ChangeItem 상세 (before / after JSON) 모달 (F-6.x)
 *
 * 표시:
 *   - 메타: id / targetType / targetId / status / attempt / error / idempotencyKey
 *   - before / after JSON pretty (좌우 분할 — 좁은 화면에서는 상하 스택)
 *
 * 보안:
 *   - 시크릿 컬럼은 적재 단계(`lib/audit/log.ts` sanitize) 에서 마스킹.
 *     ChangeItem.before/after 자체엔 시크릿 직접 적재 없음 가정.
 *
 * 동작:
 *   - row=null 이면 닫힘 상태. row 가 들어오면 자동으로 열림.
 *   - 닫기는 onClose 로 부모 상태(detailRow) 를 null 로 리셋.
 *
 * audit-detail-modal.tsx 의 패턴을 ChangeItem 형태로 응용.
 */

import * as React from "react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import type { ChangeItemRow } from "@/app/admin/change-batches/actions"

function prettyJson(value: unknown): string {
  if (value == null) return "(없음)"
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function ChangeItemDetailModal({
  row,
  onClose,
}: {
  row: ChangeItemRow | null
  onClose: () => void
}) {
  const open = row != null

  function handleOpenChange(next: boolean) {
    if (!next) onClose()
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-4xl sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>ChangeItem 상세</DialogTitle>
          <DialogDescription>
            before 는 변경 전, after 는 변경 후 (또는 변경 시도) 스냅샷입니다.
            롤백 ChangeBatch 의 항목은 before / after 가 뒤바뀌어 적재됩니다.
          </DialogDescription>
        </DialogHeader>

        {row != null ? (
          <div className="flex flex-col gap-4">
            {/* 메타 */}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
              <Meta label="ID" value={row.id} mono />
              <Meta label="targetType" value={row.targetType} />
              <Meta label="targetId" value={row.targetId ?? "-"} mono />
              <Meta label="status" value={row.status} />
              <Meta label="attempt" value={String(row.attempt)} />
              <Meta
                label="idempotencyKey"
                value={row.idempotencyKey}
                mono
              />
              {row.error ? (
                <div className="col-span-2 mt-1 flex flex-col gap-1 rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5">
                  <span className="text-[10px] font-medium uppercase text-destructive">
                    error
                  </span>
                  <span className="font-mono text-[11px] break-words text-destructive">
                    {row.error}
                  </span>
                </div>
              ) : null}
            </dl>

            {/* before / after */}
            <div className="grid gap-3 lg:grid-cols-2">
              <JsonPanel title="before" value={row.before} />
              <JsonPanel title="after" value={row.after} />
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            닫기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Meta({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd
        className={
          mono
            ? "min-w-0 flex-1 truncate font-mono text-[11px]"
            : "min-w-0 flex-1 truncate"
        }
      >
        {value}
      </dd>
    </div>
  )
}

function JsonPanel({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      <pre className="max-h-96 overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
        {prettyJson(value)}
      </pre>
    </div>
  )
}
