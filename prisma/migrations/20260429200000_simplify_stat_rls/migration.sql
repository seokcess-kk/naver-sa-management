-- =============================================================================
-- F-9.x 후속 — Stat* RLS 정책 advertiserId 단순화 + StatHourly 신규 RLS
--
-- 배경:
--   F-9.1 (StatDaily.advertiserId 추가) / F-9.2 (StatHourly 신규) 로 두 모델
--   모두 advertiserId 비정규화 컬럼 + Advertiser FK Cascade 보유.
--   기존 StatDaily RLS 정책은 refId 가 level 별로 다른 엔티티의 내부 id 라
--   campaign / adgroup / keyword 3-way join + level 별 OR 분기로 복잡했음.
--   이제 advertiserId 단일 컬럼으로 EXISTS 한 번이면 충분 — 단순화.
--
--   StatHourly 는 F-9.2 에서 RLS 미설정 상태로 도입되었으므로 본 PR 에서
--   동일 패턴으로 정책 신규 추가.
--
-- 정책 모델 (기존 다른 모델과 동일):
--   - FOR ALL TO authenticated (service_role 은 RLS 자동 bypass)
--   - admin 별도 함수 없음 (기존 마이그레이션과 동일 — admin 우회는 service_role 경유)
--   - EXISTS UserAdvertiserAccess WHERE advertiserId = "Stat*"."advertiserId"
--                                   AND userId = auth.uid()::text
--
-- 영향:
--   - StatDaily 정책 교체 — 기존 정책명 "tenant_isolation_statdaily" DROP 후 재생성
--   - StatHourly 신규 RLS ENABLE + 정책 생성
--   - 쿼리 비용: 3-way join (Keyword→AdGroup→Campaign→UserAdvertiserAccess) 제거
--               → 단일 EXISTS (advertiserId, userId) 인덱스 hit. 핫패스 KPI / 시간 차트
--               응답 시간 개선 + RLS 평가 비용 절감.
--   - 정합성: F-9.1 / F-9.2 에서 advertiserId 적재 시 refId owner advertiser
--             resolve 책임 — RLS 가 advertiserId 만 본다는 점이 ingest 정확성에
--             의존. backend-engineer ingest 로직에서 advertiserId 검증 필수.
--
-- 안전성:
--   - DROP POLICY → CREATE POLICY 가 동일 트랜잭션에서 실행되므로 빈틈 없음.
--   - StatHourly 는 신규 ENABLE — 기존 행 0건 가정 (F-9.2 직후), 적재 전 적용 권장.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- StatDaily — 기존 refId 기반 3-way join 정책 제거 후 advertiserId 단순화
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "tenant_isolation_statdaily" ON "StatDaily";

CREATE POLICY "tenant_isolation_statdaily" ON "StatDaily"
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "StatDaily"."advertiserId"
        AND uaa."userId" = auth.uid()::text
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "StatDaily"."advertiserId"
        AND uaa."userId" = auth.uid()::text
    )
  );

-- -----------------------------------------------------------------------------
-- StatHourly — F-9.2 NOTE 해소, advertiserId 단순화 패턴 그대로 적용
-- -----------------------------------------------------------------------------
ALTER TABLE "StatHourly" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_stathourly" ON "StatHourly"
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "StatHourly"."advertiserId"
        AND uaa."userId" = auth.uid()::text
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "StatHourly"."advertiserId"
        AND uaa."userId" = auth.uid()::text
    )
  );
