# 네이버 검색광고 다계정 운영 어드민
## 상위 스펙 문서 v0.2

> **1차 운영 효율 도구 + 2차 비딩 최적화**
> 1인 개발 · Claude Code 바이브코딩 전제

| | |
|---|---|
| 문서 버전 | v0.2.2 |
| 작성일 | 2026-04-27 |
| 수신 / 실행자 | 개발팀장 (1인 개발, Claude Code 활용) |
| 함께 제공되는 문서 | (추후) Claude Code 세션별 작업지시서 — 별도 마크다운 |

### v0.2.1 → v0.2.2 변경 요약 (모델 2 전환 — 광고주별 키 모음)
네이버 SA의 다계정 운영 모델을 **MCC 마스터(모델 1) → 광고주별 키 모음(모델 2)** 으로 전환. 마스터 권한 발급 부담을 제거하고, 외부 고객사의 광고주를 본인이 직접 컨트롤하며 키 발급받는 운영 환경에 맞춤.

- **`MasterAccount` 모델 제거**: 평면 구조. `Advertiser`만 존재. `Advertiser.masterId` 외래키 제거
- **`Advertiser`에 키 컬럼 추가**: `apiKeyEnc / apiKeyVersion / secretKeyEnc / secretKeyVersion` 4종 (AES-256-GCM 암호화). `apiKeyEnc / secretKeyEnc`은 **F-1.2 CSV 등록(메타만) 지원 위해 nullable**. 키 미입력 상태에서는 SA API 호출 차단
- **`/customer-links?type=MYCLIENTS` 자동 동기화 비대상**: 마스터 권한 필요한 endpoint. 광고주 등록은 **수동 등록 + CSV 업로드(F-1.2)** 흐름으로 변경
- **시크릿 운영 단위 변경**: "마스터 1개 키" → "광고주별 키 N개". 키 로테이션도 광고주별
- **testConnection endpoint 변경**: `/customer-links` → `/billing/bizmoney` (자기 자신 endpoint, 권한 무관)
- **`lib/naver-sa/customer-links.ts` 보존 + 미사용 표시**: 향후 마스터 권한 받으면 활용 가능. 현재 호출부 0건
- **마이그레이션 4건 누적**: initial → RLS → MasterAccountStatus 확장 → MasterAccount 제거(모델 2 pivot)
- **운영 검증 완료**: F-1.1(광고주 등록·테스트 연결) 실 동작 확인. 비즈머니 응답 정상 토스트

### v0.2 → v0.2.1 변경 요약 (1차 리뷰 반영)
- **확장소재 P1 4종 → 3종**: 가격링크 제외(P2+로 이동). 추가제목 / 추가설명 / 이미지만
- **큐 설계 명시**: Vercel Cron + Server Actions 청크 → ChangeBatch Job Table + Chunk Executor 패턴 (3.5절 신규)
- **삭제 정책 강화**: P1 대량 삭제 제거. 단건 삭제도 admin 권한 + 2차 확인 필수. 기본은 OFF
- **롤백 제한**: ChangeBatch 단위 1-클릭 → "rollback 가능한 변경(생성·수정·OFF) + 롤백 전 현재 상태 재검증 필수"
- **권한 모델 분리**: Supabase Auth metadata 단독 → Supabase Auth(인증) + 앱 DB(UserProfile / UserAdvertiserAccess) 병행
- **암호화 방식 구체화**: ENCRYPTION_KEY env, 키 버전 컬럼, 평문 로그 금지 테스트, envelope encryption 검토
- **P1 KPI에서 전환·매출 제거**: P2로 이동(매출 조인 시점). P1은 노출/클릭/CTR/CPC/비용/평균순위(가능 시)
- **CSV 템플릿 규격 명시**: operation 컬럼, 타깃 ID, idempotency, 빈 값·오류·중복 처리 (6.3 하위 섹션 신규)

### v0.1 → v0.2 변경 요약
- **목적 재정의**: 포괄적 광고 운영 시스템 → "다계정 운영 효율"(1차) + "비딩 최적화"(2차)로 좁힘
- **Phase 압축**: 5단계(P1~P5, 26~33주) → 2단계(P1~P2, 10~14주)
- **기술 스택 단순화**: Python 서비스·OpenAI·BullMQ·Axiom·Solapi 제거. Supabase 풀스택으로 통합
- **삭제**: 6종 목표 프리셋, 자연어 룰 빌더, LLM 에이전트(P5), 횡단 뷰
- **신규**: TanStack Table·Virtual, Estimate API 시뮬레이터, 알림 채널 추상화
- **확정 결정 12개**, 미확정 사항 추후 정리

---

## 0. 문서 사용법

### 0.1 이 문서의 위치
- **본 문서(상위 스펙)**: 전체 방향·아키텍처·Phase별 범위·결정 근거
- **에이전트 팀 + 스킬 (`.claude/agents/`, `.claude/skills/`)**: `feature-orchestrator` 스킬로 기능 ID(F-X.Y) 단위 호출. 5명 에이전트 팀(db / naver-sa / backend / ui / qa)이 협업하며 QA 점진 실행. F-INIT.1부터 순차.

### 0.2 읽는 순서
- 처음: 1장 → 2장 → 4장 (Phase 로드맵)
- 작업 시: 해당 Phase 기능 명세(6·7장) → 세션별 작업지시서 → Claude Code
- 결정 시: 12장 체크리스트

### 0.3 전제
1인 개발자 + Claude Code 협업. 모놀리식 단일 레포. 익숙한 스택 우선(Supabase + Vercel).

---

## 1. 프로젝트 정의

### 1.1 한 줄 정의
> **네이버 검색광고 API를 이용해 다수 광고주 계정을 통합 운영하는 어드민. 1차 가치는 운영 공수 절감(통합 관리·대량 작업·기본 알림), 2차 가치는 통계 기반 비딩 최적화(키워드별 한계효용 분석을 통한 목표 노출 순위 유지).**

### 1.2 핵심 문제 (운영 공수 중심)
- 광고주마다 네이버 UI 따로 로그인 → 매번 시간 누적
- 키워드 5천 단위 ON/OFF·입찰가 변경을 네이버 UI에서 하기 번거로움
- 이상 징후(예산 소진, CPC 급등 등)를 사후에 인지
- (2차) 1위 노출이 항상 ROI 최적이 아닌데, 네이버 UI는 한계효용 분석을 도와주지 않음

### 1.3 목적 (2단계)

