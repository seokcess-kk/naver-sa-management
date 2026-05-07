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
import { dispatch } from "@/lib/notifier"
import { shouldThrottle } from "@/lib/notifier/throttle"
import {
  setCredentialsResolver,
  type NaverSaCredentials,
} from "@/lib/naver-sa/client"

/**
 * decrypt 실패 시 알림 — Event 4 (api_auth_failed).
 *
 * - Throttle: 광고주별 60분 (Redis nsa:notify:api_auth:{customerId})
 *   · 같은 광고주 1시간 동안 1회만 dispatch (폭주 방지)
 * - 시크릿 X: meta 에 customerId / advertiserName 만
 * - 실패 격리: dispatch throw 가 resolve flow 에 영향 X (catch + warn)
 *
 * 호출 후 호출부의 throw 를 그대로 진행 — 본 함수는 알림만 책임.
 */
async function notifyApiAuthFailed(
  customerId: string,
  advertiserId: string | null,
  advertiserName: string | null,
): Promise<void> {
  try {
    const throttled = await shouldThrottle(
      `nsa:notify:api_auth:${customerId}`,
      60 * 60,
    )
    if (throttled) return

    console.info(
      `[naver-sa/credentials] notify api_auth_failed customerId=${customerId} advertiserId=${advertiserId}`,
    )

    await dispatch({
      ruleType: "api_auth_failed",
      severity: "critical",
      title: `[인증 실패] 광고주 ${advertiserName ?? "(unknown)"} (${customerId})`,
      body: `API 키 복호화 실패 — ENCRYPTION_KEY 미스매치 또는 키 손상. 시크릿 재입력 필요.`,
      meta: {
        advertiserId,
        customerId,
        advertiserName,
        failureType: "decrypt",
      },
    })
  } catch (e) {
    console.warn(
      "[naver-sa/credentials] notifyApiAuthFailed failed:",
      e instanceof Error ? e.message : String(e),
    )
  }
}

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
  // decrypt throw → 'decrypt: authentication failed' 등 — 운영자 즉시 알림 (Event 4).
  // try/catch 로 dispatch 후 throw 그대로 진행 (호출 흐름 영향 X).
  let apiKey: string
  let secretKey: string
  try {
    apiKey = decrypt(
      Buffer.from(advertiser.apiKeyEnc),
      advertiser.apiKeyVersion,
    )
    secretKey = decrypt(
      Buffer.from(advertiser.secretKeyEnc),
      advertiser.secretKeyVersion,
    )
  } catch (e) {
    // dispatch 는 await 하되 (발송 보장), 실패해도 throw 는 그대로.
    await notifyApiAuthFailed(customerId, advertiser.id, advertiser.name)
    throw e
  }

  return { apiKey, secretKey }
}

// import 시점에 1회 등록. 중복 호출되어도 최후 등록이 유효(setCredentialsResolver는 단순 대입).
setCredentialsResolver(resolve)
