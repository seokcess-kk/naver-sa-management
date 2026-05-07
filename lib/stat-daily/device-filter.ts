/**
 * StatDaily 조회 시 device 이중집계 방지 필터 (정책 명문화).
 *
 * 배경:
 *   StatDaily 는 같은 (date, level, refId) 에 대해 두 적재 경로가 공존한다.
 *     - AD_DETAIL TSV collapse  (lib/stat-daily/ingest.ts toUpsertInput)        → device='PC' / 'MOBILE'
 *     - Stats API 보강 적재     (lib/stat-daily/ingest.ts statsRowToUpsertInput) → device='ALL'
 *   schema 의 @@unique([date, level, refId, device]) 가 device 까지 포함하므로
 *   같은 (date, level, refId) 에 PC / MOBILE / ALL 3행이 공존한다.
 *
 *   조회 시 device 필터 없이 _sum / groupBy 하면 (PC + MOBILE) + ALL 로 ~2배 이중집계.
 *   특히 비용/클릭 합산이 부풀어 입찰 권고가 왜곡될 위험 (운영 사고 회복 기록).
 *
 * 정책: 옵션 B — device IN ('PC','MOBILE') 합산 사용
 *   근거:
 *     1) AD_DETAIL collapse 가 메인 적재 경로 (avgRnk 노출가중 평균까지 PC/MOBILE 별 보존).
 *     2) Stats API 보강의 device='ALL' 은 device 차원을 잃은 단일 행 — 보조 데이터.
 *     3) 기존 device 받는 코드 (BiddingPolicy / EstimateCache / TargetingRule /
 *        marginal-actions / marginal-utility) 가 모두 PC / MOBILE 로 분기 — 옵션 B 가 일관.
 *     4) 옵션 A (device='ALL' 단일) 채택 시 AD_DETAIL collapse 의 avgRnk 노출가중
 *        정밀도가 사라지고, ALL 미적재 광고주 (보강 단계 실패) 데이터 0 이 되는 위험.
 *
 *   적용 범위: StatDaily 의 _sum / groupBy / aggregate / findMany 전부.
 *   비대상: 단건 unique 조회 (date_level_refId_device 키 사용 시).
 */

import { StatDevice } from "@/lib/generated/prisma/enums"
import type { Prisma } from "@/lib/generated/prisma/client"

/**
 * Prisma where 절에 그대로 spread 할 수 있는 device 필터.
 *
 * Prisma 의 `in` 필드는 mutable array (`StatDevice[]`) 를 요구하므로 `as const` 미사용.
 * StatDailyWhereInput 호환 명시 — spread 후 type narrowing 이 깨지지 않도록 보장.
 *
 * 사용 예:
 *   prisma.statDaily.groupBy({
 *     where: { advertiserId, level: "keyword", date: { gte: since }, ...STAT_DAILY_DEVICE_FILTER },
 *     ...
 *   })
 */
export const STAT_DAILY_DEVICE_FILTER: Pick<Prisma.StatDailyWhereInput, "device"> = {
  device: { in: [StatDevice.PC, StatDevice.MOBILE] },
}
