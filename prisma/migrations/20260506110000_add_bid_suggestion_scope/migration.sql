-- Migration: BidSuggestion 묶음 권고 구조 (scope/affectedCount/targetName/itemsJson)
--
-- 목적: 키워드 1:1 권고만 가능한 기존 BidSuggestion 을 광고그룹/캠페인 단위 묶음 권고까지
--       표현 가능하도록 확장. 5천 행 단위 권고 폭발로 Inbox 운영 불가능 → 1건 묶음으로 N개 키워드 표현.
--
-- 안전성:
--   1) ADD COLUMN 만 사용 (drop/rename 없음)
--   2) scope/affectedCount 는 NOT NULL DEFAULT 로 기존 행 자동 채움 (PostgreSQL 11+ instant-add).
--   3) targetName/itemsJson 은 nullable — backfill 불필요 (단건 키워드 권고는 null 정상).
--   4) 인덱스 추가 없음 — scope 필터는 (advertiserId, status) 기존 인덱스로 좁혀진 후 인메모리 필터로
--      충분. 추가 인덱스 비용 가치 없음.
--
-- 검증: 기존 행은 scope='keyword', affectedCount=1, targetName=NULL, itemsJson=NULL 로 채워져
--       단건 흐름 그대로 동작.

-- 1) 묶음 단위 enum
CREATE TYPE "SuggestionScope" AS ENUM ('keyword', 'adgroup', 'campaign');

-- 2) BidSuggestion 4 컬럼 추가
ALTER TABLE "BidSuggestion"
  ADD COLUMN "scope" "SuggestionScope" NOT NULL DEFAULT 'keyword',
  ADD COLUMN "affectedCount" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "targetName" TEXT,
  ADD COLUMN "itemsJson" JSONB;
