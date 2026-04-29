"use client"

/**
 * F-11.4 — 타게팅 룰 편집 클라이언트
 *
 * 책임:
 *   - 룰 활성 토글 / 기본 가중치 / 7×24 시간 grid / 디바이스 / 지역 입력
 *   - 변경 누적 (dirty) → "저장" 버튼 클릭 시 1번에 upsert
 *   - "재설정" 버튼: initialData 로 복원 (변경 누적분 폐기)
 *   - viewer: 모든 input disabled + 저장 / 재설정 버튼 미표시
 *
 * 셀 편집 UX:
 *   - 168 셀 인라인 input 은 시각적 부담 → 셀 클릭 → 작은 Dialog 에서 weight 입력
 *   - "삭제" 버튼은 weight 키 제거 (defaultWeight 회귀)
 *   - shadcn Popover 부재 → Dialog 사용 (기존 컴포넌트 재사용 원칙)
 *
 * 색상 정책 (셀 / 디바이스 / 지역 모두 공통):
 *   - 미설정 (defaultWeight 적용)  : 옅은 gray + italic + "*" 표기
 *   - = 1.0                         : 흰색 / neutral
 *   - > 1.0                         : green tint (≥ 1.5 진하게)
 *   - < 1.0                         : amber tint
 *   - = 0                           : red (입찰 정지)
 *
 * 본 PR 단순화 (후속):
 *   - "주중 / 주말 일괄 적용" 도구 미포함 (개별 셀 + 전체 1.0 초기화 만)
 *
 * SPEC: SPEC v0.2.1 F-11.4
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  upsertTargetingRule,
  type TargetingRuleData,
} from "@/app/(dashboard)/[advertiserId]/targeting/actions"

// =============================================================================
// 상수
// =============================================================================

type Day = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun"
const DAYS: { key: Day; label: string }[] = [
  { key: "mon", label: "월" },
  { key: "tue", label: "화" },
  { key: "wed", label: "수" },
  { key: "thu", label: "목" },
  { key: "fri", label: "금" },
  { key: "sat", label: "토" },
  { key: "sun", label: "일" },
]
const HOURS = Array.from({ length: 24 }, (_, i) => i)

const REGIONS: { code: string; name: string }[] = [
  { code: "11", name: "서울" },
  { code: "26", name: "부산" },
  { code: "27", name: "대구" },
  { code: "28", name: "인천" },
  { code: "29", name: "광주" },
  { code: "30", name: "대전" },
  { code: "31", name: "울산" },
  { code: "36", name: "세종" },
  { code: "41", name: "경기" },
  { code: "42", name: "강원" },
  { code: "43", name: "충북" },
  { code: "44", name: "충남" },
  { code: "45", name: "전북" },
  { code: "46", name: "전남" },
  { code: "47", name: "경북" },
  { code: "48", name: "경남" },
  { code: "50", name: "제주" },
]

// =============================================================================
// 색상 유틸 — 가중치 → Tailwind 클래스
// =============================================================================

/**
 * 가중치 → 셀 배경 / 텍스트 클래스.
 * weight === undefined 면 미설정 (defaultWeight 적용) 시각.
 */
function weightToClass(weight: number | undefined): string {
  if (weight === undefined) {
    return "bg-muted/30 text-muted-foreground italic"
  }
  if (weight === 0) {
    return "bg-red-100 text-red-900 dark:bg-red-950/40 dark:text-red-200"
  }
  if (weight === 1) {
    return "bg-background text-foreground"
  }
  if (weight > 1) {
    if (weight >= 1.5) {
      return "bg-emerald-300/70 text-emerald-950 dark:bg-emerald-700/50 dark:text-emerald-50"
    }
    return "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
  }
  // < 1
  if (weight <= 0.5) {
    return "bg-amber-300/70 text-amber-950 dark:bg-amber-700/50 dark:text-amber-50"
  }
  return "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
}

function formatWeight(w: number): string {
  // 1.00 → "1.0" / 0.7 → "0.7"
  return w.toFixed(1).replace(/\.0$/, ".0")
}

