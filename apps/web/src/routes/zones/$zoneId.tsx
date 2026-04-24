import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Button } from "~/components/button";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/zones/$zoneId")({
  component: ZoneDetail,
});

function ZoneDetail() {
  const { zoneId } = Route.useParams();
  const navigate = useNavigate();
  const { data: zone } = useQuery({
    queryKey: ["zone", zoneId],
    queryFn: () => client.zones.getById({ zoneId }),
  });

  return (
    <>
      <div className="mb-4 flex h-8 items-center justify-between">
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="icon"
            onClick={() => navigate({ to: "/zones" })}
            aria-label="Back to zones"
          >
            <ArrowLeft />
          </Button>
          {zone ? <h1 className="text-xl font-extrabold tracking-wide">{zone.name}</h1> : null}
        </div>
      </div>
      <p className="text-muted-foreground">Zone editor (map + metadata) will live here.</p>
    </>
  );
}
