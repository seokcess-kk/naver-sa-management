/**
 * Sync Runner — 권한 검증 없는 광고주 단위 동기화 (cron 전용)
 *
 * 책임:
 *   - 광고주 1명에 대해 5단계 sync (campaigns → adgroups → keywords → ads → extensions)
 *     를 직렬 실행하는 cron 친화 헬퍼.
 *   - 사용자 권한 / Supabase Auth / revalidatePath / AuditLog 미사용 (cron 컨텍스트).
 *   - 각 단계 끝에서 lastSyncAt 갱신 (recordSyncAt) 으로 UI 표시 일관성 유지.
 *
 * 비대상:
 *   - Server Action 진입부 검증 (getCurrentAdvertiser) — cron 은 service_role 컨텍스트
 *   - revalidatePath — Next.js 캐시 무효화 (cron 은 RSC 라우트 외부 실행)
 *   - AuditLog — cron 은 응답 + Sentry 로 운영 메트릭 기록
 *
 * SA 호출 흐름 / 매핑 정책은 기존 sync action (app/(dashboard)/[advertiserId]/{kind}/actions.ts)
 * 과 동일. 매핑 함수는 lib/sync/mappers.ts 에서 공유.
 *
 * 광고주 직렬 처리 패턴 (상위 cron route):
 *   for (광고주) {
 *     try {
 *       await runAdvertiserSyncAll(advertiserId, customerId)
 *       advertisersOk++
 *     } catch (e) {
 *       advertisersFailed++
 *       errors.push({ advertiserId, message })
 *     }
 *   }
 *
 * 시간 한계:
 *   - 광고주당 ~30~60초 가정 (광고그룹 200개 × type 2종 ≈ 400회 SA 호출 / Rate Limit 토큰버킷).
 *   - Vercel Pro 함수 한도 900s → 광고주 N <= ~13명 안전선.
 *   - 한계 부딪히면 광고주별 별도 cron 분배 또는 ChangeBatch 패턴(SPEC 3.5) 이관.
 */

import { prisma } from "@/lib/db/prisma"

import { listAdgroups, type AdGroup as SaAdGroup } from "@/lib/naver-sa/adgroups"
import { listAds, type Ad as SaAd } from "@/lib/naver-sa/ads"
import {
  listAdExtensions,
  type AdExtension as SaAdExtension,
  type AdExtensionType as SaAdExtensionType,
} from "@/lib/naver-sa/ad-extensions"
import {
  listCampaigns,
  type Campaign as SaCampaign,
} from "@/lib/naver-sa/campaigns"
import { NaverSaError } from "@/lib/naver-sa/errors"
import { listKeywords, type Keyword as SaKeyword } from "@/lib/naver-sa/keywords"

import type {
  AdExtensionStatus,
  AdExtensionType,
  AdStatus,
  InspectStatus,
  KeywordStatus,
} from "@/lib/generated/prisma/client"
import type * as Prisma from "@/lib/generated/prisma/internal/prismaNamespace"

import { recordSyncAt } from "@/lib/sync/last-sync-at"
import { buildAdFields, extractAdType } from "@/lib/sync/ad-fields"
import {
  mapAdGroupStatus,
  mapAdStatus,
  mapCampaignStatus,
  mapExtensionStatus,
  mapInspectStatus,
  mapKeywordStatus,
} from "@/lib/sync/mappers"

// =============================================================================
// 헬퍼 — 품질지수 추출
// =============================================================================

/**
 * 네이버 응답의 nccQi 필드에서 품질지수(1~7)를 추출.
 *
 * 응답 shape 변동 가능 (Java/Python 샘플 / 실 응답에서 다음 패턴 관찰):
 *   - number 직접 (예: 5)
 *   - { qiGrade: number } / { qualityScore: number } / { qScoreEstm: number } / { score: number }
 *
 * 추출 실패 또는 1~7 범위 밖 → null. 호출자가 update 컬럼 미포함 처리(기존 값 보존).
 *
 * Phase A.3 — 응답 미포함 광고주는 qualityScore 미적재(null)가 정상.
 */
export function extractQualityScore(nccQi: unknown): number | null {
  if (typeof nccQi === "number") {
    return clampQualityScore(nccQi)
  }
  if (nccQi !== null && typeof nccQi === "object") {
    const obj = nccQi as Record<string, unknown>
    const candidate =
      obj.qiGrade ?? obj.qualityScore ?? obj.qScoreEstm ?? obj.score
    if (typeof candidate === "number") {
      return clampQualityScore(candidate)
    }
  }
  return null
}

