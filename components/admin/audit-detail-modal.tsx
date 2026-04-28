"use client"

/**
 * 감사 로그 상세 모달 (F-1.7)
 *
 * 표시:
 *   - 메타: ts / userDisplayName / userId / action / targetType / targetId
 *   - before / after JSON pretty (좌우 분할 — 좁은 화면에서는 상하 스택)
 *
 * 보안:
 *   - 시크릿 컬럼은 적재 단계(`lib/audit/log.ts` sanitize) 에서 이미 마스킹됨.
 *     본 모달은 raw 그대로 표시.
 *
 * 동작:
 *   - row=null 이면 닫힘 상태. row 가 들어오면 자동으로 열림.
 *   - 닫기는 onClose 로 부모 상태(detailRow) 를 null 로 리셋.
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
import type { AuditLogRow } from "@/app/admin/audit/actions"

function formatDateTime(iso: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso))
}

function prettyJson(value: unknown): string {
  if (value == null) return "(없음)"
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function AuditDetailModal({
  row,
  onClose,
}: {
  row: AuditLogRow | null
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
          <DialogTitle>감사 로그 상세</DialogTitle>
          <DialogDescription>
            before / after 는 JSON 스냅샷입니다. 시크릿 필드는 적재 단계에서
            마스킹되어 노출됩니다.
          </DialogDescription>
        </DialogHeader>

        {row != null ? (
          <div className="flex flex-col gap-4">
            {/* 메타 */}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
              <Meta label="ID" value={row.id} mono />
              <Meta label="시각" value={formatDateTime(row.ts)} />
              <Meta
                label="사용자"
                value={
                  row.userDisplayName ??
                  (row.userId ? "(삭제됨)" : "(시스템)")
                }
              />
              <Meta
                label="userId"
                value={row.userId ?? "-"}
                mono
              />
              <Meta label="action" value={row.action} mono />
              <Meta label="targetType" value={row.targetType} />
              <Meta label="targetId" value={row.targetId ?? "-"} mono />
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
