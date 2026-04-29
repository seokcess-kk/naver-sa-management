"use server"

/**
 * F-11.3 — 한계효용 분석 Server Actions.
 *
 * 책임:
 *   1. analyzeMarginalUtility    — 키워드 1개 + device 한계효용 분석 본체
 *   2. listAnalyzableKeywords    — UI 셀렉터 후보 (광고주 키워드 + 7일 클릭 desc)
 *
 * 운영 정책:
 *   - 진입부 getCurrentAdvertiser(advertiserId) — admin / 화이트리스트 검증
 *   - viewer 가능 (조회 성격 — ChangeBatch 미사용, 외부 SA mutation X)
 *   - 광고주 횡단 차단:
 *       * Keyword.findFirst({ id, adgroup.campaign.advertiserId }) — 키워드 단건 검증
 *       * StatDaily 조회는 advertiserId 직접 필터 (비정규화 컬럼 활용)
 *   - hasKeys 검사: Estimate 호출 동반 → 키 미입력 광고주는 ok:false (의미 있는 안내)
 *
 * 본 PR 비대상:
 *   - 매출 조인 (StatDaily.revenue null) → CPC/클릭 기반 분석만 (P2 후속)
 *   - 결과 캐시 (Estimate 캐시 30분 TTL 만 활용) — 클라이언트 측 polling 없음
 *
 * SPEC: SPEC v0.2.1 F-11.3
 */

import { z } from "zod"

import { prisma } from "@/lib/db/prisma"
import { getCurrentAdvertiser } from "@/lib/auth/access"
import {
  calculateMarginalUtility,
  DEFAULT_DAYS_WINDOW,
  type MarginalUtilityResult,
} from "@/lib/marginal-utility/calculate"
import { StatDevice, StatLevel } from "@/lib/generated/prisma/enums"

// =============================================================================
// 공통 타입
// =============================================================================

export type ActionResult<T = void> =
  | ({ ok: true } & (T extends void ? Record<never, never> : { data: T }))
  | { ok: false; error: string }

// =============================================================================
// Zod 스키마
// =============================================================================

const advertiserIdSchema = z.string().trim().min(1).max(128)
const keywordIdSchema = z.string().trim().min(1).max(128)
const deviceSchema = z.enum(["PC", "MOBILE"])
const daysWindowSchema = z.number().int().min(3).max(30)

const analyzeSchema = z.object({
  advertiserId: advertiserIdSchema,
  keywordId: keywordIdSchema,
  device: deviceSchema,
  daysWindow: daysWindowSchema.optional(),
})

const listSchema = z.object({
  advertiserId: advertiserIdSchema,
  device: deviceSchema,
})

// =============================================================================
// 입력 타입 (UI 호출 시그니처)
// =============================================================================

export type AnalyzeMarginalUtilityInput = {
  advertiserId: string
  keywordId: string
  device: "PC" | "MOBILE"
  /** 분석 기간 (일). 미지정 시 7. 3..30. */
  daysWindow?: number
}

export type AnalyzableKeywordOption = {
  id: string
  nccKeywordId: string
  keyword: string
  /** N일 합계 클릭 — UI 정렬 / 부제 표시. */
  last7dClicks: number
  /** 광고그룹 이름 — UI 부제. */
  adgroupName: string
}

// =============================================================================
// 1. analyzeMarginalUtility — 본체
// =============================================================================

/**
 * 키워드 1개 한계효용 분석.
 *
 *   1. Zod 검증
 *   2. getCurrentAdvertiser — admin / 화이트리스트 검증
 *   3. 광고주 횡단 차단: Keyword.findFirst({ id, adgroup.campaign.advertiserId })
 *   4. hasKeys 검사 (Estimate 호출 동반)
 *   5. calculateMarginalUtility 위임 (lib/marginal-utility/calculate.ts)
 *   6. ok:true + 결과 반환
 *
 * 외부 호출 실패는 catch + ok:false (UI 친화적). console.error 만 적재 (시크릿 마스킹은
 * client.ts 가 이미 처리, 본 모듈은 keyword 텍스트 / device 만 로깅).
 */
