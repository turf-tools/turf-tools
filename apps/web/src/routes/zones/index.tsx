import { createFileRoute, redirect } from "@tanstack/react-router";
import { zoneGroupsQuery } from "~/lib/queries/zones";

export const Route = createFileRoute("/zones/")({
  loader: async ({ context: { queryClient } }) => {
    const groups = await queryClient.fetchQuery(zoneGroupsQuery());
    // Most-recently-modified is the default.
    const fallback = [...groups].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )[0];
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
