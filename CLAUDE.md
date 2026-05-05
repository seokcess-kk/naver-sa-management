# CLAUDE.md

> Claude Code 세션 첫머리에 자동 로드되는 컨텍스트.
> 전체 스펙은 `SPEC_v0.2.md` 참조. 본 파일은 매 세션 필요한 사실·규칙만 압축.

---

## 프로젝트 요약

- **무엇**: 네이버 검색광고(SA) 다계정 운영 어드민
- **1차 가치 (P1)**: 운영 효율 — MCC 통합 / 다중 선택 일괄 / CSV / 변경 프리뷰·롤백 / 기본 알림
- **2차 가치 (P2)**: 비딩 최적화 — Estimate API 시뮬레이터 / 목표 노출 순위 유지 / 한계효용 분석 / Guardrail·Kill Switch / LLM 분석 보조
- **체질**: 1인 개발 + Claude Code 바이브코딩. 모놀리식 단일 레포. 익숙한 스택 우선(Supabase + Vercel).

---

## 기술 스택 (확정 — 변경 시 SPEC 3.1 동기화 필수)

| 영역 | 선택 |
|---|---|
| 패키지 매니저 | **pnpm** |
| 언어 | TypeScript |
| 프레임워크 | Next.js 16 + React 19 (App Router) + Server Actions + Turbopack |
| UI | Tailwind 4 + shadcn/ui + Radix(@base-ui/react) |
| 테이블 | TanStack Table v8 + TanStack Virtual (5천 행 인라인 편집) |
| 차트 | shadcn charts (Recharts 기반) |
| 폼 | react-hook-form + Zod 4 |
| 서버 데이터 | TanStack Query 5 + Server Actions |
| ORM | Prisma 7 (`prisma.config.ts` + `import "dotenv/config"`) |
| DB·인증·스토리지 | Supabase (Postgres + Auth + Storage) |
| 캐시 | Upstash Redis (단순 KV) |
| 큐 | **ChangeBatch Job Table + Vercel Cron + Route Handler Chunk Executor** (SPEC 3.5) |
| CSV | PapaParse + Zod |
| LLM (P2) | Anthropic Claude — 분석·설명만, 실행 X |
| 알림 | `NotificationChannel` 추상 (정식 채널 미정) |
| 모니터링 | Sentry + Vercel Analytics |
| 배포 | Vercel |
| 테스트 | Playwright E2E + Vitest 핵심 로직 |

---

## 디렉터리 구조 (빠른 참조)

```
/app                  Next.js App Router
  /(auth)             로그인
  /(dashboard)
    /[advertiserId]   광고주별 컨텍스트
  /(admin)            시스템 설정
  /api                Route Handlers (Cron, Webhook)
/components
  /ui                 shadcn 기본
  /tables             TanStack Table 래퍼
  /forms
/lib
  /naver-sa           네이버 SA API 클라이언트 (HMAC·재시도·Rate Limit 큐)
  /batch              BatchExecutor (청크 분할·진행·롤백)
  /notifier           NotificationChannel 추상 + email(개발)/log(항상) 구현
  /supabase           server.ts / client.ts
  /db                 prisma.ts
  /rules /optimization /llm   (P2)
/prisma               schema.prisma
/scripts              seed, sync-regions
/e2e                  Playwright
SPEC_v0.2.md          상위 스펙 (반드시 참조)
CLAUDE.md             본 파일
```

---

## 자주 쓰는 명령어

```bash
pnpm dev                                # 개발 서버
pnpm build && pnpm start
pnpm lint && pnpm typecheck

pnpm prisma migrate dev --name <msg>    # 마이그레이션 생성·적용
pnpm prisma migrate deploy              # 운영 적용
pnpm prisma studio                      # GUI

pnpm test                               # Vitest
pnpm e2e                                # Playwright
```

---

## 네이버 SA API 인증 (핵심 3줄)

- 모든 요청에 HMAC-SHA256 서명 헤더: `X-Timestamp`, `X-API-KEY`, `X-Signature`
- MCC에서 하위 광고주 호출 시 `X-Customer: {customerId}` 헤더로 전환
- Rate Limit 공개 수치 없음 → `lib/naver-sa/client.ts`에 **토큰 버킷 큐잉 + 지수 백오프 필수** (광고주별 동시성 분리)

---

## 핵심 안전장치 (절대 깨지 말 것)

1. **모든 변경은 ChangeBatch + ChangeItem에 기록**
   - 단건이라도 즉시 API 호출 X. **staging → 미리보기 → 확정** 흐름 일관 유지
   - 인라인 편집(F-3.2)도 셀 편집 즉시 반영 X. 변경 누적 후 일괄 적용

2. **5천 건 일괄은 Job Table + Chunk Executor 패턴**
   - Server Action 안에서 동기 처리 X (Vercel 함수 시간 한계)
   - **lease**(`leaseExpiresAt`)로 동시 실행 방지. 픽업 SQL은 SPEC 3.5 참조
   - chunk 픽업: `ChangeItem.status='pending' ORDER BY id LIMIT N` (cursor 기반 아님)
   - 다음 chunk는 self-invoke 아닌 **다음 Cron이 이어서 처리**

3. **롤백은 가능한 변경만 + 현재 상태 재검증**
   - "ChangeBatch 1-클릭 무조건 되돌리기"가 아님
   - 가능 변경: 생성 / 수정 / OFF (P1은 삭제 비대상이라 해당 없음)
   - drift 감지 시 항목 단위 사용자 선택

