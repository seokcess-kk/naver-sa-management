/**
 * 네이버 SA Customer-Links 모듈 (MCC 하위 광고주 동기화용)
 *
 * [현재 미사용 — 모델 2 / 마스터 권한 필요]
 *   본 프로젝트는 모델 2(평면 구조)로 운영 중. 광고주별 API 키를 직접 발급받아
 *   사용하므로 customer-links 자동 동기화 호출은 비대상.
 *   향후 MCC 마스터 권한을 받아 일괄 동기화가 필요해지면 본 모듈 재활용.
 *
 * 엔드포인트:
 *   GET /customer-links?type=MYCLIENTS
 *
 * 캐시: 1시간 (`meta` kind)
 *
 * 호출자 주의 (재활용 시):
 *   - customerId 인자는 "MCC 마스터 자체의 customerId"
 *   - X-Customer 헤더에 마스터 customerId가 들어가야 type=MYCLIENTS 가 동작
 *   - 광고주별 호출이 아님 (다른 모듈과 다른 패턴)
 */

import { z } from "zod"

import { naverSaClient } from "@/lib/naver-sa/client"
import { NaverSaValidationError } from "@/lib/naver-sa/errors"

/**
 * 응답 단일 항목 스키마.
 *
 * 네이버 문서 기준 주요 필드 (관찰 기준 — 응답 변경 대비 passthrough):
 *   - managerCustomerId: MCC 마스터 customerId
 *   - customerId: 하위 광고주 customerId
 *   - role: 권한 (예: "MASTER" / "MANAGER" / ...)
 *   - sharedAccountInfo: 공유 계정 정보 (구조 가변)
 *   - loginId / name / status 등 광고주 메타가 같이 오는 케이스 있음
 *
 * 모르는 필드는 passthrough()로 보존 → 호출부에서 raw 컬럼에 그대로 적재.
 */
export const CustomerLinkSchema = z
  .object({
    managerCustomerId: z.union([z.string(), z.number()]).optional(),
    customerId: z.union([z.string(), z.number()]),
    role: z.string().optional(),
    sharedAccountInfo: z.unknown().optional(),
    loginId: z.string().optional(),
    name: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough()

export type CustomerLink = z.infer<typeof CustomerLinkSchema>

/**
 * MCC 마스터 산하 광고주 목록 조회.
 *
 * @param customerId MCC 마스터 자체의 customerId
 *                   (주의: 일반 모듈처럼 광고주별 호출이 아님)
 *
 * 사용 예 (재활용 시):
 *   const links = await listMyClients(mccCustomerId)
 *   // → links[i].customerId 를 Advertiser.upsert
 */
export async function listMyClients(customerId: string): Promise<CustomerLink[]> {
  const res = await naverSaClient.request({
    customerId,
    method: "GET",
    path: "/customer-links?type=MYCLIENTS",
    cache: { kind: "meta", ttl: 3600 },
  })

  // 네이버 응답이 배열 또는 { items: [...] } 형태로 올 수 있어 양쪽 허용
  const arrayCandidate = Array.isArray(res)
    ? res
    : typeof res === "object" && res !== null && "items" in res && Array.isArray((res as { items?: unknown }).items)
      ? ((res as { items: unknown[] }).items)
      : null

  if (!arrayCandidate) {
    throw new NaverSaValidationError("listMyClients: unexpected response shape", {
      method: "GET",
      path: "/customer-links?type=MYCLIENTS",
      customerId,
      raw: res,
    })
  }

  const parsed = z.array(CustomerLinkSchema).safeParse(arrayCandidate)
  if (!parsed.success) {
    // raw 보존 + 도메인 에러 (호출부에서 raw 적재 + 경고 로그 처리)
    throw new NaverSaValidationError("listMyClients: zod validation failed", {
      method: "GET",
      path: "/customer-links?type=MYCLIENTS",
      customerId,
      raw: arrayCandidate,
    })
  }
  return parsed.data
}
