import { createFileRoute, redirect } from "@tanstack/react-router";
import { recallOrFirst } from "~/lib/last-selected";
import { zoneGroupsQuery } from "~/lib/queries/zones";

export const Route = createFileRoute("/$orgSlug/zones/")({
  loader: async ({ context: { queryClient }, params: { orgSlug }, preload }) => {
    const groups = await queryClient.fetchQuery(zoneGroupsQuery());
    // Redirect only on real navigations — a redirect thrown during a hover
    // preload gets committed and auto-navigates.
    if (preload) return;
    const fallback = recallOrFirst(orgSlug, "zones", groups, (g) => g.zoneGroupId);
    if (fallback) {
      throw redirect({
        to: "/$orgSlug/zones/$zoneGroupId",
        params: { orgSlug, zoneGroupId: fallback.zoneGroupId },
      });
    }
  },
  component: ZonesEmpty,
});

function ZonesEmpty() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      No zone groups yet — create one to get started.
    </div>
  );
}
