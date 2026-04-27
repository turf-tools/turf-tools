import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { FeatureCollection } from "geojson";
import { ArrowLeft, Eraser, Sparkles, Undo2 } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import { Button } from "~/components/button";
import { Map } from "~/components/map";
import { cn } from "~/lib/utils";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/campaigns/$campaignId/cut/$zoneId")({
  component: CutterPage,
});

// Turf cutter — its own page so the browser back button works and
// refreshes preserve context. Reads campaign + zone from path
// params and pulls everything else (campaign detail, zones,
// segment detail, boundaries) from React Query cache when warm
// (user came in via the editor) or fetches fresh on a cold load.
//
// Cutting itself is a stub: Autocut / Clear / Undo are placeholders
// for the next PR. The page renders the points layer scoped to
// segment ∩ zone, framed to the zone's bbox.
function CutterPage() {
  const { campaignId, zoneId } = Route.useParams();
  const navigate = useNavigate();

  const { data: campaign } = useQuery({
    queryKey: ["campaign", campaignId],
    queryFn: () => client.campaigns.getById({ campaignId }),
    placeholderData: keepPreviousData,
  });

  const { data: zoneGroups } = useQuery({
    queryKey: ["zoneGroups"],
    queryFn: () => client.zoneGroups.list(),
    placeholderData: keepPreviousData,
  });
  const zoneGroup = zoneGroups?.find((g) => g.zoneGroupId === campaign?.zoneGroupId) ?? null;

  const { data: zones } = useQuery({
    queryKey: ["zones", campaign?.zoneGroupId],
    queryFn: () => client.zones.list({ zoneGroupId: campaign!.zoneGroupId! }),
    enabled: !!campaign?.zoneGroupId,
    placeholderData: keepPreviousData,
  });
  const zone = zones?.find((z) => z.zoneId === zoneId) ?? null;

  const { data: segmentDetail } = useQuery({
    queryKey: ["segment", campaign?.segmentId],
    queryFn: () => client.segments.getById({ segmentId: campaign!.segmentId! }),
    enabled: !!campaign?.segmentId,
    placeholderData: keepPreviousData,
  });

  // Boundary GeoJSON — used to compute the zone's bbox for fitBounds.
  const boundariesUrl = zoneGroup
    ? `${import.meta.env.VITE_DATA_URL}/key-groups/${zoneGroup.keyGroup}/geojson?v=${new Date(zoneGroup.updatedAt).getTime()}`
    : null;
  const { data: boundaryFC } = useQuery<FeatureCollection>({
    queryKey: ["boundaries-geojson", zoneGroup?.keyGroup, zoneGroup?.updatedAt],
    queryFn: async () => {
      const res = await fetch(boundariesUrl!);
      if (!res.ok) throw new Error(`boundaries fetch failed: ${res.status}`);
      return (await res.json()) as FeatureCollection;
    },
    enabled: !!boundariesUrl,
    staleTime: Number.POSITIVE_INFINITY,
  });

  // Points scoped to segment ∩ this zone's keys.
  const segmentQueryKey = segmentDetail?.query ? JSON.stringify(segmentDetail.query) : null;
  const { data: pointsBuffer } = useQuery({
    queryKey: ["cutter-points", zoneId, segmentQueryKey],
    queryFn: async () => {
      const res = await fetch("/api/query-points", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: segmentDetail!.query,
          keyFilter: zoneGroup ? { keyGroup: zoneGroup.keyGroup, keys: zone!.keys } : null,
        }),
      });
      if (!res.ok) throw new Error(`query-points failed: ${res.status} ${await res.text()}`);
      return new Float32Array(await res.arrayBuffer());
    },
    enabled: !!segmentDetail?.query && !!zone,
    placeholderData: keepPreviousData,
    staleTime: Number.POSITIVE_INFINITY,
    meta: { silent: true },
  });

  // BBox of the zone's keys' polygons. We don't bother unioning —
  // bbox accumulates the same regardless.
  const fitBounds = useMemo(() => {
    if (!zone || !boundaryFC) return null;
    const keys = new Set(zone.keys);
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    let touched = false;
    const visit = (c: number[]) => {
      const lng = c[0]!;
      const lat = c[1]!;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      touched = true;
    };
    for (const f of boundaryFC.features) {
      const k = f.properties?.key;
      if (typeof k !== "string" || !keys.has(k)) continue;
      const g = f.geometry;
      if (g.type === "Polygon") {
        for (const ring of g.coordinates) for (const c of ring) visit(c);
      } else if (g.type === "MultiPolygon") {
        for (const poly of g.coordinates) for (const ring of poly) for (const c of ring) visit(c);
      }
    }
    return touched ? ([minLng, minLat, maxLng, maxLat] as [number, number, number, number]) : null;
  }, [zone, boundaryFC]);

  // First-load curtain over the map. Same pattern as the editor:
  // wait until the map is mounted+framed AND data is ready, then
  // fade. Stays gone for the rest of the session.
  const [mapLoaded, setMapLoaded] = useState(false);
  const [firstReady, setFirstReady] = useState(false);
  useEffect(() => {
    if (firstReady) return;
    const dataReady =
      !!campaign &&
      !!zone &&
      (!campaign.segmentId || pointsBuffer !== undefined) &&
      (!campaign.zoneGroupId || !!boundaryFC);
    if (mapLoaded && dataReady) setFirstReady(true);
  }, [firstReady, mapLoaded, campaign, zone, pointsBuffer, boundaryFC]);

  const onBack = () => {
    void navigate({ to: "/campaigns" });
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") onBack();
  };

  return (
    <div onKeyDown={onKey}>
      <div className="mb-4 flex h-8 items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="icon" onClick={onBack} aria-label="Back to campaign">
            <ArrowLeft />
          </Button>
          <div className="flex items-baseline gap-3">
            <h1 className="text-xl font-extrabold tracking-wide italic">Turf Cutter</h1>
            <span className="text-sm text-muted-foreground italic">{zone?.name ?? ""}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Stubs — wired up in the cutter PR. */}
          <Button variant="outline" disabled>
            <Sparkles />
            Autocut
          </Button>
          <Button variant="outline" disabled>
            <Eraser />
            Clear
          </Button>
          <Button variant="outline" disabled>
            <Undo2 />
            Undo
          </Button>
        </div>
      </div>
      <div className="relative h-[calc(100vh-9.75rem)] overflow-hidden rounded-lg border border-border">
        <Map
          className="h-full"
          points={pointsBuffer}
          fitBounds={fitBounds}
          onLoaded={() => setMapLoaded(true)}
        />
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 bg-background",
            "transition-opacity duration-150",
            firstReady ? "opacity-0" : "opacity-100",
          )}
        />
      </div>
    </div>
  );
}
