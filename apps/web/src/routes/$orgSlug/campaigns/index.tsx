import { createFileRoute, redirect } from "@tanstack/react-router";
import { recallOrFirst } from "~/lib/last-selected";
import { campaignsListQuery } from "~/lib/queries/campaigns";

export const Route = createFileRoute("/$orgSlug/campaigns/")({
  loader: async ({ context: { queryClient }, params: { orgSlug }, preload }) => {
    const campaigns = await queryClient.fetchQuery(campaignsListQuery());
    // Redirect only on real navigations — a redirect thrown during a hover
    // preload gets committed and auto-navigates.
    if (preload) return;
    // Archived campaigns stay reachable from the rail but never win the
    // index redirect.
    const active = campaigns.filter((c) => !c.isArchived);
    const fallback = recallOrFirst(orgSlug, "campaigns", active, (c) => c.campaignId);
    if (fallback) {
      throw redirect({
        to: "/$orgSlug/campaigns/$campaignId",
        params: { orgSlug, campaignId: fallback.campaignId },
      });
    }
  },
  component: CampaignsEmpty,
});

function CampaignsEmpty() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      No active campaigns yet, create one to get started.
    </div>
  );
}