export async function analyzeMarginalUtility(
  input: AnalyzeMarginalUtilityInput,
): Promise<ActionResult<MarginalUtilityResult>> {
  const parsed = analyzeSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: `입력 검증 실패: ${parsed.error.issues
        .map((i) => i.message)
        .join(", ")}`,
    }
  }
  const data = parsed.data

  const { advertiser } = await getCurrentAdvertiser(data.advertiserId)

  if (!advertiser.hasKeys) {
    return {
      ok: false,
      error: "광고주 API 키가 등록되지 않았습니다",
    }
  }

  // 광고주 횡단 차단 — Keyword 가 본 광고주 소속인지 확인
  const kw = await prisma.keyword.findFirst({
    where: {
      id: data.keywordId,
      adgroup: { campaign: { advertiserId: data.advertiserId } },
    },
    select: {
      id: true,
      nccKeywordId: true,
      keyword: true,
      bidAmt: true,
      recentAvgRnk: true,
    },
  })
  if (!kw) {
    return {
      ok: false,
      error: "해당 광고주의 키워드가 아닙니다",
    }
  }

  try {
    const result = await calculateMarginalUtility({
      advertiserId: data.advertiserId,
      customerId: advertiser.customerId,
      keywordId: kw.id,
      nccKeywordId: kw.nccKeywordId,
      keywordText: kw.keyword,
      currentBid: kw.bidAmt,
      recentAvgRnk:
        kw.recentAvgRnk !== null
          ? Number(kw.recentAvgRnk.toString())
          : null,
      device: data.device,
      daysWindow: data.daysWindow ?? DEFAULT_DAYS_WINDOW,
    })

    return { ok: true, data: result }
  } catch (e) {
    // 외부 호출 실패 — 시크릿은 client.ts 에서 이미 마스킹. 본 레이어는 keyword/device
    // 만 로깅 (사용자 식별자 X, 평문 키 X).
    console.error("[analyzeMarginalUtility] failed", {
      advertiserId: data.advertiserId,
      keywordId: data.keywordId,
      device: data.device,
      message: (e as Error).message,
    })
    return {
      ok: false,
      error: "한계효용 분석 실패 — 잠시 후 다시 시도해주세요",
    }
  }
}

// =============================================================================
// 2. listAnalyzableKeywords — UI 셀렉터
// =============================================================================

/**
 * 광고주 키워드 + 7일 클릭 합계 (정렬 desc clicks, limit 200).
 *
 *   1. Zod 검증 (실패 시 빈 배열 — UI 셀렉터 friendly)
 *   2. getCurrentAdvertiser
 *   3. Keyword.findMany — 광고주 소속 (adgroup.campaign.advertiserId)
 *   4. StatDaily.groupBy [refId] _sum.clicks — 광고주 + level=keyword + device + 7일
 *   5. 매핑 후 last7dClicks desc 정렬, take 200
 *
 * 7일 클릭 0 인 키워드도 후보 노출 (UI 가 분석 시도 → insufficientData 안내).
 *
 * 성능: N+1 회피 — keyword findMany 1회 + groupBy 1회. 광고주 키워드 5천 개여도 in 절 없이
 * 광고주 단위 groupBy 라 안전.
 */
export async function listAnalyzableKeywords(
  advertiserId: string,
  device: "PC" | "MOBILE",
): Promise<AnalyzableKeywordOption[]> {
  const parsed = listSchema.safeParse({ advertiserId, device })
  if (!parsed.success) return []

  await getCurrentAdvertiser(parsed.data.advertiserId)

  const keywords = await prisma.keyword.findMany({
    where: {
      adgroup: { campaign: { advertiserId: parsed.data.advertiserId } },
    },
    select: {
      id: true,
      nccKeywordId: true,
      keyword: true,
      adgroup: { select: { name: true } },
    },
    // 광고주 키워드 5천 한도 — 본 한도 초과는 후속에서 검색 인자 추가 검토
    take: 5000,
  })

  if (keywords.length === 0) return []

  const since = new Date(
    Date.now() - DEFAULT_DAYS_WINDOW * 24 * 60 * 60 * 1000,
  )

  const clickGroups = await prisma.statDaily.groupBy({
    by: ["refId"],
    where: {
      advertiserId: parsed.data.advertiserId,
      level: StatLevel.keyword,
      device: parsed.data.device as StatDevice,
      date: { gte: since },
      refId: { in: keywords.map((k) => k.nccKeywordId) },
    },
    _sum: { clicks: true },
  })

  const clicksByRefId = new Map<string, number>()
  for (const g of clickGroups) {
    clicksByRefId.set(g.refId, g._sum.clicks ?? 0)
  }

  const rows: AnalyzableKeywordOption[] = keywords.map((k) => ({
    id: k.id,
    nccKeywordId: k.nccKeywordId,
    keyword: k.keyword,
    last7dClicks: clicksByRefId.get(k.nccKeywordId) ?? 0,
    adgroupName: k.adgroup.name,
  }))

  rows.sort((a, b) => b.last7dClicks - a.last7dClicks)
  return rows.slice(0, 200)
}
