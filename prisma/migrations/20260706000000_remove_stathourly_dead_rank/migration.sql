-- Migration: StatHourly.recentAvgRnk 죽은 컬럼 제거
--
-- 배경:
--   - 네이버 SA API 는 "시간대별/실시간 노출 순위" 를 제공하지 않는다 (공식 확정 Issue #947).
--   - 그래서 StatHourly.recentAvgRnk 는 적재 이래로 항상 NULL 로만 기록되어 왔다
--     (유일 writer 였던 lib/stat-hourly/ingest.ts 의 synthRow 가 recentAvgRnk: null 하드코딩).
--   - 이를 소비하던 bid-suggest "6시간 가중 순위" 경로(loadWeightedRankMap 등)는 영구 dead 였다.
--   - rank 권고는 Keyword.recentAvgRnk (일별 fallback) 로 이미 정상 동작 → 컬럼 제거는 기능 영향 없음.
--
-- 안전성:
--   1) 컬럼을 참조하는 인덱스/제약 없음 (unique/index 는 date+hour+level+refId+device 조합만) → 단순 DROP.
--   2) 값이 항상 NULL 이라 데이터 손실 없음.

ALTER TABLE "StatHourly" DROP COLUMN "recentAvgRnk";
