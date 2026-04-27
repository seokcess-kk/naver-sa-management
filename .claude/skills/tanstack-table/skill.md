---
name: tanstack-table
description: 5천 행 규모 테이블 페이지를 TanStack Table + TanStack Virtual + shadcn/ui로 구성할 때 사용. 인라인 편집은 staging 누적 + 미리보기 확정 패턴(즉시 API 반영 금지), 다중 선택 일괄 액션 모달 4단계, 미확정 셀 시각 구분. 키워드·소재·광고그룹 등 대량 데이터 페이지 / 인라인 편집 / 일괄 액션 추가 시 반드시 이 스킬 사용. 가상 스크롤 없이 5천 행 테이블 금지.
---

# TanStack Table 5K Page

## 언제 사용

- 키워드 / 소재 / 확장소재 / 광고그룹 등 5천 행 단위 페이지
- 인라인 편집 + 다중 선택 + 일괄 액션이 필요한 모든 화면

## 핵심 원칙

1. **가상 스크롤 의무**: 5천 행 + DOM 5천 노드는 즉사. TanStack Virtual 없는 대량 테이블 금지
2. **인라인 편집 = staging**: 셀 변경은 클라이언트 상태에 누적. 즉시 fetch / Server Action 금지
3. **미확정 셀 시각 구분**: staging 셀은 시각적으로 구분 (배경 + ring)
4. **광고주별 컨텍스트**: URL 패턴 `/[advertiserId]/...`. 횡단 뷰 금지

## 표준 구조

```
app/(dashboard)/[advertiserId]/{feature}/page.tsx       (RSC, 데이터 fetch)
components/{feature}/
├── table.tsx                                           ('use client', 인터랙션 + Virtual)
├── columns.tsx                                         (ColumnDef + cell renderer)
├── bulk-action-modal.tsx                               (4단계 모달)
├── staging-bar.tsx                                     (변경 N건 / 미리보기 / 취소 버튼)
└── use-batch-progress.ts                               (진행률 polling 훅)
```

## 1. RSC에서 초기 데이터 fetch

```tsx
// app/(dashboard)/[advertiserId]/keywords/page.tsx
import { listKeywords } from "@/lib/naver-sa/keywords"
import { KeywordsTable } from "@/components/keywords/table"

export default async function Page({
  params,
}: {
  params: { advertiserId: string }
}) {
  // P1: Stats API + Redis 캐시 (자체 적재 X)
  // 권한 체크는 layout 또는 middleware에서 선행
  const data = await listKeywords(params.advertiserId)
  return <KeywordsTable initial={data} advertiserId={params.advertiserId} />
}
```

## 2. TanStack Table + Virtual 통합

```tsx
'use client'
import {
  useReactTable, getCoreRowModel, getSortedRowModel, getFilteredRowModel,
  flexRender, type ColumnDef,
} from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useRef, useState } from "react"

export function KeywordsTable({ initial, advertiserId }: Props) {
  // staging: rowId → 변경된 필드만
  const [staging, setStaging] = useState<Map<string, Partial<Keyword>>>(new Map())
  const [rowSelection, setRowSelection] = useState({})
  const parentRef = useRef<HTMLDivElement>(null)

  const table = useReactTable({
    data: initial,
    columns,  // see columns.tsx
    state: { rowSelection },
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    enableRowSelection: true,
    getRowId: (row) => row.nccKeywordId,
    meta: {
      staging,
      onCellChange: (rowId, field, value) => {
        setStaging(prev => {
          const next = new Map(prev)
          const current = next.get(rowId) ?? {}
          next.set(rowId, { ...current, [field]: value })
          return next
        })
      },
    },
  })

  const rows = table.getRowModel().rows
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 10,
  })

  return (
    <div ref={parentRef} className="h-[calc(100vh-200px)] overflow-auto">
      <table>
        {/* header */}
        <tbody style={{ height: rowVirtualizer.getTotalSize() }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index]
            return (
              <tr key={row.id} style={{ transform: `translateY(${virtualRow.start}px)` }}>
                {row.getVisibleCells().map(cell => (
                  <td key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
      <StagingBar staging={staging} onPreview={() => openPreviewModal()} onClear={() => setStaging(new Map())} />
    </div>
  )
}
```

## 3. 인라인 편집 = staging 누적

