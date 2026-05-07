/**
 * 광고주 시크릿 복호화 진단 — secretKeyVersion / 페이로드 길이 / 복호화 가부 확인.
 *
 * 사용:
 *   pnpm dlx tsx scripts/probe-decrypt.ts
 *
 * 출력 결과로 ENCRYPTION_KEY 미스매치 여부 판정. 평문은 절대 출력 X.
 */
import { config as loadEnv } from "dotenv"
loadEnv({ path: ".env.local" })
loadEnv({ path: ".env" })

import { prisma } from "../lib/db/prisma"
import { decrypt } from "../lib/crypto/secret"

async function main() {
  const advertisers = await prisma.advertiser.findMany({
    where: { status: "active" },
    select: {
      id: true,
      customerId: true,
      name: true,
      apiKeyEnc: true,
      apiKeyVersion: true,
      secretKeyEnc: true,
      secretKeyVersion: true,
    },
  })

  for (const a of advertisers) {
    console.log(`\n--- ${a.name} (${a.customerId}) ---`)
    console.log(`apiKeyVersion=${a.apiKeyVersion} secretKeyVersion=${a.secretKeyVersion}`)
    console.log(`apiKeyEnc.length=${a.apiKeyEnc?.length ?? null} secretKeyEnc.length=${a.secretKeyEnc?.length ?? null}`)

    if (a.apiKeyEnc && a.apiKeyVersion != null) {
      try {
        const pt = decrypt(Buffer.from(a.apiKeyEnc), a.apiKeyVersion)
        console.log(`API 자격증명 복호화: OK (length=${pt.length})`)
      } catch (e) {
        console.log(`API 자격증명 복호화: FAIL — ${(e as Error).message}`)
      }
    }
    if (a.secretKeyEnc && a.secretKeyVersion != null) {
      try {
        const pt = decrypt(Buffer.from(a.secretKeyEnc), a.secretKeyVersion)
        console.log(`Secret 자격증명 복호화: OK (length=${pt.length})`)
      } catch (e) {
        console.log(`Secret 자격증명 복호화: FAIL — ${(e as Error).message}`)
      }
    }
    console.log(`apiKeyEnc isUint8Array=${a.apiKeyEnc instanceof Uint8Array} isBuffer=${Buffer.isBuffer(a.apiKeyEnc)}`)
    console.log(`apiKeyEnc.first8(hex)=${Buffer.from(a.apiKeyEnc!).subarray(0, 8).toString("hex")}`)
  }

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
