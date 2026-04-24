import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Scissors } from "lucide-react";
import { Button } from "~/components/button";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/segments/$segmentId/")({
  component: SegmentDetail,
});

// Full-width edit view for a single segment: query builder on the left
// (placeholder for now), map of matching voters on the right (also a
// placeholder). Header has Back, Save (no-op stub), and "Cut turf" which
// routes to the turf-cutter inside this segment.
function SegmentDetail() {
  const { segmentId } = Route.useParams();
  const navigate = useNavigate();
  const { data: segment } = useQuery({
    queryKey: ["segment", segmentId],
    queryFn: () => client.segments.getById({ segmentId }),
  });

  return (
    <>
      <div className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="icon"
            onClick={() => navigate({ to: "/segments" })}
            aria-label="Back to segments"
          >
            <ArrowLeft />
          </Button>
          {segment ? (
            <h1 className="text-xl font-extrabold tracking-wide">{segment.name}</h1>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => navigate({ to: "/segments/$segmentId/cut", params: { segmentId } })}
          >
            <Scissors />
            Cut turf
          </Button>
          <Button>Save</Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 h-[calc(100vh-12rem)]">
        <Placeholder label="Query builder" />
        <Placeholder label="Map" />
      </div>
    </>
  );
}

function Placeholder({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border bg-muted/40 text-sm text-muted-foreground">
      {label}
    </div>
  );
}
