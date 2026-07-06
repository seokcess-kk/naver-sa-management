-- Migration: Phase B — auto-bidding 자동적용 트랙 완전 은퇴 (데드코드 응집세트 제거)
--
-- 배경:
--   - 본 프로젝트는 "권고(bid-inbox) + 운영자 승인" 트랙으로 피벗했고, auto-bidding
--     "자동적용" 트랙은 Phase A(2026-07-06)에서 무해화(cron 미등록)됐다.
--   - BiddingPolicy row = 0 / OptimizationRun row = 0 → 자동적용 트랙은 아무 키워드도
--     쓰지 않았다. 본 마이그레이션은 라이브 영향 0 인 데드코드 제거다.
--
-- 변경:
--   1) OptimizationRun 테이블 DROP (자동적용 실행 로그 — 소비처 전부 제거됨)
--   2) BidAutomationMode enum 에서 'auto_policy_only' 값 제거 → 'inbox' / 'off' 2값
--      · Postgres 는 enum 값 직접 삭제 불가 → 타입 재생성 방식(Prisma 표준 패턴)
--      · 재생성 전 잔존 'auto_policy_only' 행을 'off' 로 이관 (안전장치 — 데이터 0 이라 no-op)
--
-- 안전성:
--   - OptimizationRun 은 자식 테이블(FK 를 자기가 보유) — DROP TABLE 이 자신의 인덱스 /
--     FK 제약 / RLS 정책을 함께 제거. 이 테이블을 참조하는 외부 제약 없음.
--   - BiddingPolicy.runs 는 Prisma 레벨 back-relation — DB 제약 아님. 정리 불필요.

-- 1) OptimizationRun 제거 -----------------------------------------------------
DROP TABLE "OptimizationRun";

-- 2) BidAutomationMode enum 축소 ('auto_policy_only' 제거) ---------------------
-- 안전장치: 잔존 자동적용 모드 행을 off 로 이관 (enum 재생성 전, 구 타입일 때 실행).
UPDATE "BidAutomationConfig" SET "mode" = 'off' WHERE "mode" = 'auto_policy_only';

-- AlterEnum: 값 삭제는 타입 재생성으로만 가능 (Prisma 생성 패턴 준수).
BEGIN;
CREATE TYPE "BidAutomationMode_new" AS ENUM ('inbox', 'off');
ALTER TABLE "BidAutomationConfig" ALTER COLUMN "mode" DROP DEFAULT;
ALTER TABLE "BidAutomationConfig" ALTER COLUMN "mode" TYPE "BidAutomationMode_new" USING ("mode"::text::"BidAutomationMode_new");
ALTER TYPE "BidAutomationMode" RENAME TO "BidAutomationMode_old";
ALTER TYPE "BidAutomationMode_new" RENAME TO "BidAutomationMode";
DROP TYPE "BidAutomationMode_old";
ALTER TABLE "BidAutomationConfig" ALTER COLUMN "mode" SET DEFAULT 'off';
COMMIT;
