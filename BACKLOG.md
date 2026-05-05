# Backlog

> SPEC SLA 미달 아님 / 즉시 차단 아님 항목. 우선순위·시점 잡으면 별도 PR.

## UX 품질

### CLS 0.216 — 키워드 페이지 (15K행) — 1차 개선 (재측정 대기)
- **측정일**: 2026-05-04 (Lighthouse Desktop, production build, 광고주 렌트박스 15,027행)
- **이전 현황**: LCP 1.2s / TBT 80ms 통과. CLS 0.216 (Web Vitals "Needs Improvement", 0.1~0.25)
- **1차 적용 (2026-05-05)**:
  - 키워드 한정 `loading.tsx` 신규 — 공통 fallback 의 body=h-64(256px) → 실제 페이지 구조(toolbar 2줄 + 액션바 2줄 + `max-h-[calc(100dvh-280px)] min-h-[320px]` 테이블)와 매칭. loading→page swap 시 body 확장 시프트 제거.
  - `keywords-table.tsx` toolbar 우측 statsLoading/statsError 배지 자리 예약 (`min-w-[120px]` + invisible placeholder). streaming 종료 시 옆 "총 N건" 텍스트 시프트 제거.
- **재측정 필요**: production 배포 후 Lighthouse Desktop 재실행 → CLS ≤ 0.1 도달 여부 확인. 미도달 시 footer / virtualizer 영역 추가 진단.

## 운영 검증 대기

### F-2.2 PC/모바일 매체 ON/OFF — 코드 활성화 완료 (운영 검증 필요)
- **2026-05-05**: SA Targets API 매핑 확정 + 코드 활성화
  - `lib/naver-sa/adgroups.ts`: `listAdgroupTargets` (GET /ncc/adgroups/{id}/targets) + `updateAdgroupTargets` (PUT /ncc/adgroups/{id}?fields=targetLocation,targetMedia,targetTime, body.targets) 신규
  - `bulkUpdateAdgroups` channel 액션 활성화 — 광고그룹별 GET targets → `PC_MOBILE_TARGET` 만 수정 → PUT (5건 병렬, 부분 실패 허용)
  - 기존 throw 차단 코드 제거. ChangeBatch + DB pcChannelOn/mblChannelOn 업데이트 정상 흐름
- **검증 필요**: 운영 광고주 1개로 PC/모바일 4가지 토글(true/true, true/false, false/true, false/false) → SA 콘솔 UI 에서 매체 상태 일치 확인
- **fields 파라미터 위험**: `targetLocation,targetMedia,targetTime` 은 Java sample 패턴. PC_MOBILE_TARGET 의 정확한 fields 명이 공개 X — 검증 시 다른 target(시간대/지역)이 의도치 않게 변경되는지 확인 필요

## 운영 측정 후 결정

### 동기화 시간 한계 — 1차 개선 완료, 측정 trigger 대기
- **현황 (2026-05-05)**: keywords / ads / extensions sync 에 1차 개선 적용
  - `lib/sync/concurrency.ts` 신규 — `getAdgroupChunkSize()` (env `SYNC_ADGROUP_CHUNK_SIZE`, 기본 5, clamp [1,20]) / `mapWithConcurrency` / `logSyncTiming`
  - 광고그룹 chunk N 병렬 listAPI + chunk 내부 upsert UPSERT_CONCURRENCY=10 병렬화 (Supabase pool 안전선 내, 5천 행 ~150s → ~15s 추정)
  - keywords / ads action + cron runners 양쪽 적용. extensions 는 catch 분기 정밀해서 timing 로깅만
  - 종료 시 `[sync.{kind}] totalMs=...` 로그 — `totalMs > 0.8 × maxDuration(300s) = 240s` 시 ⚠ 표시
- **2차 트리거**: 운영 로그에서 ⚠ 240s 초과 광고주 지속 발생 시 ChangeBatch + Chunk Executor (SPEC 3.5) 이관
- **운영 튜닝 옵션**: `SYNC_ADGROUP_CHUNK_SIZE` env 조정 (Rate Limit 한도 / 응답 시간 측정 후)

## 외부 의존 보류

### 검색어 보고서 자동화 (D.4 — 운영팀 협의 대기)
- **재조사 (2026-05-05)**: 공식 SA API 에 검색어(query 단위) 보고서 endpoint **부재 확정**
  - `MasterReport`: 광고 구조 master data (Campaign / Adgroup / Keyword / Ad / Asset 등 29 엔티티). 검색어 데이터 X
  - `StatReport`: 광고/키워드 단위 통계 (AD / AD_DETAIL / EXPKEYWORD / SHOPPINGKEYWORD_DETAIL / CRITERION 등). 검색어(query) 단위 X
- **콘솔 내부 endpoint**(`ads.naver.com/apis/sa/api/advanced-report`): 자동화 부적합 — 세션 쿠키 인증 / TOS 위험 / 콘솔 UI 변경 시 깨짐
- **현재 우회**: D.3 CSV 업로드 도구 (`/[advertiserId]/search-term-import`) — 운영자 수동 다운로드 + 업로드 + 분류 검토
- **D.4 재개 조건**: 네이버 SA 운영팀 협의로 비공개 endpoint 발급 (외부 의존 — 코드 작업 불가)
- **D.4 추가 게이트**: 검색어 → 광고그룹 매핑 정책 결정 (자동 추정 / 사용자 row별 선택 / 1그룹씩 업로드)
- **제외키워드 SA endpoint**: 별도 확인 필요 (현재 `lib/naver-sa/keywords.ts`에 함수 X)

### NotificationChannel — Telegram 단일 채널로 확정 (2026-05-05)
- **Telegram** (`lib/notifier/telegram.ts`) — 정식 채널. `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` 둘 다 있을 때 자동 활성. Bot API 직접 호출, 외부 SDK 없음
- **Slack / Email / 카카오 알림톡** — 비대상. 필요 시 사용자 요청으로 채널 신규 구현
