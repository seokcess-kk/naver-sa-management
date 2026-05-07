import { config as loadEnv } from "dotenv"
loadEnv({ path: ".env.local" })
loadEnv({ path: ".env" })

import { prisma } from "../lib/db/prisma"

async function main() {
  const advertisers = await prisma.advertiser.findMany({
    where: { status: "active" },
    select: {
      id: true, customerId: true, name: true,
      biddingKillSwitch: true, guardrailEnabled: true,
      apiKeyEnc: true, secretKeyEnc: true,
    },
  })
  const advList = advertisers.map((a) => ({
    id: a.id, customerId: a.customerId, name: a.name,
    biddingKillSwitch: a.biddingKillSwitch, guardrailEnabled: a.guardrailEnabled,
    hasApiKey: !!a.apiKeyEnc, hasSecretKey: !!a.secretKeyEnc,
  }))

  const configs = await prisma.bidAutomationConfig.findMany()
  const profiles = await prisma.keywordPerformanceProfile.findMany()
  const policiesEnabled = await prisma.biddingPolicy.count({ where: { enabled: true } })
  const policiesTotal = await prisma.biddingPolicy.count()
  const suggPending = await prisma.bidSuggestion.count({ where: { status: "pending" } })
  const suggTotal = await prisma.bidSuggestion.count()
  const statDailyByAdv = await prisma.statDaily.groupBy({
    by: ["advertiserId"],
    _max: { date: true, updatedAt: true },
    _count: { _all: true },
  })

  console.log("=== Active Advertisers ===")
  console.log(JSON.stringify(advList, null, 2))
  console.log("\n=== BidAutomationConfig ===")
  console.log(JSON.stringify(configs, null, 2))
  console.log("\n=== KeywordPerformanceProfile ===")
  console.log(JSON.stringify(profiles, null, 2))
  console.log("\n=== BiddingPolicy ===", { total: policiesTotal, enabled: policiesEnabled })
  console.log("\n=== BidSuggestion ===", { total: suggTotal, pending: suggPending })
  console.log("\n=== StatDaily latest per advertiser ===")
  console.log(JSON.stringify(statDailyByAdv, null, 2))

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
