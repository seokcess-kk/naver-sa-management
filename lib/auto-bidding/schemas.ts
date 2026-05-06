/**
 * BidSuggestion.itemsJson 페이로드 Zod 스키마.
 *
 * scope='adgroup' / 'campaign' 묶음 권고에서 N개 키워드 변경을 표현.
 * 각 원소는 키워드 단위 before/after bid 와 (선택) 사유 코드.
 *
 * 외부 식별자 (nccKeywordId) 는 저장하지 않음 — 적용 시점에 Keyword 모델로 다시 조회.
 * 이유:
 *   1) DB drift (키워드 삭제 / 재발행) 시 itemsJson 안의 nccKeywordId 가 stale 위험
 *   2) 멱등성은 (advertiserId, adgroupId, source, scope, status) 룰로 보장
 *   3) UI 표시 정보는 적용 시점 Keyword 조회로 재조립 (변경 정확성 우선)
 *
 * 스키마는 호출부 (cron 적재 / 적용 액션 / UI 표시) 모두에서 재사용.
 */

import { z } from "zod"

/** BidSuggestion.itemsJson 의 단일 원소 (scope='adgroup'/'campaign' 시 배열로 사용). */
export const BidSuggestionItemSchema = z.object({
  /** 앱 DB Keyword.id (cuid). nccKeywordId 가 아님 — 적용 시점에 재조회. */
  keywordId: z.string().min(1),
  /** 묶음 생성 시점의 currentBid (원). 적용 시점 drift 검사에 사용. */
  beforeBid: z.number().int().min(0),
  /** 권고 입찰가 (원). 0 = 하한 도달 / clamp 결과. */
  afterBid: z.number().int().min(0),
  /** 키워드별 reasonCode (묶음 안에서도 미세 차이 표시 시). null/undefined 허용. */
  reason: z.string().optional(),
})

export const BidSuggestionItemsSchema = z
  .array(BidSuggestionItemSchema)
  .min(1)

export type BidSuggestionItem = z.infer<typeof BidSuggestionItemSchema>
export type BidSuggestionItems = z.infer<typeof BidSuggestionItemsSchema>
