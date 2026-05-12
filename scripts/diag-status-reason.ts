/**
 * statusReason 진단 — OFF 상태 행에서 DB statusReason 컬럼과 raw 페이로드를 비교.
 *
 * 결과 해석:
 *   - DB statusReason 비어있고 raw.statusReason 있음     → sync 로직 미적용 (production 배포 누락 가능성)
 *   - DB statusReason 비어있고 raw.statusReason 도 없음  → SA API 가 statusReason 응답에 미포함
 *   - DB statusReason 있음                                → 정상 — UI 측 미반영 (배지 컴포넌트 / RSC select 문제)
 *
 * 실행: pnpm tsx scripts/diag-status-reason.ts
 */
import { config as loadEnv } from "dotenv"
loadEnv({ path: ".env.local" })
loadEnv({ path: ".env" })

import { prisma } from "../lib/db/prisma"

function pickStatusReasonFromRaw(raw: unknown): string | null | "(no key)" {
  if (raw === null || typeof raw !== "object") return "(no key)"
  const obj = raw as Record<string, unknown>
  if (!("statusReason" in obj)) return "(no key)"
  const v = obj.statusReason
  if (v === null) return null
  if (typeof v === "string") return v
  return JSON.stringify(v)
}

async function main() {
  const campaigns = await prisma.campaign.findMany({
    where: { status: "off" },
    select: {
      nccCampaignId: true,
      name: true,
      status: true,
      statusReason: true,
      raw: true,
    },
    take: 5,
  })
  const adgroups = await prisma.adGroup.findMany({
    where: { status: "off" },
    select: {
      nccAdgroupId: true,
      name: true,
      status: true,
      statusReason: true,
      raw: true,
    },
    take: 5,
  })
  const keywords = await prisma.keyword.findMany({
    where: { status: "off" },
    select: {
      nccKeywordId: true,
      keyword: true,
      status: true,
      statusReason: true,
      raw: true,
    },
    take: 5,
  })

  console.log("=== Campaign OFF sample (max 5) ===")
  for (const c of campaigns) {
    console.log(`- ${c.nccCampaignId} ${c.name}`)
    console.log(`    DB.statusReason : ${c.statusReason ?? "(null)"}`)
    console.log(`    raw.statusReason: ${pickStatusReasonFromRaw(c.raw)}`)
  }
  console.log(`\n=== AdGroup OFF sample (max 5) ===`)
  for (const g of adgroups) {
    console.log(`- ${g.nccAdgroupId} ${g.name}`)
    console.log(`    DB.statusReason : ${g.statusReason ?? "(null)"}`)
    console.log(`    raw.statusReason: ${pickStatusReasonFromRaw(g.raw)}`)
  }
  console.log(`\n=== Keyword OFF sample (max 5) ===`)
  for (const k of keywords) {
    console.log(`- ${k.nccKeywordId} ${k.keyword}`)
    console.log(`    DB.statusReason : ${k.statusReason ?? "(null)"}`)
    console.log(`    raw.statusReason: ${pickStatusReasonFromRaw(k.raw)}`)
  }

  // 카운트 — 전체 / OFF / statusReason 있는 행
  const cCount = await prisma.campaign.count()
  const cOff = await prisma.campaign.count({ where: { status: "off" } })
  const cWithReason = await prisma.campaign.count({
    where: { statusReason: { not: null } },
  })
  const gCount = await prisma.adGroup.count()
  const gOff = await prisma.adGroup.count({ where: { status: "off" } })
  const gWithReason = await prisma.adGroup.count({
    where: { statusReason: { not: null } },
  })
  const kCount = await prisma.keyword.count()
  const kOff = await prisma.keyword.count({ where: { status: "off" } })
  const kWithReason = await prisma.keyword.count({
    where: { statusReason: { not: null } },
  })

  console.log(`\n=== Counts (total / off / has statusReason) ===`)
  console.log(`Campaign : ${cCount} / ${cOff} / ${cWithReason}`)
  console.log(`AdGroup  : ${gCount} / ${gOff} / ${gWithReason}`)
  console.log(`Keyword  : ${kCount} / ${kOff} / ${kWithReason}`)

  // 매핑 누락 진단 — DB 에 등장하는 모든 statusReason DISTINCT 값을 카운트별로 출력.
  // 한글 라벨 매핑(lib/dashboard/status-reason-labels.ts) 보완 시 본 출력을 그대로 활용.
  const cGroups = await prisma.campaign.groupBy({
    by: ["statusReason"],
    _count: { _all: true },
  })
  const gGroups = await prisma.adGroup.groupBy({
    by: ["statusReason"],
    _count: { _all: true },
  })
  const kGroups = await prisma.keyword.groupBy({
    by: ["statusReason"],
    _count: { _all: true },
  })

  console.log(`\n=== Distinct statusReason (Campaign) ===`)
  for (const r of cGroups.sort((a, b) => b._count._all - a._count._all)) {
    console.log(`  ${(r.statusReason ?? "(null)").padEnd(40)} ${r._count._all}`)
  }
  console.log(`\n=== Distinct statusReason (AdGroup) ===`)
  for (const r of gGroups.sort((a, b) => b._count._all - a._count._all)) {
    console.log(`  ${(r.statusReason ?? "(null)").padEnd(40)} ${r._count._all}`)
  }
  console.log(`\n=== Distinct statusReason (Keyword) ===`)
  for (const r of kGroups.sort((a, b) => b._count._all - a._count._all)) {
    console.log(`  ${(r.statusReason ?? "(null)").padEnd(40)} ${r._count._all}`)
  }

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
