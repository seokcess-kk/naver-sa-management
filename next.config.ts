import path from "node:path"
import { fileURLToPath } from "node:url"

import type { NextConfig } from "next"
import { withSentryConfig } from "@sentry/nextjs"

// next.config.ts 파일 자체 위치 기준 — 부모 `solution/` 디렉터리에 다른
// 프로젝트들이 함께 있어 Turbopack 의 lockfile lookup 이 root 를 부모로
// 잘못 잡고 모듈 해석에 실패하는 것을 방지한다 (Tailwind 4 `@import "tailwindcss"`
// 가 `solution/`에서 안 풀리는 증상). dev 서버 실행 위치와 무관하게 고정.
const projectRoot = path.dirname(fileURLToPath(import.meta.url))

const nextConfig: NextConfig = {
  outputFileTracingRoot: projectRoot,
  turbopack: {
    root: projectRoot,
  },
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