function clampQualityScore(n: number): number | null {
  if (!Number.isFinite(n)) return null
  const i = Math.round(n)
  // 네이버 SA 품질지수는 1~7 막대 (공식 기준). 범위 밖은 응답 오류로 간주 → null.
  if (i < 1 || i > 7) return null
  return i
}

// =============================================================================
// 결과 타입
// =============================================================================

export type AdvertiserSyncResult = {
  advertiserId: string
  customerId: string
  campaigns: { synced: number }
  adgroups: { synced: number; skipped: number }
  keywords: {
    syncedKeywords: number
    scannedAdgroups: number
    skipped: number
  }
  ads: { syncedAds: number; scannedAdgroups: number; skipped: number }
  extensions: {
    synced: number
    scannedAdgroups: number
    skipped: number
    unsupportedAdgroupTypes: number
  }
}

/**
 * 옵션 — 4개 runner 공통 시그니처(부분 동기화).
 *
 * - `campaignIds` : 캠페인 화이트리스트(앱 DB Campaign.id). 미지정 시 광고주 전체.
 *                   cron 친화 헬퍼라 시그니처 통일 — 현 시점 cron 진입점은 미지정 호출만 사용.
 *
 * 적용 runner: runAdgroupsSync / runKeywordsSync / runAdsSync / runExtensionsSync.
 *   - runCampaignsSync 는 캠페인 자체를 가져오는 단계라 의미 없음 → 옵션 미적용.
 *
 * BC 메모: `ExtensionsSyncOptions` alias 는 기존 호출부(extensions 한정) 호환용으로 유지.
 */
export type SyncOptions = {
  campaignIds?: string[]
}

/**
 * @deprecated `SyncOptions` 사용 (4개 runner 공통). 본 alias 는 기존 호출부 호환용.
 */
export type ExtensionsSyncOptions = SyncOptions

/**
 * 네이버 SA 가 "이 광고그룹은 이 확장소재 type 미지원" 을 알리는 응답 패턴 판별.
 * extensions/actions.ts 와 동일 정책 — silent skip 으로 부분 실패 카운팅 분리.
 */
function isUnsupportedExtensionTypeError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  return e.message.includes("Cannot handle the request")
}

// =============================================================================
// 광고주 단위 5단계 sync
// =============================================================================

/**
 * 광고주 1명의 5단계 sync 직렬 실행 (cron 진입점).
 *
 * 흐름:
 *   1. campaigns sync   → 캠페인 메타 누적
 *   2. adgroups sync    → campaigns 기반 광고그룹 매핑
 *   3. keywords sync    → adgroups 기반 키워드 (광고그룹 단위 N회 호출)
 *   4. ads sync         → adgroups 기반 소재 (광고그룹 단위 N회 호출)
 *   5. extensions sync  → adgroups 기반 확장소재 (광고그룹 × type 2종)
 *
 * 단계별로 recordSyncAt(advertiserId, kind) 호출 — UI 헤더 배지 점진 갱신.
 *
 * @param advertiserId 앱 DB Advertiser.id (cuid)
 * @param customerId   네이버 광고주 customerId (SA API 호출 X-Customer 헤더)
 * @throws NaverSaError / 일반 Error — 단계별 실패는 throw, 호출부에서 격리
 */
export async function runAdvertiserSyncAll(
  advertiserId: string,
  customerId: string,
): Promise<AdvertiserSyncResult> {
  const campaigns = await runCampaignsSync(advertiserId, customerId)
  const adgroups = await runAdgroupsSync(advertiserId, customerId)
  const keywords = await runKeywordsSync(advertiserId, customerId)
  const ads = await runAdsSync(advertiserId, customerId)
  const extensions = await runExtensionsSync(advertiserId, customerId)

  return {
    advertiserId,
    customerId,
    campaigns,
    adgroups,
    keywords,
    ads,
    extensions,
  }
}

// =============================================================================
// 1) campaigns
// =============================================================================

