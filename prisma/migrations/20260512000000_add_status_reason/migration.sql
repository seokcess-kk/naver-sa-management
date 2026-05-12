-- Migration: Campaign / AdGroup / Keyword 에 statusReason 컬럼 추가
--
-- 목적: 네이버 SA API 응답의 statusReason 필드 (예: "그룹 OFF", "캠페인 예산 도달") 를
--       OFF 상태 사유 표시용으로 분리 컬럼에 보관. raw.statusReason 과 동일 출처이나
--       select 시 raw 동반 부담 회피 + 표시 컬럼이라 인덱스 / RLS 영향 없음.
--
-- 안전성:
--   1) ADD COLUMN nullable — backfill 불필요 (기존 ON 행은 null 정상)
--   2) OFF 행은 다음 sync 사이클에 채워짐 (lib/naver-sa Zod 스키마에 이미 statusReason 통과 중)
--   3) 인덱스 없음 — 조회 키 아님 (status 가 1차 필터)
--   4) RLS 무관 — Campaign/AdGroup/Keyword 의 기존 RLS 가 그대로 적용

ALTER TABLE "Campaign" ADD COLUMN "statusReason" TEXT;
ALTER TABLE "AdGroup" ADD COLUMN "statusReason" TEXT;
ALTER TABLE "Keyword" ADD COLUMN "statusReason" TEXT;