**P1 — 운영 효율 (1차 가치)**
- 다계정 통합 운영 (광고주 1개 선택 컨텍스트, 매번 재로그인 X)
- 키워드·소재 대량 관리 (다중 선택, 인라인 편집, CSV 업로드)
- 입찰가 일괄 조정 (절대값 / 비율)
- 기본 성과 가시화 + 이상 징후 알림

**P2 — 비딩 최적화 (2차 가치)**
- Estimate API 기반 입찰가 → 예상 성과 시뮬레이션
- 키워드별 목표 노출 순위 선언
- 통계적 한계효용 분석 (1위 vs 3위 ROI 비교)
- 자동 비딩 룰 + Guardrail + Kill Switch

### 1.4 기대 효과
- **운영 공수**: 다계정 로그인·일괄 작업·반복 수정 시간 50%+ 절감
- **의사결정 속도**: 이상 징후 감지·기본 대응 (시간 → 분)
- **(P2) 광고비 효율**: 한계효용 기준 입찰가 운영으로 비용 대비 클릭·노출 순위 효율 개선. **매출/전환 데이터 연동 시 ROAS 10~20% 개선 목표** (조건부)

### 1.5 비대상 (의도적으로 안 만드는 것)
- 6종 목표 프리셋(이커머스/리드/브랜드/...) — 단일 목표("순위 유지")만
- 자연어 룰 빌더 — 1인 운영자가 직접 룰 설정
- LLM 자율 에이전트 (Tool Use 기반 자동 실행)
- 다중 매체 통합 (카카오·구글·메타) — 향후 검토
- 횡단 뷰 (전 광고주 한 화면 합산) — 광고주별 컨텍스트만
- **MCC 마스터 자동 광고주 동기화** (`/customer-links?type=MYCLIENTS`) — 모델 2(광고주별 키)라 마스터 권한 미사용. 향후 마스터 권한 확보 시 재검토

---

## 2. 핵심 설계 원칙

### 2.1 1인 + Claude Code 바이브코딩
- **모놀리식 단일 레포**: Next.js + Supabase 단일 스택. 마이크로서비스 금지.
- **세션 단위 기능 분해**: 각 기능 1~3 세션에 끝낼 수 있게 작업지시서로 분해
- **익숙한 스택 우선**: Supabase + Vercel 조합. 새 도구 도입은 한계 부딪힐 때만.

### 2.2 광고주별 컨텍스트
- GNB 셀렉터로 광고주 1개 선택 → 그 컨텍스트에서만 작업
- 전체 횡단 뷰 없음 (5천 키워드 × 10 광고주 한 화면은 운영 자체가 안 됨)

### 2.3 안전장치 우선
- 모든 일괄 작업: **선택 → 미리보기 → 확정 → 롤백** 4단계 (롤백은 가능한 변경에 한정, 현재 상태 재검증 후 항목 단위 적용)
- 변경 이력은 모두 감사 로그
- (P2) Guardrail: 룰당 일 변경 한도, Kill Switch 1-클릭 정지
- **예외 — BidSuggestion 단건 승인 (Inbox)**: `engineSource='budget' | 'targeting'` 권고는 광고그룹·캠페인 단위 단건 적용으로 ChangeBatch 큐를 거치지 않고 Server Action 안에서 즉시 SA 호출 + ChangeItem 사후 기록 (`status='done'`). 운영자가 Inbox에서 명시 승인한 단건이며 결과를 즉시 확인하는 UX가 자연스럽기 때문. 묶음 권고(`scope ≠ 'keyword'` 또는 `affectedCount > 100`) 도입 시점에 Chunk Executor 패턴(3.5절)으로 이관 예정. `engineSource='bid'`는 본 예외 비대상 — ChangeBatch 정상 흐름 유지.

### 2.4 데이터 우선 축적
- P1부터 모든 성과·변경 이력 구조화 저장 → P2의 학습 데이터
- 시간별 데이터는 네이버 API에서 7일만 보존되므로 자체 ETL로 누적 적재

---

## 3. 아키텍처

### 3.1 기술 스택 (확정)

| Layer | 선택 | 비고 |
|---|---|---|
| 언어 | TypeScript | |
| 프레임워크 | Next.js 16 + React 19 (App Router) | Server Actions 적극 활용. Turbopack 활성 |
| UI | Tailwind 4 + shadcn/ui + Radix(@base-ui/react) | 폰트: Pretendard |
| 테이블 | TanStack Table v8 + TanStack Virtual | 5천 행 인라인 편집 |
| 차트 | shadcn charts (Recharts 기반) | |
| 폼 | react-hook-form + Zod 4 | |
| 서버 데이터 | TanStack Query 5 + Server Actions | |
| ORM | Prisma 7 (`prisma.config.ts` 도입) | 데이터 접근은 Prisma 중심 통일 |
| DB | Supabase Postgres | |
| 인증 | Supabase Auth | 운영자 2~3명, 역할 기반 |
| 스토리지 | Supabase Storage | 확장소재 이미지 |
| 캐시 | Upstash Redis | 단순 KV |
| 큐 / 스케줄 | ChangeBatch Job Table + Route Handler Chunk Executor + Vercel Cron | 3.5절 참조. 한계 시 Inngest 갈아끼우기 |
| CSV | PapaParse + Zod 검증 | |
| LLM (P2 보조) | Anthropic Claude | 분석·설명 생성 한정 |
| 알림 | NotificationChannel 추상 인터페이스 | 정식 채널 추후 결정 |
| 모니터링 | Sentry + Vercel Analytics | |
| 배포 | Vercel | |
| 테스트 | Playwright E2E + Vitest 핵심 로직 | |

### 3.2 아키텍처 다이어그램

```
┌─────────────────────────────────────────────────────────┐
│              Next.js App (단일 레포 / Vercel)            │
│  ┌────────────┐  ┌────────────┐  ┌──────────────────┐   │
│  │ Pages      │  │ Server     │  │ Route Handlers   │   │
│  │ shadcn/ui  │  │ Actions    │  │ (Cron, Webhook)  │   │
│  └─────┬──────┘  └─────┬──────┘  └────────┬─────────┘   │
│        │               │                  │             │
│  ┌─────┴───────────────┴──────────────────┴───────────┐ │
│  │  Core Services (TS)                                │ │
│  │  • NaverSAClient   (HMAC · 재시도 · Rate Limit 큐) │ │
│  │  • BatchExecutor   (청크 분할 · 진행 추적 · 롤백)  │ │
│  │  • Notifier        (NotificationChannel 추상)      │ │
│  │  • RuleEngine        (P2)                          │ │
│  │  • EstimateService   (P2)                          │ │
│  │  • BiddingOptimizer  (P2)                          │ │
│  │  • LlmAdvisor        (P2 · Anthropic)              │ │
│  └────────────────────────────────────────────────┬───┘ │
└───────────────────────────────────────────────────┼─────┘
                                                    │
              ┌──────────────┬──────────────┐       │
              │              │              │       │
       ┌──────▼─────┐ ┌──────▼──────┐ ┌─────▼────────┐
       │  Supabase  │ │   Upstash   │ │  External    │
       │            │ │    Redis    │ │  APIs        │
       │ • Postgres │ │  (KV cache) │ │              │
       │ • Auth     │ └─────────────┘ │ • NAVER SA   │
       │ • Storage  │                 │ • Anthropic  │
       │ • Realtime │                 │ • Resend     │
       └────────────┘                 │ • Sentry     │
                                       └──────────────┘
```

