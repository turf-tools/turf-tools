import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Button } from "~/components/button";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/tracks/$trackId")({
  component: TrackDetail,
});

function TrackDetail() {
  const { trackId } = Route.useParams();
  const navigate = useNavigate();
  const { data: track } = useQuery({
    queryKey: ["track", trackId],
    queryFn: () => client.tracks.getById({ trackId }),
  });

  return (
    <>
      <div className="mb-4 flex h-8 items-center justify-between">
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="icon"
            onClick={() => navigate({ to: "/tracks" })}
            aria-label="Back to tracks"
          >
            <ArrowLeft />
          </Button>
          {track ? <h1 className="text-xl font-extrabold tracking-wide">{track.name}</h1> : null}
        </div>
      </div>
      <p className="text-muted-foreground">Metadata editor for track {trackId} will live here.</p>
    </>
  );
}