// =============================================================================
// 메인 컴포넌트
// =============================================================================

export function TargetingClient({
  initialData,
  userRole,
}: {
  initialData: TargetingRuleData
  userRole: "admin" | "operator" | "viewer"
}) {
  const router = useRouter()
  const canMutate = userRole === "admin" || userRole === "operator"

  // 상태
  const [enabled, setEnabled] = React.useState(initialData.enabled)
  const [defaultWeight, setDefaultWeight] = React.useState(
    initialData.defaultWeight,
  )
  const [hourWeights, setHourWeights] = React.useState<Record<string, number>>(
    initialData.hourWeights,
  )
  const [deviceWeights, setDeviceWeights] = React.useState<
    Record<string, number>
  >(initialData.deviceWeights)
  const [regionWeights, setRegionWeights] = React.useState<
    Record<string, number>
  >(initialData.regionWeights)
  const [pending, setPending] = React.useState(false)

  // dirty 검출 — initialData 와 현재 상태 비교
  const dirty = React.useMemo(() => {
    if (enabled !== initialData.enabled) return true
    if (defaultWeight !== initialData.defaultWeight) return true
    if (!shallowRecordEqual(hourWeights, initialData.hourWeights)) return true
    if (!shallowRecordEqual(deviceWeights, initialData.deviceWeights))
      return true
    if (!shallowRecordEqual(regionWeights, initialData.regionWeights))
      return true
    return false
  }, [
    enabled,
    defaultWeight,
    hourWeights,
    deviceWeights,
    regionWeights,
    initialData,
  ])

  // 셀 편집 모달
  const [editingCell, setEditingCell] = React.useState<{
    day: Day
    hour: number
  } | null>(null)

  function reset() {
    setEnabled(initialData.enabled)
    setDefaultWeight(initialData.defaultWeight)
    setHourWeights(initialData.hourWeights)
    setDeviceWeights(initialData.deviceWeights)
    setRegionWeights(initialData.regionWeights)
  }

  function clearAllHours() {
    setHourWeights({})
  }

  async function save() {
    setPending(true)
    try {
      const res = await upsertTargetingRule({
        advertiserId: initialData.advertiserId,
        enabled,
        defaultWeight,
        hourWeights,
        deviceWeights,
        regionWeights,
      })
      if (!res.ok) {
        toast.error(`저장 실패: ${res.error}`)
        return
      }
      toast.success("타게팅 룰 저장됨")
      router.refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`저장 오류: ${msg}`)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* 활성 토글 + 기본 가중치 */}
      <Card>
        <CardHeader className="border-b">
          <CardTitle>룰 활성 / 기본 가중치</CardTitle>
          <CardDescription>
            룰 비활성 시 자동 비딩은 baseBid × 1.0 (가중 효과 없음). 시간대 키
            누락 시 기본 가중치가 적용됩니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 py-4">
          <div className="flex items-center gap-3">
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={!canMutate}
              aria-label="타게팅 룰 활성"
            />
            <Label className="text-sm">
              타게팅 룰 {enabled ? "활성" : "비활성"}
            </Label>
          </div>
          <div className="flex items-center gap-3">
            <Label className="w-28 text-sm" htmlFor="defaultWeight">
              기본 가중치
            </Label>
            <Input
              id="defaultWeight"
              type="number"
              step="0.1"
              min="0"
              max="3"
              className="w-28"
              value={defaultWeight}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (Number.isFinite(v)) setDefaultWeight(clamp(v, 0, 3))
              }}
              disabled={!canMutate}
            />
            <span className="text-xs text-muted-foreground">
              범위 0..3 / step 0.1 / 권장 1.0
            </span>
          </div>
        </CardContent>
      </Card>

      {/* 7×24 시간 grid */}
      <Card>
        <CardHeader className="border-b">
          <div className="flex items-end justify-between gap-3">
            <div>
              <CardTitle>시간대 가중치 (7 × 24)</CardTitle>
              <CardDescription>
                셀 클릭 → 가중치 입력. 미설정 셀은{" "}
                <span className="italic">기본 가중치</span> 적용. 색상: 흰
                = 1.0 / 녹 = &gt;1.0 / 황 = &lt;1.0 / 적 = 0 (입찰 정지).
              </CardDescription>
            </div>
            {canMutate && (
              <Button
                size="sm"
                variant="outline"
                onClick={clearAllHours}
                disabled={Object.keys(hourWeights).length === 0}
              >
                전체 초기화
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto py-4">
          <div className="min-w-[1000px]">
            <HourGrid
              hourWeights={hourWeights}
              defaultWeight={defaultWeight}
              canMutate={canMutate}
              onCellClick={(day, hour) => setEditingCell({ day, hour })}
            />
            <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
              <Legend />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 디바이스 */}
      <Card>
        <CardHeader className="border-b">
          <CardTitle>디바이스 가중치</CardTitle>
          <CardDescription>
            PC / MOBILE 가중. 미설정 시 기본 가중치 적용.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 py-4">
          {(["PC", "MOBILE"] as const).map((d) => (
            <DeviceRow
              key={d}
              device={d}
              value={deviceWeights[d]}
              defaultWeight={defaultWeight}
              canMutate={canMutate}
              onChange={(next) => {
                setDeviceWeights((prev) => {
                  const n = { ...prev }
                  if (next === undefined) delete n[d]
                  else n[d] = next
                  return n
                })
              }}
            />
          ))}
        </CardContent>
      </Card>

      {/* 지역 (자동 비딩 미적용) */}
      <Card className="opacity-90">
        <CardHeader className="border-b">
          <CardTitle className="text-amber-700 dark:text-amber-400">
            지역 가중치 (자동 비딩 미적용 — 후속 PR)
          </CardTitle>
          <CardDescription>
            네이버 SA API 가 키워드별 노출 지역을 분리 응답하지 않아 매칭
            불가합니다. 입력값은 모델만 보존됩니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 py-4 sm:grid-cols-3 md:grid-cols-4">
          {REGIONS.map((r) => (
            <RegionRow
              key={r.code}
              code={r.code}
              name={r.name}
              value={regionWeights[r.code]}
              defaultWeight={defaultWeight}
              canMutate={canMutate}
              onChange={(next) => {
                setRegionWeights((prev) => {
                  const n = { ...prev }
                  if (next === undefined) delete n[r.code]
                  else n[r.code] = next
                  return n
                })
              }}
            />
          ))}
        </CardContent>
      </Card>

      {/* 저장 / 재설정 */}
      {canMutate ? (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            onClick={reset}
            disabled={!dirty || pending}
          >
            재설정
          </Button>
          <Button onClick={save} disabled={!dirty || pending}>
            {pending ? "저장 중..." : "저장"}
          </Button>
        </div>
      ) : (
        <p className="text-right text-xs text-muted-foreground">
          (viewer 권한 — 룰을 수정할 수 없습니다)
        </p>
      )}

      {/* 셀 편집 다이얼로그 */}
      <CellEditDialog
        editing={editingCell}
        currentWeight={
          editingCell
            ? hourWeights[`${editingCell.day}-${editingCell.hour}`]
            : undefined
        }
        defaultWeight={defaultWeight}
        onClose={() => setEditingCell(null)}
        onApply={(weight) => {
          if (!editingCell) return
          const key = `${editingCell.day}-${editingCell.hour}`
          setHourWeights((prev) => ({ ...prev, [key]: weight }))
          setEditingCell(null)
        }}
        onClear={() => {
          if (!editingCell) return
          const key = `${editingCell.day}-${editingCell.hour}`
          setHourWeights((prev) => {
            const n = { ...prev }
            delete n[key]
            return n
          })
          setEditingCell(null)
        }}
      />
    </div>
  )
}

