/**
 * SA Ad 응답 → `Ad.fields` JSON / `Ad.adType` 매핑 헬퍼.
 *
 * 배경 (RSA_AD 본문 누락 케이스):
 *   네이버 SA 의 RSA_AD(반응형 검색광고) 응답은 다음 구조:
 *     {
 *       "ad": { "pc": {final, display}, "mobile": {...} },   // URL 만
 *       "type": "RSA_AD",                                    // adType 이 아닌 type 키
 *       "assets": [
 *         { "linkType": "HEADLINE",     "assetData": { "text": "G80 특가 견적" }, ... },
 *         { "linkType": "HEADLINE",     "assetData": { "text": "G80 장기렌트" }, ... },
 *         { "linkType": "DESCRIPTION",  "assetData": { "text": "제네시스 G80..." }, ... },
 *         ...
 *       ],
 *       ...
 *     }
 *
 *   기존 sync (`fields = a.ad`) 는 URL 만 저장 → UI 셀에 "본문 정보 없음" 표시.
 *   adType 도 누락 (SA 가 `type` 으로 보냄).
 *
 * 본 헬퍼 책임:
 *   1. buildAdFields — assets 의 HEADLINE/DESCRIPTION 텍스트 추출 →
 *      `{ ...ad, headlines?: string[], descriptions?: string[] }` 형태로 반환.
 *      UI 휴리스틱(extractAdParts) 이 이미 `headlines[0]` 매칭하므로
 *      별도 UI 변경 없이 본문 표시.
 *   2. extractAdType — `adType ?? type` 폴백.
 *
 * 페이로드 측면:
 *   assets 배열 전체(metadata 포함) 보다 텍스트만 추출하면 ~10배 작음.
 *   5천 행 page select 시 부담 적음. raw 컬럼은 별도(전체 응답 보존).
 *
 * 호출처: syncAds (Server Action) + runAdsSync (cron) + createAdsBatch.
 */

export type AdFieldsRaw = {
  ad?: unknown
  assets?: unknown
}

export type AdFieldsJson = Record<string, unknown>

/**
 * SA Ad 응답 → `Ad.fields` JSON 빌더.
 *
 * - `ad` 객체(pc/mobile URL 등) 는 그대로 spread
 * - `assets` 배열에서 HEADLINE / DESCRIPTION linkType 만 텍스트 추출
 * - 둘 다 비면 null 반환 (호출부가 fields 컬럼 미설정 처리)
 */
export function buildAdFields(a: AdFieldsRaw): AdFieldsJson | null {
  const adObj =
    a.ad && typeof a.ad === "object" && !Array.isArray(a.ad)
      ? (a.ad as Record<string, unknown>)
      : null

  const headlines: string[] = []
  const descriptions: string[] = []

  if (Array.isArray(a.assets)) {
    for (const asset of a.assets) {
      if (!asset || typeof asset !== "object") continue
      const o = asset as Record<string, unknown>
      const link = o["linkType"]
      const data = o["assetData"]
      if (!data || typeof data !== "object") continue
      const text = (data as Record<string, unknown>)["text"]
      if (typeof text !== "string" || text.trim().length === 0) continue
      if (link === "HEADLINE") headlines.push(text.trim())
      else if (link === "DESCRIPTION") descriptions.push(text.trim())
    }
  }

  if (!adObj && headlines.length === 0 && descriptions.length === 0) {
    return null
  }

  return {
    ...(adObj ?? {}),
    ...(headlines.length > 0 ? { headlines } : {}),
    ...(descriptions.length > 0 ? { descriptions } : {}),
  }
}

/**
 * SA 응답의 광고 타입 추출.
 *
 * SA 가 `adType` 또는 `type` 둘 중 하나로 보냄 (RSA_AD 는 `type` 으로 옴).
 * 없으면 null.
 */
export function extractAdType(a: {
  adType?: string | null
  type?: string | null
}): string | null {
  if (typeof a.adType === "string" && a.adType.length > 0) return a.adType
  if (typeof a.type === "string" && a.type.length > 0) return a.type
  return null
}
