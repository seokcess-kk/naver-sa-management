/**
 * 네이버 SA API 도메인 에러 클래스
 *
 * 매핑 (SPEC 8.2 / naver-sa-specialist):
 *   429, 1016 → NaverSaRateLimitError
 *   1014      → NaverSaValidationError
 *   401       → NaverSaAuthError
 *   그 외      → NaverSaUnknownError
 *
 * 모든 에러는 호출부 (backend-engineer) 가 catch.
 * 에러 메시지에 시크릿/평문 키 노출 금지.
 */

export type NaverSaErrorContext = {
  /** HTTP 상태 코드 */
  status?: number
  /** 네이버 SA 응답 코드 (예: 1014, 1016) */
  code?: number | string
  /** 호출 메서드/경로 (디버깅용) */
  method?: string
  path?: string
  /** 광고주 customerId (디버깅용 — 마스터 키는 절대 X) */
  customerId?: string
  /** 네이버 응답 raw (선택) */
  raw?: unknown
}

export class NaverSaError extends Error {
  readonly context: NaverSaErrorContext
  constructor(message: string, context: NaverSaErrorContext = {}) {
    super(message)
    this.name = "NaverSaError"
    this.context = context
  }
}

/** 429 / 1016 — Rate Limit 도달 (지수 백오프 후에도 실패 시) */
export class NaverSaRateLimitError extends NaverSaError {
  constructor(message = "Naver SA rate limit exceeded", context: NaverSaErrorContext = {}) {
    super(message, context)
    this.name = "NaverSaRateLimitError"
  }
}

/** 1014 등 — 응답 형식·요청 검증 오류 (Zod 검증 실패 포함) */
export class NaverSaValidationError extends NaverSaError {
  constructor(message = "Naver SA validation error", context: NaverSaErrorContext = {}) {
    super(message, context)
    this.name = "NaverSaValidationError"
  }
}

/** 401 — 인증 실패 (키 만료·잘못된 서명) */
export class NaverSaAuthError extends NaverSaError {
  constructor(message = "Naver SA authentication failed", context: NaverSaErrorContext = {}) {
    super(message, context)
    this.name = "NaverSaAuthError"
  }
}

/** 그 외 (5xx, 네트워크 등) */
export class NaverSaUnknownError extends NaverSaError {
  constructor(message = "Naver SA unknown error", context: NaverSaErrorContext = {}) {
    super(message, context)
    this.name = "NaverSaUnknownError"
  }
}

/**
 * HTTP 응답 → 도메인 에러 매핑.
 *
 * 네이버 SA 응답 body 구조 (관찰 기준):
 *   { code: number, status: string, title: string, ... }
 *
 * @internal client.ts에서만 호출
 */
export function mapHttpToDomainError(
  status: number,
  body: unknown,
  context: Omit<NaverSaErrorContext, "status" | "code" | "raw">,
): NaverSaError {
  const code =
    typeof body === "object" && body !== null && "code" in body
      ? (body as { code?: number | string }).code
      : undefined
  const title =
    typeof body === "object" && body !== null && "title" in body
      ? String((body as { title?: unknown }).title ?? "")
      : ""

  const ctx: NaverSaErrorContext = { ...context, status, code, raw: body }

  if (status === 401) {
    return new NaverSaAuthError(title || "Authentication failed", ctx)
  }
  if (status === 429 || code === 1016) {
    return new NaverSaRateLimitError(title || "Rate limit exceeded", ctx)
  }
  if (code === 1014) {
    return new NaverSaValidationError(title || "Validation error", ctx)
  }
  return new NaverSaUnknownError(title || `HTTP ${status}`, ctx)
}
