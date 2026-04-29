-- =============================================================================
-- F-11.1 BiddingPolicy + F-11.6 Kill Switch + F-11.7 OptimizationRun
--
-- 배경:
--   P2 비딩 최적화 데이터 모델 1차 도입. 본 PR 은 모델 / FK / 인덱스 / RLS 만.
--   자동 조정 cron (F-11.2) / Guardrail (F-11.5) / 정책 UI 는 후속 PR.
--
-- 변경 요약:
--   1) Advertiser ALTER × 3 — 광고주 단위 Kill Switch (default false / null)
--   2) BiddingPolicy 신규 — 키워드 단위 목표 순위 정책 (PC/MOBILE 별 row)
--   3) OptimizationRun 신규 — 자동 비딩 실행 로그
--   4) RLS — 두 테이블 모두 advertiserId 기반 tenant_isolation
--
-- 설계 결정:
--   1) Kill Switch 광고주 단위 (전역 X):
--      운영 시나리오에서 광고주별 정책 차이 / 사고 격리가 본질적. 전역 정지는
--      admin 환경변수 (BIDDING_GLOBAL_DISABLED) 로 후속 검토. 토글 메타
--      (At / By) 는 감사 추적 — F-11.6 "재개 시 사용자 기록" 요구 충족.
--
--   2) BiddingPolicy device 분리:
--      "디바이스 분리" 요구를 단일 row + deviceMap Json 대신 PC/MOBILE 별 row
--      로 표현. UNIQUE (keywordId, device) 로 정책 충돌 방지. ALL 은 본 모델
--      비사용 (코드 정책 — Zod 검증 단계에서 차단). 그룹 단위 정책은 후속.
--
--   3) advertiserId 비정규화 (F-9.x / F-10 패턴 일관):
--      keyword → adgroup → campaign 3-way join 회피. RLS 단일 EXISTS.
--      Cascade 단순화. 적재 책임은 backend (호출부 보장).
--
--   4) OptimizationRun trigger / result string (enum 승격 후속):
--      운영 초기 케이스가 확정되지 않음 (skipped_* 변형 추가 가능성). enum 승격
--      은 운영 데이터 누적 후 결정. 그 전까지 호출부 Zod literal union 으로 강제.
--
--   5) policyId nullable + SetNull:
--      수동 1회 변경 (정책 없이 사용자가 1회 입찰가 조정) 케이스 + 정책 삭제 후에도
--      로그는 감사 추적 위해 유지.
--
--   6) errorMessage VARCHAR(500):
--      Advertiser.memo 와 동일 한계 (운영 메시지 충분, JSONB 남용 회피).
--
-- 안전성:
--   - Advertiser 신규 컬럼 3개 모두 DEFAULT false / null — 기존 행에 즉시 적용.
--   - 신규 테이블 2개 (행 0건) — NOT NULL / DEFAULT 즉시 적용 가능.
--   - enum 변경 X (StatDevice 재사용).
--   - RLS ENABLE 직후 정책 생성 — 적재 전 적용.
-- =============================================================================

-- 1) Advertiser ALTER — Kill Switch 컬럼 3개 (광고주 단위)
ALTER TABLE "Advertiser"
  ADD COLUMN "biddingKillSwitch"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "biddingKillSwitchAt" TIMESTAMP(3),
  ADD COLUMN "biddingKillSwitchBy" TEXT;

-- 2) BiddingPolicy 테이블 생성
CREATE TABLE "BiddingPolicy" (
  "id"           TEXT NOT NULL,
  "advertiserId" TEXT NOT NULL,
  "keywordId"    TEXT NOT NULL,
  "device"       "StatDevice" NOT NULL,
  "targetRank"   INTEGER NOT NULL,
  "maxBid"       INTEGER,
  "minBid"       INTEGER,
  "enabled"      BOOLEAN NOT NULL DEFAULT true,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BiddingPolicy_pkey" PRIMARY KEY ("id")
);

