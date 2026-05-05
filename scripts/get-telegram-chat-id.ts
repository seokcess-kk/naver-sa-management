/**
 * Telegram getUpdates 호출 — 봇이 받은 최근 메시지의 chat_id 확인.
 *
 * 사용:
 *   1. Telegram 앱에서 본인 봇과 대화 열기 → /start 또는 아무 메시지
 *   2. pnpm dlx tsx scripts/get-telegram-chat-id.ts
 *   3. 출력된 chat.id 를 .env.local 의 TELEGRAM_CHAT_ID 에 그대로 넣기
 *
 * 참고: getUpdates 는 webhook 미설정 봇 한정. 운영에서는 호출 X.
 */

import { config as loadEnv } from "dotenv"

loadEnv({ path: ".env.local" })
loadEnv({ path: ".env" })

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN 미설정")
    process.exit(1)
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`)
  const data = (await res.json()) as {
    ok: boolean
    result?: Array<{
      update_id: number
      message?: {
        from?: { id: number; first_name?: string; username?: string }
        chat: { id: number; type: string; title?: string; username?: string }
        text?: string
        date: number
      }
    }>
    description?: string
  }

  if (!data.ok) {
    console.error("API 에러:", data.description)
    process.exit(1)
  }

  const updates = data.result ?? []
  if (updates.length === 0) {
    console.log("최근 메시지 없음. Telegram 앱에서 본인 봇과 대화 시작 (/start) 후 재실행.")
    return
  }

  console.log(`최근 ${updates.length} 건 메시지 (마지막부터):`)
  for (const u of updates.slice(-5).reverse()) {
    const m = u.message
    if (!m) continue
    const from = m.from?.username ? `@${m.from.username}` : m.from?.first_name ?? "unknown"
    console.log(
      `  chat.id=${m.chat.id} type=${m.chat.type} from=${from} text="${(m.text ?? "").slice(0, 40)}"`,
    )
  }
  console.log("\n위 chat.id 중 본인과의 1:1 대화(type=private)의 id 를 TELEGRAM_CHAT_ID 에 설정.")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
