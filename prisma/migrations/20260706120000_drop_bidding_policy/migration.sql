-- Migration: BiddingPolicy 완전 제거 (Phase B 후속)
--
-- 배경:
--   - auto-bidding 자동적용 트랙은 Phase B(20260706110000_phase_b_retire_autobidding)에서
--     은퇴했고, 그 트랙 전용이던 BiddingPolicy(키워드별 목표순위 정책)는 이제 값이
--     아무 곳에도 배선되지 않는다 (CRUD UI / rank_deviation 알림 소비처 전부 제거).
--   - BiddingPolicy row = 0 → 라이브 영향 0 인 데드코드 제거다.
--
-- 안전성:
--   - BiddingPolicy 를 참조하던 유일한 FK 는 OptimizationRun.policyId (SET NULL) 였고,
--     OptimizationRun 은 phase_b 마이그레이션에서 이미 DROP 됨 → 현재 참조 제약 없음.
--   - DROP TABLE 이 자신의 인덱스(UNIQUE keywordId_device / advertiserId_enabled / keywordId),
--     FK 제약(advertiserId / keywordId Cascade), RLS 정책(tenant_isolation_biddingpolicy)을
--     함께 제거한다.

DROP TABLE "BiddingPolicy";
