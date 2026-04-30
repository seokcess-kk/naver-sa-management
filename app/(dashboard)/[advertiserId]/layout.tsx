import { redirect, notFound } from "next/navigation"

import {
  getCurrentAdvertiser,
  AdvertiserNotFoundError,
  AuthorizationError,
  UnauthenticatedError,
} from "@/lib/auth/access"
import { DashboardSectionNav } from "@/components/navigation/dashboard-section-nav"

export default async function AdvertiserLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ advertiserId: string }>
}) {
  const { advertiserId } = await params

  let advertiser
  try {
    const ctx = await getCurrentAdvertiser(advertiserId)
    advertiser = ctx.advertiser
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      redirect("/login")
    }
    if (e instanceof AdvertiserNotFoundError) {
      notFound()
    }
    if (e instanceof AuthorizationError) {
      notFound()
    }
    throw e
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DashboardSectionNav
        advertiser={{
          id: advertiser.id,
          name: advertiser.name,
          customerId: advertiser.customerId,
          hasKeys: advertiser.hasKeys,
          status: advertiser.status,
        }}
      />
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  )
}
