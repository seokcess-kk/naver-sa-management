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
