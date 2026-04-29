-- =============================================================================
-- F-11.5 Guardrail — Advertiser 일 변경 한도 컬럼 4개 추가
--
-- 배경:
--   P2 자동 비딩 폭주 방지. F-11.2 cron 의 매 OptimizationRun 직전에
--   본 한도들을 검사하고, 초과 시 result='skipped_guardrail' 로 차단.
--   본 PR 은 schema 컬럼 + default 만. 검사 로직은 backend (F-11.2).
--
-- 변경 요약:
--   Advertiser ALTER × 4
--     1) guardrailEnabled              BOOLEAN  DEFAULT true
--     2) guardrailMaxBidChangePct      INTEGER  DEFAULT 20
--     3) guardrailMaxChangesPerKeyword INTEGER  DEFAULT 3
--     4) guardrailMaxChangesPerDay     INTEGER  DEFAULT 50
--
-- 설계 결정:
--   1) 한도 분리 (광고주 단위 + 키워드 단위):
--      - maxBidChangePct: 1회 변경 폭 제한 — 한 번에 ±20% 초과 변경 차단
--        (입찰가 단조 폭증 방지 / 추정 오류로 인한 과조정 차단).
--      - maxChangesPerKeyword: 키워드 1개에 대한 24h 빈도 제한 — 동일
--        키워드 반복 조정 시 수렴 실패 / 비용 누수 방지 (3회/일 보수).
--      - maxChangesPerDay: 광고주 전체 24h 총량 — 정책 다수 동시 트리거
--        시 SA API 폭주 차단 (50회/일 = 100키워드 평균 0.5회/일).
--      세 한도 모두 OR 조건이 아닌 AND 검사 — 어느 하나라도 초과면 차단.
--
--   2) 룰(BiddingPolicy) 단위 한도 비포함:
--      운영 데이터 누적 후 룰별 변경 패턴 확인 후 추가 검토.
--      현재는 광고주 단위 maxChangesPerDay 로 상위 차단만 제공.
--
--   3) DEFAULT 즉시 안전:
--      Postgres ALTER ADD COLUMN ... DEFAULT 는 메타데이터 변경만 (rewrite X,
--      v11+). 기존 행에 default 값이 즉시 적용 — 별도 UPDATE 불필요.
--
--   4) guardrailEnabled=true 기본:
--      신규/기존 광고주 모두 가드레일 활성. 긴급 상황(이벤트성 대량 조정)
--      에서만 admin 이 false 로 토글. 토글 감사 로그는 후속 (Kill Switch
--      At/By 패턴 재사용 검토).
--
--   5) 범위 검증은 호출부:
--      DB 는 INTEGER + default 만 강제. 1..100 / 1..20 / 1..1000 범위는
--      Server Action Zod 스키마(UpdateAdvertiserGuardrail) 에서 강제.
--      CHECK 제약은 운영 중 한도 상한 조정 가능성 고려해 미적용.
--
--   6) RLS 정책 변경 X:
--      Advertiser tenant_isolation 정책은 기존 그대로 유효 (컬럼 추가는
--      RLS 영향 없음, 정책은 행 단위 평가).
-- =============================================================================

ALTER TABLE "Advertiser"
  ADD COLUMN "guardrailEnabled"              BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "guardrailMaxBidChangePct"      INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN "guardrailMaxChangesPerKeyword" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "guardrailMaxChangesPerDay"     INTEGER NOT NULL DEFAULT 50;
