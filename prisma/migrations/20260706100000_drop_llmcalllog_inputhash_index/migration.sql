-- Migration: LlmCallLog.inputHash 미사용 인덱스 제거
--
-- 배경:
--   - Phase A 에서 no-op 메타캐시(findRecentCallLog) 를 제거하면서 inputHash 로 조회하는
--     경로가 사라졌다. LlmCallLog 는 항상 fromCache=false 원본 호출만 적재한다.
--   - 이에 따라 "캐시 hit 검사" 용도로 만든 LlmCallLog_inputHash_idx 는 미사용 인덱스가 되었다.
--   - inputHash 컬럼 자체는 유지 — SHA-256(prompt+model+params) 적재 dedup / 디버그 키.
--
-- 안전성:
--   1) 인덱스만 DROP — 컬럼/데이터 변경 없음.
--   2) 이 인덱스를 참조하는 제약 없음 → 단순 DROP INDEX.

DROP INDEX "LlmCallLog_inputHash_idx";
