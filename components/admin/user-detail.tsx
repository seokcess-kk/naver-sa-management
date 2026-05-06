"use client"

/**
 * 사용자 상세 — 3섹션 카드 (F-1.6 UI)
 *
 * 4-A. 기본 정보
 *   - displayName / id / createdAt / 현재 role / 현재 status
 *   - 역할 / 상태 Select 변경 → ActionResult 분기 (ok/error toast)
 *   - 실패 시 select 원복 (낙관적 갱신 방지: 서버 응답 후에만 commit)
 *
 * 4-B. 광고주 화이트리스트
 *   - 부여된 목록 표 (advertiserName / customerId / grantedAt / grantor / [회수])
 *   - "광고주 추가" 모달 → 미부여 + status≠archived 광고주만 Select 후보
 *   - 회수 버튼 → confirm dialog (회수합니다) → revokeAdvertiserAccess
 *
 * 4-C. 메타
 *   - 안내성 카드. AuditLog 페이지 안내.
 *
 * 안전장치:
 *   - role/status 변경은 본인 admin → 비-admin / 본인 active → disabled 케이스를
 *     **클라이언트에서 사전 차단 X** — backend 가 "마지막 admin / 본인 disabled"
 *     케이스를 ActionResult.ok=false 로 반환. 일관성 위해 toast.error + 원복.
 *   - admin role 사용자에게도 화이트리스트 부여 가능 (UI 막지 않음). 강등 대비.
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
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
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
  grantAdvertiserAccess,
  revokeAdvertiserAccess,
  updateUserRole,
  updateUserStatus,
  type UserDetail,
} from "@/app/admin/users/actions"
import type {
  AdvertiserStatus,
  UserRole,
  UserStatus,
} from "@/lib/generated/prisma/client"

// =============================================================================
// 헬퍼
// =============================================================================

function formatDate(iso: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso))
}

type AdvertiserOption = {
  id: string
  name: string
  customerId: string
  status: AdvertiserStatus
}

// =============================================================================
// 메인
// =============================================================================

export function UserDetailView({
  user,
  meId,
  advertisers,
}: {
  user: UserDetail
  meId: string
  advertisers: AdvertiserOption[]
}) {
  // BasicInfoCard 는 user.role / user.status 를 useState 초기값으로 고정.
  // 서버 변경 후 router.refresh() → 새 user prop 이 내려오면, key 변경으로
  // BasicInfoCard 를 remount 시켜 내부 state 를 자연스럽게 재초기화.
  // (useEffect 동기화 패턴 회피 — react-hooks/set-state-in-effect lint 룰 충족)
  const basicKey = `${user.role}-${user.status}`
  return (
    <div className="flex flex-col gap-6">
      <BasicInfoCard key={basicKey} user={user} meId={meId} />
      <AdvertiserAccessCard user={user} advertisers={advertisers} />
      <MetaCard />
    </div>
  )
}

// =============================================================================
// 4-A. 기본 정보 카드
// =============================================================================

function BasicInfoCard({ user, meId }: { user: UserDetail; meId: string }) {
  const router = useRouter()

  // Select 의 controlled value. 서버 응답 ok 후에만 commit, 실패 시 직전 값으로 원복.
  // 초기값은 user.role / user.status (서버가 RSC 로 직렬화한 진실)
  const [role, setRole] = React.useState<UserRole>(user.role)
  const [status, setStatus] = React.useState<UserStatus>(user.status)
  const [rolePending, setRolePending] = React.useState(false)
  const [statusPending, setStatusPending] = React.useState(false)
  // 부모가 (user.role, user.status) 변경 시 key 로 본 컴포넌트를 remount.
  // 따라서 useEffect 로 prop → state 동기화하지 않는다.

  async function handleRoleChange(next: string | null) {
    if (next === null) return // Select 가 null 을 보내는 경우는 무시 (값 유지)
    const nextRole = next as UserRole
    if (nextRole === role) return
    const prev = role
    setRole(nextRole) // 낙관적 표시 (실패 시 원복)
    setRolePending(true)
    try {
      const res = await updateUserRole({ userId: user.id, role: nextRole })
      if (!res.ok) {
        toast.error(res.error)
        setRole(prev) // 원복
        return
      }
      toast.success(`역할을 ${nextRole} 로 변경했습니다`)
      router.refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`역할 변경 오류: ${msg}`)
      setRole(prev)
    } finally {
      setRolePending(false)
    }
  }

  async function handleStatusChange(next: string | null) {
    if (next === null) return
    const nextStatus = next as UserStatus
    if (nextStatus === status) return
    const prev = status
    setStatus(nextStatus)
    setStatusPending(true)
    try {
      const res = await updateUserStatus({
        userId: user.id,
        status: nextStatus,
      })
      if (!res.ok) {
        toast.error(res.error)
        setStatus(prev)
        return
      }
      toast.success(
        nextStatus === "active"
          ? "사용자를 활성화했습니다"
          : "사용자를 비활성화했습니다",
      )
      router.refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`상태 변경 오류: ${msg}`)
      setStatus(prev)
    } finally {
      setStatusPending(false)
    }
  }

  const isSelf = user.id === meId

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>기본 정보</CardTitle>
        <CardDescription>
          역할과 상태를 변경할 수 있습니다. 본인은 admin 강등 / 비활성화 시
          서버에서 안전 검사를 거칩니다 — 마지막 admin 이거나 본인 비활성화는 거부됩니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 py-4 sm:grid-cols-2">
        <Field label="표시명">
          <span className="text-sm">{user.displayName}</span>
        </Field>
        <Field label="ID">
          <span className="font-mono text-xs text-muted-foreground">
            {user.id}
          </span>
        </Field>
        <Field label="등록일">
          <span className="text-sm">{formatDate(user.createdAt)}</span>
        </Field>
        <Field label="본인 여부">
          <span className="text-sm">{isSelf ? "예" : "아니오"}</span>
        </Field>

        <Field label="역할 (role)">
          <Select
            value={role}
            onValueChange={handleRoleChange}
            disabled={rolePending}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="admin">관리자 (admin)</SelectItem>
              <SelectItem value="operator">운영자 (operator)</SelectItem>
              <SelectItem value="viewer">뷰어 (viewer)</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Field label="상태 (status)">
          <Select
            value={status}
            onValueChange={handleStatusChange}
            disabled={statusPending}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">활성</SelectItem>
              <SelectItem value="disabled">비활성</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </CardContent>
    </Card>
  )
}

// =============================================================================
// 4-B. 광고주 화이트리스트 카드
// =============================================================================

function AdvertiserAccessCard({
  user,
  advertisers,
}: {
  user: UserDetail
  advertisers: AdvertiserOption[]
}) {
  const grantedIds = new Set(user.advertiserAccess.map((a) => a.advertiserId))
  // 부여 가능한 광고주: 전체(아카이브 제외) - 이미 부여된 것
  const grantable = advertisers.filter((a) => !grantedIds.has(a.id))

  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>광고주 화이트리스트</CardTitle>
            <CardDescription>
              {user.role === "admin" ? (
                <>
                  admin 사용자는 화이트리스트와 무관하게 모든 광고주에 접근합니다.
                  단, 향후 operator 로 강등될 경우를 대비해 미리 부여할 수 있습니다.
                </>
              ) : (
                <>
                  operator / viewer 가 접근 가능한 광고주를 명시적으로 부여합니다.
                  부여되지 않은 광고주는 GNB 셀렉터에 표시되지 않습니다.
                </>
              )}
            </CardDescription>
          </div>
          <GrantAccessModal
            userId={user.id}
            displayName={user.displayName}
            grantable={grantable}
          />
        </div>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-4">광고주</TableHead>
              <TableHead>customerId</TableHead>
              <TableHead>부여일</TableHead>
              <TableHead>부여자</TableHead>
              <TableHead className="px-4 text-right">액션</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {user.advertiserAccess.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="px-4 py-8 text-center text-sm text-muted-foreground"
                >
                  부여된 광고주가 없습니다. 우측 상단 “광고주 추가” 버튼으로 부여하세요.
                </TableCell>
              </TableRow>
            ) : (
              user.advertiserAccess.map((a) => (
                <TableRow key={a.advertiserId}>
                  <TableCell className="px-4 font-medium">
                    {a.advertiserName}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {a.customerId}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(a.grantedAt)}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {a.grantorDisplayName ?? "-"}
                  </TableCell>
                  <TableCell className="px-4">
                    <div className="flex items-center justify-end">
                      <RevokeAccessButton
                        userId={user.id}
                        advertiserId={a.advertiserId}
                        advertiserName={a.advertiserName}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

// =============================================================================
// 광고주 부여 모달
// =============================================================================

function GrantAccessModal({
  userId,
  displayName,
  grantable,
}: {
  userId: string
  displayName: string
  grantable: AdvertiserOption[]
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [selected, setSelected] = React.useState<string>("")
  const [pending, setPending] = React.useState(false)

  // 모달 열림/닫힘 시 selected 초기화는 onOpenChange 콜백에서 처리
  // (useEffect 내 setState 안티패턴 회피).
  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) setSelected("")
  }

  async function handleGrant() {
    if (!selected) {
      toast.error("부여할 광고주를 선택하세요")
      return
    }
    setPending(true)
    try {
      const res = await grantAdvertiserAccess({
        userId,
        advertiserId: selected,
      })
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      const target = grantable.find((a) => a.id === selected)
      toast.success(
        `${displayName} 에게 ${target?.name ?? "광고주"} 권한을 부여했습니다`,
      )
      handleOpenChange(false)
      router.refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`부여 오류: ${msg}`)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={<Button disabled={grantable.length === 0}>광고주 추가</Button>}
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>광고주 부여</DialogTitle>
          <DialogDescription>
            <strong>{displayName}</strong> 에게 부여할 광고주를 선택하세요.
            {grantable.length === 0 ? (
              <span className="mt-2 block text-amber-700 dark:text-amber-400">
                부여 가능한 광고주가 없습니다 — 모든 광고주가 이미 부여되었거나
                등록되지 않았습니다.
              </span>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {grantable.length > 0 ? (
          <div className="flex flex-col gap-2">
            <Label>광고주</Label>
            <Select
              value={selected}
              onValueChange={(v) => setSelected(v ?? "")}
            >
              <SelectTrigger>
                <SelectValue placeholder="광고주 선택">
                  {(v: string | null) => {
                    if (!v) return "광고주 선택"
                    const a = grantable.find((x) => x.id === v)
                    return a ? `${a.name} (${a.customerId})` : v
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {grantable.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}{" "}
                    <span className="text-muted-foreground">
                      ({a.customerId})
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={pending}
          >
            취소
          </Button>
          <Button
            onClick={handleGrant}
            disabled={pending || !selected || grantable.length === 0}
          >
            {pending ? "부여 중..." : "부여"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// =============================================================================
// 광고주 회수 버튼 (확인 dialog)
// =============================================================================

function RevokeAccessButton({
  userId,
  advertiserId,
  advertiserName,
}: {
  userId: string
  advertiserId: string
  advertiserName: string
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [pending, setPending] = React.useState(false)

  async function handleRevoke() {
    setPending(true)
    try {
      const res = await revokeAdvertiserAccess({ userId, advertiserId })
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success(`${advertiserName} 권한을 회수했습니다`)
      setOpen(false)
      router.refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`회수 오류: ${msg}`)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            회수
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>광고주 권한 회수</DialogTitle>
          <DialogDescription>
            <strong>{advertiserName}</strong> 에 대한 권한을 회수합니다. 회수 후
            해당 사용자는 GNB 셀렉터에서 이 광고주를 볼 수 없습니다.
          </DialogDescription>
        </DialogHeader>
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
            onClick={handleRevoke}
            disabled={pending}
          >
            {pending ? "회수 중..." : "회수"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// =============================================================================
// 4-C. 메타 카드
// =============================================================================

function MetaCard() {
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>참고</CardTitle>
        <CardDescription>
          사용자 직접 생성·삭제는 본 화면에서 지원하지 않습니다 — Supabase Auth
          가 회원가입을 담당합니다. 비밀번호 변경 역시 Supabase Auth 흐름이며,
          모든 권한 변경 / 광고주 부여·회수는{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            AuditLog
          </code>{" "}
          에 before / after 로 기록됩니다 (감사 로그 페이지에서 확인).
        </CardDescription>
      </CardHeader>
    </Card>
  )
}

// =============================================================================
// Field 헬퍼
// =============================================================================

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div>{children}</div>
    </div>
  )
}
