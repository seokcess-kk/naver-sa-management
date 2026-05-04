/**
 * VAT 환산 유틸 (Phase E.2).
 *
 * 네이버 SA 운영 베스트 프랙티스 (사용자 검토 반영):
 *   - 클릭당 광고비 / 최대 입찰가 / 일예산 입력은 **VAT 제외** 기준
 *   - 비즈머니 잔액 / 실 과금액은 **VAT 포함**
 *   - 화면별 표기 혼동이 빈번 — UI 모든 표기에 "(VAT 별도/포함)" 명시 필수
 *
 * 본 모듈은 두 단위를 일관되게 환산하는 헬퍼만 제공. 어디에 어느 단위가 쓰이는지는 호출부 책임.
 *
 * 한국 VAT: 10%.
 */

export const KOREAN_VAT_RATE = 0.1

/**
 * VAT 별도(net) → VAT 포함(gross). 실 과금 / 비즈머니 차감 산출 시 사용.
 *
 * 반올림: 원 단위. 1원 미만 절사 후 재분배는 호출자 책임.
 */
export function withVat(amountExVat: number): number {
  if (!Number.isFinite(amountExVat)) {
    throw new Error("withVat: amount must be a finite number")
  }
  return Math.round(amountExVat * (1 + KOREAN_VAT_RATE))
}

/**
 * VAT 포함(gross) → VAT 별도(net). 비즈머니 잔액을 일예산 환산할 때 사용.
 */
export function withoutVat(amountIncVat: number): number {
  if (!Number.isFinite(amountIncVat)) {
    throw new Error("withoutVat: amount must be a finite number")
  }
  return Math.round(amountIncVat / (1 + KOREAN_VAT_RATE))
}

/**
 * 비즈머니 잔액(VAT 포함)이 활성 일예산 합(VAT 별도) × N일치 에 부족한지 비교.
 *
 * @returns true = 부족. false = 충분.
 *
 * 비즈머니 잔액은 VAT 포함이므로 비교 전에 VAT 제외로 환산하거나,
 * 일예산 합을 VAT 포함으로 환산해 같은 단위로 맞춰야 함. 본 함수는 일예산을 VAT 포함으로 환산.
 */
export function isBizmoneyBelowDays(args: {
  bizmoneyIncVat: number
  dailyBudgetSumExVat: number
  days: number
}): boolean {
  if (args.dailyBudgetSumExVat <= 0) return false
  const required = withVat(args.dailyBudgetSumExVat * args.days)
  return args.bizmoneyIncVat < required
}
