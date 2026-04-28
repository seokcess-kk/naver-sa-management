/**
 * 광고주 키 상태 배지 (모델 2)
 *
 * - 둘 다 없음: "키 미설정" (amber/warning)
 * - 둘 다 있음: "정상" (emerald)
 * - 한쪽만: "이상" (이론상 발생 X — backend Zod 가 차단)
 *
 * RSC / 클라이언트 양쪽에서 사용 가능 (순수 표현 컴포넌트).
 */

export function KeyStatusBadge({
  hasApiKey,
  hasSecretKey,
}: {
  hasApiKey: boolean
  hasSecretKey: boolean
}) {
  if (!hasApiKey && !hasSecretKey) {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
        키 미설정
      </span>
    )
  }
  if (hasApiKey && hasSecretKey) {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
        정상
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
      이상
    </span>
  )
}
