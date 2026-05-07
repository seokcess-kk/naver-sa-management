import { config } from "dotenv"
config({ path: ".env.local" })
import { prisma } from "../lib/db/prisma"

async function main() {
  const all = await prisma.changeBatch.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      action: true,
      status: true,
      total: true,
      processed: true,
      attempt: true,
      leaseOwner: true,
      leaseExpiresAt: true,
      createdAt: true,
      finishedAt: true,
    },
  })
  console.log("=== Recent 10 ChangeBatch ===")
  for (const b of all) {
    console.log({
      id: b.id,
      action: b.action,
      status: b.status,
      progress: `${b.processed}/${b.total}`,
      attempt: b.attempt,
      leaseOwner: b.leaseOwner,
      leaseExpiresAt: b.leaseExpiresAt?.toISOString() ?? null,
      createdAt: b.createdAt.toISOString(),
      finishedAt: b.finishedAt?.toISOString() ?? null,
    })
  }
  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
