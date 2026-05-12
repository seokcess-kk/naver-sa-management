-- Migration: 기존 행의 statusReason 컬럼 백필
--
-- 배경:
--   - 직전 마이그레이션 20260512000000_add_status_reason 에서 컬럼만 추가하고 backfill 미실시.
--   - sync 로직은 새 코드 배포 + 다음 동기화 사이클부터 채움 → 지연 발생.
--   - raw 컬럼(JSONB) 에는 SA API 응답의 statusReason 키가 이미 들어와 있음 (Zod 통과 후 raw 그대로 저장).
--   - 영문 코드 형태 (CAMPAIGN_PAUSED / GROUP_PAUSED / KEYWORD_PAUSED 등). UI 측에서 한글 라벨 매핑.
--
-- 안전성:
--   1) UPDATE WHERE 가드 — raw->>'statusReason' IS NOT NULL AND "statusReason" IS NULL 만 갱신.
--   2) 멱등성 — 두 번 실행해도 NULL 행만 덮어쓰며 기존 값 보존.
--   3) 인덱스 없는 컬럼이라 락 부담 적음. 대용량 (50k+ Keyword) 도 인덱스 갱신 X.

UPDATE "Campaign"
   SET "statusReason" = raw->>'statusReason'
 WHERE raw->>'statusReason' IS NOT NULL
   AND "statusReason" IS NULL;

UPDATE "AdGroup"
   SET "statusReason" = raw->>'statusReason'
 WHERE raw->>'statusReason' IS NOT NULL
   AND "statusReason" IS NULL;

UPDATE "Keyword"
   SET "statusReason" = raw->>'statusReason'
 WHERE raw->>'statusReason' IS NOT NULL
   AND "statusReason" IS NULL;