async function runCampaignsSync(
  advertiserId: string,
  customerId: string,
): Promise<{ synced: number }> {
  const remote: SaCampaign[] = await listCampaigns(customerId)

  for (const c of remote) {
    const mappedStatus = mapCampaignStatus(c)
    const dailyBudgetVal =
      typeof c.dailyBudget === "number" ? c.dailyBudget : null
    const rawJson = c as unknown as Prisma.InputJsonValue

    await prisma.campaign.upsert({
      where: { nccCampaignId: c.nccCampaignId },
      create: {
        advertiserId,
        nccCampaignId: c.nccCampaignId,
        name: c.name,
        campaignType: c.campaignTp ?? null,
        dailyBudget: dailyBudgetVal,
        status: mappedStatus,
        raw: rawJson,
      },
      update: {
        name: c.name,
        campaignType: c.campaignTp ?? null,
        dailyBudget: dailyBudgetVal,
        status: mappedStatus,
        raw: rawJson,
      },
    })
  }

  await recordSyncAt(advertiserId, "campaigns")
  return { synced: remote.length }
}

// =============================================================================
// 2) adgroups
// =============================================================================

async function runAdgroupsSync(
  advertiserId: string,
  customerId: string,
  options: SyncOptions = {},
): Promise<{ synced: number; skipped: number }> {
  const { campaignIds } = options
  const hasCampaignFilter =
    Array.isArray(campaignIds) && campaignIds.length > 0

  // campaignIds 미지정 → 광고주 전체. 지정 → 화이트리스트 캠페인만 매핑.
  // 응답에 화이트리스트 외 캠페인 광고그룹이 섞여 있으면 skip (카운트 X — 무관 행).
  const campaigns = await prisma.campaign.findMany({
    where: {
      advertiserId,
      ...(hasCampaignFilter ? { id: { in: campaignIds } } : {}),
    },
    select: { id: true, nccCampaignId: true },
  })
  const campaignIdByNcc = new Map<string, string>(
    campaigns.map((c) => [c.nccCampaignId, c.id]),
  )

  const remote: SaAdGroup[] = await listAdgroups(customerId)

  let synced = 0
  let skipped = 0

  for (const g of remote) {
    const dbCampaignId = campaignIdByNcc.get(g.nccCampaignId)
    if (!dbCampaignId) {
      skipped++
      continue
    }

    const mappedStatus = mapAdGroupStatus(g)
    const bidAmtVal = typeof g.bidAmt === "number" ? g.bidAmt : null
    const dailyBudgetVal =
      typeof g.dailyBudget === "number" ? g.dailyBudget : null

    const anyG = g as unknown as {
      pcChannelKey?: string
      mobileChannelKey?: string
      pcChannelOn?: boolean
      mblChannelOn?: boolean
    }
    const pcChannelOn =
      typeof anyG.pcChannelOn === "boolean"
        ? anyG.pcChannelOn
        : typeof anyG.pcChannelKey === "string"
          ? anyG.pcChannelKey.length > 0
          : true
    const mblChannelOn =
      typeof anyG.mblChannelOn === "boolean"
        ? anyG.mblChannelOn
        : typeof anyG.mobileChannelKey === "string"
          ? anyG.mobileChannelKey.length > 0
          : true

    const rawJson = g as unknown as Prisma.InputJsonValue

    await prisma.adGroup.upsert({
      where: { nccAdgroupId: g.nccAdgroupId },
      create: {
        campaignId: dbCampaignId,
        nccAdgroupId: g.nccAdgroupId,
        name: g.name,
        bidAmt: bidAmtVal,
        dailyBudget: dailyBudgetVal,
        pcChannelOn,
        mblChannelOn,
        status: mappedStatus,
        raw: rawJson,
      },
      update: {
        campaignId: dbCampaignId,
        name: g.name,
        bidAmt: bidAmtVal,
        dailyBudget: dailyBudgetVal,
        pcChannelOn,
        mblChannelOn,
        status: mappedStatus,
        raw: rawJson,
      },
    })
    synced++
  }

  // 캠페인 필터 적용된 부분 동기화는 광고주 전체 sync 가 아니므로 lastSyncAt 갱신 X.
  if (!hasCampaignFilter) {
    await recordSyncAt(advertiserId, "adgroups")
  }
  return { synced, skipped }
}

// =============================================================================
// 3) keywords (광고그룹 단위 N회 호출, 부분 실패 허용)
// =============================================================================

