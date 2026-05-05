/**
 * lib/notifier/telegram.ts 단위 테스트.
 *
 * 외부 호출 0:
 *   - global.fetch mock — 실 Telegram API 호출 X
 *
 * 검증 범위:
 *   - env 미설정 시 ok=false + 명확한 error
 *   - 정상 응답 (200) → ok=true, fetch 호출 인자 정확
 *   - API 4xx → ok=false + status 포함, URL 노출 X (토큰 보호)
 *   - fetch throw → ok=false + error message
 *   - formatTelegramMessage: 이모지 prefix + HTML escape + ruleType 푸터
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { formatTelegramMessage, telegramChannel } from "./telegram"
import type { NotificationPayload } from "./types"

const basePayload: NotificationPayload = {
  ruleType: "budget_burn",
  severity: "warn",
  title: "예산 80% 소진",
  body: "캠페인 X 의 일 예산 100,000 원 중 80,000 원 사용",
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  vi.resetAllMocks()
  process.env = { ...ORIGINAL_ENV }
  delete process.env.TELEGRAM_BOT_TOKEN
  delete process.env.TELEGRAM_CHAT_ID
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("formatTelegramMessage", () => {
  it("severity=warn → 🟡 이모지 + 굵은 제목 + 본문 + ruleType 푸터", () => {
    const out = formatTelegramMessage(basePayload)
    expect(out).toContain("🟡 <b>예산 80% 소진</b>")
    expect(out).toContain("캠페인 X 의 일 예산 100,000 원 중 80,000 원 사용")
    expect(out).toContain("<i>budget_burn</i>")
  })

  it("severity=critical → 🔴, info → ℹ️ 매핑", () => {
    expect(formatTelegramMessage({ ...basePayload, severity: "critical" })).toContain("🔴")
    expect(formatTelegramMessage({ ...basePayload, severity: "info" })).toContain("ℹ️")
  })

  it("title/body 의 HTML 특수문자 escape (<, >, &)", () => {
    const out = formatTelegramMessage({
      ...basePayload,
      title: "<script>alert(1)</script>",
      body: "A & B > C",
    })
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(out).toContain("A &amp; B &gt; C")
    expect(out).not.toContain("<script>")
  })
})

describe("telegramChannel.send — env 가드", () => {
  it("TELEGRAM_BOT_TOKEN 없음 → ok=false + 명확한 error", async () => {
    const r = await telegramChannel.send(basePayload)
    expect(r).toEqual({ ok: false, error: "TELEGRAM_BOT_TOKEN not configured" })
  })

  it("TOKEN 있고 CHAT_ID 없음 → ok=false + 명확한 error", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:abc"
    const r = await telegramChannel.send(basePayload)
    expect(r).toEqual({ ok: false, error: "TELEGRAM_CHAT_ID not configured" })
  })
})

describe("telegramChannel.send — 정상/에러 흐름", () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "123:abc"
    process.env.TELEGRAM_CHAT_ID = "987654"
  })

  it("200 응답 → ok=true, fetch 호출 인자 검증", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const r = await telegramChannel.send(basePayload)
    expect(r).toEqual({ ok: true })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://api.telegram.org/bot123:abc/sendMessage")
    expect(init.method).toBe("POST")
    const body = JSON.parse(init.body)
    expect(body.chat_id).toBe("987654")
    expect(body.parse_mode).toBe("HTML")
    expect(body.disable_web_page_preview).toBe(true)
    expect(body.text).toContain("🟡 <b>예산 80% 소진</b>")
  })

  it("4xx 응답 → ok=false + status 포함 + URL(토큰) 노출 X", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"ok":false,"description":"chat not found"}', { status: 400 }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const r = await telegramChannel.send(basePayload)
    expect(r.ok).toBe(false)
    expect(r.error).toContain("400")
    expect(r.error).toContain("chat not found")
    expect(r.error).not.toContain("123:abc")
    expect(r.error).not.toContain("api.telegram.org")
  })

  it("fetch throw → ok=false + error message 환원", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"))
    vi.stubGlobal("fetch", fetchMock)

    const r = await telegramChannel.send(basePayload)
    expect(r).toEqual({ ok: false, error: "network down" })
  })
})
