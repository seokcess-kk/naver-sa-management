/**
 * Telegram 채널 수동 발송 테스트 스크립트.
 *
 * 사용:
 *   pnpm tsx scripts/send-test-telegram.ts
 *
 * 검증:
 *   - .env.local 의 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 가 활성 채널로 픽업되는지
 *   - dispatch() 가 log + telegram 두 채널 모두 호출하는지
 *   - 3 severity 메시지 (info / warn / critical) 가 실제 도착하는지
 *
 * 비대상:
 *   - DB 적재 (AlertEvent) — dispatch 자체만 호출. 실 알림 흐름은 cron 통해 확인
 */

import { config as loadEnv } from "dotenv"

// Next.js 가 자동 로드하는 .env.local 을 스크립트 실행 시에도 명시적으로 픽업.
loadEnv({ path: ".env.local" })
loadEnv({ path: ".env" })

import { dispatch, getChannels } from "@/lib/notifier"
import type { NotificationPayload } from "@/lib/notifier/types"

async function main() {
  const channels = getChannels().map((c) => c.name)
  console.log(`활성 채널: ${channels.join(", ")}`)
  if (!channels.includes("telegram")) {
    console.error("telegram 채널 미활성. TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID 확인.")
    process.exit(1)
  }

  const samples: NotificationPayload[] = [
    {
      ruleType: "test_info",
      severity: "info",
      title: "Telegram 채널 연결 테스트 (info)",
      body: "이 메시지가 보이면 텔레그램 채널이 정상 활성화된 상태입니다.",
    },
    {
      ruleType: "budget_burn",
      severity: "warn",
      title: "예산 80% 소진 (샘플)",
      body: "캠페인 X 의 일 예산 100,000 원 중 80,000 원 사용. 일 페이스 추정 110%.",
    },
    {
      ruleType: "bizmoney_low",
      severity: "critical",
      title: "비즈머니 부족 (샘플)",
      body: "광고주 ABC 비즈머니 잔액이 일 평균 예산 3 일치 미만입니다.",
    },
  ]

  for (const p of samples) {
    const r = await dispatch(p)
    console.log(`[${p.severity}] ${p.title}`)
    for (const item of r.results) {
      const tag = item.ok ? "OK" : `FAIL: ${item.error}`
      console.log(`  - ${item.channel}: ${tag}`)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
