---
name: prisma-model-add
description: Prisma 모델 추가 또는 기존 모델 변경 시 사용. SPEC v0.2.1 9장 단일 진실 원천을 따라 schema.prisma 변경, 마이그레이션 생성, 시크릿 컬럼 패턴(Enc + Version), ChangeBatch / AuditLog 일관성 유지, RLS 정책 추가. 새 엔티티 / 컬럼 / 인덱스 / 관계 추가 또는 RLS 추가 시 반드시 이 스킬 사용. 직접 schema 수정 또는 직접 SQL 변경 금지.
---

# Prisma Model Add

## 언제 사용

- SPEC 9장에 정의된 엔티티 신규 구현
- 기존 모델에 컬럼 / 인덱스 / 관계 추가
- RLS 정책 추가
- 시크릿 저장 컬럼 추가
- 시드 데이터 추가

## 작업 흐름

### 1. SPEC 9장 확인

본 스킬을 트리거한 변경이 SPEC_v0.2.md 9장에 정의되어 있는지 먼저 확인. 없으면 사용자에게 SPEC 수정 또는 작업 보류 결정 요청. 이유: SPEC 9장이 데이터 모델의 단일 진실 원천이며, 분기되면 운영·QA·롤백 모두 어그러진다.

### 2. schema.prisma 변경

`prisma/schema.prisma`에 모델 추가/변경. 컨벤션:

| 요소 | 규칙 |
|---|---|
| 모델명 | PascalCase, 단수형 (`Keyword`, `ChangeBatch`) |
| 필드명 | camelCase |
| 네이버 ID | `nccCampaignId`, `nccKeywordId` 식 명시 |
| raw 컬럼 | 네이버 엔티티 모델은 항상 `raw Json?` (스펙 변경 대비) |
| 관계 | 양방향 (`@relation` 양쪽 다) |
| Soft delete | `status` 컬럼으로 (P1 hard delete 비대상) |
| 인덱스 | 자주 쓰는 조회 컬럼 — 추측 X, 실제 호출 패턴 발생 시 추가 |

### 3. 시크릿 컬럼 패턴

시크릿 저장 시 반드시 두 컬럼:

```prisma
// 모델 2 (광고주별 키 모음) — 평면 구조
model Advertiser {
  id                String  @id @default(cuid())
  customerId        String  @unique
  apiKeyEnc         Bytes   // 암호문
  apiKeyVersion     Int     @default(1)
  secretKeyEnc      Bytes
  secretKeyVersion  Int     @default(1)
  // ...
}
```

**평문 컬럼 절대 금지**. 암복호화는 `lib/crypto/secret.ts`(`ENCRYPTION_KEY` env 사용) 위탁. `apiKey` / `secretKey` 같은 평문 이름 컬럼 발견 시 즉시 차단.

이유: SPEC 8.1 기준 — 키 로테이션 시 신키로 재암호화하며 버전 증가. 키 버전 컬럼 없으면 로테이션 불가.

### 4. ChangeBatch / AuditLog 일관성

새 모델이 ChangeBatch로 추적될 변경 대상이면:
- ChangeItem.targetType enum/상수에 모델명 추가
- 변경 추적 필드는 ChangeItem.before / after JSON에 담길 수 있는 형태 (직렬화 가능)
- AuditLog.targetType에도 추가

### 5. 마이그레이션 생성

```bash
pnpm prisma migrate dev --name <message>
```

메시지 컨벤션:
- 모델 추가: `add_<modelname>` (예: `add_change_batch`)
- 컬럼 추가: `add_<column>_to_<model>` (예: `add_lease_owner_to_change_batch`)
- 인덱스 추가: `add_index_<col>_on_<model>`
- RLS 추가: `add_rls_<model>`

### 6. RLS 정책 (필요 시)

광고주 화이트리스트가 적용되는 모델은 RLS:

```sql
ALTER TABLE "Keyword" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_keyword" ON "Keyword"
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "AdGroup" ag
      JOIN "Campaign" c ON ag."campaignId" = c.id
      JOIN "UserAdvertiserAccess" uaa ON c."advertiserId" = uaa."advertiserId"
      WHERE ag.id = "Keyword"."adgroupId"
        AND uaa."userId" = auth.uid()::text
    )
  );
```

마이그레이션 파일에 SQL 직접 작성. Prisma는 RLS 직접 표현 X. RLS는 권한의 이중 안전망(앱 레벨 권한 체크는 Server Action에서 별도). 둘 다 필요.

### 7. 시드 데이터

테스트용 시드는 `prisma/seed.ts`. 시크릿 컬럼은 시드에서도 암호화. 운영 DB 시드 적용 금지(시드는 dev/test만).

### 8. 검증

```bash
pnpm prisma format
pnpm prisma validate
pnpm tsc --noEmit
```

검증 통과 후 마이그레이션 적용.

## 출력

- 변경된 `schema.prisma` 부분 (diff 형태)
- 생성된 마이그레이션 파일 경로
- (필요 시) RLS SQL
- Prisma 클라이언트 사용 예시 1~2줄 (다음 에이전트가 import할 때 필요)

## 안티패턴

- ❌ 평문 시크릿 컬럼 (`apiKey String`)
- ❌ raw 컬럼 누락 (네이버 엔티티)
- ❌ 인덱스 추측 추가 (실제 쿼리 패턴 없이)
- ❌ schema.prisma 우회 직접 SQL 변경
- ❌ Soft delete 정책 무시 (P1 hard delete)
- ❌ ChangeItem.targetType enum 미갱신
- ❌ 평문 키 시드 (시드 데이터에서도 암호화 의무)

## 검증 트리거 키워드

새 엔티티, Prisma 모델 추가, 마이그레이션, 컬럼 추가, 인덱스, RLS, 시크릿 컬럼, schema.prisma
