"use client"

/**
 * 이미지 확장소재 추가 모달 (F-5.3) — 광고그룹 N × 이미지 M 일괄 생성
 *
 * 기존 ExtensionsAddModal(텍스트 N×M) 패턴을 응용 — UI 폼이 매우 다르므로 별도 컴포넌트.
 *
 * 흐름 (3단계 상태 머신):
 *   1. form        — 광고그룹(다중) + 이미지 업로드(드래그 또는 클릭)
 *                    각 파일 → uploadImage Server Action(병렬) → publicUrl 보유
 *                    "추가하기 (N×M건)" → submitting
 *   2. submitting  — 스피너 + 진행 안내. createAdExtensionsBatch(type="image") 호출
 *                    throw → form 복귀 + toast.error
 *   3. result      — 카운트 카드 (요청 / 성공 / 실패) + 변경 ID + 클립보드 복사
 *                    실패 항목 분리 노출
 *                    "닫고 새로고침" → onClosed(true) → router.refresh
 *
 * 입력 검증 (클라이언트 + 백엔드 superRefine 이중):
 *   - 광고그룹: 1~50개 (체크박스 리스트, 다중)
 *   - 이미지: 1~10개
 *     · MIME 화이트리스트: image/png, image/jpeg, image/webp
 *     · 5MB 이하 (백엔드도 검증 — 이중 방어)
 *     · 업로드 성공한 항목만 카운트 (publicUrl 보유)
 *   - 총 생성 N×M: 광고그룹 수 × 이미지 수 미리보기 표시
 *
 * 안전장치:
 *   - hasKeys=false / 광고그룹 0개 → 호출자(ExtensionsTable)에서 모달 진입 차단
 *   - 5MB 초과 / MIME 외 파일 빨간 표시 + 차단
 *   - 광고그룹 체크박스 리스트는 50개 상한 검증 (Zod .max(50) 일치)
 *   - 업로드 실패 시 부분 성공 처리 — 실패 파일은 form 단계에서 제거하거나 그대로 진행 가능
 *   - 이미지 클라이언트 state 에서 삭제는 클라이언트만 (Storage 미삭제 — 잔여 cleanup 은 추후 정책)
 *
 * 폼 라이브러리:
 *   useState — 다른 모달과 일관성 유지 (KeywordsAddModal / ExtensionsAddModal 패턴).
 *
 * SPEC 6.2 F-5.3.
 */

