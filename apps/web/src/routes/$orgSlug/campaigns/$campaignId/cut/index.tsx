import { createFileRoute } from "@tanstack/react-router";
import { campaignDetailQuery } from "~/lib/queries/campaigns";
import { segmentDetailQuery } from "~/lib/queries/segments";
import { turfDraftsQuery } from "~/lib/queries/turf-drafts";
import { Cutter } from "./$zoneId";

// Zoneless cutter route — campaign has no zone group, so the cutter
// operates against the full segment. The Cutter component is shared
// with `./$zoneId.tsx`; this file is just the route wrapper.
export const Route = createFileRoute("/$orgSlug/campaigns/$campaignId/cut/")({
  loader: async ({ context: { queryClient }, params: { campaignId } }) => {
    const [campaign] = await Promise.all([
      queryClient.fetchQuery(campaignDetailQuery(campaignId)),
      queryClient.fetchQuery(turfDraftsQuery(campaignId, null)),
    ]);
    if (campaign.segmentId) {
      await queryClient.fetchQuery(segmentDetailQuery(campaign.segmentId));
    }
  },
  component: CutterPage,
});

function CutterPage() {
  const { orgSlug, campaignId } = Route.useParams();
  // Key includes campaignId so navigating between zoneless campaigns
  // remounts the Cutter; the zoned route gets this for free via `zoneId`.
  return (
    <Cutter key={`${campaignId}-full`} orgSlug={orgSlug} campaignId={campaignId} zoneId={null} />
  );
}
