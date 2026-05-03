type SearchParamValue = string | string[] | undefined

export type CampaignScopeSearchParams = Record<string, SearchParamValue>

const CAMPAIGN_IDS_PARAM = "campaignIds"

export function parseCampaignScopeIds(
  searchParams: CampaignScopeSearchParams | undefined,
): string[] {
  const raw = searchParams?.[CAMPAIGN_IDS_PARAM]
  const values = Array.isArray(raw) ? raw : raw ? [raw] : []
  const ids = values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean)

  return Array.from(new Set(ids))
}

export function getCampaignScopedHref(
  href: string,
  campaignIds: readonly string[],
): string {
  if (campaignIds.length === 0) return href

  const params = new URLSearchParams()
  params.set(CAMPAIGN_IDS_PARAM, campaignIds.join(","))
  return `${href}?${params.toString()}`
}
