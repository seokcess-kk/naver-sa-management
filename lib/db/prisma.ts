/**
 * Prisma 싱글턴 클라이언트
 *
 * - import 경로: schema.prisma 의 generator output 인 `@/lib/generated/prisma`
 * - dev / hot-reload 환경에서 인스턴스가 무한히 늘어나지 않도록 globalThis 캐싱
 * - 운영(production) 에서는 매 lambda cold start 마다 새 인스턴스 1개 (캐싱하지 않음)
 *
 * 사용처:
 *   import { prisma } from "@/lib/db/prisma"
 *
 * 직접 `new PrismaClient()` 호출 금지 (커넥션 누수 / 풀링 우회).
 *
 * Prisma 7 driver adapter:
 *   Prisma 7은 PrismaClient 생성 시 `adapter` 또는 `accelerateUrl` 옵션이 필요합니다.
 *   Supabase Postgres는 `@prisma/adapter-pg`(`PrismaPg`)로 연결합니다.
 *   schema.prisma 의 `previewFeatures = ["driverAdapters"]` 활성화 필수.
 *
 * 환경 변수:
 *   - DATABASE_URL : pgbouncer 풀링 URL (런타임 사용 — 본 어댑터가 사용)
 *   - DIRECT_URL   : Prisma 마이그레이션 전용 (prisma.config.ts 에서만 사용)
 */

import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "@/lib/generated/prisma/client"

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Required for Prisma client (pg adapter).",
    )
  }
  const adapter = new PrismaPg({ connectionString })
  return new PrismaClient({ adapter })
}

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma
}
