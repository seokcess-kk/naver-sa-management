-- =============================================================================
-- F-11 / F-12 비딩 자동화 재설계 — Inbox + ApprovalQueue + 광고주 자동화 설정
--
-- 배경:
--   1만 5천+ 키워드 환경에서 자동 비딩 폭주를 막고 운영자가 검토 가능한 대량
--   "제안 큐" 패턴으로 재설계. 5종 엔진 (bid / quality / targeting / budget /
--   copy_policy) 이 BidSuggestion 행을 적재하면 운영자가 Inbox UI 에서 검토 후
--   적용 / 무시 / 만료. 위험 액션 (검색어 제외 / 승격) 은 ApprovalQueue 별도
--   흐름. 광고주 단위 자동화 설정 / baseline 통계는 1:1 모델 신설.
--
-- 변경 요약:
--   1) ENUM 신규 7개:
--        BidAutomationMode / BudgetPacingMode / BidSuggestionSource /
--        BidSuggestionSeverity / BidSuggestionStatus / ApprovalQueueKind /
--        ApprovalQueueStatus
--   2) Keyword ALTER × 2 컬럼:
--        qualityScore (Int?), qualityScoreUpdatedAt (Timestamp?) — 네이버 SA
--        응답에 quality 점수 포함 시에만 채움 (옵셔널). 기존 행은 NULL 즉시 적용.
--   3) BidAutomationConfig 신규 — 광고주 1:1 (advertiserId @unique).
--   4) KeywordPerformanceProfile 신규 — 광고주 1:1 baseline (CTR/CVR/CPC).
--   5) BidSuggestion 신규 — Inbox 항목. 5종 엔진 공유 테이블.
--   6) ApprovalQueue 신규 — 위험 액션 대기열.
--   7) SearchTermReport 신규 — 검색어 보고서 캐시 (광고주×주차 UNIQUE).
--   8) RLS — 5개 신규 테이블 모두 advertiserId 기반 tenant_isolation
--      (F-9.x / F-11.x 기존 패턴 재사용).
--
-- 설계 결정:
--   1) BidSuggestion keywordId / adgroupId 양 nullable:
--      입찰·품질 엔진은 키워드 단위, 타게팅·예산·소재 엔진은 광고그룹 단위.
--      두 엔진군이 한 테이블에 공존. 정합성 (둘 중 하나는 NOT NULL) 은 호출부
--      (insertSuggestion) 책임 — DB CHECK constraint 미도입 (운영 case 변형
--      가능성: 향후 campaign 단위 예산 알림 추가 시 컬럼 또 늘어남).
--
--   2) advertiserId 비정규화 (F-9.x / F-10 / F-11.1 / F-11.4 / F-11.7 패턴 동일):
--      RLS 단일 EXISTS, Cascade 단순화. keyword/adgroup → advertiser 2~3-way
--      join 회피. 적재 시 owner advertiser resolve 책임은 backend.
--
--   3) action / payload Json passthrough:
--      엔진별 페이로드 shape 다양 (입찰가 변경 / 매치타입 추천 / 검색어 제외 등).
--      schema 강제하면 엔진 추가마다 마이그레이션 필요. Zod 검증은 호출부 책임.
--
--   4) BidSuggestion.expiresAt 인덱스:
--      lazy 만료 패턴 (Inbox 조회 시 expiresAt > now() 필터). cleanup cron
--      후속 PR 에서 expiresAt < now() 일괄 삭제 시 인덱스 활용.
--
--   5) appliedBatchId SetNull (BidSuggestion / ApprovalQueue):
--      ChangeBatch 삭제 (수동 cleanup) 시에도 제안 / 승인 이력 보존 — 감사 추적.
--      Cascade 면 배치 삭제 시 제안 이력 유실 위험.
--
--   6) reason VARCHAR(1000):
--      LLM enrich 후속 PR 에서 본문 길이가 늘어날 수 있음. Advertiser.memo
--      VARCHAR(500) 보다 약간 큰 한도. JSONB 남용 회피.
--
--   7) BidAutomationConfig.targetCpa Int / targetRoas Decimal(5,2):
--      CPA 는 원 단위 정수. ROAS 는 배율 (예: 4.50). 둘 다 nullable —
--      운영 시나리오에 따라 CPA 만 / ROAS 만 / 둘 다 채울 수 있음.
--
--   8) KeywordPerformanceProfile.dataDays default 28:
--      매시간 ETL 후속 cron 이 갱신 전에도 schema 적용 가능 — neutral fallback.
--
--   9) SearchTermReport (advertiserId, weekStart) UNIQUE:
--      광고주×주차 1행 보장 — ETL 멱등성. processed 컬럼으로 ApprovalQueue
--      적재 단계 분리 (cron 재실행 안전).
--
-- 안전성:
--   - Keyword 신규 컬럼 2개 모두 nullable — 기존 행에 즉시 적용 가능.
--   - 신규 5 테이블 모두 행 0건 — NOT NULL / DEFAULT 즉시 적용 가능.
--   - 신규 enum 7개 — 기존 데이터 영향 없음.
--   - RLS ENABLE 직후 정책 생성 — 적재 전 적용.
--   - advertiserId @unique 강제 (BidAutomationConfig / KeywordPerformanceProfile)
--     는 신규 테이블이라 충돌 없음.
-- =============================================================================

