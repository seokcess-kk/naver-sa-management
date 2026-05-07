/**
 * ENCRYPTION_KEY fingerprint 출력 — 평문/full key 노출 없이 비교용 hash 만 출력.
 *
 * 용도:
 *   - 로컬 .env.local 의 ENCRYPTION_KEY 와 Vercel 대시보드의 값이 정말 같은지 확인.
 *   - 사람이 64 hex chars 를 눈으로 비교하면 1글자 차이를 놓치기 쉬움 → SHA-256 short hash 로 비교.
 *
 * 사용:
 *   pnpm dlx tsx scripts/fingerprint-encryption-key.ts
 *
 *   # Vercel 측: 대시보드에서 ENCRYPTION_KEY 값을 복사 → 임시 셸에서 동일 hash 산출 후 비교.
 *   # 또는 prod 빌드에 진단 라우트를 1회 노출하지 말 것 — 키 hash 자체는 안전하지만 운영 노이즈 유발.
 */
import { createHash } from "node:crypto"
import { config as loadEnv } from "dotenv"
loadEnv({ path: ".env.local" })
loadEnv({ path: ".env" })

const raw = process.env.ENCRYPTION_KEY
if (!raw) {
  console.error("ENCRYPTION_KEY 미설정")
  process.exit(1)
}

const len = raw.length
let bytes = 0
let validHex = false
try {
  bytes = Buffer.from(raw, "hex").length
  validHex = bytes === 32
} catch {}

const sha = createHash("sha256").update(raw, "utf8").digest("hex")

console.log("=== ENCRYPTION_KEY fingerprint ===")
console.log(`chars                      : ${len}`)
console.log(`hex bytes                  : ${bytes}`)
console.log(`valid 32B hex              : ${validHex}`)
console.log(`first 4 chars              : ${raw.slice(0, 4)}`)
console.log(`last 4 chars               : ${raw.slice(-4)}`)
console.log(`sha256(key) first 16 hex   : ${sha.slice(0, 16)}`)
console.log("\nVercel 대시보드의 ENCRYPTION_KEY 값으로 같은 hash 가 나오면 100% 동일.")
console.log("first/last 4 chars 가 다르면 즉시 키 미스매치 확정.")
