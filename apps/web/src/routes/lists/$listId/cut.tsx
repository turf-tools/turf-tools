import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Sparkles } from "lucide-react";
import { Button } from "~/components/button";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/lists/$listId/cut")({
  component: TurfCutter,
});

// Focused editor for cutting turfs from a list. Chrome stays intact
// (top bar + sidebar), but the main content is a full-bleed map area
// with a small action bar on top for Autocut / Save / Cancel. After
// save, we return to /turfs so the user can inspect what they just made.
function TurfCutter() {
  const { listId } = Route.useParams();
  const navigate = useNavigate();
  const { data: list } = useQuery({
    queryKey: ["list", listId],
    queryFn: () => client.lists.getById({ listId }),
  });

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="icon"
            onClick={() => navigate({ to: "/lists/$listId", params: { listId } })}
            aria-label="Back to list"
          >
            <ArrowLeft />
          </Button>
          <div className="flex items-baseline gap-3">
            <h1 className="text-xl font-extrabold tracking-wide">Cut turf</h1>
            {list ? (
              <span className="text-sm text-muted-foreground italic">from {list.name}</span>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline">
            <Sparkles />
            Autocut
          </Button>
          <Button onClick={() => navigate({ to: "/turfs" })}>Save</Button>
        </div>
      </div>
      <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border bg-muted/40 text-sm text-muted-foreground">
        Map (drawing tools will live here)
      </div>
    </div>
  );
}
