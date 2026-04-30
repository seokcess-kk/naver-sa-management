"use client"

/**
 * 마지막 동기화 시각 배지 (F-3.1 외 sync 가능한 모든 페이지에서 재사용)
 *
 * 표시 형식:
 *   - syncedAt === undefined → "동기화 이력 없음" (회색 + 안내)
 *   - 1분 이내                → "방금 전"
 *   - 60분 이내               → "N분 전"        (default 색)
 *   - 60분 ~ 24시간            → "N시간 전"      (amber + "동기화 권장" 부제)
 *   - 24시간 초과             → "N일 전"        (red)
 *
 * 외부 라이브러리 없이 `Intl.RelativeTimeFormat` (한국어) 사용.
 *
 * SSR 한 번 + 클라이언트 1분 간격 자동 갱신:
 *   - SSR 렌더 시점의 "now" 와 클라이언트 hydration 시점의 "now" 가 다르면 hydration mismatch
 *     → 마운트 전(첫 렌더)은 props.syncedAt 만 신뢰, 마운트 후 1분 간격 useEffect 로 강제 재계산
 *
 * 위치: 페이지 헤더 actions 영역 (동기화 버튼 옆) — SyncKeywordsButton 와 함께 묶어서 노출.
 *
 * SPEC 안전장치 7 (광고주별 컨텍스트). 컴포넌트 자체는 광고주 무관 — 호출부가 광고주별 syncedAt 만 전달.
 */

import * as React from "react"
import { ClockIcon, AlertTriangleIcon } from "lucide-react"

import { cn } from "@/lib/utils"

export type LastSyncBadgeProps = {
  /** ISO timestamp (Advertiser.lastSyncAt[kind]) — undefined 면 동기화 이력 없음 */
  syncedAt: string | undefined
  /** 이 분 초과 시 stale 색상 (default 60분). 60분 → amber, 24*60 → red */
  staleMinutes?: number
  /** 부제 ("동기화 권장") 표시 여부 — default true. 컴팩트 모드에서 false */
  showHint?: boolean
  className?: string
}

type Tone = "none" | "fresh" | "warn" | "danger"

type Computed = {
  tone: Tone
  label: string
  hint?: string
  /** 절대 시각 tooltip (전체 ISO) */
  title?: string
}

/**
 * syncedAt 과 현재 시각 차이를 계산해 표시 텍스트 / tone 반환.
 *
 * 분 단위 음수 / 미래 시각은 "방금 전" 으로 폴백 (시계 차이 안전망).
 */
function computeBadge(
  syncedAt: string | undefined,
  now: number,
  staleMinutes: number,
): Computed {
  if (!syncedAt) {
    return {
      tone: "none",
      label: "동기화 이력 없음",
      hint: "동기화 권장",
    }
  }

  const ts = Date.parse(syncedAt)
  if (Number.isNaN(ts)) {
    return {
      tone: "none",
      label: "동기화 시각 알 수 없음",
    }
  }

  const diffMs = now - ts
  const diffMin = Math.floor(diffMs / 60_000)
  const dayMinutes = 24 * 60

  // 한국어 RelativeTimeFormat — auto 는 "어제"/"오늘" 같은 의미적 표현 사용
  const rtf = new Intl.RelativeTimeFormat("ko", { numeric: "auto" })

  if (diffMin < 1) {
    return {
      tone: "fresh",
      label: "방금 전",
      title: new Date(ts).toLocaleString("ko-KR"),
    }
  }

  if (diffMin < 60) {
    return {
      tone: "fresh",
      label: rtf.format(-diffMin, "minute"),
      title: new Date(ts).toLocaleString("ko-KR"),
    }
  }

  if (diffMin < dayMinutes) {
    const hours = Math.floor(diffMin / 60)
    const tone: Tone = diffMin >= staleMinutes ? "warn" : "fresh"
    return {
      tone,
      label: rtf.format(-hours, "hour"),
      hint: tone === "warn" ? "동기화 권장" : undefined,
      title: new Date(ts).toLocaleString("ko-KR"),
    }
  }

  const days = Math.floor(diffMin / dayMinutes)
  return {
    tone: "danger",
    label: rtf.format(-days, "day"),
    hint: "동기화 권장",
    title: new Date(ts).toLocaleString("ko-KR"),
  }
}

const TONE_STYLES: Record<Tone, string> = {
  none: "bg-gray-100 text-gray-600 border-gray-200",
  fresh: "bg-muted text-muted-foreground border-transparent",
  warn: "bg-amber-100 text-amber-800 border-amber-300",
  danger: "bg-red-100 text-red-800 border-red-300",
}

export function LastSyncBadge({
  syncedAt,
  staleMinutes = 60,
  showHint = true,
  className,
}: LastSyncBadgeProps) {
  // SSR 시점의 "now" — 첫 렌더는 이 값을 사용 (hydration mismatch 방지).
  // 마운트 후 1분 간격으로 클라이언트 now 로 갱신.
  //   - useEffect 본문에서 setState 동기 호출은 cascading render 유발 → 금지 (eslint react-hooks/set-state-in-effect)
  //   - setInterval(.., 60_000) 만으로도 60초 안에 첫 tick 으로 hydration 보정됨
  //   - SSR → hydration 간격은 일반적으로 < 1초 → 분 단위 라벨 불일치 거의 없음
  const [now, setNow] = React.useState<number>(() => Date.now())

  React.useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now())
    }, 60_000)
    return () => clearInterval(id)
  }, [])

  const { tone, label, hint, title } = computeBadge(syncedAt, now, staleMinutes)

  const Icon = tone === "warn" || tone === "danger" ? AlertTriangleIcon : ClockIcon

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        TONE_STYLES[tone],
        className,
      )}
      title={title}
      // 절대 시각 + 부제를 SR 사용자에게 함께 전달
      aria-label={
        title
          ? `마지막 동기화 ${label} (${title})${hint ? ` — ${hint}` : ""}`
          : `마지막 동기화 ${label}${hint ? ` — ${hint}` : ""}`
      }
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="leading-none">마지막 동기화: {label}</span>
      {showHint && hint ? (
        <span className="leading-none text-[10px] opacity-80">· {hint}</span>
      ) : null}
    </span>
  )
}
