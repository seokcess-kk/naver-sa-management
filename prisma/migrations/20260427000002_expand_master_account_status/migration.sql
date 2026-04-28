-- =============================================================================
-- MasterAccountStatus enum 확장: active / disabled → active / paused / archived
-- AdvertiserStatus와 동일 형식으로 통일.
--
-- 'disabled' 값을 제거하려면 새 enum 타입을 만들어 컬럼을 옮긴 뒤 교체해야 한다
-- (PostgreSQL은 enum 값 직접 삭제 미지원). 기존 'disabled' 데이터는 'archived'
-- 로 자동 매핑한다 (soft delete 의미상 동일).
-- =============================================================================

-- 1. 새 enum 타입 생성
CREATE TYPE "MasterAccountStatus_new" AS ENUM ('active', 'paused', 'archived');

-- 2. MasterAccount.status 컬럼을 새 타입으로 교체
--    'disabled' → 'archived' 매핑. 기본값 제약은 캐스팅 전 일시 해제.
ALTER TABLE "MasterAccount" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "MasterAccount"
  ALTER COLUMN "status" TYPE "MasterAccountStatus_new"
  USING (
    CASE "status"::text
      WHEN 'disabled' THEN 'archived'::"MasterAccountStatus_new"
      ELSE "status"::text::"MasterAccountStatus_new"
    END
  );

ALTER TABLE "MasterAccount"
  ALTER COLUMN "status" SET DEFAULT 'active'::"MasterAccountStatus_new";

-- 3. 구 enum 제거 후 새 enum 이름 변경
DROP TYPE "MasterAccountStatus";
ALTER TYPE "MasterAccountStatus_new" RENAME TO "MasterAccountStatus";