### 3.3 디렉터리 구조

```
/app                       # Next.js App Router
  /(auth)                  # 로그인
  /(dashboard)
    /[advertiserId]        # 광고주별 컨텍스트
      /campaigns
      /adgroups
      /keywords
      /ads
      /extensions
      /alerts
  /(admin)                 # 시스템 설정
  /api                     # Route Handlers (Cron, Webhook)
/components                # shadcn/ui + 프로젝트 컴포넌트
  /ui                      # shadcn 기본
  /tables                  # TanStack Table 래퍼
  /forms
/lib
  /naver-sa                # 네이버 SA API 클라이언트
    client.ts              # HMAC 서명·재시도·Rate Limit 큐잉
    campaigns.ts
    adgroups.ts
    keywords.ts
    ads.ts
    extensions.ts          # 확장소재 (P1: 3종)
    targets.ts             # P2부터
    estimate.ts            # P2
    reports.ts             # StatReport 비동기
    stats.ts               # Stats 동기
  /batch
    executor.ts            # 청크 분할·진행·롤백
  /notifier
    channel.ts             # NotificationChannel 인터페이스
    email.ts               # Resend 구현체 (개발)
    log.ts                 # DB 적재 구현체 (항상 활성)
  /rules                   # P2
  /optimization            # P2
  /llm                     # P2 (Anthropic 래퍼)
  /supabase
    server.ts
    client.ts
  /db
    prisma.ts
/prisma
  schema.prisma
/scripts                   # seed, sync-regions
/e2e                       # Playwright
CLAUDE.md                  # Claude Code 컨텍스트
```

### 3.4 CLAUDE.md 권장 내용
레포 루트의 `CLAUDE.md`는 Claude Code가 매 세션 첫머리에 읽는 컨텍스트.
- 프로젝트 요약 3줄
- 기술 스택 + 컨벤션 (Prisma · Server Actions · shadcn/ui 등)
- 네이버 SA API 인증 방식 (HMAC-SHA256, X-Customer 헤더) 3줄 요약
- 자주 쓰는 명령어 (`pnpm dev`, `prisma migrate` 등)
- 민감 주의사항: 변경은 모두 ChangeBatch 기록, 일괄 작업은 미리보기 단계 필수
- 본 문서(`SPEC_v0.2.md`)와 작업지시서 위치

### 3.5 비동기 일괄 작업 패턴 (Job Table + Chunk Executor)

5천 건 일괄 변경처럼 Vercel Function 시간 한계(60~300초)를 넘을 수 있는 작업은 다음 패턴으로 처리.

**구성요소**

1. **Job Table = ChangeBatch / ChangeItem**
   - 사용자가 "확정" 클릭 → Server Action이 `ChangeBatch(status=pending)` + N건의 `ChangeItem(status=pending)` 생성 후 즉시 응답(Batch ID 반환)
   - UI는 Batch ID로 진행률 polling
2. **Chunk Executor = Route Handler `/api/batch/run`**
   - Vercel Cron(1분 주기) 또는 Server Action이 트리거. Cron Secret 헤더로 인증
   - **동시 실행 방지 (lease)**: Batch 픽업 시 원자적 트랜잭션
     ```sql
     UPDATE ChangeBatch
        SET leaseOwner = :workerId,
            leaseExpiresAt = now() + interval '5 min',
            status = 'running',
            attempt = attempt + 1
      WHERE id = :batchId
        AND status IN ('pending','running')
        AND (leaseExpiresAt IS NULL OR leaseExpiresAt < now())
     ```
     `IS NULL` 조건으로 신규 pending(lease 미설정)도 포함. 다른 워커는 lease 만료 전까지 픽업 안 함
   - **처리 단위**: `SELECT * FROM ChangeItem WHERE batchId=:id AND status='pending' ORDER BY id LIMIT chunkSize` (예: 100). cursor 기반 아닌 **status=pending 정렬**이 기본 — 부분 실패·재시도가 단순해짐
   - 각 chunk마다:
     - 각 ChangeItem은 `idempotencyKey`로 재실행 시 중복 적용 방지
     - NaverSAClient 호출 (토큰 버킷 큐 + 지수 백오프)
     - 성공/실패 → ChangeItem 상태 업데이트, ChangeBatch.processed += 처리 수
   - Function 시간 한계 근접 시 lease 갱신 후 종료 → 다음 Cron이 이어서 처리 (self-invoke 안 함, 배포 중단·중복 실행 리스크 회피)
3. **진행률 / 재시도 / 장애 대응**
   - UI: TanStack Query polling 5초 간격. ChangeBatch.processed/total 표시
   - lease 만료(5분 무응답) → 자동 재픽업. ChangeBatch.attempt += 1, 최대 N회 후 status=failed
   - 부분 실패 ChangeItem만 "재시도" 버튼 → ChangeItem.status=pending 재설정 → 다음 Cron 픽업 시 자동으로 다시 처리
   - 사용자 취소: status=canceled. 진행 중 chunk는 완료 후 종료
4. **Rate Limit 제어**
   - NaverSAClient 내부 토큰 버킷 (광고주별 분리). 초과 시 chunk 처리 대기

**왜 Inngest 즉시 도입 안 하는가**

- Vercel + Supabase 익숙한 스택만으로 위 4가지 충족 가능
- 5천 건 일괄 PUT의 실제 소요 시간 측정 후 한계 명확해지면 Inngest로 마이그레이션
- 마이그레이션 비용 최소화: `BatchExecutor` 인터페이스 추상화. Cron+Route 구현체 ↔ Inngest 구현체 교체

**모니터링**

