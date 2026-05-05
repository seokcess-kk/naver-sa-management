/**
 * 광고그룹 userLock 추출 헬퍼.
 *
 * 'use server' 모듈에서 export 시 async 강제 — 본 동기 헬퍼는 lib 로 분리.
 *
 * SPEC: F-6.4 롤백 정확도 / SPEC 9 / 5.4.
 */

import type { AdGroupStatus } from "@/lib/generated/prisma/client"

/**
 * SA 응답(`raw`)에서 명시적인 `userLock` boolean 을 추출. 없으면 `status==='off'` 단순화 폴백.
 *
 * 배경 (F-6.4 롤백 정확도):
 *   - 앱 DB `AdGroup.status` 는 enum(on/off/deleted) 으로 단순화됨.
 *   - SA 의 실제 비활성 상태는 두 축이 분리:
 *       a) `userLock=true` (사용자 명시 OFF 토글)
 *       b) `status='PAUSED'` (시스템 정지: 검수반려 / 예산소진 / 캠페인 OFF 상속 등)
 *   - 둘 모두 앱 DB 에서는 `status='off'` 로 흡수되어 둘을 구분 못 함.
 *   - 토글 액션의 ChangeItem.before 가 `userLock: dbG.status === "off"` 로 적히면,
 *     실제로 PAUSED 인데 userLock=false 인 광고그룹의 before 가 잘못 `true` 로 기록됨.
 *   - F-6.4 롤백 시 잘못된 before 로 복원 시도 → drift / 무의미한 SA 호출.
 *
 * 해결:
 *   - `raw` 가 SA 응답이면 `raw.userLock` 을 신뢰 (최신 sync 시점 사실).
 *   - `raw` 없거나 `userLock` 필드 없으면 폴백 (기존 단순화 표현식).
 *
 * 폴백이 발생해도 F-6.4 롤백은 "현재 상태 재검증 필수" 원칙이라 drift 감지 후 사용자 선택 흐름 진입.
 * 본 헬퍼는 before 정확도를 1단계 끌어올리는 1차 개선.
 */
export function extractActualUserLock(snap: {
  status: AdGroupStatus
  raw: unknown
}): boolean {
  if (snap.raw && typeof snap.raw === "object" && !Array.isArray(snap.raw)) {
    const raw = snap.raw as Record<string, unknown>
    if (typeof raw.userLock === "boolean") {
      return raw.userLock
    }
  }
  return snap.status === "off"
}
