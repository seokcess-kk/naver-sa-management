/**
 * F-11.4 — TargetingRule 시간/디바이스 가중치 추출 헬퍼.
 *
 * 자동 비딩 결정 흐름:
 *   1. cron 픽업 시 광고주 → TargetingRule 1행 lazy upsert
 *   2. 본 모듈 getTargetingWeight(rule, ctx) 로 baseBid 곱할 가중치 산출
 *   3. decideBidAdjustment 입력의 targetingWeight 로 전달
 *
 * 정책:
 *   - rule == null  →  1.0 (rule 미존재 = 가중 미적용)
 *   - rule.enabled === false  →  1.0 (스위치 OFF 시 적용 X)
 *   - hourKey = "{day}-{hour}" (KST)
 *     * day  : "sun"|"mon"|"tue"|"wed"|"thu"|"fri"|"sat"
 *     * hour : 0..23 (정수)
 *   - hourWeights[hourKey] 누락 시 defaultWeight 폴백
 *   - deviceWeights[device] 누락 시 1.0 폴백 (defaultWeight 폴백 X — 디바이스 미설정은 "중립")
 *   - 최종 weight = hourW * deviceW
 *   - clamp 0.1..3.0 (안전 — 운영 입력은 호출부 Zod 가 0.1..3.0 강제하지만,
 *     DB 컬럼이 0..9.99 까지 허용하므로 cron 도 한 번 더 방어)
 *
 * KST 변환:
 *   - 입력 ctx.now 는 UTC 기준 Date 가정. UTC + 9h shift 후 getUTCDay/getUTCHours.
 *   - 운영 환경 timezone 미의존 (Vercel Lambda UTC 기본).
 *
 * 비정상 입력 방어 (parseWeight):
 *   - typeof !== "number" / NaN / Infinity / 음수 / 9.99 초과 → fallback
 *   - JSON 컬럼이 typo / 외부 변경으로 오염되어도 폭주 방지
 *
 * 본 PR 비대상:
 *   - regionWeights 자동 비딩 적용 (모델만 보유 — SA 응답에 키워드별 노출 지역 없음)
 *
 * SPEC: SPEC v0.2.1 F-11.4
 */

// =============================================================================
// 타입
// =============================================================================

export type TargetingRuleSlice = {
  enabled: boolean
  /** JSON 키 누락 시 적용 (운영 권장 0.1..3.0). number 강제. */
  defaultWeight: number
  /** { "{day}-{hour}": number } — 168 키 max. JSON passthrough. */
  hourWeights: Record<string, unknown>
  /** { "PC"|"MOBILE": number } — 2 키 max. JSON passthrough. */
  deviceWeights: Record<string, unknown>
}

export type TargetingDevice = "PC" | "MOBILE"

export type TargetingContext = {
  /** 적용 시점 (UTC Date). 본 함수가 KST 로 shift 하여 dayKey/hour 산출. */
  now: Date
  /** 정책의 device. PC|MOBILE 만 (StatDevice ALL 비사용). */
  device: TargetingDevice
}

// =============================================================================
// 상수
// =============================================================================

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const

/** 운영 안전 clamp 범위 — 3배 / 0 차단. */
const WEIGHT_MIN = 0.1
const WEIGHT_MAX = 3.0

/** DB 컬럼 Decimal(4,2) 상한 (0..9.99). 호환 가능한 number 판별용. */
const DB_WEIGHT_MAX = 9.99

// =============================================================================
// 핵심 헬퍼
// =============================================================================

/**
 * KST 기준 hourKey 산출.
 *
 * @example
 *   makeHourKey(new Date("2026-04-29T00:00:00Z")) // → "wed-9" (UTC 0시 = KST 9시)
 */
export function makeHourKey(now: Date): string {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  const day = DAY_KEYS[kst.getUTCDay()] ?? "sun"
  const hour = kst.getUTCHours()
  return `${day}-${hour}`
}

/**
 * unknown 값을 weight number 로 변환.
 *
 * 허용: typeof === "number" + finite + 0 <= v <= 9.99 (DB 한계)
 * 거부: NaN / Infinity / 음수 / DB 한계 초과 / 문자열 / 객체
 *
 * 거부 시 fallback (defaultWeight 또는 1.0).
 */
function parseWeight(v: unknown, fallback: number): number {
  if (
    typeof v === "number" &&
    Number.isFinite(v) &&
    v >= 0 &&
    v <= DB_WEIGHT_MAX
  ) {
    return v
  }
  return fallback
}

/**
 * fallback 자체도 비정상일 경우(외부 호출부 typo) 안전선 — clamp 후 1.0 으로 강제.
 */
function safeFallback(v: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > DB_WEIGHT_MAX) {
    return 1.0
  }
  return v
}

// =============================================================================
// 메인 — getTargetingWeight
// =============================================================================

/**
 * TargetingRule + 시점/디바이스 → 적용 weight (baseBid 곱셈용).
 *
 * 반환값은 항상 [0.1, 3.0] 범위 보장 (clamp).
 * rule null / enabled false 시 1.0 (가중 미적용 = 무영향).
 */
export function getTargetingWeight(
  rule: TargetingRuleSlice | null | undefined,
  ctx: TargetingContext,
): number {
  if (!rule || !rule.enabled) return 1.0

  const fallback = safeFallback(rule.defaultWeight)
  const hourKey = makeHourKey(ctx.now)

  const hourW = parseWeight(rule.hourWeights[hourKey], fallback)
  const deviceW = parseWeight(rule.deviceWeights[ctx.device], 1.0)

  const w = hourW * deviceW

  // 곱셈 결과 비정상 (NaN / Infinity) 방어
  if (!Number.isFinite(w) || w < 0) return 1.0

  // 운영 안전 clamp
  if (w < WEIGHT_MIN) return WEIGHT_MIN
  if (w > WEIGHT_MAX) return WEIGHT_MAX
  return w
}
