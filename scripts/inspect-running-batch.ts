import { config } from "dotenv"
config({ path: ".env.local" })
import { prisma } from "../lib/db/prisma"

async function main() {
  const batchId = "cmouv8sim000004l8wselyjp9"
  const counts = await prisma.changeItem.groupBy({
    by: ["status"],
    where: { batchId },
    _count: true,
  })
  console.log("counts:", Object.fromEntries(counts.map((c) => [c.status, c._count])))

  const sample = await prisma.changeItem.findMany({
    where: { batchId },
    take: 3,
    select: { id: true, status: true, error: true, attempt: true, targetId: true, after: true },
  })
  for (const it of sample) console.log(JSON.stringify(it, null, 2))

  // 실패 에러 메시지 그룹
  const failed = await prisma.changeItem.findMany({
    where: { batchId, status: "failed" },
    select: { error: true },
  })
  const byMsg = new Map<string, number>()
  for (const f of failed) {
    const k = (f.error ?? "(none)").slice(0, 200)
    byMsg.set(k, (byMsg.get(k) ?? 0) + 1)
  }
  console.log("\nfailed error groups:")
  for (const [m, c] of [...byMsg.entries()].sort((a, b) => b[1] - a[1])) console.log(`  [${c}] ${m}`)

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
