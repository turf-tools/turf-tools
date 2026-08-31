import { Icon } from "~/components/icon";

type CampaignRow = {
  campaignId: string;
  name: string;
  createdAt: string | Date;
  isArchived: boolean;
};

// Campaign dropdown options for the reporting pages: active campaigns
// first, archived after with a muted marker — reporting keeps history
// reachable, unlike operational pickers which drop archived entirely.
export function campaignFilterOptions(campaigns: ReadonlyArray<CampaignRow>) {
  return [...campaigns.filter((c) => !c.isArchived), ...campaigns.filter((c) => c.isArchived)].map(
    (c) => ({
      value: c.campaignId,
      label: c.name,
      icon: c.isArchived ? (
        <Icon name="archive" className="text-muted-foreground size-3.5 shrink-0" />
      ) : undefined,
    }),
  );
}

// Resolve a campaign search param to a concrete scope: "all" and null
// both mean all campaigns, but null floats to the default so new
// campaigns take over without being pinned in the URL.
export function scopedCampaignId(
  param: string | null,
  campaigns: ReadonlyArray<Omit<CampaignRow, "name">>,
): string | null {
  return param === "all" ? null : (param ?? defaultCampaignId(campaigns));
}

// Newest-created active campaign, falling back to newest archived — the
// default scope for pages that always show exactly one campaign.
export function defaultCampaignId(
  campaigns: ReadonlyArray<Omit<CampaignRow, "name">>,
): string | null {
  const newestFirst = [...campaigns].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  return (newestFirst.find((c) => !c.isArchived) ?? newestFirst[0])?.campaignId ?? null;
}