-- 3) BiddingPolicy FK — Advertiser Cascade
ALTER TABLE "BiddingPolicy"
  ADD CONSTRAINT "BiddingPolicy_advertiserId_fkey"
  FOREIGN KEY ("advertiserId") REFERENCES "Advertiser"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 4) BiddingPolicy FK — Keyword Cascade
ALTER TABLE "BiddingPolicy"
  ADD CONSTRAINT "BiddingPolicy_keywordId_fkey"
  FOREIGN KEY ("keywordId") REFERENCES "Keyword"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 5) BiddingPolicy UNIQUE — (keywordId, device) 정책 충돌 방지
CREATE UNIQUE INDEX "BiddingPolicy_keywordId_device_key"
  ON "BiddingPolicy"("keywordId", "device");

-- 6) BiddingPolicy 인덱스 — 광고주별 활성 정책 픽업 (F-11.2 cron)
CREATE INDEX "BiddingPolicy_advertiserId_enabled_idx"
  ON "BiddingPolicy"("advertiserId", "enabled");

-- 7) BiddingPolicy 인덱스 — 키워드 단위 lookup (UNIQUE 와 별도 — keywordId 단일 prefix)
--    UNIQUE (keywordId, device) 가 (keywordId) prefix 로 동작하지만 명시적 단일 인덱스로 의도 분명히.
CREATE INDEX "BiddingPolicy_keywordId_idx"
  ON "BiddingPolicy"("keywordId");

-- 8) OptimizationRun 테이블 생성
CREATE TABLE "OptimizationRun" (
  "id"           TEXT NOT NULL,
  "advertiserId" TEXT NOT NULL,
  "policyId"     TEXT,
  "trigger"      TEXT NOT NULL,
  "before"       JSONB,
  "after"        JSONB,
  "result"       TEXT NOT NULL,
  "errorMessage" VARCHAR(500),
  "triggeredAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OptimizationRun_pkey" PRIMARY KEY ("id")
);

-- 9) OptimizationRun FK — Advertiser Cascade
ALTER TABLE "OptimizationRun"
  ADD CONSTRAINT "OptimizationRun_advertiserId_fkey"
  FOREIGN KEY ("advertiserId") REFERENCES "Advertiser"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 10) OptimizationRun FK — BiddingPolicy SetNull (정책 삭제해도 로그 유지)
ALTER TABLE "OptimizationRun"
  ADD CONSTRAINT "OptimizationRun_policyId_fkey"
  FOREIGN KEY ("policyId") REFERENCES "BiddingPolicy"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 11) OptimizationRun 인덱스 — 광고주별 시간 윈도 read
CREATE INDEX "OptimizationRun_advertiserId_triggeredAt_idx"
  ON "OptimizationRun"("advertiserId", "triggeredAt");

-- 12) OptimizationRun 인덱스 — 정책별 실행 추이
CREATE INDEX "OptimizationRun_policyId_triggeredAt_idx"
  ON "OptimizationRun"("policyId", "triggeredAt");

-- 13) OptimizationRun 인덱스 — 실패 / 차단 trace
CREATE INDEX "OptimizationRun_result_triggeredAt_idx"
  ON "OptimizationRun"("result", "triggeredAt");

-- 14) RLS — BiddingPolicy (F-9.x advertiserId 단순 패턴)
ALTER TABLE "BiddingPolicy" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_biddingpolicy" ON "BiddingPolicy"
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "BiddingPolicy"."advertiserId"
        AND uaa."userId" = auth.uid()::text
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "BiddingPolicy"."advertiserId"
        AND uaa."userId" = auth.uid()::text
    )
  );

-- 15) RLS — OptimizationRun
ALTER TABLE "OptimizationRun" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_optimizationrun" ON "OptimizationRun"
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "OptimizationRun"."advertiserId"
        AND uaa."userId" = auth.uid()::text
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "OptimizationRun"."advertiserId"
        AND uaa."userId" = auth.uid()::text
    )
  );