- ChangeBatch 평균 소요 시간 / 실패율 대시보드 (8.4 관찰성)
- 5분 이상 소요 또는 실패율 5% 이상이면 자동 알림

---

## 4. Phase 로드맵 (2단계)

### Phase 분할 철학
P1만으로도 운영 효율이라는 명확한 1차 가치 제공. P2는 그 위에 데이터 기반 최적화. P1 출시 후 P2 시작.

| Phase | 테마 | 핵심 범위 | 1인 기준 |
|---|---|---|---|
| **P1** | 운영 효율 | 다계정 통합 (광고주별 키) / 광고 구조 CRUD / 다중 선택 일괄 작업 / CSV 업로드 / 변경 프리뷰·롤백 / 기본 대시보드 / 이상 징후 알림 | 6~8주 |
| **P2** | 비딩 최적화 | 시계열 ETL / Estimate API 시뮬레이터 / 목표 순위 선언 / 자동 비딩 룰 / 한계효용 분석 / Guardrail / Kill Switch / LLM 분석 보조 | 4~6주 |

※ 1인·Claude Code 전일 작업 가정. 겸업·학습 고려 시 1.5배 버퍼.

### 4.1 P3+ 미래 검토 (의도적 미정)
- 추가 매체 통합 (카카오 등)
- 자연어 룰 인터페이스
- 자율 에이전트
- 자동 카피 생성

이들은 P1·P2의 데이터 축적·UX 검증 후 다시 평가.

---

## 5. 도메인 모델 개요

### 5.1 광고주 (모델 2 — 평면 구조)
- **Advertiser**: 광고주 N개. **광고주별 API 키·시크릿 직접 보관** (`apiKeyEnc / apiKeyVersion / secretKeyEnc / secretKeyVersion` 4종 컬럼, AES-256-GCM)
- **MasterAccount 비대상**: 모델 1(MCC 마스터 1개 키 + X-Customer로 광고주 전환) 모델은 v0.2.2에서 제거. 마스터 권한 확보 시 향후 재검토
- **광고주 등록**: 사용자 수동 입력 또는 CSV 업로드(F-1.2). `/customer-links?type=MYCLIENTS` 자동 동기화 비대상 (마스터 권한 endpoint)
- **인증**: 호출 시 `customerId`로 Advertiser 직접 조회 → 시크릿 복호화 → HMAC 서명. X-Customer 헤더는 자기 자신 customerId

### 5.2 광고 구조
```
Advertiser
  └─ Campaign (캠페인)
       └─ AdGroup (광고그룹)
            ├─ Keyword (키워드)
            ├─ Ad (소재)
            └─ AdExtension (확장소재)
```
모든 엔티티는 네이버 측 `nccId`를 보존.

### 5.3 성과 데이터
- **(P1) Stats 조회 + Redis 캐시**: 동기 Stats API로 최근 기간(오늘·어제·7일·30일) 조회. 자체 적재 테이블은 두지 않거나 최소화. 캐시 TTL: 오늘 5분 / 과거 1시간
- **(P2) StatHourly**: 시간 단위 매시간 적재 (Stats API `hh24` breakdown). 네이버 7일 보존 한계 → 자체 누적
- **(P2) StatDaily**: 일 단위 적재 (StatReport AD_DETAIL). 매출/전환 조인 시점
- 키워드 단위 + 광고그룹 단위 + 캠페인 단위
- 차원: PC/모바일 분리

### 5.4 변경 이력
- **ChangeBatch**: 일괄 작업 1건 = 1 Batch
- **ChangeItem**: Batch 안의 개별 변경. before/after JSON
- **AuditLog**: 모든 사용자 행동·자동 실행 (1년+ 보관)
- 롤백: ChangeBatch 기준 롤백 후보 생성, 가능 변경(생성·수정·OFF)에 한정, 현재 상태 재검증 후 항목 단위 적용 (상세 6.6 F-6.4)

### 5.5 알림 (P1)
- **AlertRule**: 알림 발동 조건 (예: 예산 80% 소진)
- **AlertEvent**: 발동 이력. NotificationChannel을 통해 발송

### 5.6 비딩 정책 (P2)
- **BiddingPolicy**: 키워드별 목표 순위·최대 입찰가·디바이스 분리
- **RankObservation**: 시간별 순위 관측치 (자체 적재)
- **EstimateCache**: Estimate API 결과 캐시
- **OptimizationRun**: 자동 비딩 실행 기록

---

## 6. P1 기능 명세 — 운영 효율

### 6.1 인증 · 계정 · 권한

| ID | 기능 | 요구사항 |
|---|---|---|
| F-1.1 | 광고주 등록 (단건) | 광고주별 customerId·API_KEY·SECRET_KEY 등록. SECRET AES-256-GCM 암호화 저장. admin 전용. **모델 2 — 광고주별 키 직접 발급** |
| F-1.2 | 광고주 CSV 일괄 등록 | CSV 업로드 → 검증 → 미리보기 → 일괄 등록. **시크릿 컬럼은 CSV에 포함 X** (보안. 별도 화면 또는 등록 직후 시크릿 입력) |
| F-1.3 | 광고주 메타정보 | 표시명·카테고리·담당자·메모·태그 (CRUD) |
| F-1.4 | 광고주 셀렉터 | GNB 상단 셀렉터로 1개 선택. 컨텍스트 전환 |
| F-1.5 | 연결 상태 점검 | `/billing/bizmoney` 호출로 헬스체크 + 비즈머니 잔액 표시 (자기 자신 endpoint, 권한 무관) |
| F-1.6 | 사용자 / 권한 | **Supabase Auth(인증) + 앱 DB(권한) 분리**. UserProfile + UserAdvertiserAccess 테이블로 역할(admin/operator/viewer)·광고주 화이트리스트 운영. Auth metadata 단독 운영 X (감사·검색·관리 UX 약함) |
| F-1.7 | 감사 로그 | 모든 수정·자동 실행 기록. 1년+ 보관 |

### 6.2 캠페인 · 광고그룹 관리

| ID | 기능 | 요구사항 |
|---|---|---|
| F-2.1 | 캠페인 목록·상세 | 목록·상세·ON/OFF·예산 수정 (단건 + 일괄) |
| F-2.2 | 광고그룹 목록·상세 | 입찰가·예산·기본 매체 ON/OFF·일괄 변경 |
| F-2.3 | 다중 선택 일괄 | 캠페인·그룹 다중 선택 → ON/OFF·예산·기본 입찰가 일괄 |

### 6.3 키워드 관리 (P1 핵심)

