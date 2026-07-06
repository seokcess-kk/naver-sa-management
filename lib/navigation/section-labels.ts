/**
 * 광고주 섹션 화면의 표준 라벨 — 단일 진실 원천 (single source of truth).
 *
 * 같은 화면이 nav(dashboard-section-nav) / quick-nav(quick-nav-card) /
 * 각 페이지의 PageHeader `title`·`breadcrumb` 에서 서로 다른 이름으로 표기되어
 * 인지부하가 컸다. 아래 맵을 모든 표기 지점이 참조하도록 통일한다.
 *
 * key = `/[advertiserId]/{segment}` 경로의 마지막 조각 (root 대시보드는 "dashboard").
 *
 * 알림(alert) 관련 화면은 별도 Worker 담당 — 본 맵에 포함하지 않는다.
 */
export const SECTION_LABELS = {
  dashboard: "대시보드",
  // 광고 구조
  campaigns: "캠페인",
  adgroups: "광고그룹",
  keywords: "키워드",
  ads: "소재",
  extensions: "확장소재",
  // 비딩
  "bid-inbox": "운영 Inbox",
  targeting: "타게팅",
  // 분석
  "marginal-utility": "한계효용",
  "search-term-import": "검색어 분석",
  // 승인
  "approval-queue": "승인 대기",
} as const

export type SectionSegment = keyof typeof SECTION_LABELS
