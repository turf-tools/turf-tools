import { createFileRoute, redirect } from "@tanstack/react-router";
import { zoneGroupsQuery } from "~/lib/queries/zones";

export const Route = createFileRoute("/$orgSlug/zones/")({
  loader: async ({ context: { queryClient }, params: { orgSlug }, preload }) => {
    const groups = await queryClient.fetchQuery(zoneGroupsQuery());
    // Redirect only on real navigations — a redirect thrown during a hover
    // preload gets committed and auto-navigates.
    if (preload) return;
    // Alphabetically first is the default — matches the list-column order.
    const fallback = [...groups].sort((a, b) => a.name.localeCompare(b.name))[0];
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
