---
name: batch-executor-job
description: 5천 건 같은 일괄 변경을 ChangeBatch Job Table + Chunk Executor 패턴으로 추가할 때 사용. SPEC v0.2.1 3.5절 패턴 — lease 기반 동시 실행 방지(IS NULL 조건 포함), ChangeItem.status='pending' 정렬 픽업, idempotencyKey 멱등성, 진행률 polling, 재시도 흐름. 일괄 변경 / 대량 작업 / 백그라운드 Job 추가 시 반드시 이 스킬 사용. self-invoke 또는 cursor 기반 처리 금지.
---

# Batch Executor Job

## 언제 사용

- 키워드·소재·광고그룹 다중 선택 일괄 변경
- CSV 업로드 일괄 적용
- 비딩 자동 조정 (P2)
- 그 외 5천 건 단위 백그라운드 Job

## 핵심 원칙 (SPEC 3.5)

이 패턴이 깨지면 5천 키워드 일괄 작업이 Vercel 함수 시간 한계(60~300초)에 막히거나, 동시 실행으로 중복 적용된다. 다음 4가지가 안전성 핵심:

1. **lease 기반 동시 실행 방지** — `leaseExpiresAt IS NULL OR < now()` 조건. IS NULL 누락 시 신규 pending 픽업 못함
2. **status=pending 정렬 픽업** — cursor 기반 X. 부분 실패 재시도가 단순해짐
3. **idempotencyKey 의무** — 같은 변경 재실행 시 skip
4. **다음 chunk는 다음 Cron이** — self-invoke 금지 (배포 중단·중복 실행 리스크)

## 표준 패턴

### 1. ChangeBatch + ChangeItem 생성 (Server Action)

```ts
// app/(dashboard)/[advertiserId]/keywords/actions.ts
'use server'
import { prisma } from "@/lib/db/prisma"
import { auth } from "@/lib/supabase/server"
import { assertAdvertiserAccess } from "@/lib/auth/access"

export async function applyKeywordChanges(input: ApplyInput) {
  // 1. 권한 체크
  const user = await auth.getUser()
  await assertAdvertiserAccess(user.id, input.advertiserId)

  // 2. ChangeBatch 생성 (status=pending)
  const batch = await prisma.changeBatch.create({
    data: {
      userId: user.id,
      action: "keywords:bulk",
      total: input.items.length,
      processed: 0,
      attempt: 0,
      summary: { advertiserId: input.advertiserId, kind: input.kind },
      // leaseOwner / leaseExpiresAt: NULL (Cron이 픽업)
    },
  })

  // 3. ChangeItem 생성 (status=pending, idempotencyKey 의무)
  await prisma.changeItem.createMany({
    data: input.items.map(item => ({
      batchId: batch.id,
      targetType: "Keyword",
      targetId: item.nccKeywordId,
      before: item.before,
      after: item.after,
      idempotencyKey: item.externalId ?? `${batch.id}:${item.nccKeywordId}`,
      status: "pending",
      attempt: 0,
    })),
  })

  // 4. 즉시 응답 (Batch ID)
  return { batchId: batch.id }
}
```

### 2. Chunk Executor (Route Handler)

