-- =============================================================================
-- F-11.4 TargetingRule 모델 신규 — 광고주 1:1 시간대·지역·디바이스 가중치
--
-- 배경:
--   P2 비딩 자동화에서 "특정 요일·시간 / 디바이스 / 지역" 가중을 BiddingPolicy 가
--   산출한 baseBid 에 곱해 입찰가를 조정. 본 PR 은 모델 / FK / RLS 만 — cron 통합
--   (F-11.x 후속) 과 UI 는 별도 PR.
--
-- 변경 요약:
--   1) TargetingRule 신규 — 광고주 단위 가중치 룰 (advertiserId @unique 1:1)
--   2) RLS — advertiserId 기반 tenant_isolation
--
-- 설계 결정:
--   1) 광고주 1:1 (advertiserId @unique):
--      "정책별 override (BiddingPolicy 단위 가중치)" 는 운영 stable 후 결정. 운영 데이터
--      누적 전 모델을 분기시키면 schema migration 부담만 늘어남. unique constraint 로
--      "광고주 1행" 을 강제하여 어디서든 lookup 결과 단일성 보장 + 자동 lookup 인덱스
--      효과 동시 획득. override 필요 시 (advertiserId, scope) 복합 unique 로 후속 변경.
--
--   2) 단일 row + JSON 컬럼 (정규화 X):
--      168(시간) + 17(시도) + 2(디바이스) ≈ 187 entry 를 별도 row 로 정규화하면
--      광고주 N × 187 row 로 카디널리티 부풀고, read 패턴은 항상 "광고주 1행 전체"
--      이므로 JSON passthrough 가 가장 단순. cron 진입 시점에 1 query 로 전체 가중치
--      로드 → in-memory lookup. 운영 stable 후 (예: 키별 변경 이력 추적이 필요해질 때)
--      정규화 검토.
--
--   3) hourWeights 키 형식 "{day}-{hour}":
--      day  : mon|tue|wed|thu|fri|sat|sun
--      hour : 0..23 (KST)
--      예) { "mon-0": 1.0, "mon-9": 1.5, "fri-22": 0.7 } — max 168 키.
--      누락 키는 defaultWeight 적용 → cron 코드 단순.
--      대안 (요일 array 7 × 24 nested array) 검토했으나 부분 변경 시 전체 재작성
--      필요 → flat object 가 patch / merge 모두 단순.
--
--   4) regionWeights 자동 비딩 미적용 (모델만):
--      네이버 SA API 응답에 키워드별 노출 지역 정보가 분리돼 들어오지 않음 → 자동
--      비딩에서 "현재 노출 지역" 을 알 수 없어 가중 적용 불가. 시·도 코드 2자리 ("11"
--      서울 / "26" 부산 등 행정구역 코드) 를 키로 받아 UI 시각화 / 향후 보고서 용도
--      확보. 자동 비딩 통합은 SA API 가 지역 breakdown 을 제공하는 시점 후속.
--
--   5) defaultWeight Decimal(4, 2) (0..9.99):
--      운영 입력 권장 0.1..3.0 — clamp 는 호출부 Zod 책임. DB 는 범위 강제 X (cleanup
--      마이그레이션 부담 회피 + 오타 / 확장 여유). enabled=false 시 cron 은 가중 적용
--      자체 스킵 (defaultWeight 1.0 과 동등).
--
--   6) 모든 JSON 컬럼 default '{}' 빈 객체:
--      신규 행은 빈 객체로 시작 → 호출부에서 lazy patch (덮어쓰기 X, merge). NULL 회피
--      로 코드 분기 단순화 (JSON_BUILD_OBJECT / jsonb_set 패턴 일관).
--
--   7) 인덱스 추가 X:
--      advertiserId @unique 자동 lookup 인덱스로 충분 (광고주 횡단 enabled 카운트
--      쿼리는 본 PR 비포함). 추측 인덱스 추가 금지 원칙 준수.
--
-- 안전성:
--   - 신규 테이블 (행 0건) — NOT NULL / DEFAULT 즉시 적용.
--   - enum 변경 X.
--   - RLS ENABLE 직후 정책 생성 — 적재 전 적용.
--   - 기존 광고주 backfill 없음 — backend 가 페이지 진입 / cron 진입 시 lazy upsert.
-- =============================================================================

-- 1) TargetingRule 테이블 생성
CREATE TABLE "TargetingRule" (
  "id"            TEXT NOT NULL,
  "advertiserId"  TEXT NOT NULL,
  "enabled"       BOOLEAN NOT NULL DEFAULT true,
  "defaultWeight" DECIMAL(4, 2) NOT NULL DEFAULT 1.0,
  "hourWeights"   JSONB NOT NULL DEFAULT '{}',
  "regionWeights" JSONB NOT NULL DEFAULT '{}',
  "deviceWeights" JSONB NOT NULL DEFAULT '{}',
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TargetingRule_pkey" PRIMARY KEY ("id")
);

-- 2) advertiserId @unique — 광고주 1:1 강제 (자동 lookup 인덱스 동시 획득)
CREATE UNIQUE INDEX "TargetingRule_advertiserId_key"
  ON "TargetingRule"("advertiserId");

-- 3) FK — Advertiser Cascade (광고주 삭제 시 가중치 룰도 함께 정리)
ALTER TABLE "TargetingRule"
  ADD CONSTRAINT "TargetingRule_advertiserId_fkey"
  FOREIGN KEY ("advertiserId") REFERENCES "Advertiser"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 4) RLS — advertiserId 기반 tenant_isolation (F-9.x / F-10 / F-11.x 패턴 일관)
ALTER TABLE "TargetingRule" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_targetingrule" ON "TargetingRule"
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "TargetingRule"."advertiserId"
        AND uaa."userId" = auth.uid()::text
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "UserAdvertiserAccess" uaa
      WHERE uaa."advertiserId" = "TargetingRule"."advertiserId"
        AND uaa."userId" = auth.uid()::text
    )
  );
