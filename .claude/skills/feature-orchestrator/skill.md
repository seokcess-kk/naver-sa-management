---
name: feature-orchestrator
description: SPEC v0.2.1 기능 ID(F-X.Y)를 입력 받아 5명 에이전트 팀(db-architect, naver-sa-specialist, backend-engineer, ui-engineer, qa-engineer)으로 구현할 때 사용. 기능 단락 로드 → 팀 매핑 → 작업 분배 → QA 점진 실행 → 결과 종합. F-DB.1 / F-NS.1 / F-1.1 / F-3.4 / F-7.1 등 SPEC 기능 ID 입력 시 반드시 이 스킬 사용. 단일 에이전트로 직접 구현 금지.
---

# Feature Orchestrator

## 언제 사용

- SPEC v0.2.1의 기능 ID(F-X.Y) 신규 구현 또는 변경 시작
- 예: `F-DB.1` (Prisma 스키마), `F-NS.1` (네이버 SA 클라이언트), `F-3.4` (CSV 업로드), `F-7.1` (KPI 카드)

## 핵심 원칙

1. **항상 5명 팀**으로 시작 (단일 에이전트 우회 금지)
2. **모델은 모두 opus** (Agent 도구 호출 시 `model: "opus"` 필수)
3. **빌트인 타입 `general-purpose`** (qa-engineer 포함 — Explore는 검증 스크립트 실행 불가)
4. **QA는 모듈 완성 직후 점진 실행** (전체 후 일괄 X)
5. **워크스페이스 산출 보존** (`_workspace/{featureId}/`)

## 워크플로우

### Phase 1: 기능 단락 로드

1. `SPEC_v0.2.md`에서 기능 ID(F-X.Y) 단락 검색·로드
2. 관련 단락 함께 로드:
   - 9장 (해당 모델)
   - 10장 (관련 외부 API)
   - 8장 (비기능 / 보안)
   - 2.3, 3.5, 6.6 (안전장치 흐름)
   - 12장 (확정 / 미확정 사항)

### Phase 2: 팀 매핑 결정

기능 유형별 표준 매핑:

| 기능 유형 | 협업 에이전트 (순서 = 의존 순) | 사용 스킬 |
|---|---|---|
| **신규 엔티티 / 마이그레이션** (F-DB.*) | db-architect → qa-engineer | prisma-model-add |
| **외부 API 모듈** (F-NS.*) | naver-sa-specialist → qa-engineer | naver-sa-endpoint-add |
| **CRUD 페이지** (F-1.* ~ F-5.*) | db-architect → naver-sa-specialist → backend-engineer → ui-engineer → qa-engineer | 위 + tanstack-table |
| **일괄 작업 / CSV** (F-3.3, F-3.4) | db-architect → naver-sa-specialist → backend-engineer (Job) → ui-engineer (모달) → qa-engineer | + batch-executor-job |
| **인증 / 권한** (F-1.6) | db-architect → backend-engineer → qa-engineer | prisma-model-add |
| **알림** (F-8.*) | db-architect → backend-engineer → ui-engineer → qa-engineer | prisma-model-add |
| **대시보드 / KPI** (F-7.*) | naver-sa-specialist (Stats 캐시) → backend-engineer → ui-engineer → qa-engineer | naver-sa-endpoint-add |
| **변경 프리뷰 / 롤백** (F-6.*) | db-architect → backend-engineer → ui-engineer → qa-engineer | + batch-executor-job |
| **비딩 최적화** (F-9~F-13, P2) | db-architect → naver-sa-specialist (Estimate) → backend-engineer (룰) → ui-engineer → qa-engineer | + batch-executor-job |

### Phase 3: 팀 구성 + 작업 분배

```
TeamCreate({
  name: "feature-{featureId}",
  members: [...mappedAgents],   // 위 표 매핑
})

TaskCreate({
  tasks: [
    { agent: "db-architect",        deps: [],                                            task: "..." },
    { agent: "naver-sa-specialist", deps: [],                                            task: "..." },
    { agent: "backend-engineer",    deps: ["db-architect", "naver-sa-specialist"],       task: "..." },
    { agent: "ui-engineer",         deps: ["backend-engineer"],                          task: "..." },
    { agent: "qa-engineer",         deps: ["db-architect"],   incremental: true,         task: "QA: schema 정합성 / RLS 일치" },
    { agent: "qa-engineer",         deps: ["naver-sa-specialist"], incremental: true,    task: "QA: HMAC / Rate Limit / Zod 검증" },
    { agent: "qa-engineer",         deps: ["backend-engineer"],    incremental: true,    task: "QA: ChangeBatch / 권한 / 멱등성" },
    { agent: "qa-engineer",         deps: ["ui-engineer"],         incremental: true,    task: "QA: staging / 가상 스크롤 / ChangeBatch ID 노출" },
  ]
})
```

모든 Agent 호출에 `model: "opus"`, `subagent_type: "general-purpose"`.

### Phase 4: QA 점진 실행

각 모듈 완성 직후 qa-engineer 실행 (가이드 권장: 전체 후 일괄 X).

