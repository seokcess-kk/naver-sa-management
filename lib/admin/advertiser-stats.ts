/**
 * 광고주별 광고 구조 카운트 헬퍼 (admin 화면 전용)
 *
 * UI:
 *   - app/admin/advertisers (목록): 카운트 5종을 행마다 표시
 *   - app/admin/advertisers/[id] (상세): 단건 카운트
 *
 * 동작:
 *   - status='deleted' 제외 (UI 표시 가능 항목만 — on/off 합산)
 *   - 5개 모델(Campaign/AdGroup/Keyword/Ad/AdExtension)의 advertiserId 별 count
 *   - AdGroup/Keyword/Ad/AdExtension은 advertiserId 컬럼이 없어 Campaign join 필요
 *     → raw SQL 5개를 Promise.all 병렬 (네트워크 RTT 1회 묶음)
 *
 * 권한:
 *   - 본 헬퍼는 권한 검사 안 함. admin 가드 통과 후에 호출 (호출부 책임)
 *   - 광고주 격리는 호출부가 advertiserIds로 한정
 *
 * 성능:
 *   - 광고주 100개 이내 가정 (admin 화면 — 페이지네이션 후속)
 *   - bigint → Number 변환 (Postgres COUNT(*)는 bigint)
 */

import { prisma } from "@/lib/db/prisma"

export type AdvertiserStructureStats = {
  advertiserId: string
  campaigns: number
  adgroups: number
  keywords: number
  ads: number
  extensions: number
}

type CountRow = { advertiserId: string; count: bigint }

const EMPTY_STATS = (advertiserId: string): AdvertiserStructureStats => ({
  advertiserId,
  campaigns: 0,
  adgroups: 0,
  keywords: 0,
  ads: 0,
  extensions: 0,
})

function rowsToMap(rows: CountRow[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const row of rows) {
    map.set(row.advertiserId, Number(row.count))
  }
  return map
}

/**
 * 광고주 N개에 대한 광고 구조 카운트를 한 번에 조회.
 *
 * @param advertiserIds 광고주 ID 배열. 빈 배열은 빈 Map 반환 (DB query 생략).
 * @returns advertiserId → AdvertiserStructureStats Map.
 *          입력에 있던 모든 ID는 Map에 존재 (카운트 0이어도 entry 보장).
 */
export async function getAdvertiserStructureStats(
  advertiserIds: string[],
): Promise<Map<string, AdvertiserStructureStats>> {
  const map = new Map<string, AdvertiserStructureStats>()
  if (advertiserIds.length === 0) return map

  // 중복 제거 (호출부 실수 방어)
  const ids = Array.from(new Set(advertiserIds))

  // 5개 query 병렬. raw SQL — enum 비교는 ::text 캐스팅으로 명확히.
  // Campaign은 advertiserId 직접 보유. 나머지 4개는 Campaign join.
  const [campaignRows, adgroupRows, keywordRows, adRows, extensionRows] =
    await Promise.all([
      prisma.$queryRaw<CountRow[]>`
        SELECT c."advertiserId" AS "advertiserId", COUNT(*)::bigint AS count
        FROM "Campaign" c
        WHERE c."advertiserId" = ANY(${ids}::text[])
          AND c."status"::text <> 'deleted'
        GROUP BY c."advertiserId"
      `,
      prisma.$queryRaw<CountRow[]>`
        SELECT c."advertiserId" AS "advertiserId", COUNT(*)::bigint AS count
        FROM "AdGroup" ag
        JOIN "Campaign" c ON c."id" = ag."campaignId"
        WHERE c."advertiserId" = ANY(${ids}::text[])
          AND ag."status"::text <> 'deleted'
        GROUP BY c."advertiserId"
      `,
      prisma.$queryRaw<CountRow[]>`
        SELECT c."advertiserId" AS "advertiserId", COUNT(*)::bigint AS count
        FROM "Keyword" k
        JOIN "AdGroup" ag ON ag."id" = k."adgroupId"
        JOIN "Campaign" c ON c."id" = ag."campaignId"
        WHERE c."advertiserId" = ANY(${ids}::text[])
          AND k."status"::text <> 'deleted'
        GROUP BY c."advertiserId"
      `,
      prisma.$queryRaw<CountRow[]>`
        SELECT c."advertiserId" AS "advertiserId", COUNT(*)::bigint AS count
        FROM "Ad" a
        JOIN "AdGroup" ag ON ag."id" = a."adgroupId"
        JOIN "Campaign" c ON c."id" = ag."campaignId"
        WHERE c."advertiserId" = ANY(${ids}::text[])
          AND a."status"::text <> 'deleted'
        GROUP BY c."advertiserId"
      `,
      // AdExtension.ownerId == AdGroup.id (P1: ownerType=adgroup 가정 — schema.prisma 주석)
      prisma.$queryRaw<CountRow[]>`
        SELECT c."advertiserId" AS "advertiserId", COUNT(*)::bigint AS count
        FROM "AdExtension" e
        JOIN "AdGroup" ag ON ag."id" = e."ownerId"
        JOIN "Campaign" c ON c."id" = ag."campaignId"
        WHERE c."advertiserId" = ANY(${ids}::text[])
          AND e."ownerType" = 'adgroup'
          AND e."status"::text <> 'deleted'
        GROUP BY c."advertiserId"
      `,
    ])

  const campaignsCount = rowsToMap(campaignRows)
  const adgroupsCount = rowsToMap(adgroupRows)
  const keywordsCount = rowsToMap(keywordRows)
  const adsCount = rowsToMap(adRows)
  const extensionsCount = rowsToMap(extensionRows)

  for (const id of ids) {
    map.set(id, {
      advertiserId: id,
      campaigns: campaignsCount.get(id) ?? 0,
      adgroups: adgroupsCount.get(id) ?? 0,
      keywords: keywordsCount.get(id) ?? 0,
      ads: adsCount.get(id) ?? 0,
      extensions: extensionsCount.get(id) ?? 0,
    })
  }

  return map
}

/**
 * 단건 편의 헬퍼.
 *
 * 광고주가 존재하지 않거나 카운트가 모두 0이어도 0으로 채운 객체 반환.
 */
export async function getAdvertiserStructureStat(
  advertiserId: string,
): Promise<AdvertiserStructureStats> {
  const map = await getAdvertiserStructureStats([advertiserId])
  return map.get(advertiserId) ?? EMPTY_STATS(advertiserId)
}