async function runKeywordsSync(
  advertiserId: string,
  customerId: string,
  options: SyncOptions = {},
): Promise<{
  syncedKeywords: number
  scannedAdgroups: number
  skipped: number
}> {
  const { campaignIds } = options
  const hasCampaignFilter =
    Array.isArray(campaignIds) && campaignIds.length > 0

  const adgroups = await prisma.adGroup.findMany({
    where: {
      campaign: {
        advertiserId,
        ...(hasCampaignFilter ? { id: { in: campaignIds } } : {}),
      },
    },
    select: { id: true, nccAdgroupId: true },
  })

  if (adgroups.length === 0) {
    if (!hasCampaignFilter) {
      await recordSyncAt(advertiserId, "keywords")
    }
    return { syncedKeywords: 0, scannedAdgroups: 0, skipped: 0 }
  }

  const adgroupIdMap = new Map<string, string>(
    adgroups.map((g) => [g.nccAdgroupId, g.id]),
  )

  let syncedKeywords = 0
  let skipped = 0
  let scannedAdgroups = 0

  // 광고그룹 chunk 5 병렬화 (Rate Limit 토큰 버킷이 광고주별 큐잉 → 자동 wait).
  // N=50 기준 기존 순차 ~15초 → ~3초 수준 (약 5배 단축).
  const CHUNK_SIZE = 5

  for (let i = 0; i < adgroups.length; i += CHUNK_SIZE) {
    const slice = adgroups.slice(i, i + CHUNK_SIZE)
    const settled = await Promise.allSettled(
      slice.map((ag) =>
        listKeywords(customerId, { nccAdgroupId: ag.nccAdgroupId }),
      ),
    )

    for (let j = 0; j < slice.length; j++) {
      const ag = slice[j]
      const r = settled[j]
      if (r.status === "rejected") {
        // 단일 광고그룹 실패는 부분 실패 — 다른 광고그룹은 계속.
        const e = r.reason
        if (e instanceof NaverSaError) {
          console.warn(
            `[runKeywordsSync] listKeywords failed for nccAdgroupId=${ag.nccAdgroupId}: ${e.message}`,
          )
        } else {
          console.warn(
            `[runKeywordsSync] listKeywords unknown error for nccAdgroupId=${ag.nccAdgroupId}:`,
            e,
          )
        }
        scannedAdgroups++
        continue
      }
      const remote: SaKeyword[] = r.value

      for (const k of remote) {
        const dbAdgroupId = adgroupIdMap.get(k.nccAdgroupId)
        if (!dbAdgroupId) {
          skipped++
          continue
        }

        const mappedStatus = mapKeywordStatus(k)
        const mappedInspect = mapInspectStatus(k)
        const bidAmtVal = typeof k.bidAmt === "number" ? k.bidAmt : null
        const useGroupBidAmtVal =
          typeof k.useGroupBidAmt === "boolean" ? k.useGroupBidAmt : true
        const userLockVal =
          typeof k.userLock === "boolean" ? k.userLock : false

        const anyK = k as unknown as {
          matchType?: string
          recentAvgRnk?: number | string | null
          nccQi?: unknown
        }
        const matchTypeVal =
          typeof anyK.matchType === "string" && anyK.matchType.length > 0
            ? anyK.matchType.toUpperCase()
            : null

        // 품질지수 (qualityScore) — 응답 shape 변동 가능 (nccQi: number | { qiGrade } | { qualityScore } 등)
        // 응답에 추출 가능한 값이 없으면 null → 기존 값 보존(update 시 컬럼 미포함).
        const qualityScoreVal = extractQualityScore(anyK.nccQi)

        const rawJson = k as unknown as Prisma.InputJsonValue

        const baseCreateData = {
          adgroupId: dbAdgroupId,
          nccKeywordId: k.nccKeywordId,
          keyword: k.keyword,
          matchType: matchTypeVal,
          bidAmt: bidAmtVal,
          useGroupBidAmt: useGroupBidAmtVal,
          userLock: userLockVal,
          status: mappedStatus,
          inspectStatus: mappedInspect,
          raw: rawJson,
          qualityScore: qualityScoreVal,
          qualityScoreUpdatedAt: qualityScoreVal !== null ? new Date() : null,
        }

        const baseUpdateData: {
          adgroupId: string
          keyword: string
          bidAmt: number | null
          useGroupBidAmt: boolean
          userLock: boolean
          status: KeywordStatus
          inspectStatus: InspectStatus
          raw: Prisma.InputJsonValue
          matchType?: string
          qualityScore?: number
          qualityScoreUpdatedAt?: Date
        } = {
          adgroupId: dbAdgroupId,
          keyword: k.keyword,
          bidAmt: bidAmtVal,
          useGroupBidAmt: useGroupBidAmtVal,
          userLock: userLockVal,
          status: mappedStatus,
          inspectStatus: mappedInspect,
          raw: rawJson,
        }
        if (matchTypeVal !== null) {
          baseUpdateData.matchType = matchTypeVal
        }
        // qualityScore 응답 추출 성공 시에만 update — 응답 미포함 시 기존 값 유지.
        if (qualityScoreVal !== null) {
          baseUpdateData.qualityScore = qualityScoreVal
          baseUpdateData.qualityScoreUpdatedAt = new Date()
        }

        await prisma.keyword.upsert({
          where: { nccKeywordId: k.nccKeywordId },
          create: baseCreateData,
          update: baseUpdateData,
        })
        syncedKeywords++
      }

      scannedAdgroups++
    }
  }

  if (!hasCampaignFilter) {
    await recordSyncAt(advertiserId, "keywords")
  }
  return { syncedKeywords, scannedAdgroups, skipped }
}

