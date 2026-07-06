/**
 * 네이버 SA 자격증명 Resolver — DB 기반 (모델 2: Advertiser 직접 조회)
 *
 * 동작:
 *   customerId(광고주) → Advertiser 행 조회 →
 *   apiKeyEnc / secretKeyEnc 복호화 → { apiKey, secretKey } 반환
 *
 * 모델 2 (평면 구조):
 *   - 광고주별 API 키·시크릿을 직접 발급받아 저장 (MCC 마스터 권한 불필요)
 *   - MasterAccount 모델은 제거됨. Advertiser.customerId로 단일 조회.
 *
 * 평문 시크릿은 본 함수 호출자(client.ts) 외부로 절대 흘리지 말 것.
 *
 * 부팅 시 1회 등록 (앱 import 그래프에 들어오면 자동 등록):
 *   import "@/lib/naver-sa/credentials" // side-effect 등록
 */

import { prisma } from "@/lib/db/prisma"
import { decrypt } from "@/lib/crypto/secret"
import {
  setCredentialsResolver,
  type NaverSaCredentials,
} from "@/lib/naver-sa/client"

/**
 * 인증 실패 알림 단일 소스 = cron 합성 프로브(lib/alerts/evaluators.ts evaluateApiAuthError).
 *
 *   - 프로브가 getBizmoney 를 실호출하므로 decrypt 실패(키 손상)와 라이브 401(SA측 키
 *     취소·만료)을 모두 감지한다. ruleType="api_auth_error", muteKey="api_auth:{advertiserId}"
 *     로 cron 공통 flow 가 dispatch + AlertEvent 적재 + 광고주당 1시간 음소거를 처리.
 *   - 따라서 본 resolver 는 인증 실패 시 자체 dispatch/적재를 하지 않는다(이중 발생 방지).
 *     decrypt 실패는 그대로 throw 하여 호출부(client.ts)로 전파.
 */
async function resolve(customerId: string): Promise<NaverSaCredentials> {
  const advertiser = await prisma.advertiser.findUnique({
    where: { customerId },
  })

  if (!advertiser) {
    // 평문 키/시크릿은 메시지에 노출 X. customerId 만 디버깅용으로.
    throw new Error(`Advertiser not found for customerId=${customerId}`)
  }
  if (advertiser.status !== "active") {
    throw new Error(
      `Advertiser status=${advertiser.status} for customerId=${customerId}`,
    )
  }

  // 키 미입력 광고주 차단 (F-1.2: CSV 메타 등록 후 시크릿 입력 전 상태).
  // apiKeyEnc / secretKeyEnc 가 nullable 이므로 narrow 후 Buffer.from 호출.
  if (advertiser.apiKeyEnc === null || advertiser.secretKeyEnc === null) {
    throw new Error(`Credentials not set for customerId=${customerId}`)
  }

  // Prisma Bytes 컬럼 → Buffer 로 감싸서 decrypt 호출 (컨벤션 #2).
  // decrypt throw → 'decrypt: authentication failed' 등. 그대로 전파 —
  // 인증 실패 알림은 cron 프로브(evaluateApiAuthError)가 단일 소스로 담당(위 헤더 주석).
  const apiKey = decrypt(
    Buffer.from(advertiser.apiKeyEnc),
    advertiser.apiKeyVersion,
  )
  const secretKey = decrypt(
    Buffer.from(advertiser.secretKeyEnc),
    advertiser.secretKeyVersion,
  )

  return { apiKey, secretKey }
}

// import 시점에 1회 등록. 중복 호출되어도 최후 등록이 유효(setCredentialsResolver는 단순 대입).
setCredentialsResolver(resolve)
