-- =============================================================================
-- 첫 admin 승격 (Supabase SQL Editor 붙여넣기 실행)
-- =============================================================================
-- 사전:
--   1. /login 회원가입 또는 매직링크 → 로그인 1회 (UserProfile 자동 생성, role=viewer)
--   2. Supabase Dashboard → Authentication → Users 탭에서 본인 사용자 ID(UUID) 복사
--   3. 아래 {USER_ID}를 복사한 UUID로 치환 후 실행
-- =============================================================================

-- 본인 UserProfile을 admin으로 승격
UPDATE "UserProfile"
SET role = 'admin', "updatedAt" = NOW()
WHERE id = '{USER_ID}';

-- 검증 (1 row 반환되면 성공)
SELECT id, "displayName", role, status FROM "UserProfile" WHERE id = '{USER_ID}';
