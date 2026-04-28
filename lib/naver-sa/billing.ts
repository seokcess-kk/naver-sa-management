/**
 * 네이버 SA Billing 모듈
 *
 * 엔드포인트:
 *   GET /billing/bizmoney  — 광고주 비즈머니 잔액 조회
 *
 * 사용처:
 *   - 광고주 등록 후 연결 테스트 (인증 검증용 단순 GET)
 *   - 비즈머니 잔액 알림 (P1 후반)
 *
 * 응답 형식 (실측):
 *   { customerId: number, bizmoney: number, budgetLock: boolean, refundLock: boolean }
 *
 * 호출자 주의:
 *   - customerId 인자는 광고주 customerId (X-Customer 헤더로 부착)
 */

import { z } from "zod"

import { naverSaClient } from "@/lib/naver-sa/client"
import { NaverSaValidationError } from "@/lib/naver-sa/errors"

/**
 * /billing/bizmoney 응답 스키마.
 *
 * 외부 API customerId는 number/string 양쪽 가능 → union 후 호출부에서 String() 변환 (컨벤션 #3).
 * 모르는 필드는 passthrough()로 보존.
 */
export const BizmoneyResponseSchema = z
  .object({
    customerId: z.union([z.string(), z.number()]),
    bizmoney: z.number(),
    budgetLock: z.boolean().optional(),
    refundLock: z.boolean().optional(),
  })
  .passthrough()

export type BizmoneyResponse = z.infer<typeof BizmoneyResponseSchema>

/**
 * 광고주 비즈머니 잔액 조회.
 *
 * @param customerId 광고주 customerId
 * @returns { customerId, bizmoney, budgetLock?, refundLock? } — customerId는 외부 API 원본 타입
 */
export async function getBizmoney(customerId: string): Promise<BizmoneyResponse> {
  const res = await naverSaClient.request({
    customerId,
    method: "GET",
    path: "/billing/bizmoney",
  })

  const parsed = BizmoneyResponseSchema.safeParse(res)
  if (!parsed.success) {
    throw new NaverSaValidationError("getBizmoney: zod validation failed", {
      method: "GET",
      path: "/billing/bizmoney",
      customerId,
      raw: res,
    })
  }
  return parsed.data
}