| ID | 기능 | 요구사항 |
|---|---|---|
| F-3.1 | 키워드 목록 | TanStack Table + Virtual. 5천 행 부드러운 스크롤. 필터·정렬·검색 |
| F-3.2 | 인라인 편집 | 입찰가·확장 입찰가·ON/OFF 셀 편집. **즉시 API 반영 X** — 변경 staging 영역에 누적 → 미리보기·확정 시 일괄 적용(2.3 / 6.6 안전장치 흐름과 동일). 미확정 셀은 시각적으로 구분 표시 |
| F-3.3 | 다중 선택 일괄 | ON/OFF, 입찰가(절대값/비율). 청크 분할 처리. **대량 삭제는 P1 비대상** (OFF로 대체) |
| F-3.4 | CSV 업로드 | PapaParse + Zod. **6.3.x 규격 준수**. 검증 → 미리보기 → 확정 |
| F-3.5 | CSV 다운로드 | 현재 필터 결과 CSV 내보내기 (6.3.x 규격) |
| F-3.6 | 키워드 추가 | 단건·다건. 광고그룹 단위 |
| F-3.7 | 키워드 단건 삭제 | **admin 권한 한정 + 2차 확인**. 다중 선택 삭제 비대상 |
| F-3.8 | 키워드 검색·필터 | 키워드명·매치타입·상태·성과 범위 |

#### 6.3.x CSV 템플릿 규격 (F-3.4 / F-3.5 공통)

| 컬럼 | 필수 | 설명 |
|---|---|---|
| `operation` | ✓ | `CREATE` / `UPDATE` / `OFF` (DELETE는 P1 비대상) |
| `nccKeywordId` | UPDATE/OFF | 네이버 키워드 ID. CREATE 시 빈값 |
| `nccAdgroupId` | CREATE | 대상 광고그룹 ID. UPDATE/OFF 시 무시 |
| `keyword` | CREATE | 키워드 텍스트 |
| `matchType` | CREATE | `EXACT` / `PHRASE` / `BROAD` 등. 매치타입 |
| `bidAmt` | optional | 입찰가(원). 빈값 = 변경 안 함 |
| `useGroupBidAmt` | optional | true/false. 빈값 = 변경 안 함 |
| `userLock` | optional | true(OFF) / false(ON). 빈값 = 변경 안 함 |
| `externalId` | **CREATE 필수** / UPDATE·OFF optional | 사용자 멱등키. CREATE 재시도 중복 등록 방지 |

**처리 규칙**:
- **빈 값**: UPDATE 시 빈 셀 = "변경 안 함". CREATE 시 필수 컬럼 빈값 → 오류 행 처리
- **오류 행**: 검증 실패 행은 미리보기 단계에서 별도 표시. 사용자가 "오류 행 제외하고 진행" 또는 "전체 중단" 선택
- **중복 행**: 동일 `nccKeywordId` + 동일 `operation` 행 N개 → 마지막 행만 적용 (경고 표시)
- **CREATE 멱등성** (이중 방어):
  1. `externalId` 필수 → ChangeItem에 저장. 동일 `externalId` 재실행 시 skip
  2. **Natural key 중복 검사**: `nccAdgroupId` + `keyword` + `matchType` 조합으로 기존 키워드 존재 확인 → 충돌 시 오류 행 표시 후 사용자 선택 ("skip" / "UPDATE로 전환" / "전체 중단")
- **UPDATE/OFF 멱등성**: `nccKeywordId` 자체가 자연 식별자. `externalId`는 선택
- **인코딩**: UTF-8 (BOM 허용)
- **헤더**: 1행 헤더 필수. 컬럼 순서 무관

### 6.4 소재 관리

| ID | 기능 | 요구사항 |
|---|---|---|
| F-4.1 | 소재 목록 | 광고그룹별 텍스트 소재 + 검수 상태 |
| F-4.2 | 다중 선택 일괄 | ON/OFF, 일부 필드 수정 (URL 등). **대량 삭제는 P1 비대상** |
| F-4.3 | 소재 등록·수정 | 단건·다건 |
| F-4.4 | 단건 삭제 | **admin 권한 한정 + 2차 확인** |
| F-4.5 | 검수 상태 모니터 | 검수 중 / 통과 / 반려(사유) |

### 6.5 확장소재 (핵심 3종)

| ID | 기능 | 요구사항 |
|---|---|---|
| F-5.1 | 추가제목 | CRUD |
| F-5.2 | 추가설명 | CRUD |
| F-5.3 | 이미지 | CRUD. Supabase Storage 업로드 → 네이버 등록 |
| F-5.4 | 일괄 적용 | 광고그룹 단위 일괄 등록 |
| (P2+) | 가격링크 / 서브링크 / 위치 / 계산 / 네이버예약 / 톡톡 | 6종 추후 |

### 6.6 변경 프리뷰 · 롤백

| ID | 기능 | 요구사항 |
|---|---|---|
| F-6.1 | 일괄 작업 미리보기 | 선택 → 미리보기(전/후 비교) → 확정 |
| F-6.2 | 진행률 추적 | 청크 단위 처리, 실시간 진행률 표시 |
| F-6.3 | 부분 실패 처리 | 성공/실패 분리, 실패 항목만 재시도 |
| F-6.4 | 롤백 | **ChangeBatch 기준 롤백 후보 생성**. 가능한 변경(생성·수정·OFF)에 한정 (P1 삭제 비대상이라 해당 없음). **롤백 전 현재 상태 재검증 필수** — 그 사이 외부 변경(타 사용자·자동화·네이버측 변경) 감지 시 drift 경고 후 항목 단위로 롤백 여부 선택 |

### 6.7 기본 대시보드

| ID | 기능 | 요구사항 |
|---|---|---|
| F-7.1 | 광고주 KPI 카드 | 오늘·어제·7일·30일 노출·클릭·비용·CTR·CPC. **데이터 소스: Stats API + Redis 캐시** (5.3 참조, 자체 적재 X). 평균 노출 순위는 API 응답 가능 시 **P1 읽기 전용 표시 OK** (최적화·알림은 P2). 전환·매출은 P2 |
| F-7.2 | 일자별 트렌드 차트 | 기간 선택. shadcn charts |
| F-7.3 | 최근 알림 피드 | DB 기반 알림 이력 위젯 |
| F-7.4 | 캠페인·키워드 TOP | 비용·클릭·CTR·CPC 상/하위 N개 (전환·매출 기준은 P2) |

### 6.8 이상 징후 알림

**P1 기본 4종** (운영·차단 위주 — 성과 적재 의존도 낮음):