```ts
// app/api/batch/run/route.ts
import { prisma } from "@/lib/db/prisma"
import { applyChange } from "@/lib/batch/apply"

export async function POST(req: Request) {
  // Cron Secret 인증
  if (req.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 })
  }

  const workerId = crypto.randomUUID()

  // 1. lease 획득 (원자 트랜잭션)
  // SPEC 3.5: IS NULL 조건 필수
  const acquired = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "ChangeBatch"
       SET "leaseOwner" = ${workerId},
           "leaseExpiresAt" = now() + interval '5 minutes',
           "status" = 'running',
           "attempt" = "attempt" + 1
     WHERE "id" = (
       SELECT "id" FROM "ChangeBatch"
        WHERE "status" IN ('pending','running')
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now())
        ORDER BY "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     RETURNING "id"
  `

  if (acquired.length === 0) {
    return Response.json({ ok: true, picked: 0 })
  }
  const batchId = acquired[0].id

  // 2. chunk 처리 (status=pending ORDER BY id LIMIT 100)
  const startedAt = Date.now()
  const TIME_BUDGET_MS = 50_000  // Vercel 60s 한계 안전 마진

  while (Date.now() - startedAt < TIME_BUDGET_MS) {
    const items = await prisma.changeItem.findMany({
      where: { batchId, status: "pending" },
      orderBy: { id: "asc" },
      take: 100,
    })
    if (items.length === 0) break

    for (const item of items) {
      try {
        // 3. 멱등성: idempotencyKey 이미 처리됐으면 skip
        // (재시도 중 같은 키 두 번 처리 방지)
        await applyChange(item)
        await prisma.changeItem.update({
          where: { id: item.id },
          data: { status: "done" },
        })
      } catch (e) {
        await prisma.changeItem.update({
          where: { id: item.id },
          data: {
            status: "failed",
            error: String(e).slice(0, 1000),
            attempt: { increment: 1 },
          },
        })
      }
    }

    // 4. processed 갱신
    await prisma.changeBatch.update({
      where: { id: batchId },
      data: { processed: { increment: items.length } },
    })
  }

  // 5. 종료 처리
  // pending 0 + failed > 0 → status=failed, pending 0 + failed=0 → done
  // 시간 한계로 종료 시 lease 해제 후 다음 Cron이 이어 처리
  await finalizeBatch(batchId)

  return Response.json({ ok: true })
}
```

### 3. 진행률 polling

```ts
// app/api/batch/[id]/route.ts (GET)
export async function GET(_req: Request, { params }: { params: { id: string }}) {
  const batch = await prisma.changeBatch.findUnique({
    where: { id: params.id },
    select: { id: true, total: true, processed: true, status: true, attempt: true },
  })
  return Response.json(batch)
}
```

UI는 TanStack Query 5초 간격 polling.

### 4. 재시도 흐름

부분 실패 ChangeItem만 재시도:
- UI에서 "실패 항목 재시도" 클릭 → Server Action이 `ChangeItem.status='pending'` 재설정
- 다음 Cron이 자동으로 다시 픽업 (cursor 되돌림 X — status 기반이라 자동)

### 5. Vercel Cron 등록

```json
// vercel.json
{
  "crons": [
    { "path": "/api/batch/run", "schedule": "* * * * *" }
  ]
}
```

`CRON_SECRET` env 등록 필수.

### 6. applyChange (변경 적용 함수)

`lib/batch/apply.ts`에서 ChangeItem.targetType별로 분기 → naver-sa 모듈 호출.

```ts
export async function applyChange(item: ChangeItem) {
  switch (item.targetType) {
    case "Keyword": return applyKeywordChange(item)
    case "Ad":      return applyAdChange(item)
    // ...
  }
}
```

## 의무 안전장치

- ❌ self-invoke (Route Handler 안에서 다음 chunk를 별도 fetch로 호출)
- ❌ cursor 기반 처리 (status=pending 정렬이 정답)
- ❌ Server Action 안에서 동기 처리 (Vercel 함수 시간 한계)
- ❌ idempotencyKey 누락
- ❌ lease IS NULL 조건 누락 → 신규 pending 픽업 못함
- ❌ Rate Limit 큐 우회 (naver-sa 모듈 통과 의무)
- ❌ FOR UPDATE SKIP LOCKED 누락 → 동시 워커 race condition

## 의존

- `db-architect`: ChangeBatch / ChangeItem 모델 (lease·idempotency 컬럼 포함)
- `naver-sa-specialist`: applyChange가 호출할 모듈 함수 (예: keywords.ts의 updateKeywordsBulk)
- 환경 변수: `CRON_SECRET`, `DATABASE_URL`

## 출력

- Server Action (ChangeBatch 생성)
- Route Handler (Chunk Executor)
- 진행률 GET API
- `vercel.json` Cron 등록
- `lib/batch/apply.ts` (변경 적용 분기)

## 안티패턴 (재강조)

- ❌ 5천 건을 단일 Server Action 안에서 동기 처리
- ❌ self-invoke로 다음 chunk 트리거
- ❌ cursor 기반 픽업
- ❌ 멱등성 키 없음
- ❌ lease 없이 동시 실행 허용
- ❌ ChangeBatch 안 거치고 직접 naver-sa 모듈 호출

## 검증 트리거 키워드

일괄, 대량, ChangeBatch, Chunk Executor, Job, lease, 5천, batch-executor, 백그라운드 작업, Vercel Cron
