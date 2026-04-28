-- =============================================================================
-- RLS (Row Level Security) — 광고주 화이트리스트 격리
-- 정책 모델: 사용자가 UserAdvertiserAccess에 등록된 advertiserId에 속한
--           행만 SELECT/INSERT/UPDATE/DELETE 가능.
-- 인증된 클라이언트(authenticated)에만 적용. service_role은 RLS bypass.
--
-- 적용 대상: Advertiser, Campaign, AdGroup, Keyword, Ad, AdExtension,
--          StatDaily, ChangeBatch
-- 비적용: UserProfile / UserAdvertiserAccess / MasterAccount /
--       AuditLog / AlertRule / AlertEvent / ChangeItem (별도 정책 또는 service_role 전용)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Advertiser
-- -----------------------------------------------------------------------------
ALTER TABLE "Advertiser" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_advertiser" ON "Advertiser"
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "Advertiser".id
        AND uaa."userId" = auth.uid()::text
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "Advertiser".id
        AND uaa."userId" = auth.uid()::text
    )
  );

-- -----------------------------------------------------------------------------
-- Campaign
-- -----------------------------------------------------------------------------
ALTER TABLE "Campaign" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_campaign" ON "Campaign"
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "Campaign"."advertiserId"
        AND uaa."userId" = auth.uid()::text
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "Campaign"."advertiserId"
        AND uaa."userId" = auth.uid()::text
    )
  );

-- -----------------------------------------------------------------------------
-- AdGroup (campaign 조인)
-- -----------------------------------------------------------------------------
ALTER TABLE "AdGroup" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_adgroup" ON "AdGroup"
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1
        FROM "Campaign" c
        JOIN "UserAdvertiserAccess" uaa
          ON uaa."advertiserId" = c."advertiserId"
       WHERE c.id = "AdGroup"."campaignId"
         AND uaa."userId" = auth.uid()::text
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM "Campaign" c
        JOIN "UserAdvertiserAccess" uaa
          ON uaa."advertiserId" = c."advertiserId"
       WHERE c.id = "AdGroup"."campaignId"
         AND uaa."userId" = auth.uid()::text
    )
  );

-- -----------------------------------------------------------------------------
-- Keyword (adgroup → campaign 조인)
-- -----------------------------------------------------------------------------
ALTER TABLE "Keyword" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_keyword" ON "Keyword"
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1
        FROM "AdGroup" ag
        JOIN "Campaign" c              ON c.id = ag."campaignId"
        JOIN "UserAdvertiserAccess" uaa ON uaa."advertiserId" = c."advertiserId"
       WHERE ag.id = "Keyword"."adgroupId"
         AND uaa."userId" = auth.uid()::text
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM "AdGroup" ag
        JOIN "Campaign" c              ON c.id = ag."campaignId"
        JOIN "UserAdvertiserAccess" uaa ON uaa."advertiserId" = c."advertiserId"
       WHERE ag.id = "Keyword"."adgroupId"
         AND uaa."userId" = auth.uid()::text
    )
  );

-- -----------------------------------------------------------------------------
-- Ad (adgroup → campaign 조인)
-- -----------------------------------------------------------------------------
ALTER TABLE "Ad" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_ad" ON "Ad"
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1
        FROM "AdGroup" ag
        JOIN "Campaign" c              ON c.id = ag."campaignId"
        JOIN "UserAdvertiserAccess" uaa ON uaa."advertiserId" = c."advertiserId"
       WHERE ag.id = "Ad"."adgroupId"
         AND uaa."userId" = auth.uid()::text
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM "AdGroup" ag
        JOIN "Campaign" c              ON c.id = ag."campaignId"
        JOIN "UserAdvertiserAccess" uaa ON uaa."advertiserId" = c."advertiserId"
       WHERE ag.id = "Ad"."adgroupId"
         AND uaa."userId" = auth.uid()::text
    )
  );

