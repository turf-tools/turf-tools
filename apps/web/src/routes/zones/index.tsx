import { createFileRoute, redirect } from "@tanstack/react-router";
import { zoneGroupsQuery } from "~/lib/queries/zones";

export const Route = createFileRoute("/zones/")({
  loader: async ({ context: { queryClient } }) => {
    const groups = await queryClient.fetchQuery(zoneGroupsQuery());
    // Alphabetically first is the default — matches the list-column order.
    const fallback = [...groups].sort((a, b) => a.name.localeCompare(b.name))[0];
    if (fallback) {
      throw redirect({
        to: "/zones/$zoneGroupId",
        params: { zoneGroupId: fallback.zoneGroupId },
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