| 선행 모듈 완성 | QA 점검 영역 |
|---|---|
| db-architect | schema 정합성, RLS 정책, 시크릿 컬럼 패턴, ChangeItem.targetType enum 갱신 |
| naver-sa-specialist | HMAC 한 곳에서만, Rate Limit 큐 통과, Zod 검증, X-Customer 헤더, raw 보존 |
| backend-engineer | ChangeBatch 흐름, lease IS NULL 조건, status=pending 정렬, 권한 체크, idempotencyKey, 시크릿 마스킹 |
| ui-engineer | staging 패턴, 미확정 셀 시각 구분, 가상 스크롤, ChangeBatch ID 노출, 광고주 컨텍스트(URL), 일괄 액션 4단계 |

QA 차단 발견 시 해당 에이전트에게 SendMessage로 수정 요청. 통과 전까지 다음 단계 진행 X.

### Phase 5: 결과 종합

오케스트레이터가 사용자에게 보고:
- 변경된 파일 목록 (실제 코드 경로)
- QA 차단 / 경고 / 통과 요약
- 다음 단계 제안 (의존하는 후속 기능)

## 데이터 전달

- **워크스페이스**: `_workspace/{featureId}/`
  - `01_db_schema.md` (db-architect 산출 요약)
  - `02_naver_modules.md` (naver-sa-specialist 산출 요약)
  - `03_backend.md` (backend-engineer 산출 요약)
  - `04_ui.md` (ui-engineer 산출 요약)
  - `05_qa_report.md` (qa-engineer 보고서)
- **최종 산출**: 실제 코드 파일 (`app/`, `lib/`, `prisma/`, `components/`)
- **중간 파일 보존**: `_workspace/`는 git에 포함하지 않음(.gitignore 추가) — 감사 추적용 로컬 보관

## 에러 핸들링

- **1회 재시도 후 재실패**: 해당 산출 누락 명시 + 사용자 결정 요청 (스킵 / 중단 / 사용자 직접 작성)
- **상충 데이터**: 삭제 X. 양쪽 출처 병기 후 사용자 결정
- **QA 차단**: 해당 에이전트에게 수정 요청. 통과 전까지 다음 단계 진행 X
- **에이전트 응답 모호**: 의존 단계 결과를 다시 보내 명확화 요청

## 첫 묶음 (P1 시작)

| 기능 ID | 매핑 | 비고 |
|---|---|---|
| **F-INIT.1** | (오케스트레이터 외 작업) | `pnpm create next-app` + Tailwind + shadcn 초기. backend-engineer 단독 또는 사용자 직접 |
| **F-DB.1** | db-architect → qa-engineer | 9장 모델 → schema.prisma 전체 + 첫 마이그레이션 |
| **F-NS.1** | naver-sa-specialist → qa-engineer | client.ts (HMAC + Rate Limit) + customer-links 모듈 |

## 테스트 시나리오

### 정상 흐름 — F-3.4 CSV 업로드

1. 사용자: "F-3.4 시작해줘"
2. 오케스트레이터: SPEC 6.3.x CSV 규격 + 6.3 키워드 + 9장 ChangeBatch + 3.5 Job Table 로드
3. 팀 매핑: db / naver-sa / backend / ui / qa
4. db-architect: ChangeBatch.idempotencyKey + ChangeItem 컬럼 검증 (이미 있음)
5. backend-engineer: PapaParse + Zod CSV 파싱 + Server Action(ChangeBatch 생성) + Chunk Executor
6. ui-engineer: CSV 미리보기 모달 + 진행률 polling
7. qa: 멱등성(externalId + natural key) / lease IS NULL / staging / 가상 스크롤
8. 종합 보고

### 에러 흐름 — naver-sa 모듈 부재

- backend-engineer가 keywords PUT 일괄 호출 필요한데 모듈 없음
- backend가 SendMessage로 naver-sa-specialist에게 의뢰
- naver-sa-specialist가 `lib/naver-sa/keywords.ts`에 `updateKeywordsBulk` 추가
- backend 작업 재개

### 에러 흐름 — QA 차단

- backend가 ChangeBatch 생성 후 즉시 NaverSAClient 호출(staging 우회) 작성
- qa-engineer가 차단: "Server Action에서 직접 API 호출. ChangeBatch + Chunk Executor로 재구성 필요"
- backend 수정 → 재검증

## 안티패턴

- ❌ 단일 에이전트로 다중 영역 작업 (예: backend가 schema도 변경)
- ❌ QA를 마지막에 일괄 (점진 실행 의무)
- ❌ `model: "opus"` 누락
- ❌ 빌트인 타입 `Explore`를 qa-engineer에 사용 (읽기 전용이라 검증 스크립트 실행 불가)
- ❌ 워크스페이스 산출 누락 (감사 추적 어려움)
- ❌ SPEC 단락 미리 로드 안 하고 작업 시작

## 검증 트리거 키워드

F-, SPEC 기능, F-DB, F-NS, F-1, F-2, F-3, F-4, F-5, F-6, F-7, F-8, 새 기능, 기능 시작, 기능 구현, feature-orchestrator
