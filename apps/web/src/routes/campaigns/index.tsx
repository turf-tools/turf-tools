import { createFileRoute, redirect } from "@tanstack/react-router";
import { campaignsListQuery } from "~/lib/queries/campaigns";

export const Route = createFileRoute("/campaigns/")({
  loader: async ({ context: { queryClient } }) => {
    const campaigns = await queryClient.fetchQuery(campaignsListQuery());
    // Alphabetically first is the default — matches the list-column order.
    const fallback = [...campaigns].sort((a, b) => a.name.localeCompare(b.name))[0];
    if (fallback) {
      throw redirect({
        to: "/campaigns/$campaignId",
        params: { campaignId: fallback.campaignId },
      });
    }
  },
  component: CampaignsEmpty,
});

function CampaignsEmpty() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      No campaigns yet — create one to get started.
    </div>
  );
}
