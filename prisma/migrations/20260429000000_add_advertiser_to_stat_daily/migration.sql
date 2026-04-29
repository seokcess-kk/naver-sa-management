-- =============================================================================
-- F-9.1 — StatDaily.advertiserId 비정규화 컬럼 추가
--
-- 배경:
--   F-9.1 (P2 일별 적재 진입). StatDaily.refId 는 level별로 다른 엔티티
--   (campaign / adgroup / keyword) 내부 id 라 광고주 단일 필터 조회가
--   매번 3-way join 을 요구함. 광고주 + 기간 KPI / TOP-N / RLS 정책 단순화 위해
--   advertiserId 를 비정규화 컬럼으로 보존.
--
-- 안전성:
--   - P1 단계에서는 StatDaily 적재 X (Stats API + Redis 캐시) — 기존 행 0건 가정.
--   - 만약 운영 환경에 행이 존재하면, ADD COLUMN NOT NULL 이 실패하므로
--     아래 단계별로 수행: ADD COLUMN NULL → backfill → SET NOT NULL.
--     (현재는 0건 전제이므로 단일 트랜잭션으로 처리)
--
-- 변경:
--   1. advertiserId VARCHAR NOT NULL 컬럼 추가
--   2. Advertiser FK + ON DELETE CASCADE
--   3. 인덱스 2개 추가:
--        (advertiserId, date)
--        (advertiserId, level, date)
--   * 기존 unique (date, level, refId, device) 와 index (date, level, refId) 유지
-- =============================================================================

-- 1) 컬럼 추가 (행 0건 전제 — NOT NULL 즉시 가능)
ALTER TABLE "StatDaily" ADD COLUMN "advertiserId" TEXT NOT NULL;

-- 2) FK 제약
ALTER TABLE "StatDaily"
  ADD CONSTRAINT "StatDaily_advertiserId_fkey"
  FOREIGN KEY ("advertiserId") REFERENCES "Advertiser"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 3) 인덱스 추가 — 광고주 + 기간 (KPI 카드) 및 광고주 + 레벨별 (차트)
CREATE INDEX "StatDaily_advertiserId_date_idx" ON "StatDaily"("advertiserId", "date");
CREATE INDEX "StatDaily_advertiserId_level_date_idx" ON "StatDaily"("advertiserId", "level", "date");