// =============================================================================
// 4) ads (광고그룹 단위 N회 호출, 부분 실패 허용)
// =============================================================================

async function runAdsSync(
  advertiserId: string,
  customerId: string,
  options: SyncOptions = {},
): Promise<{ syncedAds: number; scannedAdgroups: number; skipped: number }> {
  const { campaignIds } = options
  const hasCampaignFilter =
    Array.isArray(campaignIds) && campaignIds.length > 0

  const adgroups = await prisma.adGroup.findMany({
    where: {
      campaign: {
        advertiserId,
        ...(hasCampaignFilter ? { id: { in: campaignIds } } : {}),
      },
    },
    select: { id: true, nccAdgroupId: true },
  })

  if (adgroups.length === 0) {
    if (!hasCampaignFilter) {
      await recordSyncAt(advertiserId, "ads")
    }
    return { syncedAds: 0, scannedAdgroups: 0, skipped: 0 }
  }

  const adgroupIdMap = new Map<string, string>(
    adgroups.map((g) => [g.nccAdgroupId, g.id]),
  )

  let syncedAds = 0
  let skipped = 0
  let scannedAdgroups = 0

  // 광고그룹 chunk 5 병렬화 (Rate Limit 토큰 버킷이 광고주별 큐잉 → 자동 wait).
  const CHUNK_SIZE = 5

  for (let i = 0; i < adgroups.length; i += CHUNK_SIZE) {
    const slice = adgroups.slice(i, i + CHUNK_SIZE)
    const settled = await Promise.allSettled(
      slice.map((ag) =>
        listAds(customerId, { nccAdgroupId: ag.nccAdgroupId }),
      ),
    )

    for (let j = 0; j < slice.length; j++) {
      const ag = slice[j]
      const r = settled[j]
      if (r.status === "rejected") {
        const e = r.reason
        if (e instanceof NaverSaError) {
          console.warn(
            `[runAdsSync] listAds failed for nccAdgroupId=${ag.nccAdgroupId}: ${e.message}`,
          )
        } else {
          console.warn(
            `[runAdsSync] listAds unknown error for nccAdgroupId=${ag.nccAdgroupId}:`,
            e,
          )
        }
        scannedAdgroups++
        continue
      }
      const remote: SaAd[] = r.value

      for (const a of remote) {
        const dbAdgroupId = adgroupIdMap.get(a.nccAdgroupId)
        if (!dbAdgroupId) {
          skipped++
          continue
        }

        const mappedStatus = mapAdStatus(a)
        const mappedInspect = mapInspectStatus(a)

        // RSA_AD 본문은 a.ad 가 아닌 a.assets 배열에 있어 buildAdFields 가 추출.
        // adType 은 SA 가 type 으로 보낼 수도 있어 extractAdType 폴백.
        const adTypeVal = extractAdType(
          a as unknown as { adType?: string | null; type?: string | null },
        )
        const fieldsRaw = buildAdFields(
          a as unknown as { ad?: unknown; assets?: unknown },
        )
        const fieldsVal =
          fieldsRaw !== null
            ? (fieldsRaw as unknown as Prisma.InputJsonValue)
            : null
        const inspectMemoVal =
          typeof a.inspectMemo === "string" && a.inspectMemo.length > 0
            ? a.inspectMemo
            : null

        const rawJson = a as unknown as Prisma.InputJsonValue

        const baseCreateData: {
          adgroupId: string
          nccAdId: string
          inspectStatus: InspectStatus
          status: AdStatus
          raw: Prisma.InputJsonValue
          adType?: string | null
          fields?: Prisma.InputJsonValue
          inspectMemo?: string
        } = {
          adgroupId: dbAdgroupId,
          nccAdId: a.nccAdId,
          adType: adTypeVal,
          inspectStatus: mappedInspect,
          status: mappedStatus,
          raw: rawJson,
        }
        if (fieldsVal !== null) baseCreateData.fields = fieldsVal
        if (inspectMemoVal !== null)
          baseCreateData.inspectMemo = inspectMemoVal

        const baseUpdateData: {
          adgroupId: string
          inspectStatus: InspectStatus
          status: AdStatus
          raw: Prisma.InputJsonValue
          adType?: string
          fields?: Prisma.InputJsonValue
          inspectMemo?: string
        } = {
          adgroupId: dbAdgroupId,
          inspectStatus: mappedInspect,
          status: mappedStatus,
          raw: rawJson,
        }
        if (adTypeVal !== null) baseUpdateData.adType = adTypeVal
        if (fieldsVal !== null) baseUpdateData.fields = fieldsVal
        if (inspectMemoVal !== null)
          baseUpdateData.inspectMemo = inspectMemoVal

        await prisma.ad.upsert({
          where: { nccAdId: a.nccAdId },
          create: baseCreateData,
          update: baseUpdateData,
        })
        syncedAds++
      }

      scannedAdgroups++
    }
  }

  if (!hasCampaignFilter) {
    await recordSyncAt(advertiserId, "ads")
  }
  return { syncedAds, scannedAdgroups, skipped }
}

