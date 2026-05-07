/**
 * 운영 inbox(BidSuggestion) 부트스트랩 — Cron 3종 직렬 트리거.
 *
 * 순서:
 *   1. /api/cron/stat-daily            — 일별 성과 적재 (네이버 SA StatReport AD_DETAIL)
 *   2. /api/cron/keyword-perf-profile  — KeywordPerformanceProfile baseline 재계산
 *   3. /api/cron/bid-suggest           — BidSuggestion(Inbox) 권고 적재
 *
 * 사용:
 *   pnpm dev   # 별도 터미널에서 실행 중이어야 함 (기본 base url: http://localhost:3000)
 *   pnpm dlx tsx scripts/bootstrap-inbox.ts
 *
 *   # 프로덕션 / 다른 호스트 대상:
 *   BOOTSTRAP_BASE_URL=https://your-domain.com pnpm dlx tsx scripts/bootstrap-inbox.ts
 *
 *   # 일부 단계만 (skip): SKIP=stat-daily,keyword-perf-profile pnpm dlx tsx scripts/bootstrap-inbox.ts
 *
 * 정책:
 *   - Authorization: Bearer ${CRON_SECRET} 헤더 자동 부착
 *   - 단계별 응답 JSON 출력 + ok=false 시 즉시 중단 (다음 단계가 직전 단계 산출물에 의존)
 *   - 운영용 자동화 트리거 X — 1회성 진단·복구 도구
 */

import { config as loadEnv } from "dotenv"

loadEnv({ path: ".env.local" })
loadEnv({ path: ".env" })

type Step = {
  name: string
  path: string
}

const STEPS: Step[] = [
  { name: "stat-daily", path: "/api/cron/stat-daily" },
  { name: "keyword-perf-profile", path: "/api/cron/keyword-perf-profile" },
  { name: "bid-suggest", path: "/api/cron/bid-suggest" },
]

async function runStep(baseUrl: string, secret: string, step: Step): Promise<void> {
  const url = `${baseUrl}${step.path}`
  const startedAt = Date.now()
  console.log(`\n▶ [${step.name}] GET ${url}`)

  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${secret}` },
  })

  const elapsedMs = Date.now() - startedAt
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }

  console.log(`  status=${res.status} elapsed=${elapsedMs}ms`)
  console.log("  response:")
  console.log(
    JSON.stringify(body, null, 2)
      .split("\n")
      .map((l) => "    " + l)
      .join("\n"),
  )

  if (!res.ok) {
    throw new Error(`[${step.name}] HTTP ${res.status}`)
  }
  if (
    body !== null &&
    typeof body === "object" &&
    "ok" in body &&
    (body as { ok: unknown }).ok === false
  ) {
    throw new Error(`[${step.name}] response.ok=false`)
  }
}

async function main() {
  const baseUrl = (process.env.BOOTSTRAP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "")
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error("cron 인증 환경변수 미설정 — .env.local 에 정의 필요")
    process.exit(1)
  }

  const skip = new Set(
    (process.env.SKIP ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )

  console.log(`baseUrl=${baseUrl}`)
  console.log(`steps=${STEPS.map((s) => s.name).join(" → ")}`)
  if (skip.size > 0) console.log(`skip=${[...skip].join(",")}`)

  for (const step of STEPS) {
    if (skip.has(step.name)) {
      console.log(`\n⏭ [${step.name}] skipped (SKIP env)`)
      continue
    }
    await runStep(baseUrl, secret, step)
  }

  console.log("\n✔ 완료. /admin/bidding 또는 /[advertiserId]/bid-inbox 에서 권고 확인.")
}

main().catch((e) => {
  console.error(`\n✖ 실패: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
