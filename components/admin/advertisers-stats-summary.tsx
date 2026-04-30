/**
 * 광고주 목록 통계 hero — RSC 집계 결과를 받아 표시만.
 *
 * 4개 작은 Card 가로 배치(md+ grid-cols-4 / sm grid-cols-2):
 *   - 전체   : status='active' + 'paused' 합산 (status='archived' 는 RSC 단계에서 이미 제외)
 *   - 활성   : status='active'
 *   - 일시중지: status='paused'
 *   - 키 미설정: hasApiKey=false || hasSecretKey=false
 *
 * 순수 표현 컴포넌트 — 인터랙션 없으므로 'use client' 미부여.
 */

import {
  Building2Icon,
  CheckCircle2Icon,
  PauseCircleIcon,
  KeyRoundIcon,
} from "lucide-react"

const NUMBER_FMT = new Intl.NumberFormat("ko-KR")

type Item = {
  label: string
  value: number
  icon: React.ReactNode
  tone: "default" | "emerald" | "amber" | "rose"
}

const TONE_CLASSES: Record<Item["tone"], { box: string; icon: string }> = {
  default: {
    box: "bg-card",
    icon: "text-muted-foreground",
  },
  emerald: {
    box: "bg-card",
    icon: "text-emerald-600 dark:text-emerald-400",
  },
  amber: {
    box: "bg-card",
    icon: "text-amber-600 dark:text-amber-400",
  },
  rose: {
    box: "bg-card",
    icon: "text-rose-600 dark:text-rose-400",
  },
}

export type AdvertisersStatsSummaryProps = {
  total: number
  active: number
  paused: number
  missingKey: number
}

export function AdvertisersStatsSummary({
  total,
  active,
  paused,
  missingKey,
}: AdvertisersStatsSummaryProps) {
  const items: Item[] = [
    {
      label: "전체",
      value: total,
      icon: <Building2Icon className="size-4" />,
      tone: "default",
    },
    {
      label: "활성",
      value: active,
      icon: <CheckCircle2Icon className="size-4" />,
      tone: "emerald",
    },
    {
      label: "일시중지",
      value: paused,
      icon: <PauseCircleIcon className="size-4" />,
      tone: "amber",
    },
    {
      label: "키 미설정",
      value: missingKey,
      icon: <KeyRoundIcon className="size-4" />,
      tone: "rose",
    },
  ]

  return (
    <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
      {items.map((it) => {
        const tone = TONE_CLASSES[it.tone]
        return (
          <div
            key={it.label}
            className={`flex items-center justify-between rounded-xl border ${tone.box} px-4 py-3 ring-1 ring-foreground/10`}
          >
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{it.label}</p>
              <p className="font-heading mt-1 text-2xl font-semibold tabular-nums leading-none">
                {NUMBER_FMT.format(it.value)}
              </p>
            </div>
            <span
              className={`flex size-9 items-center justify-center rounded-full bg-muted ${tone.icon}`}
              aria-hidden
            >
              {it.icon}
            </span>
          </div>
        )
      })}
    </div>
  )
}
