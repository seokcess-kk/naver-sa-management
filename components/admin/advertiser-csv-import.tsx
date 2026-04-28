"use client"

/**
 * 광고주 CSV 일괄 등록 인터랙티브 컴포넌트 (F-1.2)
 *
 * 단계:
 *   step "select"  → 파일 선택 + 템플릿 다운로드
 *   step "preview" → 정상 / 오류 / 중복 분리 미리보기 + duplicatePolicy 선택
 *   step "result"  → 등록 결과 (created / skipped / failed)
 *
 * 정책:
 *   - CSV 컬럼에 시크릿 정의 X (lib/csv/advertiser.ts 가 강제)
 *   - 정상 행 미리보기는 상위 10건만 표시 (대량 시 페이지 스크롤 부하 회피)
 *   - 중복 customerId 는 마지막 행만 실제 등록 — extractFinalRows 가 추출
 *   - registerAdvertisersBulk Server Action 호출 (backend 동시 작업 가정)
 */

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  ADVERTISER_CSV_TEMPLATE,
  extractFinalRows,
  parseAdvertiserCsv,
  type CsvParseResult,
  type ParsedAdvertiserRow,
} from "@/lib/csv/advertiser"
import {
  registerAdvertisersBulk,
  type BulkRegisterResult,
} from "@/app/admin/advertisers/actions"

type DuplicatePolicy = "skip" | "error"

type Step = "select" | "preview" | "result"

// =============================================================================
// 컴포넌트
// =============================================================================

