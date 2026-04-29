/**
 * 네이버 검색광고 API 클라이언트 (HMAC-SHA256 + Rate Limit + 캐시 + 재시도)
 *
 * 핵심 책임 (이 파일에서만):
 *   1. HMAC-SHA256 서명: signature = HMAC(secretKey, `${ts}.${method}.${path}`)
 *      → 헤더 X-Timestamp / X-API-KEY / X-Customer / X-Signature 자동 부착
 *   2. Rate Limit 토큰 버킷 (Upstash Redis, 광고주별 분리)
 *   3. 지수 백오프 재시도 (429 / 1016 / 5xx)
 *   4. 응답 캐시 (cache 옵션 시 GET만 대상)
 *   5. HTTP/응답 코드 → 도메인 에러 매핑
 *
 * 다른 모듈(campaigns/keywords/...)은 본 파일의 `naverSaClient.request`만 호출.
 * fetch / axios 직접 사용 금지 (HMAC·Rate Limit 우회 차단).
 *
 * 시크릿 운영 (SPEC 8.1, 모델 2):
 * - 광고주별 API 키·시크릿을 DB(Advertiser)에 AES-256-GCM 암호화 저장
 * - customerId 기반으로 Advertiser 직접 조회 (lib/naver-sa/credentials.ts)
 * - 본 파일은 lib/crypto/secret.ts 의 decrypt만 사용. 평문 로그 금지.
 *
 * 자격증명 resolver는 lib/naver-sa/credentials.ts 가 import 시점에 등록.
 *   getCredentials(customerId) 시그니처를 통해서만 평문 시크릿 접근.
 */

import { createHash, createHmac } from "node:crypto"

import { cached, getRedis } from "@/lib/cache/redis"
import {
  NaverSaError,
  NaverSaRateLimitError,
  NaverSaUnknownError,
  NaverSaValidationError,
  mapHttpToDomainError,
} from "@/lib/naver-sa/errors"
import type { NaverSaCacheKind, NaverSaHttpMethod } from "@/lib/naver-sa/types"

// =============================================================================
// 자격증명 조회 (lib/db 와 분리)
// =============================================================================

/**
 * customerId → 마스터 API 키/시크릿 조회 결과.
 * - apiKey: 평문 (헤더에 그대로 들어감)
 * - secretKey: 평문 (HMAC 시그니처 생성에 사용)
 *
 * 두 값 모두 메모리 외부로 누출 금지 (로그·에러 메시지 X).
 */
export type NaverSaCredentials = {
  apiKey: string
  secretKey: string
}

/**
 * customerId 기반으로 자격증명을 조회하는 함수.
 *
 * 기본 구현은 미설정 에러를 던집니다 (resolver 미등록 시 차단).
 * 실제 연결: lib/naver-sa/credentials.ts 가 import 시점에 setCredentialsResolver 호출.
 *   1. lib/db/prisma.ts 의 prisma 로 Advertiser.findUnique({ where: { customerId } })
 *   2. apiKeyEnc / secretKeyEnc 를 lib/crypto/secret.decrypt 로 복호화
 *   3. NaverSaCredentials 반환
 *
 * `setCredentialsResolver` 로 외부에서 주입 가능 (테스트 mock / 다른 조회 전략 교체).
 */
export type CredentialsResolver = (customerId: string) => Promise<NaverSaCredentials>

let _credentialsResolver: CredentialsResolver = async () => {
  // resolver 미등록 시 차단. 정상 흐름: lib/naver-sa/credentials.ts import.
  throw new NaverSaError(
    "getCredentials not configured: import '@/lib/naver-sa/credentials' to register resolver",
  )
}

export function setCredentialsResolver(resolver: CredentialsResolver): void {
  _credentialsResolver = resolver
}

export async function getCredentials(customerId: string): Promise<NaverSaCredentials> {
  return _credentialsResolver(customerId)
}

// =============================================================================
// HMAC 서명 (이 파일에서만)
// =============================================================================

/**
 * 네이버 SA HMAC-SHA256 서명 생성.
 *
 * 서명 대상 문자열: `${timestamp}.${method}.${path}`
 *   - timestamp: 밀리초 epoch 문자열
 *   - method: 대문자 HTTP method (GET/POST/PUT/...)
 *   - path: 쿼리스트링 포함 경로 (`/keywords?nccAdgroupId=abc`)
 *
 * 결과: base64 인코딩.
 *
 * 주의: secretKey 평문은 본 함수 외부로 흘리지 말 것.
 */