// =============================================================================
// 5) extensions (광고그룹 × type 2종 + image, 부분 실패 허용)
// =============================================================================

const EXTENSION_TYPES: ReadonlyArray<{
  app: AdExtensionType
  sa: SaAdExtensionType
}> = [
  { app: "headline", sa: "HEADLINE" },
  { app: "description", sa: "DESCRIPTION" },
  { app: "image", sa: "IMAGE" },
] as const

async function runExtensionsSync(
  advertiserId: string,
  customerId: string,
  options: SyncOptions = {},
): Promise<{
  synced: number
  scannedAdgroups: number
  skipped: number
  unsupportedAdgroupTypes: number
}> {
  const { campaignIds } = options
  const hasCampaignFilter =
    Array.isArray(campaignIds) && campaignIds.length > 0

  const adgroups = await prisma.adGroup.findMany({
    where: {
      campaign: {
        advertiserId,
        ...(hasCampaignFilter ? { id: { in: campaignIds } } : {}),
      },
      status: { not: "deleted" },
    },
    select: { id: true, nccAdgroupId: true },
  })

  if (adgroups.length === 0) {
    // 캠페인 필터 부분 동기화는 광고주 전체 sync 가 아니므로 lastSyncAt 갱신 X.
    if (!hasCampaignFilter) {
      await recordSyncAt(advertiserId, "extensions")
    }
    return {
      synced: 0,
      scannedAdgroups: 0,
      skipped: 0,
      unsupportedAdgroupTypes: 0,
    }
  }

  const adgroupIdMap = new Map<string, string>(
    adgroups.map((g) => [g.nccAdgroupId, g.id]),
  )

  let synced = 0
  let skipped = 0
  let scannedAdgroups = 0
  let unsupportedAdgroupTypes = 0

  for (const ag of adgroups) {
    let touched = false
    // 3 type (headline/description/image) 병렬 호출 (Promise.allSettled 부분 실패 허용).
    // 광고그룹별 ~3배 단축 (광고주당 burst 3 호출).
    const settled = await Promise.allSettled(
      EXTENSION_TYPES.map((t) =>
        listAdExtensions(customerId, {
          nccAdgroupId: ag.nccAdgroupId,
          type: t.sa,
        }),
      ),
    )
    for (let ti = 0; ti < EXTENSION_TYPES.length; ti++) {
      const t = EXTENSION_TYPES[ti]
      const settledRes = settled[ti]
      if (settledRes.status === "rejected") {
        const e = settledRes.reason
        // "Cannot handle the request" → 광고그룹이 해당 type 미지원. 정상 skip.
        if (isUnsupportedExtensionTypeError(e)) {
          unsupportedAdgroupTypes++
          touched = true
          continue
        }
        if (e instanceof NaverSaError) {
          console.warn(
            `[runExtensionsSync] listAdExtensions failed for nccAdgroupId=${ag.nccAdgroupId} type=${t.sa}: ${e.message}`,
          )
        } else {
          console.warn(
            `[runExtensionsSync] listAdExtensions unknown error for nccAdgroupId=${ag.nccAdgroupId} type=${t.sa}:`,
            e,
          )
        }
        continue
      }
      const remote: SaAdExtension[] = settledRes.value

      for (const e of remote) {
        const respTypeLc = e.type?.toString().toLowerCase()
        if (respTypeLc !== t.app) {
          skipped++
          continue
        }

        const dbAdgroupId = adgroupIdMap.get(e.ownerId)
        if (!dbAdgroupId) {
          skipped++
          continue
        }

        const mappedStatus = mapExtensionStatus(e)
        const mappedInspect = mapInspectStatus(e)

        let payload: Record<string, unknown>
        if (t.app === "image") {
          const img = extractImage(e)
          payload = img ? { image: img } : {}
        } else if (t.app === "headline" || t.app === "description") {
          const text = extractText(e, t.app)
          payload = text ? { [t.app]: text } : {}
        } else {
          // EXTENSION_TYPES 화이트리스트 외 타입 — P1 비대상. 빈 payload.
          payload = {}
        }

        const inspectMemoVal =
          typeof e.inspectMemo === "string" && e.inspectMemo.length > 0
            ? e.inspectMemo
            : null
        const rawJson = e as unknown as Prisma.InputJsonValue

        const baseCreateData: {
          ownerId: string
          ownerType: string
          nccExtId: string
          type: AdExtensionType
          payload: Prisma.InputJsonValue
          inspectStatus: InspectStatus
          status: AdExtensionStatus
          raw: Prisma.InputJsonValue
          inspectMemo?: string
        } = {
          ownerId: dbAdgroupId,
          ownerType: "adgroup",
          nccExtId: e.nccExtId,
          type: t.app,
          payload: payload as Prisma.InputJsonValue,
          inspectStatus: mappedInspect,
          status: mappedStatus,
          raw: rawJson,
        }
        if (inspectMemoVal !== null) baseCreateData.inspectMemo = inspectMemoVal

        const baseUpdateData: {
          ownerId: string
          ownerType: string
          type: AdExtensionType
          payload: Prisma.InputJsonValue
          inspectStatus: InspectStatus
          status: AdExtensionStatus
          raw: Prisma.InputJsonValue
          inspectMemo?: string
        } = {
          ownerId: dbAdgroupId,
          ownerType: "adgroup",
          type: t.app,
          payload: payload as Prisma.InputJsonValue,
          inspectStatus: mappedInspect,
          status: mappedStatus,
          raw: rawJson,
        }
        if (inspectMemoVal !== null) baseUpdateData.inspectMemo = inspectMemoVal

        await prisma.adExtension.upsert({
          where: { nccExtId: e.nccExtId },
          create: baseCreateData,
          update: baseUpdateData,
        })
        synced++
      }
      touched = true
    }
    if (touched) scannedAdgroups++
  }

  if (!hasCampaignFilter) {
    await recordSyncAt(advertiserId, "extensions")
  }
  return { synced, scannedAdgroups, skipped, unsupportedAdgroupTypes }
}

// =============================================================================
// extension payload helpers (extensions/actions.ts 와 동일 정책 — 본 모듈로 복제)
// =============================================================================
// 본 PR 단순화 — 향후 통합 후보. 현 시점은 "use server" 파일에서 함수 export 시 server action
// 으로 취급되는 한계 회피용.

function extractText(e: SaAdExtension, t: "headline" | "description"): string {
  const anyE = e as unknown as Record<string, unknown>
  const v = anyE[t]
  return typeof v === "string" ? v : ""
}

function extractImage(e: SaAdExtension): { url: string } | null {
  const anyE = e as unknown as Record<string, unknown>
  const img = anyE.image
  if (typeof img === "string" && img.length > 0) {
    return { url: img }
  }
  if (img && typeof img === "object") {
    const url = (img as Record<string, unknown>).url
    if (typeof url === "string" && url.length > 0) {
      return { url }
    }
  }
  return null
}
