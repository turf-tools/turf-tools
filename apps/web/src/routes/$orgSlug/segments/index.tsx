import { createFileRoute, redirect } from "@tanstack/react-router";
import { recallOrFirst } from "~/lib/last-selected";
import { segmentsListQuery } from "~/lib/queries/segments";

export const Route = createFileRoute("/$orgSlug/segments/")({
  loader: async ({ context: { queryClient }, params: { orgSlug }, preload }) => {
    const segments = await queryClient.fetchQuery(segmentsListQuery());
    // Redirect only on real navigations — a redirect thrown during a hover
    // preload gets committed and auto-navigates.
    if (preload) return;
    // Archived segments stay reachable from the rail but never win the
    // index redirect.
    const active = segments.filter((s) => !s.isArchived);
    const fallback = recallOrFirst(orgSlug, "segments", active, (s) => s.segmentId);
    if (fallback) {
      throw redirect({
        to: "/$orgSlug/segments/$segmentId",
        params: { orgSlug, segmentId: fallback.segmentId },
      });
    }
  },
  component: SegmentsEmpty,
});

function SegmentsEmpty() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      No active segments yet, create one to get started.
    </div>
  );
}