export function AdvertiserCsvImport() {
  const router = useRouter()
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const [step, setStep] = React.useState<Step>("select")
  const [fileName, setFileName] = React.useState<string | null>(null)
  const [parsing, setParsing] = React.useState(false)
  const [parsed, setParsed] = React.useState<CsvParseResult | null>(null)
  const [duplicatePolicy, setDuplicatePolicy] =
    React.useState<DuplicatePolicy>("skip")
  const [submitting, setSubmitting] = React.useState(false)
  const [result, setResult] = React.useState<BulkRegisterResult | null>(null)

  function reset() {
    setStep("select")
    setFileName(null)
    setParsed(null)
    setResult(null)
    setSubmitting(false)
    setParsing(false)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    setParsing(true)
    try {
      const result = await parseAdvertiserCsv(file)
      setParsed(result)
      setStep("preview")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`파싱 실패: ${msg}`)
    } finally {
      setParsing(false)
    }
  }

  function downloadTemplate() {
    const blob = new Blob([ADVERTISER_CSV_TEMPLATE], {
      type: "text/csv;charset=utf-8;",
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "advertisers-template.csv"
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  async function handleConfirm() {
    if (!parsed) return
    const finalRows = extractFinalRows(parsed)
    if (finalRows.length === 0) {
      toast.error("등록할 정상 행이 없습니다.")
      return
    }
    setSubmitting(true)
    try {
      const res = await registerAdvertisersBulk({
        rows: finalRows,
        duplicatePolicy,
      })
      setResult(res)
      setStep("result")
      // 목록 캐시 무효화
      router.refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`등록 실패: ${msg}`)
    } finally {
      setSubmitting(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Step: select (파일 선택)
  // ---------------------------------------------------------------------------

  if (step === "select") {
    return (
      <Card>
        <CardHeader className="border-b">
          <CardTitle>1. 파일 업로드</CardTitle>
          <CardDescription>
            CSV 파일을 선택하면 자동으로 파싱·검증 후 미리보기로 이동합니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 py-4">
          <div className="flex items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleFileChange}
              disabled={parsing}
              className="block w-full max-w-md text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-foreground hover:file:bg-primary/80 disabled:opacity-50"
            />
            <Button
              type="button"
              variant="outline"
              onClick={downloadTemplate}
              disabled={parsing}
            >
              CSV 템플릿 다운로드
            </Button>
          </div>
          {parsing && (
            <p className="text-sm text-muted-foreground">파싱 중...</p>
          )}
          {fileName && !parsing && (
            <p className="text-xs text-muted-foreground">선택: {fileName}</p>
          )}
        </CardContent>
      </Card>
    )
  }

  // ---------------------------------------------------------------------------
  // Step: preview (검증 결과 미리보기)
  // ---------------------------------------------------------------------------

  if (step === "preview" && parsed) {
    // 파일 수준 오류
    if (parsed.fileError) {
      return (
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="text-destructive">2. 파일 오류</CardTitle>
            <CardDescription>{parsed.fileError}</CardDescription>
          </CardHeader>
          <CardFooter className="justify-end">
            <Button variant="outline" onClick={reset}>
              다시 업로드
            </Button>
          </CardFooter>
        </Card>
      )
    }

    const validRows = parsed.rows.filter(
      (r): r is Extract<ParsedAdvertiserRow, { ok: true }> => r.ok,
    )
    const invalidRows = parsed.rows.filter(
      (r): r is Extract<ParsedAdvertiserRow, { ok: false }> => !r.ok,
    )
    const finalRows = extractFinalRows(parsed)
    const previewRows = validRows.slice(0, 10)
    const hasErrors = invalidRows.length > 0
    const hasDuplicates = parsed.duplicates.length > 0

    return (
      <Card>
        <CardHeader className="border-b">
          <CardTitle>2. 검증 결과 · 미리보기</CardTitle>
          <CardDescription>
            정상 <strong>{validRows.length}</strong>건 · 오류{" "}
            <strong className={hasErrors ? "text-destructive" : ""}>
              {invalidRows.length}
            </strong>
            건 · 중복 customerId{" "}
            <strong className={hasDuplicates ? "text-amber-600" : ""}>
              {parsed.duplicates.length}
            </strong>
            건. 실제 등록 대상 <strong>{finalRows.length}</strong>건.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6 py-4">
          {/* 오류 행 표 */}
          {hasErrors && (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium text-destructive">
                오류 행 ({invalidRows.length}건) — 등록에서 제외됩니다
              </h3>
              <div className="rounded-md border border-destructive/30">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="px-3 w-20">CSV 행</TableHead>
                      <TableHead>customerId</TableHead>
                      <TableHead>name</TableHead>
                      <TableHead>오류 메시지</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invalidRows.slice(0, 50).map((r) => (
                      <TableRow key={`err-${r.row}`}>
                        <TableCell className="px-3 font-mono text-xs">
                          {r.row}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {r.raw.customerId || "-"}
                        </TableCell>
                        <TableCell className="text-xs">
                          {r.raw.name || "-"}
                        </TableCell>
                        <TableCell className="text-xs text-destructive">
                          {r.error}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {invalidRows.length > 50 && (
                  <p className="px-3 py-2 text-xs text-muted-foreground">
                    ...외 {invalidRows.length - 50}건 더
                  </p>
                )}
              </div>
            </section>
          )}

          {/* 중복 customerId 표 */}
          {hasDuplicates && (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium text-amber-700 dark:text-amber-400">
                중복 customerId ({parsed.duplicates.length}건) — 마지막 행만
                적용됩니다
              </h3>
              <div className="rounded-md border border-amber-300/60">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="px-3">customerId</TableHead>
                      <TableHead>등장한 CSV 행</TableHead>
                      <TableHead>적용되는 행</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {parsed.duplicates.map((d) => (
                      <TableRow key={`dup-${d.customerId}`}>
                        <TableCell className="px-3 font-mono text-xs">
                          {d.customerId}
                        </TableCell>
                        <TableCell className="text-xs">
                          {d.rowNumbers.join(", ")}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {d.rowNumbers[d.rowNumbers.length - 1]}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          )}

          {/* 정상 행 미리보기 */}
          {validRows.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">
                정상 행 미리보기 (상위 {previewRows.length}건 / 총{" "}
                {validRows.length}건)
              </h3>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="px-3 w-16">행</TableHead>
                      <TableHead>name</TableHead>
                      <TableHead>customerId</TableHead>
                      <TableHead>category</TableHead>
                      <TableHead>manager</TableHead>
                      <TableHead>tags</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewRows.map((r) => (
                      <TableRow key={`ok-${r.row}`}>
                        <TableCell className="px-3 font-mono text-xs">
                          {r.row}
                        </TableCell>
                        <TableCell className="text-sm font-medium">
                          {r.data.name}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {r.data.customerId}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {r.data.category ?? "-"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {r.data.manager ?? "-"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {r.data.tags?.join(", ") ?? "-"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          )}

          {/* duplicatePolicy 옵션 */}
          {finalRows.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">
                이미 DB에 등록된 customerId 처리
              </h3>
              <div className="flex items-center gap-3">
                <Select
                  value={duplicatePolicy}
                  onValueChange={(v) =>
                    setDuplicatePolicy(v as DuplicatePolicy)
                  }
                >
                  <SelectTrigger className="w-64">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="skip">건너뛰기 (skip)</SelectItem>
                    <SelectItem value="error">오류로 처리 (error)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  CSV 안의 중복은 항상 마지막 행만 적용. 본 옵션은 DB에 이미
                  존재하는 customerId 처리 방식입니다.
                </p>
              </div>
            </section>
          )}
        </CardContent>
        <CardFooter className="justify-between">
          <div className="text-xs text-muted-foreground">
            {hasErrors && "오류 행은 자동으로 제외됩니다."}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={reset} disabled={submitting}>
              취소 / 다시 업로드
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={submitting || finalRows.length === 0}
            >
              {submitting
                ? "등록 중..."
                : `${finalRows.length}건 등록 진행`}
            </Button>
          </div>
        </CardFooter>
      </Card>
    )
  }

  // ---------------------------------------------------------------------------
  // Step: result (등록 결과)
  // ---------------------------------------------------------------------------

  if (step === "result" && result) {
    return (
      <Card>
        <CardHeader className="border-b">
          <CardTitle>3. 등록 결과</CardTitle>
          <CardDescription>
            생성 <strong className="text-emerald-600">{result.created}</strong>건
            · 스킵 <strong>{result.skipped}</strong>건 · 실패{" "}
            <strong
              className={result.failed > 0 ? "text-destructive" : ""}
            >
              {result.failed}
            </strong>
            건
          </CardDescription>
        </CardHeader>
        <CardContent className="py-4">
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-3 w-16">CSV 행</TableHead>
                  <TableHead>customerId</TableHead>
                  <TableHead>결과</TableHead>
                  <TableHead>비고</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.map((r) => (
                  <TableRow key={`res-${r.row}-${r.ok ? r.id : "err"}`}>
                    <TableCell className="px-3 font-mono text-xs">
                      {r.row}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {r.ok ? r.customerId : (r.customerId ?? "-")}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.ok ? (
                        <ResultBadge action={r.action} />
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                          실패
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {r.ok ? (
                        r.action === "created" ? (
                          <Link
                            href={`/admin/advertisers/${r.id}`}
                            className="underline hover:text-foreground"
                          >
                            상세 (시크릿 입력) →
                          </Link>
                        ) : (
                          "DB에 이미 존재"
                        )
                      ) : (
                        <span className="text-destructive">{r.error}</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
            새로 생성된 광고주는 키 미설정 상태입니다. 광고주 목록 또는 위 상세
            링크에서 API 키 / Secret 키를 입력해야 SA API 호출이 활성화됩니다.
          </p>
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <Button variant="outline" onClick={reset}>
            또 업로드
          </Button>
          <Button render={<Link href="/admin/advertisers" />}>
            광고주 목록으로
          </Button>
        </CardFooter>
      </Card>
    )
  }

  return null
}

// =============================================================================
// 결과 행 배지
// =============================================================================

function ResultBadge({ action }: { action: "created" | "skipped" }) {
  if (action === "created") {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
        생성
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
      스킵
    </span>
  )
}