| ID | 기능 | 요구사항 |
|---|---|---|
| F-8.1 | 예산 소진 | 50/80/100% (시간대 페이스 이상은 P1.5) |
| F-8.2 | 비즈머니 부족 | 잔액 < 일 예산 평균 N일치 (기본 3일) |
| F-8.3 | API 인증 오류 | 실패율 임계 초과·인증 만료 |
| F-8.4 | 검수 반려 | 사유 포함 |

**P1.5 추가** (성과 적재 안정화 후 활성화 — Stats API 캐시 검증 후):

| ID | 기능 | 요구사항 |
|---|---|---|
| F-8.5 | CPC 급등 | 7일 평균 대비 +N% (기본 +50%) |
| F-8.6 | 노출 급감 | 7일 평균 대비 -N% (기본 -50%) |
| F-8.1+ | 예산 페이스 이상 | 시간대 페이스 이상(F-8.1 확장) |

**공통**:

| ID | 기능 | 요구사항 |
|---|---|---|
| F-8.7 | 알림 채널 | NotificationChannel 추상. 정식 채널은 P1 마무리 시 결정 |
| F-8.8 | 이력·음소거 | 발송 이력 적재. 동일 이벤트 1시간 내 중복 발송 방지 |

#### 알림 채널 임시 처리 (제안사항)

P1 개발 중 **정식 채널 결정 전**까지 다음 3가지 옵션 중 선택:

- **A. 이메일만 임시 사용** (Resend, 가장 보편)
- **B. 콘솔 로그 · DB 알림 피드만** (외부 발송 X, 어드민 화면 안에서만 확인)
- **C. 본인 개인 이메일 1개로 다 보내기** (개발 중 디버깅용)

**권장: B + C 병행**. DB 적재(B)는 항상 켜두고, 외부 발송은 본인 이메일(C)로만. 정식 채널 후보(이메일·Slack·Discord·카카오 알림톡·SMS)는 P1 마무리 시점에 결정.

---

## 7. P2 기능 명세 — 비딩 최적화

### 7.1 시계열 데이터 적재

| ID | 기능 | 요구사항 |
|---|---|---|
| F-9.1 | 일별 적재 | 새벽 StatReport(AD_DETAIL)로 전일 데이터 적재 |
| F-9.2 | 시간별 적재 | Stats API `hh24` breakdown 1시간 주기 폴링 (네이버 7일 보존 한계 → 자체 누적) |
| F-9.3 | PC/모바일 분리 | `breakdown=pcMblTp` 별 적재 |
| F-9.4 | 노출 순위 적재 | `recentAvgRnk` 1시간 주기 (null 시 재시도 큐) |

### 7.2 Estimate API 통합

| ID | 기능 | 요구사항 |
|---|---|---|
| F-10.1 | 평균 순위 입찰가 | `POST /estimate/average-position-bid/keyword`. 순위 1~5위 입찰가 조회 |
| F-10.2 | 최소 노출 입찰가 | `POST /estimate/exposure-minimum-bid/keyword` |
| F-10.3 | 입찰가별 성과 시뮬레이터 | `POST /estimate/performance-bulk`. 입찰가 후보 N개 → 예상 노출/클릭/CPC |
| F-10.4 | Estimate 캐시 | 동일 키워드 30분 캐시. EstimateCache 테이블 |

### 7.3 비딩 정책 · 자동 조정

| ID | 기능 | 요구사항 |
|---|---|---|
| F-11.1 | 키워드별 목표 순위 | 키워드 단위(또는 그룹 단위) 수동 선언. 디바이스 분리 |
| F-11.2 | 자동 비딩 룰 | 목표 순위 ±N 이탈 시 입찰가 자동 조정. Estimate 결과 활용 |
| F-11.3 | 한계효용 분석 | 데이터 충분(클릭 ≥ N) 키워드 한정. 1위 vs 3위 ROI 비교 → "유지 권장 순위" 제안 |
| F-11.4 | 시간대·지역 타게팅 | 시간대(7×24) / 지역(시도) / 디바이스. 입찰 가중 조정 |
| F-11.5 | Guardrail | 키워드별 일 변경 한도(±%·건수). 룰별 일 변경 총량 한도 |
| F-11.6 | Kill Switch | 1-클릭 자동화 전체 정지. 재개 시 사용자 기록 |
| F-11.7 | 실행 로그 | OptimizationRun: 트리거·대상·전후·결과 |

### 7.4 알림 (비딩 관련)

| ID | 기능 | 요구사항 |
|---|---|---|
| F-12.1 | 목표 순위 이탈 | recentAvgRnk가 목표 ±N에서 벗어남 |
| F-12.2 | 모바일 5위 외 | 모바일 첫 페이지 이탈(평균 6위 이상) |
| F-12.3 | 자동 조정 결과 알림 | 일 단위 요약 |

### 7.5 LLM 분석 보조

| ID | 기능 | 요구사항 |
|---|---|---|
| F-13.1 | 변경 이유 자동 설명 | "이 키워드 입찰가 -10%" 옆에 "이유: 7일 클릭 효율 하락, 한계효용 음수" 형태(기본). **매출 조인된 경우** "ROAS 60%" 같은 표현 추가 |
| F-13.2 | 일일 운영 요약 | 어제 자동 조정·알림 요약 (1단락) |
| F-13.3 | 비용 통제 | LLM 호출 비용 대시보드. 동일 입력 캐시. sonnet/haiku 분기 |

> **LLM 사용 원칙**: 분석·설명 생성에만 사용. 실행은 절대 X (자율 에이전트는 비대상).

---

## 8. 비기능 요구사항

### 8.1 보안
- **SECRET 암호화 방식 (모델 2 — 광고주별 키)**:
  - 앱 레벨 AES-256-GCM. 키는 `ENCRYPTION_KEY` env (Vercel env vars)
  - DB 컬럼: `Advertiser.apiKeyEnc / apiKeyVersion + secretKeyEnc / secretKeyVersion` (광고주마다 보유)
  - 향후 rotation 시 신키로 재암호화하며 버전 증가. **로테이션 단위는 광고주별** (모델 2 특성)
  - 평문 로그 금지: 로깅 직전 마스킹 유틸 통과 의무. CI에 평문 키 패턴 검출 테스트(snapshot) 추가
  - 반기 로테이션 권장. envelope encryption(KEK/DEK 분리)은 광고주 N>50 또는 컴플라이언스 요건 발생 시 검토