function sign(args: {
  timestamp: string
  method: NaverSaHttpMethod
  path: string
  secretKey: string
}): string {
  const { timestamp, method, path, secretKey } = args
  const message = `${timestamp}.${method}.${path}`
  return createHmac("sha256", secretKey).update(message).digest("base64")
}

// =============================================================================
// 토큰 버킷 Rate Limit (Upstash Redis 기반)
// =============================================================================

/**
 * 광고주별 토큰 버킷 설정.
 *
 * 보수적 기본값 (운영팀 협의 전):
 *   - 분당 50회 (= 1.2초당 1토큰 보충, capacity 50)
 *
 * 추후 운영팀 협의 결과로 NAVER_SA_RATE_TOKENS_PER_SEC / NAVER_SA_RATE_BURST 환경 변수로 오버라이드.
 */
const RATE_BURST = Number.parseInt(process.env.NAVER_SA_RATE_BURST ?? "", 10) || 50
const RATE_REFILL_PER_SEC =
  Number.parseFloat(process.env.NAVER_SA_RATE_TOKENS_PER_SEC ?? "") || 50 / 60

/**
 * 광고주별 토큰 버킷 키.
 *
 * Redis 값 구조: { tokens: number, updatedMs: number }
 */
function bucketKey(customerId: string): string {
  return `nsa:rl:${customerId}`
}

/**
 * 토큰 1개 소비 시도.
 *
 * 단순 RMW (race 시 다소 관대 — Lua 스크립트는 추후 도입). 1인 워크로드 기준 충분.
 *
 * @returns 부족 시 다음 토큰까지 대기해야 할 ms
 */
async function tryConsumeToken(customerId: string): Promise<number> {
  const r = getRedis()
  const key = bucketKey(customerId)
  const now = Date.now()
  const state = await r.get<{ tokens: number; updatedMs: number }>(key)
  let tokens = state?.tokens ?? RATE_BURST
  const updatedMs = state?.updatedMs ?? now

  // 경과 시간만큼 토큰 보충
  const elapsedSec = Math.max(0, (now - updatedMs) / 1000)
  tokens = Math.min(RATE_BURST, tokens + elapsedSec * RATE_REFILL_PER_SEC)

  if (tokens >= 1) {
    tokens -= 1
    await r.set(key, { tokens, updatedMs: now }, { ex: 600 })
    return 0
  }

  // 부족: 다음 1토큰까지 대기 ms 반환 (저장은 하지 않음 — 실제 소비 시점에만)
  const need = 1 - tokens
  const waitMs = Math.ceil((need / RATE_REFILL_PER_SEC) * 1000)
  return waitMs
}

/**
 * 토큰 1개 소비될 때까지 대기 (busy poll 아님 — sleep 후 재시도).
 *
 * 토큰 버킷 우회 금지: 본 함수 통과 없이 fetch 호출 X.
 */
async function consumeToken(customerId: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const wait = await tryConsumeToken(customerId)
    if (wait === 0) return
    await sleep(Math.min(wait, 5000))
  }
  throw new NaverSaRateLimitError("Local rate limit bucket starvation", { customerId })
}

// =============================================================================
// 보조 유틸
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

/** 안정적 캐시 키용 해시 (params 직렬화). 짧은 sha1 hex. */
function hashParams(value: unknown): string {
  const json = JSON.stringify(value ?? null)
  return createHash("sha1").update(json).digest("hex").slice(0, 16)
}

function baseUrl(): string {
  return process.env.NAVER_SA_BASE_URL?.replace(/\/+$/, "") || "https://api.searchad.naver.com"
}

// =============================================================================
// public request API
// =============================================================================

export type NaverSaRequest = {
  customerId: string
  method: NaverSaHttpMethod
  /** 쿼리스트링 포함 경로 (예: `/customer-links?type=MYCLIENTS`) */
  path: string
  /** POST/PUT body (JSON 직렬화됨) */
  body?: unknown
  /** GET 응답 캐시 (POST/PUT은 무시) */
  cache?: { kind: NaverSaCacheKind; ttl: number }
  /** 재시도 한도 (기본 5) */
  maxRetries?: number
}

/**
 * 네이버 SA API 호출 단일 진입점.
 *
 * - HMAC 서명 자동
 * - X-Customer 헤더 자동 부착 (customerId 인자 필수)
 * - 토큰 버킷 통과 후 fetch
 * - 429 / 1016 / 5xx 시 지수 백오프 재시도
 * - GET 요청에 cache 옵션 있으면 Upstash 캐시 사용
 * - 응답 코드 → 도메인 에러 매핑
 */
