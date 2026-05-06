import Link from "next/link"
import type { ReactNode } from "react"
import { ArrowLeft, ChevronRight, HelpCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type PageBreadcrumb = {
  label: string
  href?: string
}

type PageHeaderProps = {
  title: string
  /**
   * 페이지 진입 시 항상 보이는 1줄 상태 문구. 매뉴얼성 안내는 helpText 로 분리.
   * 비어 있으면 헤더가 더 조용해짐 — 운영자 일상 화면에 권장.
   */
  description?: ReactNode
  /**
   * "이 페이지로 무엇을 할 수 있는가" 같은 신규 사용자용 안내.
   * title 옆 ? 버튼을 누르면 펼쳐짐(native <details>). 숙련 사용자 시야엔 안 들어옴.
   */
  helpText?: ReactNode
  breadcrumbs?: PageBreadcrumb[]
  backHref?: string
  backLabel?: string
  actions?: ReactNode
  className?: string
}

export function PageHeader({
  title,
  description,
  helpText,
  breadcrumbs = [],
  backHref,
  backLabel = "뒤로가기",
  actions,
  className,
}: PageHeaderProps) {
  const showCrumbs = breadcrumbs.length > 0 || backHref

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {showCrumbs ? (
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {backHref ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
              render={<Link href={backHref} />}
            >
              <ArrowLeft className="size-3.5" />
              {backLabel}
            </Button>
          ) : null}
          {breadcrumbs.map((crumb, index) => {
            const content = crumb.href ? (
              <Link
                href={crumb.href}
                className="rounded px-1 py-0.5 hover:text-foreground hover:underline"
              >
                {crumb.label}
              </Link>
            ) : (
              <span className="px-1 py-0.5 font-medium text-foreground">
                {crumb.label}
              </span>
            )

            return (
              <div key={`${crumb.label}-${index}`} className="flex items-center">
                {index > 0 || backHref ? (
                  <ChevronRight className="mx-1 size-3 shrink-0 text-muted-foreground/70" />
                ) : null}
                {content}
              </div>
            )
          })}
        </div>
      ) : null}

      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h1 className="font-heading text-xl font-medium leading-snug">
              {title}
            </h1>
            {helpText ? (
              <details className="group inline-block">
                <summary
                  className={cn(
                    "list-none cursor-pointer rounded-md p-1 text-muted-foreground transition",
                    "hover:bg-muted hover:text-foreground",
                    "[&::-webkit-details-marker]:hidden",
                  )}
                  aria-label="페이지 도움말"
                  title="페이지 도움말"
                >
                  <HelpCircle className="size-4" />
                </summary>
                <div className="absolute z-10 mt-1 max-w-md rounded-md border bg-popover p-3 text-sm text-muted-foreground shadow-md">
                  {helpText}
                </div>
              </details>
            ) : null}
          </div>
          {description ? (
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </div>
  )
}
