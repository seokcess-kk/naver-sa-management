/**
 * 네이버 SA 모듈 공유 타입.
 *
 * 모듈별 도메인 스키마는 각 파일 (campaigns.ts / keywords.ts ...) 에 두고,
 * 본 파일은 여러 모듈이 공통으로 쓰는 enum / 타입만.
 */

/**
 * 캐시 kind — `lib/naver-sa/client.ts` request 옵션의 cache.kind.
 *
 * 키 패턴: `nsa:{kind}:{customerId}:{params-hash}`
 *
 * (스킬 표준 패턴 참조)
 */
export type NaverSaCacheKind =
  | "structure" // 광고 구조 GET (campaigns/adgroups/keywords/ads/extensions)
  | "stats:today" // Stats 오늘
  | "stats:past" // Stats 과거
  | "estimate" // Estimate
  | "meta" // customer-links 등 메타

/**
 * HTTP method 화이트리스트.
 * client.request의 method 인자.
 */
export type NaverSaHttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH"