```tsx
// components/keywords/columns.tsx
export const columns: ColumnDef<Keyword>[] = [
  {
    accessorKey: "bidAmt",
    header: "입찰가",
    cell: ({ row, table, column }) => {
      const meta = table.options.meta as TableMeta
      const staged = meta.staging.get(row.id)
      const isStaged = staged && "bidAmt" in staged
      const value = isStaged ? staged.bidAmt : row.original.bidAmt
      return (
        <input
          type="number"
          value={value ?? ""}
          onChange={(e) => meta.onCellChange(row.id, "bidAmt", Number(e.target.value))}
          className={cn(
            "w-full",
            isStaged && "bg-yellow-50 ring-1 ring-yellow-400"  // 미확정 시각 구분
          )}
        />
      )
    },
  },
  // ...
]
```

**즉시 API 호출 금지**. 셀 변경은 staging Map에만. 사용자가 명시적으로 "미리보기 → 확정" 누를 때까지 외부 호출 0회.

## 4. 일괄 액션 모달 4단계

```
┌─────────────────────────────────────────┐
│ 1. 선택: "키워드 23개 선택됨"            │
├─────────────────────────────────────────┤
│ 2. 액션 선택:                            │
│    ◯ ON / OFF                           │
│    ◯ 입찰가 변경 (절대값 / 비율)         │
│    ✕ 삭제 (P1 비대상)                   │
├─────────────────────────────────────────┤
│ 3. 미리보기 (전/후 표):                  │
│    keyword | before | after             │
│    ...     | 500    | 450 (-10%)        │
├─────────────────────────────────────────┤
│ 4. 확정 → Server Action → batchId       │
│    진행률 polling (5초): 23/23 완료      │
│    결과: 성공 22 / 실패 1               │
│    ChangeBatch ID: cuid... [롤백]       │
└─────────────────────────────────────────┘
```

`bulk-action-modal.tsx`에서 4단계를 controlled state로 관리 (`step: 'select' | 'preview' | 'progress' | 'result'`).

## 5. 진행률 polling 훅

```tsx
// components/keywords/use-batch-progress.ts
import { useQuery } from "@tanstack/react-query"

export function useBatchProgress(batchId: string | null) {
  return useQuery({
    queryKey: ["batch", batchId],
    queryFn: () => fetch(`/api/batch/${batchId}`).then(r => r.json()),
    enabled: !!batchId,
    refetchInterval: (q) => {
      const data = q.state.data
      if (!data) return 5000
      if (data.status === "done" || data.status === "failed") return false
      return 5000
    },
  })
}
```

## 6. 다중 선택

TanStack Table의 `enableRowSelection`. 선택된 row IDs:

```ts
const selectedIds = Object.keys(rowSelection).filter(k => rowSelection[k])
```

`getRowId: (row) => row.nccKeywordId` 사용 시 selection key가 nccKeywordId가 됨. ChangeItem.targetId 매핑 직접.

## 7. ChangeBatch ID 노출

작업 결과 화면에 ChangeBatch ID 표시 → 클릭 시 `/[advertiserId]/audit/batch/{id}` 롤백 페이지로 이동. 사용자가 변경 추적 가능해야 함(SPEC 11.3).

## 8. 광고주별 컨텍스트 엄수

URL 패턴 `/[advertiserId]/...` 의무. 횡단 뷰(전 광고주 합산) 만들지 말 것. 다른 광고주 데이터 노출 차단(권한 체크 + RLS).

## 출력

- `app/(dashboard)/[advertiserId]/{feature}/page.tsx` (RSC)
- `components/{feature}/table.tsx` ('use client' + Virtual)
- `components/{feature}/columns.tsx` (ColumnDef + cell renderer)
- `components/{feature}/bulk-action-modal.tsx` (4단계 모달)
- `components/{feature}/staging-bar.tsx` (변경 N건 표시 + 액션)
- `components/{feature}/use-batch-progress.ts` (진행률 polling)

## 안티패턴

- ❌ 셀 편집 즉시 fetch / Server Action 호출 (staging 우회)
- ❌ 가상 스크롤 없는 5천 행
- ❌ 다중 선택 액션에 "삭제" 추가 (P1 비대상)
- ❌ 횡단 뷰 (전 광고주 합산)
- ❌ ChangeBatch ID 노출 누락
- ❌ 미확정 셀 시각 구분 누락
- ❌ 광고주별 권한 체크 누락 (URL `[advertiserId]` 무시)

## 검증 트리거 키워드

키워드 페이지, 5천 행, 인라인 편집, TanStack Table, 가상 스크롤, 다중 선택, 일괄 액션, staging, 미리보기 모달
