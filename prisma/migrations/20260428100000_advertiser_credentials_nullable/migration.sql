-- =============================================================================
-- F-1.2 사전 준비 — Advertiser 키 컬럼 nullable 전환
--
-- 배경:
--   F-1.2 (광고주 CSV 일괄 등록) 결정사항: CSV에는 메타만 포함하고
--   시크릿(API_KEY / SECRET_KEY)은 광고주별로 별도 화면에서 입력한다.
--   따라서 등록 시점에 키가 비어있을 수 있어야 하므로 NOT NULL 해제.
--
-- 영향:
--   - apiKeyEnc / secretKeyEnc 만 nullable 로 전환
--   - apiKeyVersion / secretKeyVersion 은 default 1 유지 (NOT NULL 유지)
--   - 기존 row 의 키 데이터는 그대로 보존 (NULL 허용 변경만)
--   - credentials.ts (backend 후속 작업) 가 NULL 체크 후 "Credentials not set" 에러 던지도록 분기 필요.
-- =============================================================================

ALTER TABLE "Advertiser" ALTER COLUMN "apiKeyEnc"    DROP NOT NULL;
ALTER TABLE "Advertiser" ALTER COLUMN "secretKeyEnc" DROP NOT NULL;
