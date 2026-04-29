-- =============================================================================
-- F-10.4 — EstimateCache 모델 신규 (P2 비딩 시뮬레이터 캐시)
--
-- 배경:
--   F-10.1 (평균 순위 입찰가) / F-10.2 (최소 노출 입찰가) / F-10.3 (성과 시뮬)
--   세 endpoint 결과를 30분 캐시. Estimate API 는 호출 비용이 비싸고
--   동일 키워드 / 디바이스 / 옵션 조합이 짧은 시간 내 반복 호출되는 패턴
--   (사용자가 시뮬레이터 모달에서 후보 입찰가를 슬라이드).
--
-- 설계 결정:
--   1) 단일 테이블 + EstimateType enum 분기:
--      3개 endpoint 의 입력 / 출력 shape 가 다르지만 캐시 read/write 패턴이 동일
--      (TTL, 광고주 격리, 키워드 단위 무효화) → 단일 테이블에 type 컬럼 분기.
--
--   2) position / bid sentinel 0:
--      Postgres NULL 은 unique 비교에서 항상 distinct 로 취급 → NULL 을 키 일부로
--      두면 동일 (advertiser, keyword, device, type) 의 행이 중복 삽입 가능.
--      position(1..5) 와 bid(양수) 둘 다 0 은 의미 없는 값이라 sentinel 로 강제.
--      → unique 위반이 정확히 캐시 hit 으로 작동. NOT NULL + DEFAULT 0.
--
--   3) advertiserId 비정규화 (F-9.x StatDaily / StatHourly 패턴 일관):
--      RLS 단일 EXISTS (advertiserId, userId) → keyword→adgroup→campaign 3-way join
--      회피. 적재 시 keywordId owner advertiser resolve 책임은 backend 측.
--
--   4) keywordId = 내부 Keyword.id (nccKeywordId 아님):
--      FK Cascade — 키워드 삭제 / 광고주 삭제 시 캐시 자동 정리.
--
--   5) result Json passthrough (Zod 검증은 호출부):
--      endpoint 응답 shape 변경에 대비. 본 PR 은 schema 레벨 강제 X.
--
--   6) device:
--      StatDevice enum 재사용 (PC / MOBILE 만 사용, ALL 비사용). estimate 는
--      디바이스 분리 호출이 표준.
--
-- 인덱스:
--   - UNIQUE (advertiserId, keywordId, device, type, position, bid)
--     → 캐시 hit lookup 의 단일 키 (read 인덱스 역할 동시).
--   - (expiresAt) → cleanup cron 만료 스캔 효율.
--   - (keywordId) → 키워드 단위 일괄 무효화 (입찰가 변경 시 해당 키워드 캐시 drop).
--
-- TTL / cleanup:
--   본 PR 은 모델만. expiresAt < now() 행 삭제 cron 후속 PR 권고.
--   read 시점 lazy 만료 검사 (WHERE expiresAt > now()) 로 stale 회피.
--
-- 안전성:
--   - 신규 테이블 (행 0건) — NOT NULL / DEFAULT 즉시 적용 가능.
--   - CREATE TYPE 신규 enum (ALTER TYPE 아님) — 트랜잭션 블록 내 안전.
--   - RLS ENABLE 직후 정책 생성 — 적재 전 적용 (행 0건).
-- =============================================================================

-- 1) EstimateType enum 신규 (3 endpoint)
CREATE TYPE "EstimateType" AS ENUM (
  'average_position',
  'exposure_minimum',
  'performance_bulk'
);

-- 2) EstimateCache 테이블 생성
CREATE TABLE "EstimateCache" (
  "id"           TEXT NOT NULL,
  "advertiserId" TEXT NOT NULL,
  "keywordId"    TEXT NOT NULL,
  "device"       "StatDevice" NOT NULL,
  "type"         "EstimateType" NOT NULL,
  "position"     INTEGER NOT NULL DEFAULT 0,
  "bid"          INTEGER NOT NULL DEFAULT 0,
  "result"       JSONB NOT NULL,
  "expiresAt"    TIMESTAMP(3) NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EstimateCache_pkey" PRIMARY KEY ("id")
);

-- 3) FK — Advertiser Cascade
ALTER TABLE "EstimateCache"
  ADD CONSTRAINT "EstimateCache_advertiserId_fkey"
  FOREIGN KEY ("advertiserId") REFERENCES "Advertiser"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 4) FK — Keyword Cascade
ALTER TABLE "EstimateCache"
  ADD CONSTRAINT "EstimateCache_keywordId_fkey"
  FOREIGN KEY ("keywordId") REFERENCES "Keyword"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 5) UNIQUE — 캐시 hit 키 (sentinel 0 정책 덕에 NOT NULL 컬럼 6-tuple)
CREATE UNIQUE INDEX "EstimateCache_advertiserId_keywordId_device_type_position_bid_key"
  ON "EstimateCache"("advertiserId", "keywordId", "device", "type", "position", "bid");

-- 6) 인덱스 — cleanup cron 만료 스캔
CREATE INDEX "EstimateCache_expiresAt_idx"
  ON "EstimateCache"("expiresAt");

-- 7) 인덱스 — 키워드 단위 일괄 무효화
CREATE INDEX "EstimateCache_keywordId_idx"
  ON "EstimateCache"("keywordId");

-- 8) RLS — F-9.x advertiserId 단순화 패턴 일관
ALTER TABLE "EstimateCache" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_estimatecache" ON "EstimateCache"
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "EstimateCache"."advertiserId"
        AND uaa."userId" = auth.uid()::text
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "EstimateCache"."advertiserId"
        AND uaa."userId" = auth.uid()::text
    )
  );
