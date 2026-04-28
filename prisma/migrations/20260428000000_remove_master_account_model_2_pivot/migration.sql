-- =============================================================================
-- 모델 2 전환 — MasterAccount 제거 + Advertiser에 키 컬럼 추가
--
-- 배경:
--   이전(모델 1): MCC 마스터 키 1개 + X-Customer 헤더로 광고주 전환.
--                MasterAccount.apiKey 한 쌍이 N개 Advertiser 운영.
--   새 모델(모델 2): 광고주별 API 키·시크릿을 직접 발급받아 저장.
--                  마스터 권한 불필요. 평면(flat) 구조.
--
-- 영향:
--   - MasterAccount 테이블 / MasterAccountStatus enum 완전 제거 (사용자 동의)
--   - Advertiser.masterId 외래키·컬럼 제거
--   - Advertiser에 apiKeyEnc / apiKeyVersion / secretKeyEnc / secretKeyVersion 추가
--   - ChangeItem / AuditLog targetType은 string이라 enum drop 불필요. 사용자 동의로
--     기존 'MasterAccount' 대상 row 정리.
-- =============================================================================

-- 1. ChangeItem / AuditLog에 남아있는 'MasterAccount' targetType row 삭제.
--    targetType 컬럼은 string이라 enum drop 부담은 없다. 사용자 동의로
--    레거시 추적 row 제거.
DELETE FROM "ChangeItem"  WHERE "targetType" = 'MasterAccount';
DELETE FROM "AuditLog"    WHERE "targetType" = 'MasterAccount';

-- 2. Advertiser에 모델 2 키 컬럼 4종 추가.
--    NOT NULL DEFAULT 빈 bytes — 기존 row가 있더라도 임시값으로 채워지며,
--    신규/재등록 시 정상 암호화 키가 들어간다.
--    DEFAULT는 추가 직후 DROP하여 향후 INSERT에서 키 누락을 강제 차단.
ALTER TABLE "Advertiser"
  ADD COLUMN "apiKeyEnc"        BYTEA   NOT NULL DEFAULT '\x',
  ADD COLUMN "apiKeyVersion"    INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "secretKeyEnc"     BYTEA   NOT NULL DEFAULT '\x',
  ADD COLUMN "secretKeyVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "Advertiser"
  ALTER COLUMN "apiKeyEnc"    DROP DEFAULT,
  ALTER COLUMN "secretKeyEnc" DROP DEFAULT;
-- apiKeyVersion / secretKeyVersion DEFAULT 1은 schema와 일치하므로 유지.

-- 3. Advertiser.masterId 외래키 + 인덱스 + 컬럼 제거.
ALTER TABLE "Advertiser" DROP CONSTRAINT IF EXISTS "Advertiser_masterId_fkey";
DROP INDEX IF EXISTS "Advertiser_masterId_customerId_idx";
ALTER TABLE "Advertiser" DROP COLUMN IF EXISTS "masterId";

-- 4. 새 인덱스 추가 (schema와 동기화).
CREATE INDEX IF NOT EXISTS "Advertiser_customerId_idx" ON "Advertiser"("customerId");
CREATE INDEX IF NOT EXISTS "Advertiser_status_idx"     ON "Advertiser"("status");

-- 5. MasterAccount 테이블 drop (사용자 동의로 기존 row 데이터 삭제).
--    CASCADE는 의존 객체(외래키 등)가 있을 때 함께 정리하기 위함이지만,
--    Advertiser.masterId fk를 위에서 이미 drop했으므로 사실상 없음.
DROP TABLE IF EXISTS "MasterAccount" CASCADE;

-- 6. MasterAccountStatus enum drop.
DROP TYPE IF EXISTS "MasterAccountStatus";
