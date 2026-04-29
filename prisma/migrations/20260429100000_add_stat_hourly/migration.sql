-- =============================================================================
-- F-9.2 — StatHourly 모델 신규 + StatDevice enum 확장 (ALL 추가)
--
-- 배경:
--   네이버 Stats API 시간별(hh24 breakdown) 데이터는 7일 보존 한계.
--   F-9.2 는 1시간 주기 폴링으로 자체 누적. F-9.4 (recentAvgRnk 1시간 갱신)
--   원천이기도 함.
--
-- 설계 결정:
--   1) date (Date) + hour (Int 0..23) 분리 컬럼 (KST 기준).
--      - 단일 timestamp 컬럼은 timezone 정합성 모호함 → 회피.
--   2) StatDevice enum 에 ALL 추가:
--      - hh24 + pcMblTp 동시 breakdown 미지원 → StatHourly 는 device='ALL' 단일 적재.
--      - StatDaily 는 PC/MOBILE 만 사용 (코드 정책으로 강제, DB 분리 enum 별도 안 둠).
--   3) advertiserId 비정규화 (StatDaily F-9.1 과 동일 패턴) — Cascade FK + 단일 필터.
--   4) Unique [date, hour, level, refId, device] — upsert 키 + 향후 device 분리 시 안전.
--   5) 인덱스:
--        (advertiserId, date, hour)        — 광고주 시간 윈도
--        (advertiserId, level, date, hour) — 광고주 + 레벨 시간 차트
--        (date, hour, level, refId)        — 적재 / ref별 디버깅
--
-- retention:
--   본 마이그레이션은 모델만 추가. 행 수 폭증 가능 → 운영 부하 측정 후
--   90일 cleanup cron 후속 PR 권고.
--
-- 안전성:
--   - 신규 테이블 (행 0건) — NOT NULL / FK 즉시 적용 가능.
--   - ALTER TYPE ADD VALUE 는 Postgres 12+ 에서 트랜잭션 블록 외부 허용.
--     Prisma 마이그레이션은 기본 단일 트랜잭션 → 별도 파일 분리 또는
--     ALTER TYPE 만 트랜잭션 외부에서 실행해야 함. 본 PR 은 동일 마이그레이션
--     내에서 실행 — Prisma 7 은 ALTER TYPE 단독 statement 의 트랜잭션 회피
--     자동 처리. 적용 실패 시 ALTER TYPE 분리 마이그레이션으로 재작성.
-- =============================================================================

-- 1) StatDevice enum 에 'ALL' 추가
ALTER TYPE "StatDevice" ADD VALUE 'ALL';

-- 2) StatHourly 테이블 생성
CREATE TABLE "StatHourly" (
  "id"            TEXT NOT NULL,
  "advertiserId"  TEXT NOT NULL,
  "date"          DATE NOT NULL,
  "hour"          INTEGER NOT NULL,
  "level"         "StatLevel" NOT NULL,
  "refId"         TEXT NOT NULL,
  "device"        "StatDevice" NOT NULL,
  "impressions"   INTEGER NOT NULL DEFAULT 0,
  "clicks"        INTEGER NOT NULL DEFAULT 0,
  "cost"          DECIMAL(14,2) NOT NULL DEFAULT 0,
  "recentAvgRnk"  DECIMAL(5,2),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StatHourly_pkey" PRIMARY KEY ("id")
);

-- 3) FK — Advertiser Cascade
ALTER TABLE "StatHourly"
  ADD CONSTRAINT "StatHourly_advertiserId_fkey"
  FOREIGN KEY ("advertiserId") REFERENCES "Advertiser"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 4) Unique — upsert 키 (date + hour + level + refId + device)
CREATE UNIQUE INDEX "StatHourly_date_hour_level_refId_device_key"
  ON "StatHourly"("date", "hour", "level", "refId", "device");

-- 5) 인덱스
CREATE INDEX "StatHourly_advertiserId_date_hour_idx"
  ON "StatHourly"("advertiserId", "date", "hour");

CREATE INDEX "StatHourly_advertiserId_level_date_hour_idx"
  ON "StatHourly"("advertiserId", "level", "date", "hour");

CREATE INDEX "StatHourly_date_hour_level_refId_idx"
  ON "StatHourly"("date", "hour", "level", "refId");
