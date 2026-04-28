-- =============================================================================
-- F-1.3 — Advertiser.memo 길이 제약 추가
--
-- 배경:
--   F-1.3 (광고주 메타정보) — 자유 메모 필드. 무제한 TEXT 보다 VARCHAR(500) 으로
--   상한을 두어 입력 가드 + UI 표시 일관성 확보.
--
-- 영향:
--   - 초기 마이그레이션(20260427000000_initial_schema)에서 "memo" 가 이미
--     TEXT 로 생성되어 있음. 따라서 ADD COLUMN 이 아닌 ALTER COLUMN ... TYPE.
--   - 기존 row 의 memo 데이터는 보존 (현 시점 운영 데이터에 500자 초과 row 가
--     없다는 전제. 안전장치로 USING substring(...) 적용해 잘려도 실패하지 않게 함).
-- =============================================================================

ALTER TABLE "Advertiser"
  ALTER COLUMN "memo" TYPE VARCHAR(500)
  USING substring("memo" FROM 1 FOR 500);
