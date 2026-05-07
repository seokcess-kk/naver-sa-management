/**
 * 최근 sync_keywords ChangeBatch 의 실패 ChangeItem 에러 메시지 그룹별 카운트.
 *
 * 사용:
 *   pnpm dlx tsx scripts/check-sync-failures.ts
 */
import { config as loadEnv } from "dotenv"
loadEnv({ path: ".env.local" })
loadEnv({ path: ".env" })

import { prisma } from "../lib/db/prisma"

async function main() {
  const recent = await prisma.changeBatch.findMany({
    where: { action: "sync_keywords" },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      status: true,
      total: true,
      processed: true,
      attempt: true,
      summary: true,
      createdAt: true,
      finishedAt: true,
    },
  })

  for (const b of recent) {
    console.log("\n=== ChangeBatch ===")
    console.log({
      id: b.id,
      status: b.status,
      total: b.total,
      processed: b.processed,
      attempt: b.attempt,
      createdAt: b.createdAt.toISOString(),
      finishedAt: b.finishedAt?.toISOString() ?? null,
      summary: b.summary,
    })

    const counts = await prisma.changeItem.groupBy({
      by: ["status"],
      where: { batchId: b.id },
      _count: true,
    })
    console.log("counts:", Object.fromEntries(counts.map((c) => [c.status, c._count])))

    const failed = await prisma.changeItem.findMany({
      where: { batchId: b.id, status: "failed" },
      select: { id: true, targetId: true, error: true, attempt: true },
    })
    if (failed.length === 0) continue

    // error 메시지별 그룹핑
    const byMsg = new Map<string, { count: number; sampleTargets: string[] }>()
    for (const f of failed) {
      const msg = (f.error ?? "(no error)").slice(0, 200)
      const cur = byMsg.get(msg) ?? { count: 0, sampleTargets: [] }
      cur.count += 1
      if (cur.sampleTargets.length < 3 && f.targetId) {
        cur.sampleTargets.push(f.targetId)
      }
      byMsg.set(msg, cur)
    }

    console.log("\nfailed by error message:")
    const sorted = Array.from(byMsg.entries()).sort((a, b) => b[1].count - a[1].count)
    for (const [msg, v] of sorted) {
      console.log(`  [${v.count}] ${msg}`)
      console.log(`     samples: ${v.sampleTargets.join(", ")}`)
    }
  }

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
