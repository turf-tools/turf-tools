import { createFileRoute, redirect } from "@tanstack/react-router";
import { segmentsListQuery } from "~/lib/queries/segments";

export const Route = createFileRoute("/segments/")({
  loader: async ({ context: { queryClient } }) => {
    const segments = await queryClient.fetchQuery(segmentsListQuery());
    // Alphabetically first is the default — matches the list-column order.
    const fallback = [...segments].sort((a, b) => a.name.localeCompare(b.name))[0];
    if (fallback) {
      throw redirect({
        to: "/segments/$segmentId",
        params: { segmentId: fallback.segmentId },
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
