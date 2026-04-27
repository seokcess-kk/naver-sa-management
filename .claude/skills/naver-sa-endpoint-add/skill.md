---
name: naver-sa-endpoint-add
description: 네이버 검색광고 API 신규 엔드포인트 모듈을 lib/naver-sa/에 추가할 때 사용. HMAC-SHA256 서명, X-Customer 헤더 광고주 전환, Rate Limit 토큰 버킷, Zod 응답 검증, 캐시 전략, 에러 코드 매핑을 표준 패턴으로 적용. 새 API 호출 / 모듈 추가 / 응답 shape 검증 추가 시 반드시 이 스킬 사용. HMAC 서명 직접 작성 또는 fetch 직접 호출 금지.
---

# Naver SA Endpoint Add

## 언제 사용

- 네이버 SA 신규 API 모듈 추가 (campaigns / keywords / ads / extensions / estimate / stats / reports / customer-links)
- 기존 모듈에 엔드포인트 함수 추가
- 응답 Zod 스키마 추가 / 변경

## 표준 패턴

### 1. 위치

```
lib/naver-sa/
├── client.ts               # HMAC + Rate Limit 큐 (이 파일은 한 번만 작성)
├── errors.ts               # 도메인 에러 클래스
├── types.ts                # 공유 타입
├── campaigns.ts
├── adgroups.ts
├── keywords.ts             # ← 새 모듈은 이 위치
├── ads.ts
├── extensions.ts
├── estimate.ts
├── stats.ts
├── reports.ts
└── customer-links.ts
```

### 2. client.ts 의존성

새 모듈은 항상 `client.ts`의 `naverSaClient` 사용:

```ts
// lib/naver-sa/keywords.ts
import { naverSaClient } from "./client"
import { z } from "zod"
import { KeywordSchema } from "./types"
```

`client.ts`가 자동 처리:
- HMAC-SHA256 서명 (`X-Timestamp`, `X-API-KEY`, `X-Signature`)
- X-Customer 헤더 (`customerId` 인자)
- Rate Limit 토큰 버킷 (광고주별 동시성 분리)
- 지수 백오프 재시도 (429 / 1016)

**다른 모듈에서 fetch / axios 직접 호출 금지**. 이유: HMAC 서명은 timestamp 의존이라 한 곳에서만 관리, Rate Limit 큐 우회 시 5천 키워드 일괄 작업이 차단됨.

### 3. Zod 응답 스키마

```ts
export const KeywordSchema = z.object({
  nccKeywordId: z.string(),
  nccAdgroupId: z.string(),
  keyword: z.string(),
  bidAmt: z.number().nullable(),
  useGroupBidAmt: z.boolean(),
  userLock: z.boolean(),
  inspectStatus: z.string().optional(),
  // ...
}).passthrough()  // 응답 변경 대비 — 정의 안 된 필드는 통과시키되 raw에 보존
export type Keyword = z.infer<typeof KeywordSchema>
```

`passthrough()` 또는 별도 `raw` 필드로 정의 외 응답을 보존. 네이버 스펙 변경 시 차단 X 경고만.

### 4. 함수 시그니처

```ts
export async function listKeywords(
  customerId: string,
  adgroupId: string,
): Promise<Keyword[]> {
  const res = await naverSaClient.request({
    customerId,
    method: "GET",
    path: `/ncc/keywords?nccAdgroupId=${adgroupId}`,
    cache: { kind: "structure", ttl: 600 },  // 10분
  })
  return z.array(KeywordSchema).parse(res)
}
```

검증 실패 시 raw 보존 + 경고 로그 + `NaverSaValidationError`.

### 5. 일괄 변경 (PUT)

```ts
export async function updateKeywordsBulk(
  customerId: string,
  items: Array<{ nccKeywordId: string; bidAmt?: number; userLock?: boolean }>,
): Promise<Keyword[]> {
  // 운영 합의 전 청크 사이즈 100 기본
  const res = await naverSaClient.request({
    customerId,
    method: "PUT",
    path: "/ncc/keywords?fields=bidAmt,userLock",
    body: items,
  })
  return z.array(KeywordSchema).parse(res)
}
```

청크 분할은 호출부(backend-engineer의 batch-executor-job 스킬)가 담당. 본 모듈은 단일 호출 API 그대로 노출.

### 6. 캐시 전략

| 모듈 | TTL | kind |
|---|---|---|
| campaigns / adgroups / keywords / ads / extensions GET | 5~30분 | `structure` |
| stats (오늘) | 5분 | `stats:today` |
| stats (과거) | 1시간 | `stats:past` |
| estimate | 30분 | `estimate` |
| reports (StatReport) | 캐시 X | — |
| customer-links | 1시간 | `meta` |

`naverSaClient.request`의 `cache` 옵션 사용. 키 패턴: `nsa:{kind}:{customerId}:{params-hash}`.

### 7. 에러 코드 매핑

```ts
// lib/naver-sa/errors.ts
export class NaverSaRateLimitError extends Error {}      // 429, 1016
export class NaverSaValidationError extends Error {}     // 1014 등 응답 형식 오류
export class NaverSaAuthError extends Error {}           // 401
export class NaverSaUnknownError extends Error {}        // 그 외
```

`client.ts`가 응답 코드 → 도메인 에러 변환. 모듈 함수는 throw만 정의하고 캐치는 호출부.

### 8. X-Customer 누락 검증

`customerId` 인자 없이 호출 가능한 시그니처 만들지 말 것. MCC 마스터 키 1개로 모든 광고주 호출이라 `customerId` 누락 시 마스터 계정 자체가 호출됨.

### 9. 검증

```bash
pnpm tsc --noEmit
pnpm vitest run lib/naver-sa  # 단위 테스트
```

새 모듈 함수에 단위 테스트:
- 정상 응답 → Zod 검증 통과
- 응답 형식 오류 → `NaverSaValidationError`
- 429 → 재시도 후 결국 `NaverSaRateLimitError`

## 출력

- `lib/naver-sa/{module}.ts`
- `lib/naver-sa/types.ts`에 공유 Zod 스키마 추가 (필요 시)
- 사용 예시 1~2줄 (호출부 import 가이드)

## 안티패턴

- ❌ HMAC 서명 직접 작성
- ❌ fetch / axios 직접 호출 (`client.ts` 우회)
- ❌ Rate Limit 큐 우회 (자체 setTimeout 등)
- ❌ raw 보존 누락 (passthrough 또는 raw 필드)
- ❌ Zod 검증 생략 (`as Keyword[]` 같은 강제 캐스팅)
- ❌ X-Customer 헤더 누락 (customerId 인자 없는 시그니처)
- ❌ 캐시 무한 (TTL 없음 / 캐시 키 충돌)
- ❌ 청크 분할을 본 모듈에 포함 (호출부 책임)

## 검증 트리거 키워드

네이버 SA, naver-sa, HMAC, X-Customer, 신규 엔드포인트, API 모듈, lib/naver-sa, Estimate, StatReport, Stats API, Rate Limit
