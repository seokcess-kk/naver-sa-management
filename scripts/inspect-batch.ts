import { config } from "dotenv"
config({ path: ".env.local" })
import { prisma } from "../lib/db/prisma"

async function main() {
  const items = await prisma.changeItem.findMany({
    where: { batchId: "cmouuvgbp000004l2o335vw3x", status: "failed" },
    take: 2,
    select: { id: true, targetId: true, after: true, error: true },
  })
  for (const it of items) console.log("FAILED:", JSON.stringify(it, null, 2))

  const csv = await prisma.changeItem.findMany({
    where: { batch: { action: "keyword.csv" } },
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { batchId: true, after: true, status: true, error: true, createdAt: true },
  })
  for (const it of csv) console.log("CSV recent:", JSON.stringify(it, null, 2).slice(0, 1000))

  // bid_inbox.apply 도 확인 (cron에서 동작 확인된 액션)
  const inbox = await prisma.changeItem.findMany({
    where: { batch: { action: "bid_inbox.apply" } },
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { batchId: true, status: true, error: true, createdAt: true, batch: { select: { status: true, finishedAt: true } } },
  })
  for (const it of inbox) console.log("inbox recent:", JSON.stringify(it, null, 2).slice(0, 600))

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