-- -----------------------------------------------------------------------------
-- AdExtension (P1: ownerType='adgroup' 가정 — adgroup → campaign 조인)
-- 향후 다른 ownerType 추가 시 정책 OR 절 확장.
-- -----------------------------------------------------------------------------
ALTER TABLE "AdExtension" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_adextension" ON "AdExtension"
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1
        FROM "AdGroup" ag
        JOIN "Campaign" c              ON c.id = ag."campaignId"
        JOIN "UserAdvertiserAccess" uaa ON uaa."advertiserId" = c."advertiserId"
       WHERE ag.id = "AdExtension"."ownerId"
         AND "AdExtension"."ownerType" = 'adgroup'
         AND uaa."userId" = auth.uid()::text
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM "AdGroup" ag
        JOIN "Campaign" c              ON c.id = ag."campaignId"
        JOIN "UserAdvertiserAccess" uaa ON uaa."advertiserId" = c."advertiserId"
       WHERE ag.id = "AdExtension"."ownerId"
         AND "AdExtension"."ownerType" = 'adgroup'
         AND uaa."userId" = auth.uid()::text
    )
  );

-- -----------------------------------------------------------------------------
-- StatDaily
--   refId가 level별로 다른 엔티티(campaign/adgroup/keyword)의 내부 id이므로
--   level별 OR 결합으로 화이트리스트 검증.
-- -----------------------------------------------------------------------------
ALTER TABLE "StatDaily" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_statdaily" ON "StatDaily"
  FOR ALL TO authenticated
  USING (
    (
      "StatDaily".level = 'campaign'
      AND EXISTS (
        SELECT 1
          FROM "Campaign" c
          JOIN "UserAdvertiserAccess" uaa ON uaa."advertiserId" = c."advertiserId"
         WHERE c.id = "StatDaily"."refId"
           AND uaa."userId" = auth.uid()::text
      )
    )
    OR (
      "StatDaily".level = 'adgroup'
      AND EXISTS (
        SELECT 1
          FROM "AdGroup" ag
          JOIN "Campaign" c              ON c.id = ag."campaignId"
          JOIN "UserAdvertiserAccess" uaa ON uaa."advertiserId" = c."advertiserId"
         WHERE ag.id = "StatDaily"."refId"
           AND uaa."userId" = auth.uid()::text
      )
    )
    OR (
      "StatDaily".level = 'keyword'
      AND EXISTS (
        SELECT 1
          FROM "Keyword" k
          JOIN "AdGroup" ag              ON ag.id = k."adgroupId"
          JOIN "Campaign" c              ON c.id = ag."campaignId"
          JOIN "UserAdvertiserAccess" uaa ON uaa."advertiserId" = c."advertiserId"
         WHERE k.id = "StatDaily"."refId"
           AND uaa."userId" = auth.uid()::text
      )
    )
  )
  WITH CHECK (
    (
      "StatDaily".level = 'campaign'
      AND EXISTS (
        SELECT 1
          FROM "Campaign" c
          JOIN "UserAdvertiserAccess" uaa ON uaa."advertiserId" = c."advertiserId"
         WHERE c.id = "StatDaily"."refId"
           AND uaa."userId" = auth.uid()::text
      )
    )
    OR (
      "StatDaily".level = 'adgroup'
      AND EXISTS (
        SELECT 1
          FROM "AdGroup" ag
          JOIN "Campaign" c              ON c.id = ag."campaignId"
          JOIN "UserAdvertiserAccess" uaa ON uaa."advertiserId" = c."advertiserId"
         WHERE ag.id = "StatDaily"."refId"
           AND uaa."userId" = auth.uid()::text
      )
    )
    OR (
      "StatDaily".level = 'keyword'
      AND EXISTS (
        SELECT 1
          FROM "Keyword" k
          JOIN "AdGroup" ag              ON ag.id = k."adgroupId"
          JOIN "Campaign" c              ON c.id = ag."campaignId"
          JOIN "UserAdvertiserAccess" uaa ON uaa."advertiserId" = c."advertiserId"
         WHERE k.id = "StatDaily"."refId"
           AND uaa."userId" = auth.uid()::text
      )
    )
  );

-- -----------------------------------------------------------------------------
-- ChangeBatch — 본인이 만든 batch만 조회 가능 (userId 기반)
-- 시스템 cron 픽업·executor는 service_role로 처리하므로 RLS bypass.
-- -----------------------------------------------------------------------------
ALTER TABLE "ChangeBatch" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_isolation_changebatch" ON "ChangeBatch"
  FOR ALL TO authenticated
  USING ("ChangeBatch"."userId" = auth.uid()::text)
  WITH CHECK ("ChangeBatch"."userId" = auth.uid()::text);
