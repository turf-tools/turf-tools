import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/tracks/$trackId")({
  component: TrackDetail,
});

function TrackDetail() {
  const { trackId } = Route.useParams();
  return (
    <>
      <h1 className="mb-4 text-xl font-extrabold tracking-wide">Track</h1>
      <p className="text-muted-foreground">Metadata editor for track {trackId} will live here.</p>
    </>
  );
}
