/**
 * 확장소재 타입 배지 (F-5.x)
 *
 * Prisma AdExtensionType enum 값을 한국어 라벨 + 색으로 표시.
 *
 * 표시 규칙 (P1 텍스트 2종 화이트리스트):
 *   - "headline"    → "추가제목" (sky/blue 톤)
 *   - "description" → "추가설명" (violet 톤)
 *   - 그 외          → 원본 문자열 (zinc 폴백)
 *
 * 본 PR(텍스트 2종) 외 타입(image/sublink/...)은 후속 PR 진입 시 enum 추가 후
 * 본 컴포넌트에 분기 추가.
 *
 * 순수 표현 컴포넌트. RSC / 클라이언트 양쪽에서 사용 가능.
 *
 * SPEC 6.2 F-5.x.
 */

import { cn } from "@/lib/utils"

export function ExtensionTypeBadge({ type }: { type: string }) {
  if (type === "headline") {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
          "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300",
        )}
      >
        추가제목
      </span>
    )
  }
  if (type === "description") {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
          "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
        )}
      >
        추가설명
      </span>
    )
  }
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-300",
      )}
    >
      {type}
    </span>
  )
}