4. **시크릿 평문 로그 금지**
   - 앱 레벨 AES-256-GCM, `ENCRYPTION_KEY` env, `secretKeyVersion` 컬럼
   - 마스킹 유틸 통과 의무. CI에 평문 패턴 검출 테스트(snapshot)

5. **권한 모델은 앱 DB 기반**
   - 인증: Supabase Auth만 담당
   - 권한·광고주 화이트리스트: `UserProfile` + `UserAdvertiserAccess` 테이블
   - Auth metadata에 권한 두지 말 것

6. **대량 삭제는 P1 비대상**
   - 키워드·소재·확장소재 다중 선택 액션에 "삭제" 추가 금지 (OFF로 대체)
   - 단건 삭제도 **admin + 2차 확인** 필수

7. **LLM은 분석·설명만 (P2 한정)**
   - Tool Use·자율 실행 X. 모든 변경은 사용자 확정 거침
   - 프롬프트에 시크릿·고객 개인정보 주입 금지
   - 모델 분기(sonnet/haiku) + 동일 입력 캐시

---

## 데이터 소스 정책

- **P1 성과 데이터**: Stats API 동기 호출 + Redis 캐시 (TTL: 오늘 5분 / 과거 1시간). **자체 적재 테이블 X**
- **P2 성과 데이터**: `StatHourly`(시간별 ETL) + `StatDaily`(일별 StatReport AD_DETAIL)
- **시간별 데이터 7일 보존 한계** → P2 ETL이 매시간 자체 누적
- 평균 노출 순위(`recentAvgRnk`)는 P1 읽기 전용 표시 OK, 최적화·알림은 P2

---

## CSV 처리 규격 (F-3.4 / F-3.5)

- **컬럼**: `operation`(CREATE/UPDATE/OFF), `nccKeywordId`, `nccAdgroupId`, `keyword`, `matchType`(EXACT/PHRASE/BROAD), `bidAmt`, `useGroupBidAmt`, `userLock`, `externalId`
- **CREATE 멱등성 (이중 방어)**: `externalId` 필수 + `(nccAdgroupId + keyword + matchType)` natural key 중복 검사
- **DELETE는 비대상** (OFF로 대체)
- **빈 셀**: UPDATE 시 "변경 안 함", CREATE 필수 컬럼 빈값은 오류 행
- **인코딩**: UTF-8 (BOM 허용)

---

## 환경 변수 (예상 — 실제는 .env.local에 정의)

```
# Supabase
DATABASE_URL                    # Postgres 풀링 URL
DIRECT_URL                      # Prisma 마이그레이션용
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY       # 서버 전용

# 시크릿 암호화 (앱 레벨)
ENCRYPTION_KEY                  # AES-256-GCM 키. 마스터 API 키는 DB에 암호화 저장

# 네이버 SA
NAVER_SA_BASE_URL               # https://api.searchad.naver.com 등

# 캐시
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN

# 알림 (둘 다 optional — 있으면 자동 활성)
RESEND_API_KEY                  # 이메일 (현재 stub — Resend 호출 코드 활성화 필요)
ALERT_EMAIL_TO
TELEGRAM_BOT_TOKEN              # 텔레그램 (Bot API 직접 호출, 외부 SDK 없음)
TELEGRAM_CHAT_ID

# 모니터링
SENTRY_DSN

# 큐
CRON_SECRET                     # Vercel Cron 인증 헤더

# P2 시점
ANTHROPIC_API_KEY
```

---

## Claude Code 작업 패턴

- **기능 ID 단위로 `feature-orchestrator` 스킬 호출**: SPEC v0.2.1의 F-X.Y 입력 → 5명 에이전트 팀 자동 구성 (db / naver-sa / backend / ui / qa)
- **에이전트·스킬 위치**: `.claude/agents/` (5명) + `.claude/skills/` (4 스킬 + 1 오케스트레이터)
- **세션 시작 시**: 본 CLAUDE.md + SPEC_v0.2.md의 해당 기능 ID 단락 자동 로드
- **새 의존성 추가 전**: 위 기술 스택 표와 일치 확인. 일치 안 하면 **중단하고 사용자에게 보고**
- **익숙한 스택 우선** 원칙 (Supabase + Vercel). 새 도구 도입은 한계 부딪힐 때만
- **QA 점진 실행**: 각 모듈 완성 직후 `qa-engineer` 호출. 전체 후 일괄 검증 금지

---

## 비대상 (이유 묻지 말고 안 만드는 것)

- 6종 목표 프리셋 (이커머스/리드/브랜드/...)
- 자연어 룰 빌더
- LLM 자율 에이전트 (Tool Use 자동 실행)
- 다중 매체 통합 (카카오·구글·메타) — 향후 검토
- 광고주 횡단 뷰 (전체 합산 화면)
- P1 대량 삭제 / P1 9종 확장소재(P1은 3종만)
- Python 분리 서비스 / OpenAI Embeddings / BullMQ / Solapi SMS / Axiom

---

## 참고 문서

- **`SPEC_v0.2.md`** — 상위 스펙. 본 파일이 추상화·요약한 사실의 출처
- **`SPEC_ver0.1.docx`** — 이전 버전(v0.1). 참고용으로만 보관, 신규 결정은 v0.2.1 기준
- **`.claude/agents/`** — 5명 에이전트 정의 (db-architect / naver-sa-specialist / backend-engineer / ui-engineer / qa-engineer)
- **`.claude/skills/`** — 4 스킬 + 1 오케스트레이터 (prisma-model-add / naver-sa-endpoint-add / batch-executor-job / tanstack-table / feature-orchestrator)
- **`_workspace/{featureId}/`** — 오케스트레이터 중간 산출물 (`.gitignore` 포함, 감사 추적용 로컬 보관)
