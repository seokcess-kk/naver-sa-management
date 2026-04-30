-- =============================================================================
-- Advertiser.lastSyncAt 신규 — 동기화 마지막 시각 (sync 종류별 ISO 맵)
--
-- 배경:
--   UI 헤더에 "마지막 동기화: N분 전" 배지 노출. campaigns / adgroups / keywords /
--   ads / extensions 5종 각각 별도 시각이 필요 → 광고주당 5컬럼 vs JSON 맵 1컬럼.
--   - sync 종류는 5개로 안정적이지만 향후 확장 (예: products / placements) 가능성
--   - 호출부(헬퍼)에서 키 일관성 책임 → JSON passthrough 가 schema migration 부담 0
--   - 운영 stable 후 정규화 (Sync 모델 별도) 검토 가능
--
-- 변경 요약:
--   ALTER TABLE "Advertiser" ADD COLUMN "lastSyncAt" JSONB NOT NULL DEFAULT '{}'.
--
-- 안전:
--   NOT NULL DEFAULT '{}' — 기존 row 는 빈 객체로 채워짐. 이후 sync 호출 시 점진 갱신.
--   읽기 측은 키 누락을 정상 케이스로 처리해야 함 (헬퍼 getLastSyncAt 가 보장).
-- =============================================================================

ALTER TABLE "Advertiser"
  ADD COLUMN "lastSyncAt" JSONB NOT NULL DEFAULT '{}';