async function request<T = unknown>(req: NaverSaRequest): Promise<T> {
  const { customerId, method, path, body, cache, maxRetries = 5 } = req

  if (!customerId) {
    // X-Customer 헤더 누락 = MCC 마스터 자체에 호출 → 사고 방지
    throw new NaverSaValidationError("customerId is required for all Naver SA calls")
  }

  // GET + cache 옵션이면 캐시 우선
  if (method === "GET" && cache) {
    const key = `nsa:${cache.kind}:${customerId}:${hashParams({ path, body })}`
    return cached<T>(key, cache.ttl, () =>
      doRequest<T>({ customerId, method, path, body, maxRetries }),
    )
  }

  return doRequest<T>({ customerId, method, path, body, maxRetries })
}

async function doRequest<T>(args: {
  customerId: string
  method: NaverSaHttpMethod
  path: string
  body?: unknown
  maxRetries: number
}): Promise<T> {
  const { customerId, method, path, body, maxRetries } = args
  const creds = await getCredentials(customerId)

  let lastErr: unknown = null
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Rate Limit 토큰 소비 (재시도 시에도 매번 소비)
    await consumeToken(customerId)

    const ts = Date.now().toString()
    // 네이버 SA 서명은 query string을 제외한 path(uri)만 사용한다.
    // (공식 Python sample: uri="/customer-links" + params={"type":"MYCLIENTS"} 별도 전달)
    const signedPath = path.split("?")[0]
    const signature = sign({
      timestamp: ts,
      method,
      path: signedPath,
      secretKey: creds.secretKey,
    })

    const headers: Record<string, string> = {
      "X-Timestamp": ts,
      "X-API-KEY": creds.apiKey,
      "X-Customer": customerId,
      "X-Signature": signature,
      Accept: "application/json",
    }
    if (body !== undefined && body !== null) {
      headers["Content-Type"] = "application/json"
    }

    let res: Response
    try {
      res = await fetch(`${baseUrl()}${path}`, {
        method,
        headers,
        body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
        cache: "no-store",
      })
    } catch {
      // 네트워크 오류 → 지수 백오프 재시도 (원인 메시지에 환경/시크릿 누출 우려 → 일반화)
      lastErr = new NaverSaUnknownError("network error", { method, path, customerId })
      await sleep(backoffMs(attempt))
      continue
    }

    // 응답 파싱 (JSON 우선, 실패 시 text)
    let parsed: unknown = null
    const text = await res.text()

    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
    }

    if (res.ok) {
      return parsed as T
    }

    const err = mapHttpToDomainError(res.status, parsed, { method, path, customerId })

    // 재시도 대상: 429 / 1016 / 5xx
    const retryable =
      res.status === 429 ||
      res.status >= 500 ||
      (typeof parsed === "object" && parsed !== null && "code" in parsed && (parsed as { code?: unknown }).code === 1016)

    if (!retryable) {
      throw err
    }

    lastErr = err
    await sleep(backoffMs(attempt))
  }

  // 한도 도달 → 마지막 에러 throw (rate limit 우선)
  if (lastErr instanceof NaverSaError) throw lastErr
  throw new NaverSaRateLimitError("Naver SA call exhausted retries", { customerId })
}

/**
 * 지수 백오프 (jitter 포함):
 *   attempt 0 → ~250ms
 *   attempt 1 → ~500ms
 *   attempt 2 → ~1s
 *   attempt 3 → ~2s
 *   attempt 4 → ~4s
 */
function backoffMs(attempt: number): number {
  const base = 250 * Math.pow(2, attempt)
  const jitter = Math.floor(Math.random() * 100)
  return Math.min(base + jitter, 8000)
}

// =============================================================================
// export
// =============================================================================

export const naverSaClient = {
  request,
}

export type NaverSaClient = typeof naverSaClient

// =============================================================================
// 테스트 전용 internal export
// =============================================================================
// 운영 코드에서는 절대 import 하지 말 것 (public surface 는 naverSaClient.request).
// 단위 테스트(client.test.ts)에서 내부 헬퍼 회귀 가드 용도로만 사용.
export const __test__ = {
  sign,
  backoffMs,
  tryConsumeToken,
  consumeToken,
  hashParams,
  bucketKey,
}