-- 1) ENUM 신규 7개
CREATE TYPE "BidAutomationMode" AS ENUM ('inbox', 'auto_policy_only', 'off');
CREATE TYPE "BudgetPacingMode" AS ENUM ('focus', 'explore', 'protect');
CREATE TYPE "BidSuggestionSource" AS ENUM ('bid', 'quality', 'targeting', 'budget', 'copy_policy');
CREATE TYPE "BidSuggestionSeverity" AS ENUM ('info', 'warn', 'critical');
CREATE TYPE "BidSuggestionStatus" AS ENUM ('pending', 'applied', 'dismissed', 'expired');
CREATE TYPE "ApprovalQueueKind" AS ENUM ('search_term_exclude', 'search_term_promote');
CREATE TYPE "ApprovalQueueStatus" AS ENUM ('pending', 'approved', 'rejected', 'expired');

-- 2) Keyword ALTER — qualityScore + qualityScoreUpdatedAt (옵셔널, 기존 행 NULL)
ALTER TABLE "Keyword"
  ADD COLUMN "qualityScore"          INTEGER,
  ADD COLUMN "qualityScoreUpdatedAt" TIMESTAMP(3);

-- 3) BidAutomationConfig — 광고주 1:1 자동화 설정
CREATE TABLE "BidAutomationConfig" (
  "id"               TEXT NOT NULL,
  "advertiserId"     TEXT NOT NULL,
  "mode"             "BidAutomationMode" NOT NULL DEFAULT 'off',
  "budgetPacingMode" "BudgetPacingMode"  NOT NULL DEFAULT 'focus',
  "targetCpa"        INTEGER,
  "targetRoas"       DECIMAL(5, 2),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BidAutomationConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BidAutomationConfig_advertiserId_key"
  ON "BidAutomationConfig"("advertiserId");

ALTER TABLE "BidAutomationConfig"
  ADD CONSTRAINT "BidAutomationConfig_advertiserId_fkey"
  FOREIGN KEY ("advertiserId") REFERENCES "Advertiser"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 4) KeywordPerformanceProfile — 광고주 1:1 baseline 통계
CREATE TABLE "KeywordPerformanceProfile" (
  "id"           TEXT NOT NULL,
  "advertiserId" TEXT NOT NULL,
  "dataDays"     INTEGER NOT NULL DEFAULT 28,
  "avgCtr"       DECIMAL(6, 4),
  "avgCvr"       DECIMAL(6, 4),
  "avgCpc"       DECIMAL(10, 2),
  "refreshedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KeywordPerformanceProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KeywordPerformanceProfile_advertiserId_key"
  ON "KeywordPerformanceProfile"("advertiserId");

ALTER TABLE "KeywordPerformanceProfile"
  ADD CONSTRAINT "KeywordPerformanceProfile_advertiserId_fkey"
  FOREIGN KEY ("advertiserId") REFERENCES "Advertiser"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 5) BidSuggestion — Inbox 항목 (5종 엔진 공유)
