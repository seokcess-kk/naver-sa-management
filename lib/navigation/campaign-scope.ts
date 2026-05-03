type SearchParamValue = string | string[] | undefined

export type CampaignScopeSearchParams = Record<string, SearchParamValue>

const CAMPAIGN_IDS_PARAM = "campaignIds"
const ADGROUP_IDS_PARAM = "adgroupIds"

function parseScopeIds(
  searchParams: CampaignScopeSearchParams | undefined,
  key: string,
): string[] {
  const raw = searchParams?.[key]
  const values = Array.isArray(raw) ? raw : raw ? [raw] : []
  const ids = values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean)

  return Array.from(new Set(ids))
}

export function parseCampaignScopeIds(
  searchParams: CampaignScopeSearchParams | undefined,
): string[] {
  return parseScopeIds(searchParams, CAMPAIGN_IDS_PARAM)
}

export function parseAdgroupScopeIds(
  searchParams: CampaignScopeSearchParams | undefined,
): string[] {
  return parseScopeIds(searchParams, ADGROUP_IDS_PARAM)
}

export function getCampaignScopedHref(
  href: string,
  campaignIds: readonly string[],
): string {
  return getScopedHref(href, { campaignIds })
}

export function getScopedHref(
  href: string,
  scope: {
    campaignIds?: readonly string[]
    adgroupIds?: readonly string[]
  },
): string {
  const campaignIds = scope.campaignIds ?? []
  const adgroupIds = scope.adgroupIds ?? []
  if (campaignIds.length === 0 && adgroupIds.length === 0) return href

  const params = new URLSearchParams()
  if (campaignIds.length > 0) {
    params.set(CAMPAIGN_IDS_PARAM, campaignIds.join(","))
  }
  if (adgroupIds.length > 0) {
    params.set(ADGROUP_IDS_PARAM, adgroupIds.join(","))
  }
  return `${href}?${params.toString()}`
}