- 권한: admin / operator / viewer + 광고주 화이트리스트 — **앱 DB(UserProfile / UserAdvertiserAccess) 기반**. Supabase Auth는 인증만 담당 (F-1.6 / 9장 데이터 모델과 일치)
- 민감 액션 (예산 일괄 수정, 자동 비딩 활성화, Kill Switch 해제) — 2차 확인 다이얼로그
- 감사 로그 1년+ 보관
- LLM 프롬프트에 시크릿·고객 개인정보 주입 금지

### 8.2 성능 · Rate Limit
- 네이버 SA Rate Limit은 공개 수치 없음 → **운영팀 사전 협의 필수 (P0 차단 사항)**
- NaverSAClient 내부에 토큰 버킷 큐잉 + 지수 백오프
- 광고주별 동시성 제어 (5 동시 호출 정도)
- Redis 캐시: 광고 구조 5~30분, 성과 1시간, Estimate 30분
- 대시보드 첫 페인트 < 1.5s, 키워드 테이블 5천 행 < 3s

### 8.3 데이터 동기화
- **실시간**: 사용자 액션 (CRUD)
- **준실시간 (15~60분)**: 당일 누적 성과·비즈머니·알림 트리거
- **일 배치 (새벽)**: StatReport → Postgres → (P2) 매출 조인
- **정합성**: 네이버 UI 대비 ±0.5% 이내

### 8.4 관찰성
- Sentry: 에러·성능 추적
- Vercel Analytics: 사용자 패턴
- (P2) 자동화 결과 대시보드: 룰별 성공·실패·영향 매출

### 8.5 확장성
- 매체 추상화: Account-Campaign-AdGroup-Creative-Stat 인터페이스
- 알림 채널 추상화: NotificationChannel
- 큐 추상화: Vercel Cron → Inngest 갈아끼우기 가능

---

## 9. 데이터 모델 (Prisma 개요)

상세 `schema.prisma`는 작업지시서 F-DB.1에서 생성.

| 엔티티 | 주요 필드 | 비고 |
|---|---|---|
| Advertiser | id, customerId, name, bizNo, category, manager, tags, status, **apiKeyEnc?, apiKeyVersion, secretKeyEnc?, secretKeyVersion** | **모델 2 — 광고주별 키 직접 보관** (AES-256-GCM). 키는 nullable (F-1.2 CSV 메타 등록 후 시크릿 별도 입력 흐름 지원). 키 미입력 시 SA API 호출 차단. MasterAccount 모델은 v0.2.2에서 제거 |
| Campaign | id, advertiserId, nccCampaignId, name, type, dailyBudget, status, raw | |
| AdGroup | id, campaignId, nccAdgroupId, name, bidAmt, dailyBudget, status, raw | |
| Keyword | id, adgroupId, nccKeywordId, keyword, bidAmt, useGroupBidAmt, status, raw | |
| Ad | id, adgroupId, nccAdId, type, fields, inspectStatus, status, raw | |
| AdExtension | id, ownerId, nccExtId, type, payload, period, inspectStatus | P1: 3종 |
| StatDaily (P2) | date, level, refId, device, impressions, clicks, cost, avgRnk + (조건부) conversions, revenue | StatReport 기반 일 적재. **P1은 Stats API + Redis 캐시로 대체** (5.3 참조). 매출/전환 컬럼은 매출 조인 시점에 활성 |
| StatHourly (P2) | hour, level, refId, device, impressions, clicks, cost, recentAvgRnk | 7일 한계 → 자체 누적 |
| ChangeBatch | id, userId, action, status(pending/running/done/failed/canceled), total, processed, summary, **leaseOwner, leaseExpiresAt, attempt**, cursor(선택, 진단용), createdAt, finishedAt | 일괄 작업 단위 + 동시 실행 제어. 처리 픽업은 ChangeItem.status=pending 기준 |
| ChangeItem | batchId, targetType, targetId, before, after, status, error, **idempotencyKey, attempt** | 개별 변경. idempotencyKey = externalId 또는 자체 생성 |
| AuditLog | userId, action, targetType, targetId, before, after, ts | 1년+ |
| AlertRule | id, type, params, channelHint, enabled | 발동 조건 |
| AlertEvent | id, ruleId, payload, status, sentAt | 발송 이력 |
| BiddingPolicy (P2) | keywordId, targetRank, deviceMap, maxBid, minBid, enabled | |
| OptimizationRun (P2) | id, policyId, triggeredAt, before, after, result | |
| EstimateCache (P2) | keyword, device, position, bid, ttl | 30분 캐시 |
| LlmCallLog (P2) | id, purpose, model, promptHash, tokensIn, tokensOut, costKrw | 비용 |
| UserProfile | id(=Auth user.id), displayName, role(admin/operator/viewer), status | 앱 DB |
| UserAdvertiserAccess | userId, advertiserId, grantedBy, grantedAt | 광고주 화이트리스트 |

---

## 10. 외부 연동 요약

| 대상 | 용도 | 비고 |
|---|---|---|
| 네이버 SA API | 광고 CRUD · 성과 · 확장소재 · Estimate · StatReport · `/billing/bizmoney`(헬스체크) | HMAC-SHA256, **광고주별 키로 서명** (모델 2). X-Customer는 자기 자신 customerId. **Rate Limit 사전 협의 필수**. `/customer-links?type=MYCLIENTS`는 마스터 권한 endpoint라 비대상 (모듈은 보존, 호출 0건) |
| Supabase | DB · Auth · Storage | 데이터 접근은 Prisma 중심 |
| Anthropic Claude (P2) | 분석·설명 생성 | sonnet / haiku 분기, 캐시 |
| Resend (개발 임시) | 이메일 알림 | 정식 채널은 P1 마무리 시 결정 |
| Sentry | 에러 모니터링 | |
| Upstash Redis | 캐시 | 단순 KV |

---

## 11. 화면 구성

### 11.1 네비게이션
- **GNB**: 광고주 셀렉터 · 기간 · 알림 · 사용자 메뉴
- **LNB**: 대시보드 / 캠페인 / 광고그룹 / 키워드 / 소재 / 확장소재 / 알림 / (P2: 비딩 최적화) / **광고주(admin)** / 설정

