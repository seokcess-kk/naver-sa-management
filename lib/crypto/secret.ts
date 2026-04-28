/**
 * 시크릿 암복호화 유틸 (AES-256-GCM)
 *
 * 운영 정책 (SPEC 8.1 / CLAUDE.md "핵심 안전장치 4"):
 * - 키는 `ENCRYPTION_KEY` env (32바이트 hex 인코딩)
 * - DB 컬럼: `secretKeyEnc` (Buffer/Bytea) + `secretKeyVersion` (정수)
 * - 평문 로그·에러 메시지·Sentry 노출 절대 금지
 * - 향후 로테이션 시 신키 사용 + version 증가 (현재 v1 고정)
 *
 * 형식 (단일 Buffer 직렬화):
 *   [ IV(12B) | TAG(16B) | CIPHERTEXT(N) ]
 *   - GCM IV는 12바이트 권장
 *   - GCM Auth Tag는 16바이트 (기본)
 *   - 복호화 시 동일 키 + 동일 IV + Tag 검증
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto"

const ALGO = "aes-256-gcm"
const IV_LEN = 12
const TAG_LEN = 16
const CURRENT_VERSION = 1

export type EncryptedSecret = {
  enc: Buffer
  version: number
}

/**
 * ENCRYPTION_KEY를 안전하게 로딩.
 * - 32바이트(=64 hex chars)만 허용
 * - 키 자체를 throw 메시지에 노출하지 않음
 */
function loadKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) {
    // 평문 노출 없음. 환경 변수 부재만 알림.
    throw new Error("ENCRYPTION_KEY is not set")
  }
  let key: Buffer
  try {
    key = Buffer.from(raw, "hex")
  } catch {
    throw new Error("ENCRYPTION_KEY must be hex-encoded")
  }
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 32 bytes (64 hex chars)")
  }
  return key
}

/**
 * 평문 → 암호문 (AES-256-GCM)
 *
 * 반환 enc 형식: [ IV(12B) | TAG(16B) | CIPHERTEXT(N) ]
 * version은 현재 고정 1. 키 로테이션 시 version 분기 추가.
 *
 * 평문 로그 금지: 함수 내부에서도 plainText를 console / 외부 모듈로 흘리지 않음.
 */
export function encrypt(plainText: string): EncryptedSecret {
  if (typeof plainText !== "string") {
    // 타입 가드. 메시지에 값 노출 X
    throw new Error("encrypt: plainText must be a string")
  }
  const key = loadKey()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, key, iv)
  const ct = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  if (tag.length !== TAG_LEN) {
    // 이론상 불가. 방어 코드.
    throw new Error("encrypt: unexpected auth tag length")
  }
  return {
    enc: Buffer.concat([iv, tag, ct]),
    version: CURRENT_VERSION,
  }
}

/**
 * 암호문 → 평문 (AES-256-GCM)
 *
 * - version 1만 지원. 향후 신키 도입 시 분기 추가.
 * - Tag 검증 실패 시 throw (메시지에 평문/키 노출 X).
 */
export function decrypt(enc: Buffer, version: number): string {
  if (version !== CURRENT_VERSION) {
    throw new Error(`decrypt: unsupported secret version: ${version}`)
  }
  if (!Buffer.isBuffer(enc) || enc.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("decrypt: invalid encrypted payload")
  }
  const key = loadKey()
  const iv = enc.subarray(0, IV_LEN)
  const tag = enc.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ct = enc.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  try {
    const pt = Buffer.concat([decipher.update(ct), decipher.final()])
    return pt.toString("utf8")
  } catch {
    // GCM 인증 실패 시 노드는 generic 에러를 던짐.
    // 메시지에 키/평문 정보 누출 없도록 단순화.
    throw new Error("decrypt: authentication failed")
  }
}

/**
 * 두 시크릿이 동일한지 timing-safe 비교 (선택 유틸).
 * 길이 다르면 즉시 false (정보 누출 없음 — 길이는 식별자가 아님).
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * 평문 시크릿을 로그·UI용으로 마스킹.
 * 8자 미만은 전체 마스킹. 그 이상은 앞 4 + "****" + 뒤 4.
 *
 * 예: mask("ABCDEFGHIJKLMNOP") => "ABCD****MNOP"
 *     mask("short")           => "********"
 */
export function mask(plainText: string): string {
  if (typeof plainText !== "string") return "********"
  if (plainText.length < 8) return "********"
  return `${plainText.slice(0, 4)}****${plainText.slice(-4)}`
}