CREATE TABLE "BidSuggestion" (
  "id"             TEXT NOT NULL,
  "advertiserId"   TEXT NOT NULL,
  "keywordId"      TEXT,
  "adgroupId"      TEXT,
  "engineSource"   "BidSuggestionSource" NOT NULL,
  "action"         JSONB NOT NULL,
  "reason"         VARCHAR(1000) NOT NULL,
  "severity"       "BidSuggestionSeverity" NOT NULL DEFAULT 'info',
  "status"         "BidSuggestionStatus"   NOT NULL DEFAULT 'pending',
  "expiresAt"      TIMESTAMP(3) NOT NULL,
  "appliedBatchId" TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BidSuggestion_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "BidSuggestion"
  ADD CONSTRAINT "BidSuggestion_advertiserId_fkey"
  FOREIGN KEY ("advertiserId") REFERENCES "Advertiser"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BidSuggestion"
  ADD CONSTRAINT "BidSuggestion_keywordId_fkey"
  FOREIGN KEY ("keywordId") REFERENCES "Keyword"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BidSuggestion"
  ADD CONSTRAINT "BidSuggestion_adgroupId_fkey"
  FOREIGN KEY ("adgroupId") REFERENCES "AdGroup"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BidSuggestion"
  ADD CONSTRAINT "BidSuggestion_appliedBatchId_fkey"
  FOREIGN KEY ("appliedBatchId") REFERENCES "ChangeBatch"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- BidSuggestion 인덱스 — Inbox 페이지 조회 (active suggestions: status=pending, expiresAt > now)
CREATE INDEX "BidSuggestion_advertiserId_status_expiresAt_idx"
  ON "BidSuggestion"("advertiserId", "status", "expiresAt");

-- 엔진별 분류 + 시간 윈도 — UI 필터 (예: 최근 24h 의 bid 엔진 제안)
CREATE INDEX "BidSuggestion_advertiserId_engineSource_createdAt_idx"
  ON "BidSuggestion"("advertiserId", "engineSource", "createdAt");

-- 키워드 단위 lookup (키워드 상세 페이지)
CREATE INDEX "BidSuggestion_keywordId_idx"
  ON "BidSuggestion"("keywordId");

-- 광고그룹 단위 lookup (그룹 상세)
CREATE INDEX "BidSuggestion_adgroupId_idx"
  ON "BidSuggestion"("adgroupId");

-- cleanup cron (만료 행 일괄 삭제)
CREATE INDEX "BidSuggestion_expiresAt_idx"
  ON "BidSuggestion"("expiresAt");

-- 6) ApprovalQueue — 위험 액션 대기열
CREATE TABLE "ApprovalQueue" (
  "id"             TEXT NOT NULL,
  "advertiserId"   TEXT NOT NULL,
  "kind"           "ApprovalQueueKind"   NOT NULL,
  "payload"        JSONB NOT NULL,
  "status"         "ApprovalQueueStatus" NOT NULL DEFAULT 'pending',
  "decidedBy"      TEXT,
  "decidedAt"      TIMESTAMP(3),
  "appliedBatchId" TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ApprovalQueue_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ApprovalQueue"
  ADD CONSTRAINT "ApprovalQueue_advertiserId_fkey"
  FOREIGN KEY ("advertiserId") REFERENCES "Advertiser"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ApprovalQueue"
  ADD CONSTRAINT "ApprovalQueue_appliedBatchId_fkey"
  FOREIGN KEY ("appliedBatchId") REFERENCES "ChangeBatch"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 광고주별 대기열 페이지 (status=pending 시간순)
CREATE INDEX "ApprovalQueue_advertiserId_status_createdAt_idx"
  ON "ApprovalQueue"("advertiserId", "status", "createdAt");

-- 운영 모니터 — 종류별 status 분포
CREATE INDEX "ApprovalQueue_kind_status_idx"
  ON "ApprovalQueue"("kind", "status");

-- 7) SearchTermReport — 검색어 보고서 캐시 (광고주×주차 1행)
CREATE TABLE "SearchTermReport" (
  "id"           TEXT NOT NULL,
  "advertiserId" TEXT NOT NULL,
  "weekStart"    DATE NOT NULL,
  "rows"         JSONB NOT NULL,
  "processed"    BOOLEAN NOT NULL DEFAULT false,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SearchTermReport_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SearchTermReport"
  ADD CONSTRAINT "SearchTermReport_advertiserId_fkey"
  FOREIGN KEY ("advertiserId") REFERENCES "Advertiser"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 광고주×주차 UNIQUE — ETL 멱등성 (재처리 시 upsert)
CREATE UNIQUE INDEX "SearchTermReport_advertiserId_weekStart_key"
  ON "SearchTermReport"("advertiserId", "weekStart");

-- 8) RLS — BidAutomationConfig (F-9.x advertiserId 단순 패턴)
ALTER TABLE "BidAutomationConfig" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_bidautomationconfig" ON "BidAutomationConfig"
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "BidAutomationConfig"."advertiserId"
        AND uaa."userId" = auth.uid()::text
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "BidAutomationConfig"."advertiserId"
        AND uaa."userId" = auth.uid()::text
    )
  );

-- 9) RLS — KeywordPerformanceProfile
ALTER TABLE "KeywordPerformanceProfile" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_keywordperformanceprofile" ON "KeywordPerformanceProfile"
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "KeywordPerformanceProfile"."advertiserId"
        AND uaa."userId" = auth.uid()::text
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "KeywordPerformanceProfile"."advertiserId"
        AND uaa."userId" = auth.uid()::text
    )
  );

-- 10) RLS — BidSuggestion
ALTER TABLE "BidSuggestion" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_bidsuggestion" ON "BidSuggestion"
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "BidSuggestion"."advertiserId"
        AND uaa."userId" = auth.uid()::text
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "BidSuggestion"."advertiserId"
        AND uaa."userId" = auth.uid()::text
    )
  );

-- 11) RLS — ApprovalQueue
ALTER TABLE "ApprovalQueue" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_approvalqueue" ON "ApprovalQueue"
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "ApprovalQueue"."advertiserId"
        AND uaa."userId" = auth.uid()::text
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "ApprovalQueue"."advertiserId"
        AND uaa."userId" = auth.uid()::text
    )
  );

-- 12) RLS — SearchTermReport
ALTER TABLE "SearchTermReport" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_searchtermreport" ON "SearchTermReport"
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "SearchTermReport"."advertiserId"
        AND uaa."userId" = auth.uid()::text
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "SearchTermReport"."advertiserId"
        AND uaa."userId" = auth.uid()::text
    )
  );
