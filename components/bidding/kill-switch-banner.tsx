"use client"

/**
 * Kill Switch 배너 (F-11.6)
 *
 * - enabled === true:
 *   * 빨간 배너 — "🛑 자동 비딩 정지 중"
 *   * 토글 시각 / 토글한 사용자 displayName 표시
 *   * admin 이면 "재개" 버튼 (KillSwitchToggleModal)
 *
 * - enabled === false:
 *   * 회색 작은 안내 카드 — "🟢 자동 비딩 활성"
 *   * admin 이면 "정지" 버튼 (KillSwitchToggleModal)
 *   * operator/viewer 는 상태만 표시 (토글 버튼 X)
 *
 * 위치 결정 (현 PR):
 *   - 비딩 정책 페이지 상단에만 표시. GNB / 광고주 layout 통합은 후속 PR.
 *   - 사유: 본 PR 범위 단순화. 운영 사고 시 즉시 발견하도록 하려면 GNB 통합 권고.
 *
 * SPEC 6.11 F-11.6.
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import { ShieldOffIcon, ShieldCheckIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { KillSwitchToggleModal } from "@/components/bidding/kill-switch-toggle-modal"

export function KillSwitchBanner({
  advertiserId,
  enabled,
  toggledAt,
  toggledByName,
  userRole,
}: {
  advertiserId: string
  enabled: boolean
  /** ISO 시각 (마지막 토글). null = 한 번도 토글된 적 없음. */
  toggledAt: string | null
  /** 마지막 토글한 사용자 displayName. null = 미해상. */
  toggledByName: string | null
  userRole: "admin" | "operator" | "viewer"
}) {
  const router = useRouter()
  const [modalOpen, setModalOpen] = React.useState(false)
  const isAdmin = userRole === "admin"

  if (enabled) {
    // 정지 중 — 빨간 배너
    return (
      <>
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <ShieldOffIcon className="mt-0.5 size-4 text-destructive" />
              <div className="flex flex-col gap-0.5">
                <span className="font-medium text-destructive">
                  자동 비딩 정지 중
                </span>
                <span className="text-xs text-destructive/80">
                  본 광고주의 자동 비딩 cron(F-11.2) / 룰 트리거 / OptimizationRun
                  신규 실행이 모두 차단됩니다.
                </span>
                {toggledAt && (
                  <span className="mt-1 text-[11px] text-muted-foreground">
                    정지 시각: {formatTimestamp(toggledAt)}
                    {toggledByName ? ` · 정지자: ${toggledByName}` : ""}
                  </span>
                )}
              </div>
            </div>
            {isAdmin ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setModalOpen(true)}
              >
                재개
              </Button>
            ) : (
              <span className="text-[11px] text-muted-foreground">
                재개는 관리자 권한 필요
              </span>
            )}
          </div>
        </div>
        <KillSwitchToggleModal
          advertiserId={advertiserId}
          currentEnabled={enabled}
          open={modalOpen}
          onOpenChange={setModalOpen}
          onDone={() => {
            setModalOpen(false)
            router.refresh()
          }}
        />
      </>
    )
  }

  // 활성 (정상) — 회색 카드 + admin 토글 버튼
  return (
    <>
      <div className="rounded-md border bg-muted/30 px-4 py-2 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ShieldCheckIcon className="size-4 text-emerald-600" />
            <span className="font-medium">자동 비딩 활성</span>
            <span className="text-xs text-muted-foreground">
              cron(F-11.2) 매시간 정책을 픽업합니다.
            </span>
            {toggledAt && (
              <span className="text-[11px] text-muted-foreground">
                · 마지막 토글 {formatTimestamp(toggledAt)}
                {toggledByName ? ` · ${toggledByName}` : ""}
              </span>
            )}
          </div>
          {isAdmin && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setModalOpen(true)}
            >
              정지 (Kill Switch)
            </Button>
          )}
        </div>
      </div>
      <KillSwitchToggleModal
        advertiserId={advertiserId}
        currentEnabled={enabled}
        open={modalOpen}
        onOpenChange={setModalOpen}
        onDone={() => {
          setModalOpen(false)
          router.refresh()
        }}
      />
    </>
  )
}

function formatTimestamp(iso: string): string {
  // 단순 로케일 포맷 — YYYY-MM-DD HH:mm 형태.
  try {
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
      d.getDate(),
    )} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch {
    return iso
  }
}
