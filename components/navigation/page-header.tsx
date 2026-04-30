import Link from "next/link"
import type { ReactNode } from "react"
import { ArrowLeft, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type PageBreadcrumb = {
  label: string
  href?: string
}

type PageHeaderProps = {
  title: string
  description?: ReactNode
  breadcrumbs?: PageBreadcrumb[]
  backHref?: string
  backLabel?: string
  actions?: ReactNode
  className?: string
}

export function PageHeader({
  title,
  description,
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
          <h1 className="font-heading text-xl font-medium leading-snug">
            {title}
          </h1>
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
