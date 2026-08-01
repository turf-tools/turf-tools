import { createFileRoute, redirect } from "@tanstack/react-router";
import { recallSelection } from "~/lib/last-selected";
import { segmentsListQuery } from "~/lib/queries/segments";

export const Route = createFileRoute("/$orgSlug/segments/")({
  loader: async ({ context: { queryClient }, params: { orgSlug }, preload }) => {
    const segments = await queryClient.fetchQuery(segmentsListQuery());
    // Redirect only on real navigations — a redirect thrown during a hover
    // preload gets committed and auto-navigates.
    if (preload) return;
    // Last-visited segment first; alphabetically first on a cold start —
    // matches the list-column order.
    const remembered = recallSelection(orgSlug, "segments");
    const fallback =
      segments.find((s) => s.segmentId === remembered) ??
      [...segments].sort((a, b) => a.name.localeCompare(b.name))[0];
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
      No segments yet — create one to get started.
    </div>
  );
}
