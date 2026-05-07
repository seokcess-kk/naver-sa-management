import { config as loadEnv } from "dotenv"
loadEnv({ path: ".env.local" })
loadEnv({ path: ".env" })
import { prisma } from "../lib/db/prisma"

async function main() {
  const adv = "cmoi1lmm80000zoubcyqsevd0"
  const [campaigns, adgroups, keywords, kwExplicit, policiesEnabled, bsnchannels] = await Promise.all([
    prisma.campaign.count({ where: { advertiserId: adv } }),
    prisma.adGroup.count({ where: { campaign: { advertiserId: adv } } }),
    prisma.keyword.count({ where: { adgroup: { campaign: { advertiserId: adv } } } }),
    prisma.keyword.count({ where: { adgroup: { campaign: { advertiserId: adv } }, useGroupBidAmt: false } }),
    prisma.biddingPolicy.count({ where: { advertiserId: adv, enabled: true } }),
    Promise.resolve("n/a"),
  ])
  console.log({ campaigns, adgroups, keywords, kwExplicit, policiesEnabled, bsnchannels })
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