// =============================================================================
// HourGrid — 7행(요일) × 24열(시간) 그리드
// =============================================================================

function HourGrid({
  hourWeights,
  defaultWeight,
  canMutate,
  onCellClick,
}: {
  hourWeights: Record<string, number>
  defaultWeight: number
  canMutate: boolean
  onCellClick: (day: Day, hour: number) => void
}) {
  return (
    <div className="rounded-md border">
      {/* 헤더 행 — 시간 0..23 */}
      <div
        className="grid border-b bg-muted/20 text-[10px] text-muted-foreground"
        style={{ gridTemplateColumns: "48px repeat(24, minmax(34px, 1fr))" }}
      >
        <div className="px-2 py-1.5"></div>
        {HOURS.map((h) => (
          <div key={h} className="border-l px-1 py-1.5 text-center font-mono">
            {h}
          </div>
        ))}
      </div>
      {/* 본문 — 요일 7행 */}
      {DAYS.map(({ key: day, label }) => (
        <div
          key={day}
          className="grid border-b last:border-b-0"
          style={{ gridTemplateColumns: "48px repeat(24, minmax(34px, 1fr))" }}
        >
          <div className="flex items-center justify-center border-r bg-muted/20 px-2 py-1 text-xs font-medium">
            {label}
          </div>
          {HOURS.map((hour) => {
            const key = `${day}-${hour}`
            const w = hourWeights[key]
            const cls = weightToClass(w)
            const display = w === undefined ? formatWeight(defaultWeight) : formatWeight(w)
            return (
              <button
                key={key}
                type="button"
                disabled={!canMutate}
                onClick={() => onCellClick(day, hour)}
                className={`relative h-8 border-l px-1 text-[10px] font-mono outline-none transition-colors ${cls} ${
                  canMutate ? "hover:ring-2 hover:ring-primary/40" : "cursor-default"
                } focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-default`}
                aria-label={`${label} ${hour}시 가중치 ${display}${
                  w === undefined ? " (기본값)" : ""
                }`}
              >
                {w === undefined ? (
                  <span>
                    {display}
                    <span className="ml-0.5 text-[8px] align-top">*</span>
                  </span>
                ) : (
                  <span>{display}</span>
                )}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

// =============================================================================
// Legend — 색상 범례
// =============================================================================

function Legend() {
  return (
    <div className="flex flex-wrap gap-3">
      <LegendItem label="기본값 (미설정)" cls="bg-muted/30 italic" />
      <LegendItem label="1.0 (중립)" cls="bg-background border" />
      <LegendItem label=">1.0" cls="bg-emerald-100" />
      <LegendItem label="≥1.5" cls="bg-emerald-300/70" />
      <LegendItem label="<1.0" cls="bg-amber-100" />
      <LegendItem label="≤0.5" cls="bg-amber-300/70" />
      <LegendItem label="0 (정지)" cls="bg-red-100" />
    </div>
  )
}

function LegendItem({ label, cls }: { label: string; cls: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`inline-block size-3.5 rounded ${cls}`} />
      <span>{label}</span>
    </div>
  )
}

// =============================================================================
// CellEditDialog — 셀 가중치 편집 다이얼로그 (Popover 대용)
// =============================================================================

function CellEditDialog({
  editing,
  currentWeight,
  defaultWeight,
  onClose,
  onApply,
  onClear,
}: {
  editing: { day: Day; hour: number } | null
  currentWeight: number | undefined
  defaultWeight: number
  onClose: () => void
  onApply: (weight: number) => void
  onClear: () => void
}) {
  if (!editing) return null
  // 매 open 마다 새 inner 컴포넌트 마운트 → useState 초기값으로 prefill (effect 불필요).
  return (
    <Dialog open={editing !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <CellEditDialogBody
          key={`${editing.day}-${editing.hour}`}
          editing={editing}
          currentWeight={currentWeight}
          defaultWeight={defaultWeight}
          onClose={onClose}
          onApply={onApply}
          onClear={onClear}
        />
      </DialogContent>
    </Dialog>
  )
}

function CellEditDialogBody({
  editing,
  currentWeight,
  defaultWeight,
  onClose,
  onApply,
  onClear,
}: {
  editing: { day: Day; hour: number }
  currentWeight: number | undefined
  defaultWeight: number
  onClose: () => void
  onApply: (weight: number) => void
  onClear: () => void
}) {
  const [draft, setDraft] = React.useState<string>(() =>
    currentWeight !== undefined
      ? formatWeight(currentWeight)
      : formatWeight(defaultWeight),
  )

  const dayLabel = DAYS.find((d) => d.key === editing.day)?.label ?? editing.day
  const parsed = Number(draft)
  const valid = Number.isFinite(parsed) && parsed >= 0 && parsed <= 3

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {dayLabel}요일 {editing.hour}시 가중치
        </DialogTitle>
        <DialogDescription>
          범위 0..3 / step 0.1. 0 은 입찰 정지. 미설정 시 기본 가중치 (
          {formatWeight(defaultWeight)}) 적용.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-2">
        <Label htmlFor="cell-weight">가중치</Label>
        <Input
          id="cell-weight"
          type="number"
          step="0.1"
          min="0"
          max="3"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter" && valid) {
              onApply(parsed)
            }
          }}
        />
        {!valid && (
          <p className="text-xs text-red-700 dark:text-red-400">
            0..3 사이 숫자를 입력하세요.
          </p>
        )}
      </div>

      <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        <Button
          variant="ghost"
          onClick={onClear}
          disabled={currentWeight === undefined}
          title="기본 가중치로 회귀"
        >
          초기화 (기본값)
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button disabled={!valid} onClick={() => valid && onApply(parsed)}>
            적용
          </Button>
        </div>
      </DialogFooter>
    </>
  )
}

// =============================================================================
// DeviceRow / RegionRow — 단일 키 가중치 입력 + "초기화" 버튼
// =============================================================================

function DeviceRow({
  device,
  value,
  defaultWeight,
  canMutate,
  onChange,
}: {
  device: "PC" | "MOBILE"
  value: number | undefined
  defaultWeight: number
  canMutate: boolean
  onChange: (next: number | undefined) => void
}) {
  const display = value !== undefined ? formatWeight(value) : ""
  const cls = weightToClass(value)
  return (
    <div className="flex items-center gap-3">
      <Label className="w-24 text-sm">{device}</Label>
      <Input
        type="number"
        step="0.1"
        min="0"
        max="3"
        className={`w-28 ${cls}`}
        value={display}
        placeholder={`* ${formatWeight(defaultWeight)}`}
        disabled={!canMutate}
        onChange={(e) => {
          const raw = e.target.value
          if (raw === "") {
            onChange(undefined)
            return
          }
          const v = Number(raw)
          if (Number.isFinite(v)) onChange(clamp(v, 0, 3))
        }}
      />
      {value !== undefined && canMutate && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onChange(undefined)}
        >
          초기화
        </Button>
      )}
      {value === undefined && (
        <span className="text-xs italic text-muted-foreground">
          기본값 적용
        </span>
      )}
    </div>
  )
}

function RegionRow({
  code,
  name,
  value,
  defaultWeight,
  canMutate,
  onChange,
}: {
  code: string
  name: string
  value: number | undefined
  defaultWeight: number
  canMutate: boolean
  onChange: (next: number | undefined) => void
}) {
  const display = value !== undefined ? formatWeight(value) : ""
  const cls = weightToClass(value)
  return (
    <div className="flex items-center gap-2">
      <Label className="w-12 shrink-0 text-xs">{name}</Label>
      <Input
        type="number"
        step="0.1"
        min="0"
        max="3"
        className={`w-20 ${cls}`}
        value={display}
        placeholder={`* ${formatWeight(defaultWeight)}`}
        disabled={!canMutate}
        onChange={(e) => {
          const raw = e.target.value
          if (raw === "") {
            onChange(undefined)
            return
          }
          const v = Number(raw)
          if (Number.isFinite(v)) onChange(clamp(v, 0, 3))
        }}
      />
      <span className="font-mono text-[10px] text-muted-foreground">
        {code}
      </span>
    </div>
  )
}

// =============================================================================
// 헬퍼
// =============================================================================

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min
  if (n > max) return max
  return Math.round(n * 10) / 10 // 0.1 step normalize
}

function shallowRecordEqual(
  a: Record<string, number>,
  b: Record<string, number>,
): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (a[k] !== b[k]) return false
  }
  return true
}
