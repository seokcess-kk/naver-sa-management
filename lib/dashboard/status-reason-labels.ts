/**
 * 네이버 SA statusReason 영문 코드 → 한글 라벨 매핑.
 *
 * SA API 응답의 statusReason 은 영문 enum 코드 (예: CAMPAIGN_PAUSED, GROUP_PAUSED).
 * 네이버 광고 운영 UI 에서는 이것을 한글로 풀어 표시 ("캠페인 OFF", "그룹 OFF" 등).
 * 본 매핑은 운영자가 익숙한 한글 표기를 유지하기 위함.
 *
 * 정책:
 *   - 매핑 안 된 코드는 영문 코드 그대로 노출 (운영자가 raw 가치 확인 가능).
 *   - 코드는 점진 추가. 새 사유 발견 시 본 객체에 한 줄씩 추가.
 *
 * 출처:
 *   - lib/sync/runners.ts 가 raw → statusReason 컬럼으로 저장.
 *   - 운영 중 발견된 코드: CAMPAIGN_PAUSED / GROUP_PAUSED / KEYWORD_PAUSED.
 *   - 그 외 알려진 코드 (네이버 SA 광고 운영 화면 표기 기준):
 *     예산 도달 / 시간 외 / 비즈머니 부족 / 검수 / 삭제 등.
 */

const STATUS_REASON_LABELS: Record<string, string> = {
  // 일시중지 (사용자 / 시스템 OFF)
  CAMPAIGN_PAUSED: "캠페인 OFF",
  ADGROUP_PAUSED: "그룹 OFF",
  GROUP_PAUSED: "그룹 OFF",
  KEYWORD_PAUSED: "키워드 OFF",
  AD_PAUSED: "소재 OFF",

  // 예산 도달 — 실제 SA 응답 코드는 *_LIMITED_BY_BUDGET 계열.
  // (*_BUDGET_REACHED 는 다른 광고주 응답에서 등장할 가능성 대비 유지.)
  CAMPAIGN_LIMITED_BY_BUDGET: "캠페인 예산 도달",
  ADGROUP_LIMITED_BY_BUDGET: "그룹 예산 도달",
  GROUP_LIMITED_BY_BUDGET: "그룹 예산 도달",
  AD_LIMITED_BY_BUDGET: "소재 예산 도달",
  CAMPAIGN_BUDGET_REACHED: "캠페인 예산 도달",
  ADGROUP_BUDGET_REACHED: "그룹 예산 도달",
  GROUP_BUDGET_REACHED: "그룹 예산 도달",
  OUT_OF_BUDGET: "예산 도달",

  // 검수 거절 — 실제 SA 응답 코드는 *_DISAPPROVED 계열.
  // (*_NOT_ELIGIBLE 와는 다른 의미 — DISAPPROVED 는 명시적 검수 거절)
  CAMPAIGN_DISAPPROVED: "캠페인 비승인",
  ADGROUP_DISAPPROVED: "그룹 비승인",
  GROUP_DISAPPROVED: "그룹 비승인",
  KEYWORD_DISAPPROVED: "키워드 비승인",
  AD_DISAPPROVED: "소재 비승인",

  // 정상 노출 — status='on' 일 때만 등장. 배지 컴포넌트가 ON 행은 사유 숨김이라 표시되지 않으나,
  // fallback 정책상 영문 노출 회피 위해 라벨 매핑.
  ELIGIBLE: "정상 노출",

  // 시간 / 비즈머니
  CAMPAIGN_OUT_OF_TIME: "캠페인 시간 외",
  ADGROUP_OUT_OF_TIME: "그룹 시간 외",
  LOW_BIZMONEY: "비즈머니 부족",
  NO_BIZMONEY: "비즈머니 부족",

  // 삭제
  CAMPAIGN_DELETED: "캠페인 삭제",
  ADGROUP_DELETED: "그룹 삭제",
  GROUP_DELETED: "그룹 삭제",
  KEYWORD_DELETED: "키워드 삭제",
  AD_DELETED: "소재 삭제",

  // 검수
  CAMPAIGN_NOT_ELIGIBLE: "캠페인 검수",
  ADGROUP_NOT_ELIGIBLE: "그룹 검수",
  GROUP_NOT_ELIGIBLE: "그룹 검수",
  KEYWORD_NOT_ELIGIBLE: "키워드 검수",
  AD_NOT_ELIGIBLE: "소재 검수",

  // 입찰가
  LOW_BID: "입찰가 낮음",
  KEYWORD_LOW_BID: "입찰가 낮음",

  // 만료 / 차단
  EXPIRED: "만료",
  ABUSING_RESTRICTED: "어뷰징 제한",
}

/**
 * 영문 코드 → 한글 라벨 변환. 매핑 미정 코드는 원본 그대로 반환 (디버깅 가치).
 * null / undefined / 빈 문자열 입력은 null 반환.
 */
export function formatStatusReason(
  code: string | null | undefined,
): string | null {
  if (!code) return null
  return STATUS_REASON_LABELS[code] ?? code
}
