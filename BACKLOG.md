# Backlog

> SPEC SLA 미달 아님 / 즉시 차단 아님 항목. 우선순위·시점 잡으면 별도 PR.

## UX 품질

### CLS 0.216 — 키워드 페이지 (15K행)
- **측정일**: 2026-05-04 (Lighthouse Desktop, production build, 광고주 렌트박스 15,027행)
- **현황**: LCP 1.2s / TBT 80ms 통과. CLS 0.216 (Web Vitals "Needs Improvement", 0.1~0.25)
- **추정 원인**: client streaming(`b6d9f32`) 으로 데이터가 늦게 채워질 때 footer 합계·지표 영역이 시프트. 키워드 행 자체는 colgroup `table-layout: fixed`로 고정.
- **확인 방법**: Chrome DevTools → Performance Insights → Layout shifts 패널에서 시프트 요소 식별
- **개선안 후보**: 합계 footer / 5개 지표 컬럼 헤더의 자리 예약(min-height·skeleton placeholder), streaming fallback 영역 사이즈 고정
- **목표**: CLS ≤ 0.1

## 외부 의존 보류

### 검색어 보고서 자동화 (D.4 — 운영팀 협의 대기)
- **확인일**: 2026-05-05
- **결론**: 네이버 SA 공식 API(`api.searchad.naver.com`)에 검색어 보고서 endpoint 부재
- **콘솔 내부 endpoint**(`ads.naver.com/apis/sa/api/advanced-report`): 자동화 부적합 — 세션 쿠키 인증 / TOS 위험 / 콘솔 UI 변경 시 깨짐
- **현재 우회**: D.3 CSV 업로드 도구 (`/[advertiserId]/search-term-import`) — 운영자 수동 다운로드 + 업로드 + 분류 검토
- **D.4 재개 조건**: 운영팀 협의로 비공개 endpoint 발급 / `MasterReport` API 확인 / 또는 콘솔 내부 endpoint 공식화 권한
- **D.4 추가 게이트**: 검색어 → 광고그룹 매핑 정책 결정 (자동 추정 / 사용자 row별 선택 / 1그룹씩 업로드)
- **제외키워드 SA endpoint**: 별도 확인 필요 (현재 `lib/naver-sa/keywords.ts`에 함수 X)

### NotificationChannel 정식 채널 결정
- **Telegram** (`lib/notifier/telegram.ts`) — `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` 추가 시 자동 활성. Bot API 직접 호출, 외부 SDK 없음
- **Email** (`lib/notifier/email.ts`) — Resend SDK 호출은 stub 상태. `RESEND_API_KEY` 추가 + stub 코드 활성화 필요
- Slack 채널은 비대상 결정 (`48439c9` 제거)
- 카카오 알림톡은 별도 NotificationChannel 구현 필요 (후속)
