// Prisma 7는 .env를 자동 로드하지 않으므로 dotenv를 명시적으로 로드한다.
// .env.local 우선 → .env 보조. .env.local 값이 항상 이긴다.
import { config as loadDotenv } from "dotenv";
import { defineConfig } from "prisma/config";

// .env.local을 먼저 로드 (이 키들은 process.env에 자리 잡음)
loadDotenv({ path: ".env.local" });
// .env는 비어있는 키만 채움 (override: false 가 기본 — 위에서 채워진 키는 보존)
loadDotenv({ path: ".env" });

// Prisma 7에서 datasource.url은 단일 URL만 허용된다(directUrl 미지원).
// Supabase는 마이그레이션 시 DIRECT_URL(5432, 풀링 X)을 사용해야 안전하므로,
// DIRECT_URL이 정의되어 있으면 우선 사용. 런타임 앱은 PrismaClient에서 별도로
// DATABASE_URL을 사용하도록 구성한다.
const datasourceUrl =
  process.env["DIRECT_URL"] ?? process.env["DATABASE_URL"];

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: datasourceUrl,
  },
});
