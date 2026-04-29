/**
 * Vitest 설정
 *
 * 적용 범위:
 *  - 시크릿 암복호화 / 마스킹 단위 테스트
 *  - audit sanitize 단위 테스트
 *  - 정적 누설 가드 (tests/secret-leak-static.test.ts)
 *
 * 정책:
 *  - Node 환경 (DOM 불필요. brower 컴포넌트는 Playwright 담당)
 *  - tsconfig paths(`@/*` → 루트) 인식 위해 alias 직접 매핑
 *  - Prisma 생성물(lib/generated/**) 수집 제외 — 생성 코드를 vitest가 파싱 시 메모리 폭주
 */

import { defineConfig } from "vitest/config"
import { resolve } from "node:path"

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/lib/generated/**",
      "**/.next/**",
      "**/e2e/**",
    ],
  },
})