import * as React from "react"
import { toast } from "sonner"
import { CopyIcon, XIcon, UploadCloudIcon, Loader2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import {
  createAdExtensionsBatch,
  uploadImage,
  type CreateAdExtensionsBatchResult,
} from "@/app/(dashboard)/[advertiserId]/extensions/actions"
import { cn } from "@/lib/utils"

// =============================================================================
// 타입
// =============================================================================

/** 광고주 한정 광고그룹 옵션 (RSC 조회 결과) — ExtensionsAddModal 와 shape 동일. */
export type ExtensionAdgroupOption = {
  id: string
  nccAdgroupId: string
  name: string
  campaign: { id: string; name: string }
}

type Step = "form" | "submitting" | "result"

/** 클라이언트 측 업로드 항목 상태 머신. */
type UploadItem =
  | {
      id: string
      file: File
      previewUrl: string
      status: "pending" // 검증 대기
    }
  | {
      id: string
      file: File
      previewUrl: string
      status: "uploading"
    }
  | {
      id: string
      file: File
      previewUrl: string
      status: "uploaded"
      storagePath: string
      publicUrl: string
    }
  | {
      id: string
      file: File
      previewUrl: string
      status: "failed"
      error: string
    }

// 입력 한도 — 백엔드 createExtensionsSchema / uploadImage 와 일치.
const MAX_ADGROUPS = 50
const MAX_IMAGES = 10
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024
const ALLOWED_MIME = ["image/png", "image/jpeg", "image/webp"] as const
type AllowedMime = (typeof ALLOWED_MIME)[number]

function isAllowedMime(mime: string): mime is AllowedMime {
  return (ALLOWED_MIME as readonly string[]).includes(mime)
}

// =============================================================================
// 메인 컴포넌트
// =============================================================================

export function ExtensionsImageAddModal({
  advertiserId,
  adgroups,
  open,
  onOpenChange,
  onClosed,
}: {
  advertiserId: string
  adgroups: ExtensionAdgroupOption[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 모달 닫힌 직후 — didApply=true 면 호출자가 router.refresh */
  onClosed?: (didApply: boolean) => void
}) {
  const [step, setStep] = React.useState<Step>("form")
  const [result, setResult] =
    React.useState<CreateAdExtensionsBatchResult | null>(null)

  // -- 폼 state ---------------------------------------------------------------
  // 선택된 광고그룹 nccAdgroupId 집합 (체크박스 리스트).
  const [selectedAgIds, setSelectedAgIds] = React.useState<Set<string>>(
    new Set(),
  )
  // 광고그룹 검색.
  const [agSearch, setAgSearch] = React.useState<string>("")
  // 업로드 항목 리스트 (파일 → uploadImage 결과).
  const [uploads, setUploads] = React.useState<UploadItem[]>([])
  // 드래그 오버 시각 효과 state.
  const [isDragOver, setIsDragOver] = React.useState(false)

  // -- 광고그룹 검색 + 정렬 ---------------------------------------------------
  const filteredAdgroups = React.useMemo(() => {
    const q = agSearch.trim().toLowerCase()
    const arr = q
      ? adgroups.filter(
          (g) =>
            g.name.toLowerCase().includes(q) ||
            g.campaign.name.toLowerCase().includes(q),
        )
      : adgroups
    return [...arr].sort((a, b) => {
      const c = a.campaign.name.localeCompare(b.campaign.name, "ko")
      if (c !== 0) return c
      return a.name.localeCompare(b.name, "ko")
    })
  }, [adgroups, agSearch])

  // 모달 닫힐 때 preview Object URL revoke (메모리 누수 방지).
  React.useEffect(() => {
    return () => {
      uploads.forEach((u) => {
        if (u.previewUrl.startsWith("blob:")) {
          try {
            URL.revokeObjectURL(u.previewUrl)
          } catch {
            // ignore
          }
        }
      })
    }
    // 마운트/언마운트 단위로 실행 — 의도적으로 deps 무시.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // -- 검증 -------------------------------------------------------------------
  const adgroupCount = selectedAgIds.size
  const overAgLimit = adgroupCount > MAX_ADGROUPS
  const adgroupValid = adgroupCount >= 1 && !overAgLimit

  const uploadedItems = uploads.filter(
    (u): u is Extract<UploadItem, { status: "uploaded" }> =>
      u.status === "uploaded",
  )
  const uploadingCount = uploads.filter(
    (u) => u.status === "uploading" || u.status === "pending",
  ).length
  const failedItems = uploads.filter(
    (u): u is Extract<UploadItem, { status: "failed" }> =>
      u.status === "failed",
  )
  const imageCount = uploadedItems.length
  const overImageLimit = uploads.length > MAX_IMAGES

  const imagesValid = imageCount >= 1 && !overImageLimit && uploadingCount === 0
  const formValid = adgroupValid && imagesValid

  const totalCombinations = adgroupCount * imageCount

  // -- 광고그룹 선택 핸들 -----------------------------------------------------
  function toggleAdgroup(nccAdgroupId: string, checked: boolean) {
    setSelectedAgIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(nccAdgroupId)
      else next.delete(nccAdgroupId)
      return next
    })
  }
  function selectAllFiltered() {
    setSelectedAgIds((prev) => {
      const next = new Set(prev)
      for (const g of filteredAdgroups) next.add(g.nccAdgroupId)
      return next
    })
  }
  function clearAdgroups() {
    setSelectedAgIds(new Set())
  }

  // -- 파일 선택 / 업로드 핸들 -----------------------------------------------
  /**
   * 파일 → base64 (data: prefix 제거된 순수 base64).
   * FileReader.readAsDataURL 결과에서 콤마 이후만 사용.
   */
  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = reader.result
        if (typeof result !== "string") {
          reject(new Error("readAsDataURL result not string"))
          return
        }
        const idx = result.indexOf(",")
        resolve(idx > 0 ? result.slice(idx + 1) : result)
      }
      reader.onerror = () => reject(reader.error ?? new Error("read failed"))
      reader.readAsDataURL(file)
    })
  }

  /**
   * 개별 파일 처리:
   *   1. MIME / size 클라이언트 검증 (실패 → status='failed')
   *   2. base64 변환 후 uploadImage 병렬 호출
   *   3. 결과 → status='uploaded' (publicUrl 보유) 또는 'failed'
   */
  async function processFile(item: UploadItem): Promise<void> {
    const { id, file } = item

    // 1. 클라이언트 검증.
    if (!isAllowedMime(file.type)) {
      setUploads((prev) =>
        prev.map((u) =>
          u.id === id
            ? {
                id: u.id,
                file: u.file,
                previewUrl: u.previewUrl,
                status: "failed" as const,
                error: `허용되지 않는 형식 (${file.type || "unknown"})`,
              }
            : u,
        ),
      )
      return
    }
    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      setUploads((prev) =>
        prev.map((u) =>
          u.id === id
            ? {
                id: u.id,
                file: u.file,
                previewUrl: u.previewUrl,
                status: "failed" as const,
                error: `5MB 초과 (${(file.size / 1024 / 1024).toFixed(2)}MB)`,
              }
            : u,
        ),
      )
      return
    }

    // 2. uploading 상태로.
    setUploads((prev) =>
      prev.map((u) =>
        u.id === id
          ? {
              id: u.id,
              file: u.file,
              previewUrl: u.previewUrl,
              status: "uploading" as const,
            }
          : u,
      ),
    )

    // 3. base64 + uploadImage.
    try {
      const fileBase64 = await fileToBase64(file)
      const fileType = file.type as AllowedMime
      const res = await uploadImage(advertiserId, {
        fileBase64,
        fileType,
        originalName: file.name,
      })
      if (res.ok) {
        setUploads((prev) =>
          prev.map((u) =>
            u.id === id
              ? {
                  id: u.id,
                  file: u.file,
                  previewUrl: u.previewUrl,
                  status: "uploaded" as const,
                  storagePath: res.storagePath,
                  publicUrl: res.publicUrl,
                }
              : u,
          ),
        )
      } else {
        setUploads((prev) =>
          prev.map((u) =>
            u.id === id
              ? {
                  id: u.id,
                  file: u.file,
                  previewUrl: u.previewUrl,
                  status: "failed" as const,
                  error: res.error,
                }
              : u,
          ),
        )
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setUploads((prev) =>
        prev.map((u) =>
          u.id === id
            ? {
                id: u.id,
                file: u.file,
                previewUrl: u.previewUrl,
                status: "failed" as const,
                error: msg.slice(0, 200),
              }
            : u,
        ),
      )
    }
  }

  /**
   * 파일 추가 — 갯수 상한 적용 (MAX_IMAGES 까지만 받고 초과는 toast 경고).
   * 각 항목을 병렬로 processFile 시도.
   */
  function addFiles(files: FileList | File[]) {
    const arr = Array.from(files)
    if (arr.length === 0) return

    const remainingSlots = MAX_IMAGES - uploads.length
    if (remainingSlots <= 0) {
      toast.error(`이미지는 최대 ${MAX_IMAGES}개까지 업로드 가능`)
      return
    }
    const accepted = arr.slice(0, remainingSlots)
    if (arr.length > remainingSlots) {
      toast.warning(
        `이미지는 최대 ${MAX_IMAGES}개 — ${arr.length - remainingSlots}개는 무시됨`,
      )
    }

    const newItems: UploadItem[] = accepted.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      file,
      previewUrl: URL.createObjectURL(file),
      status: "pending" as const,
    }))

    setUploads((prev) => [...prev, ...newItems])

    // 병렬 처리. 각 processFile 은 setUploads 로 자기 항목만 갱신.
    void Promise.all(newItems.map((it) => processFile(it)))
  }

  function removeUpload(id: string) {
    setUploads((prev) => {
      const target = prev.find((u) => u.id === id)
      if (target && target.previewUrl.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(target.previewUrl)
        } catch {
          // ignore
        }
      }
      return prev.filter((u) => u.id !== id)
    })
  }

  // -- 드래그&드롭 핸들 -------------------------------------------------------
  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }
  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files)
    }
  }

  // -- 제출 -------------------------------------------------------------------
  async function handleSubmit() {
    if (!formValid) return
    setStep("submitting")
    try {
      const res = await createAdExtensionsBatch(advertiserId, {
        type: "image",
        imageUrls: uploadedItems.map((u) => u.publicUrl),
        nccAdgroupIds: Array.from(selectedAgIds),
      })
      setResult(res)
      setStep("result")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`이미지 확장소재 추가 오류: ${msg}`)
      setStep("form")
    }
  }

  // -- 닫기 -------------------------------------------------------------------
  function handleClose() {
    const didApply = step === "result"
    onOpenChange(false)
    onClosed?.(didApply)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>이미지 확장소재 추가</DialogTitle>
          <DialogDescription>
            {step === "form" &&
              "광고그룹과 이미지를 선택하세요. 광고그룹 N × 이미지 M = N×M개의 이미지 확장소재가 생성됩니다."}
            {step === "submitting" &&
              "이미지 확장소재를 추가하고 있습니다. 잠시만 기다려주세요..."}
            {step === "result" && "이미지 확장소재 추가 결과를 확인하세요."}
          </DialogDescription>
        </DialogHeader>

        {step === "form" && (
          <FormView
            adgroups={adgroups}
            filteredAdgroups={filteredAdgroups}
            selectedAgIds={selectedAgIds}
            toggleAdgroup={toggleAdgroup}
            selectAllFiltered={selectAllFiltered}
            clearAdgroups={clearAdgroups}
            agSearch={agSearch}
            setAgSearch={setAgSearch}
            uploads={uploads}
            uploadingCount={uploadingCount}
            failedCount={failedItems.length}
            imageCount={imageCount}
            overImageLimit={overImageLimit}
            adgroupCount={adgroupCount}
            totalCombinations={totalCombinations}
            overAgLimit={overAgLimit}
            isDragOver={isDragOver}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onFilesSelected={addFiles}
            onRemoveUpload={removeUpload}
          />
        )}

        {step === "submitting" && (
          <div className="flex flex-col items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2Icon className="size-6 animate-spin" />
            <span>{totalCombinations}건 추가 중...</span>
          </div>
        )}

        {step === "result" && result && <ResultView result={result} />}

        <DialogFooter>
          {step === "form" && (
            <>
              <Button variant="outline" onClick={handleClose}>
                취소
              </Button>
              <Button onClick={handleSubmit} disabled={!formValid}>
                추가하기
                {totalCombinations > 0 && ` (${totalCombinations}건)`}
              </Button>
            </>
          )}
          {step === "result" && (
            <Button onClick={handleClose}>닫고 새로고침</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// =============================================================================
// form 단계
// =============================================================================

function FormView({
  adgroups,
  filteredAdgroups,
  selectedAgIds,
  toggleAdgroup,
  selectAllFiltered,
  clearAdgroups,
  agSearch,
  setAgSearch,
  uploads,
  uploadingCount,
  failedCount,
  imageCount,
  overImageLimit,
  adgroupCount,
  totalCombinations,
  overAgLimit,
  isDragOver,
  onDragOver,
  onDragLeave,
  onDrop,
  onFilesSelected,
  onRemoveUpload,
}: {
  adgroups: ExtensionAdgroupOption[]
  filteredAdgroups: ExtensionAdgroupOption[]
  selectedAgIds: Set<string>
  toggleAdgroup: (nccAdgroupId: string, checked: boolean) => void
  selectAllFiltered: () => void
  clearAdgroups: () => void
  agSearch: string
  setAgSearch: (v: string) => void
  uploads: UploadItem[]
  uploadingCount: number
  failedCount: number
  imageCount: number
  overImageLimit: boolean
  adgroupCount: number
  totalCombinations: number
  overAgLimit: boolean
  isDragOver: boolean
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onFilesSelected: (files: FileList | File[]) => void
  onRemoveUpload: (id: string) => void
}) {
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)

  function handleClickUpload() {
    fileInputRef.current?.click()
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      onFilesSelected(e.target.files)
    }
    // 같은 파일 재선택 가능하도록 reset.
    e.target.value = ""
  }

  return (
    <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1">
      {/* 광고그룹 다중 선택 */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-end justify-between">
          <Label className="text-sm">
            대상 광고그룹 (1~{MAX_ADGROUPS}개)
          </Label>
          <span className="text-[11px] text-muted-foreground">
            {adgroupCount.toLocaleString()}개 선택됨
            {overAgLimit && (
              <span className="ml-2 font-medium text-destructive">
                {MAX_ADGROUPS}개 초과
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={agSearch}
            onChange={(e) => setAgSearch(e.target.value)}
            placeholder="광고그룹 / 캠페인 이름 검색"
            className="h-8 flex-1 rounded-md border bg-background px-2 text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={selectAllFiltered}
            disabled={filteredAdgroups.length === 0}
            title={
              filteredAdgroups.length > MAX_ADGROUPS
                ? `검색 결과 ${filteredAdgroups.length}개 — ${MAX_ADGROUPS}개 상한 초과 가능`
                : undefined
            }
          >
            검색결과 전체 선택
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={clearAdgroups}
            disabled={adgroupCount === 0}
          >
            선택 해제
          </Button>
        </div>
        <div className="max-h-40 overflow-y-auto rounded-md border bg-background">
          {adgroups.length === 0 ? (
            <div className="flex h-16 items-center justify-center text-xs text-muted-foreground">
              사용 가능한 광고그룹이 없습니다.
            </div>
          ) : filteredAdgroups.length === 0 ? (
            <div className="flex h-16 items-center justify-center text-xs text-muted-foreground">
              검색 결과 없음.
            </div>
          ) : (
            <ul className="divide-y">
              {filteredAdgroups.map((g) => {
                const checked = selectedAgIds.has(g.nccAdgroupId)
                return (
                  <li key={g.id} className="px-2 py-1.5">
                    <Label className="flex cursor-pointer items-center gap-2 font-normal">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) =>
                          toggleAdgroup(g.nccAdgroupId, !!v)
                        }
                      />
                      <div className="flex flex-1 flex-col gap-0">
                        <span className="text-sm">{g.name}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {g.campaign.name}
                        </span>
                      </div>
                    </Label>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        {adgroupCount === 0 && (
          <p className="text-[11px] text-muted-foreground">
            광고그룹을 1개 이상 선택하세요.
          </p>
        )}
      </div>

      {/* 이미지 업로드 영역 */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-end justify-between">
          <Label className="text-sm">
            이미지 (1~{MAX_IMAGES}개 / PNG·JPEG·WebP / 5MB 이하)
          </Label>
          <span className="text-[11px] text-muted-foreground">
            {imageCount.toLocaleString()}개 업로드됨
            {uploadingCount > 0 && (
              <span className="ml-2 text-amber-700 dark:text-amber-400">
                업로드 중 {uploadingCount}개
              </span>
            )}
            {failedCount > 0 && (
              <span className="ml-2 text-destructive">
                실패 {failedCount}개
              </span>
            )}
            {overImageLimit && (
              <span className="ml-2 font-medium text-destructive">
                {MAX_IMAGES}개 초과
              </span>
            )}
          </span>
        </div>

        {/* 드래그/클릭 업로드 영역 */}
        <button
          type="button"
          onClick={handleClickUpload}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={cn(
            "flex flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed bg-background py-6 text-center transition-colors",
            isDragOver
              ? "border-sky-400 bg-sky-50 dark:bg-sky-900/20"
              : "border-muted-foreground/30 hover:border-muted-foreground/60",
            uploads.length >= MAX_IMAGES && "opacity-60",
          )}
          disabled={uploads.length >= MAX_IMAGES}
        >
          <UploadCloudIcon className="size-6 text-muted-foreground" />
          <span className="text-sm">
            드래그 또는 클릭하여 업로드
          </span>
          <span className="text-[11px] text-muted-foreground">
            PNG / JPEG / WebP, 5MB 이하 — 최대 {MAX_IMAGES}개
          </span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          onChange={handleFileInputChange}
          className="hidden"
        />

        {/* 업로드된 이미지 리스트 */}
        {uploads.length > 0 && (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {uploads.map((u) => (
              <UploadItemCard
                key={u.id}
                item={u}
                onRemove={() => onRemoveUpload(u.id)}
              />
            ))}
          </ul>
        )}

        {imageCount === 0 && uploadingCount === 0 && (
          <p className="text-[11px] text-muted-foreground">
            이미지를 1개 이상 업로드하세요.
          </p>
        )}
      </div>

      {/* 미리보기 — N × M 안내 */}
      <div className="rounded-md border bg-muted/40 px-3 py-2">
        <div className="text-[11px] font-medium text-muted-foreground">
          미리보기
        </div>
        <div className="mt-0.5 text-sm">
          광고그룹 <strong>{adgroupCount}</strong>개 × 이미지{" "}
          <strong>{imageCount}</strong>개 ={" "}
          <strong className="text-foreground">{totalCombinations}</strong>개의{" "}
          이미지 확장소재가 생성됩니다.
        </div>
      </div>
    </div>
  )
}

// =============================================================================
// 업로드 항목 카드
// =============================================================================

function UploadItemCard({
  item,
  onRemove,
}: {
  item: UploadItem
  onRemove: () => void
}) {
  const sizeKb = (item.file.size / 1024).toFixed(1)
  const status = item.status

  return (
    <li
      className={cn(
        "relative flex flex-col gap-1 rounded-md border bg-background p-2",
        status === "failed" &&
          "border-destructive/40 bg-destructive/5",
        status === "uploaded" &&
          "border-emerald-300 bg-emerald-50/30 dark:border-emerald-900/40 dark:bg-emerald-900/10",
      )}
    >
      {/* 우상단 삭제 버튼 */}
      <button
        type="button"
        onClick={onRemove}
        className="absolute right-1 top-1 rounded-full bg-background/80 p-0.5 shadow hover:bg-background"
        aria-label="삭제"
        title="삭제"
      >
        <XIcon className="size-3" />
      </button>

      {/* 썸네일 */}
      <div className="relative flex aspect-square w-full items-center justify-center overflow-hidden rounded bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.previewUrl}
          alt={item.file.name}
          className="h-full w-full object-cover"
        />
        {status === "uploading" && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-sm">
            <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>

      {/* 메타 */}
      <div className="flex flex-col gap-0">
        <span className="line-clamp-1 text-[11px] font-medium" title={item.file.name}>
          {item.file.name}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {sizeKb} KB
          {status === "pending" && " • 대기 중"}
          {status === "uploading" && " • 업로드 중"}
          {status === "uploaded" && " • 완료"}
          {status === "failed" && " • 실패"}
        </span>
        {status === "failed" && (
          <span className="mt-0.5 line-clamp-2 text-[10px] text-destructive">
            {item.error}
          </span>
        )}
      </div>
    </li>
  )
}

// =============================================================================
// result 단계
// =============================================================================

function ResultView({ result }: { result: CreateAdExtensionsBatchResult }) {
  const noBatch = result.batchId === ""
  const failedItems = result.items.filter((it) => !it.ok)

  function copyBatchId() {
    if (noBatch) return
    navigator.clipboard
      .writeText(result.batchId)
      .then(() => toast.success("변경 ID 복사됨"))
      .catch(() => toast.error("복사 실패"))
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 카운트 카드 */}
      <div className="grid grid-cols-3 gap-2">
        <Stat label="요청" value={result.total} />
        <Stat label="성공" value={result.success} accent="emerald" />
        <Stat label="실패" value={result.failed} accent="destructive" />
      </div>

      {/* 실패 항목 분리 노출 */}
      {failedItems.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
          <div className="text-xs font-medium text-destructive">
            실패 항목 ({failedItems.length}개)
          </div>
          <ul className="max-h-40 overflow-y-auto text-[11px] text-destructive">
            {failedItems.slice(0, 50).map((it) => (
              <li
                key={it.index}
                className="flex items-start gap-2 border-b border-destructive/10 py-1 last:border-b-0"
              >
                <span className="font-mono text-[10px] text-destructive/70">
                  #{it.index + 1}
                </span>
                <div className="flex flex-1 flex-col gap-0">
                  <span className="line-clamp-1 break-all font-mono text-[10px]">
                    {it.imageUrl}
                  </span>
                  <span className="font-mono text-[10px] text-destructive/70">
                    nccAdgroupId: {it.ownerId}
                  </span>
                  <span className="text-destructive">
                    {it.error ?? "원인 미상"}
                  </span>
                </div>
              </li>
            ))}
            {failedItems.length > 50 && (
              <li className="py-1 text-[10px] text-destructive/70">
                ...외 {failedItems.length - 50}개 (전체는 변경 ID 로 조회)
              </li>
            )}
          </ul>
        </div>
      )}

      {/* 변경 ID 영역 */}
      {noBatch ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/10 dark:text-amber-300">
          변경 없음 — 변경 사항 없음.
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
            <span className="text-xs text-muted-foreground">
              변경 ID
            </span>
            <code className="flex-1 truncate font-mono text-xs">
              {result.batchId}
            </code>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={copyBatchId}
              title="ID 복사"
            >
              <CopyIcon />
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled
              title="롤백 화면 준비 중 (F-6.4)"
            >
              롤백 페이지로 이동
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            롤백 페이지(F-6.4)에서 본 ID 로 변경 이력을 조회할 수 있습니다.
          </p>
        </>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string
  value: number
  accent?: "emerald" | "destructive" | "amber"
}) {
  const valueClass =
    accent === "emerald"
      ? "text-emerald-700 dark:text-emerald-400"
      : accent === "destructive"
        ? "text-destructive"
        : accent === "amber"
          ? "text-amber-700 dark:text-amber-400"
          : "text-foreground"
  return (
    <div className="rounded-md border bg-background p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-0.5 font-mono text-lg font-medium ${valueClass}`}>
        {value}
      </div>
    </div>
  )
}
