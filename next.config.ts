import type { NextConfig } from "next"
import { withSentryConfig } from "@sentry/nextjs"

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // F-5.3 이미지 확장소재: 5MB 이미지 base64 + 메타. 여유 6MB.
      bodySizeLimit: "6mb",
    },
  },
}

/**
 * Sentry 빌드 통합 (F-8.4).
 *
 * 정책:
 *   - SENTRY_AUTH_TOKEN 미설정 시 source map upload 자동 skip (SDK 자체 동작)
 *   - SENTRY_ORG / SENTRY_PROJECT 미설정 시도 빌드 자체는 통과
 *   - automaticVercelMonitors=false: Vercel Cron 자동 모니터 OFF (명시 등록 정책)
 *   - silent: CI 외 환경에서 빌드 로그 조용히
 *   - widenClientFileUpload: 클라이언트 청크 source map 업로드 범위 확장
 *   - disableLogger: production 번들에서 SDK 자체 로거 statement 제거
 */
export default withSentryConfig(nextConfig, {
  silent: !process.env.CI,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  automaticVercelMonitors: false,
  widenClientFileUpload: true,
  disableLogger: true,
})