### 11.2 주요 페이지
- **대시보드** — 광고주 KPI 카드 + 트렌드 차트 + 최근 알림 피드 + TOP 캠페인/키워드
- **캠페인 목록** — 다중 선택, ON/OFF·예산 일괄
- **광고그룹 목록** — 다중 선택, 입찰가·예산 일괄
- **키워드 (핵심)** — TanStack Table 5천 행, 인라인 편집, 다중 선택, CSV 업·다운, 일괄 액션 모달
- **소재 목록** — 검수 상태, 다중 선택 ON/OFF
- **확장소재** — 3종 탭(추가제목 / 추가설명 / 이미지) + 등록·수정·이미지 업로드
- **알림** — 이력 + 룰 설정 + 채널 설정 (채널 미정 표시)
- **광고주 (admin)** — `/admin/advertisers` — 등록·수정·삭제·테스트 연결(비즈머니). 광고주별 키 보관
- **설정** — 사용자 / 감사 로그 / (P2) LLM 비용
- **(P2) 비딩 최적화** — 정책 목록 + 한계효용 분석 뷰 + 자동 실행 이력 + Kill Switch

### 11.3 공통 패턴
- 일괄 작업 모달: 선택 카운트 → 액션 선택 → 미리보기(전/후 표) → 확정 → 진행률 → 결과(성공·실패 분리)
- 모든 변경에는 ChangeBatch ID 표시 → 클릭 시 롤백 페이지

---

## 12. 결정 사항

### 12.1 확정 (이번 기획에서)
- [x] 1차/2차 우선순위: 운영 효율 → 비딩 최적화
- [x] Phase 2단계 (P1 6~8주, P2 4~6주)
- [x] 광고주별 컨텍스트 (전체 횡단 뷰 없음)
- [x] 키워드 단위 5,000개 미만
- [x] CSV는 네이버 API 필드 표준
- [x] DB · 인증 · 스토리지: Supabase
- [x] 인증: Supabase Auth (운영자 2~3명)
- [x] 호스팅: Vercel
- [x] 큐: ChangeBatch Job Table + Chunk Executor (Vercel Cron + Route Handler) — 3.5절. 한계 시 Inngest 갈아끼우기
- [x] LLM: P2 분석 보조 한정
- [x] 알림 채널: 추상 인터페이스, 정식 채널은 P1 마무리 시 결정
- [x] 6종 목표 프리셋 · 자연어 룰 빌더 · LLM 에이전트 비대상
- [x] 확장소재 P1 3종(추가제목 / 추가설명 / 이미지). 가격링크 등 6종은 P2+
- [x] P1 대량 삭제 비대상(OFF로 대체). 단건 삭제는 admin + 2차 확인
- [x] 롤백은 가능 변경(생성·수정·OFF) + 현재 상태 재검증
- [x] 권한 모델: Supabase Auth(인증) + 앱 DB(UserProfile / UserAdvertiserAccess) 병행
- [x] 암호화: ENCRYPTION_KEY env + 키 버전 + 평문 로그 금지 테스트
- [x] P1 KPI에서 전환·매출 제거 (P2 이동)
- [x] CSV 템플릿 규격 명시 (operation, idempotency 등 — 6.3.x)
- [x] **다계정 운영 모델: 모델 2(광고주별 키 모음)** 채택. MasterAccount 모델 제거. testConnection은 `/billing/bizmoney`로

### 12.2 미확정 (Phase 1 착수 전)
- [ ] 관리 대상 광고주 수 (현재 / 1년 후) — 10개 미만 가정으로 진행
- [ ] MCC 마스터 권한 신청 진행 여부 (모델 1 fallback 가능 여부)
- [ ] **네이버 SA Rate Limit 협의** (P0 차단 사항)
- [ ] 알림 채널 정식 결정 (이메일 / Slack / Discord / 카카오 알림톡 / SMS)
- [ ] 학습기간 / Guardrail 기본값 (P2 시작 전)
- [ ] LLM 모델 기본값 + 월 비용 상한 (P2 시작 전)
- [ ] 내부 매출 DB 접근 (P2 매출 조인 — 필요 시)
- [ ] P1 확장소재 6종 추가 시점 (가격링크 / 서브링크 / 위치 / 계산 / 예약 / 톡톡)
- [ ] 감사 로그 보관 기간 (1년 / 3년)

### 12.3 P0 차단 사항 (반드시 사전 해결)
- ~~MCC 마스터 계정 API 키 발급~~ — **모델 2 전환으로 비대상**. 광고주별 키만 발급받음
- 네이버 SA 운영팀과 Rate Limit 협의
- ~~Supabase 프로젝트 생성 + Vercel 연결~~ — 완료
- 광고주별 API 키·시크릿 발급 (등록할 광고주마다)

---

## 13. 리스크 및 대응

| 리스크 | 영향 | 대응 |
|---|---|---|
| **네이버 SA Rate Limit 불투명** | 1만 키워드 일괄 작업 실패·지연 | 사전 협의 필수. NaverSAClient 토큰 버킷 큐 (광고주별 분리). 일괄 PUT 청크 분할 |
| **광고주별 키 회전 부담 (모델 2)** | 키 만료 시 광고주마다 갱신 필요 | 광고주 메타에 키 만료 추적 / 만료 임박 알림 / 키 갱신 화면 (P2 검토). 모델 1로 전환 시 부담 X |
| **`recentAvgRnk` null·지연** | P2 실시간 순위 알림 신뢰성 ↓ | 재시도 큐. SLA "15~30분 지연" 명시 |
| **시간별 데이터 7일 보존 한계** | 장기 학습 데이터 누락 | P2 ETL 자체 적재. 누락 일자 재집계 배치 |
| **1인 개발 병목·번아웃** | 일정·품질 저하 | 세션 단위 분해, Phase별 독립 배포, 필요 시 외주 단기 |
| **MCC 권한 해지** | 광고주 데이터 차단 | 동기화 + 상태 알림 |
| **자동화 룰 오작동** | 광고비 과소진 | (P2) 미리보기 + Guardrail + Kill Switch + 롤백 4중 |
| **LLM 환각** | 잘못된 분석 메시지 | (P2) LLM은 "설명"만, 실행은 절대 X |
| **시크릿 유출 (MCC)** | 전 광고주 탈취 | Supabase 암호화 컬럼 + 로테이션 + 감사 로그 |
| **네이버 스펙 변경 (지역·확장소재)** | 적용 실패 | 메타 동기화 배치, 메타 기반 구조 |
| **Vercel 함수 시간 한계** | 일괄 작업 타임아웃 | 청크 분할 + 진행 추적. 한계 시 Inngest 도입 |
| **수치 불일치** | 신뢰도 하락 | 일 배치 재집계, 주기 샘플 대조 |

---

— 상위 스펙 문서 v0.2 끝 · 세션별 작업지시서는 별도 파일로 추후 제공 —
