"use client"

/**
 * 광고주 삭제 버튼 (확인 dialog)
 *
 * - 단건 삭제도 admin + 2차 확인 (CLAUDE.md 안전장치 6)
 * - server action `deleteAdvertiser(id)` 호출 (soft delete: status='archived')
 * - 성공 시 목록으로 redirect
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { deleteAdvertiser } from "@/app/admin/advertisers/actions"

export function DeleteAdvertiserButton({
  id,
  name,
}: {
  id: string
  name: string
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [confirmText, setConfirmText] = React.useState("")

  async function handleDelete() {
    setPending(true)
    try {
      await deleteAdvertiser(id)
      toast.success("광고주가 삭제되었습니다.")
      setOpen(false)
      router.push("/admin/advertisers")
      router.refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`삭제 실패: ${msg}`)
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="destructive">삭제</Button>} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>광고주 삭제</DialogTitle>
          <DialogDescription>
            <strong>{name}</strong> 광고주를 아카이브합니다.
            연결된 캠페인 동기화가 중단되며, 관련 변경 이력 / 감사 로그는 보존됩니다.
            <br />
            계속하려면 표시명 <code className="font-mono">{name}</code> 을(를)
            아래에 입력하세요.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={name}
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            autoComplete="off"
          />
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            취소
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={pending || confirmText !== name}
          >
            {pending ? "삭제 중..." : "삭제 확정"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
