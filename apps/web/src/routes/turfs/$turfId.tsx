import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Button } from "~/components/button";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/turfs/$turfId")({
  component: TurfDetail,
});

// Read-only inspection of a single turf: name + metadata header, a map
// placeholder that will eventually show the turf polygon + doors, and a
// stats panel (canvass progress, survey results). Everything is stubbed
// for now — this route exists mostly so the nav target resolves.
function TurfDetail() {
  const { turfId } = Route.useParams();
  const navigate = useNavigate();
  const { data: turf } = useQuery({
    queryKey: ["turf", turfId],
    queryFn: () => client.turfs.getByIdForOrg({ turfId }),
  });

  return (
    <>
      <div className="mb-4 flex h-8 items-center justify-between">
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="icon"
            onClick={() => navigate({ to: "/turfs" })}
            aria-label="Back to turfs"
          >
            <ArrowLeft />
          </Button>
          {turf ? (
            <div className="flex items-baseline gap-3">
              <h1 className="text-xl font-extrabold tracking-wide">{turf.name}</h1>
              {turf.turfCode ? (
                <span className="text-sm text-muted-foreground italic">code {turf.turfCode}</span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-4 h-[calc(100vh-9.75rem)]">
        <div className="col-span-2 flex items-center justify-center rounded-lg border border-dashed border-border bg-muted/40 text-sm text-muted-foreground">
          Map (turf polygon + doors will render here)
        </div>
        <div className="flex items-center justify-center rounded-lg border border-dashed border-border bg-muted/40 text-sm text-muted-foreground">
          Canvass progress + results
        </div>
      </div>
    </>
  );
}
