-- =============================================================================
-- F-13 — LlmCallLog (Phase F.2)
--
-- 배경:
--   F LLM 분석 보조의 비용 추적 인프라 1차 도입. 본 PR 은 schema / 인덱스 / RLS 만.
--   실제 LLM 호출 (lib/llm/anthropic.ts) 은 ANTHROPIC_API_KEY 결정 후 별도 PR.
--
-- 변경 요약:
--   1) LlmCallLog 신규 — purpose / model / inputHash / tokens / costUsd / fromCache / result
--   2) 인덱스 4개 — 비용 집계 + 캐시 hit 검사
--
-- 설계 결정:
--   1) prompt / response 본문 미저장:
--      inputHash(SHA-256) 만 저장 — 시크릿/PII 누설 차단. 동일 입력 캐시 키로도 사용.
--      response 본문도 미저장 — 토큰 수 / 비용만.
--
--   2) costUsd Decimal(10, 6):
--      Anthropic 가격 정밀 표현 (예: 0.000003 USD / token). 월 집계 시 sum 정확성.
--
--   3) fromCache Boolean:
--      캐시 hit 도 row 적재 — 호출 빈도 / 캐시 효율 추적. cost=0 / tokens=0 가능.
--
--   4) RLS X (admin / cron 컨텍스트만 접근):
--      LlmCallLog 는 광고주별 데이터가 아닌 시스템 전역 비용 추적 — RLS 미적용.
--      운영 화면(admin/llm-cost) 후속 PR 에서 admin 권한 검증.
--
-- 안전성:
--   - 신규 테이블 (행 0건) — NOT NULL / DEFAULT 즉시 적용 가능
--   - enum 변경 X
-- =============================================================================

-- 1) LlmCallLog 테이블 생성
CREATE TABLE "LlmCallLog" (
  "id"           TEXT NOT NULL,
  "purpose"      TEXT NOT NULL,
  "model"        TEXT NOT NULL,
  "inputHash"    TEXT NOT NULL,
  "tokensIn"     INTEGER NOT NULL DEFAULT 0,
  "tokensOut"    INTEGER NOT NULL DEFAULT 0,
  "costUsd"      DECIMAL(10, 6) NOT NULL DEFAULT 0,
  "fromCache"    BOOLEAN NOT NULL DEFAULT false,
  "result"       TEXT NOT NULL DEFAULT 'success',
  "errorMessage" VARCHAR(500),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LlmCallLog_pkey" PRIMARY KEY ("id")
);

-- 2) 인덱스 — 시간 윈도 비용 집계
CREATE INDEX "LlmCallLog_createdAt_idx" ON "LlmCallLog"("createdAt");

-- 3) 인덱스 — 모델별 비용 집계
CREATE INDEX "LlmCallLog_model_createdAt_idx" ON "LlmCallLog"("model", "createdAt");

-- 4) 인덱스 — purpose 별 비용 집계
CREATE INDEX "LlmCallLog_purpose_createdAt_idx" ON "LlmCallLog"("purpose", "createdAt");

-- 5) 인덱스 — 캐시 hit 검사 (inputHash 단일 조회)
CREATE INDEX "LlmCallLog_inputHash_idx" ON "LlmCallLog"("inputHash");

-- RLS 미적용 — admin / cron 컨텍스트만 접근 (운영 화면은 후속 PR 에서 admin 가드).
