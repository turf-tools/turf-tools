import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { ArrowLeft, Eraser, Send, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapProvider } from "react-map-gl/maplibre";
import { darkAtom } from "~/lib/atoms/theme";
import { Button } from "~/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "~/components/dialog";
import { Map } from "~/components/map";
import { Switch } from "~/components/switch";
import { TurfDrawer, type Turf } from "~/components/turf-drawer";
import { TurfList } from "~/components/turf-list";
import { pointInPolygon, polygonToVertices, verticesToPolygon } from "~/lib/geometry";
import { boundariesGeoJsonQuery } from "~/lib/queries/boundaries";
import { campaignDetailQuery } from "~/lib/queries/campaigns";
import { cutterBuildingsQuery, segmentDetailQuery } from "~/lib/queries/segments";
import { turfDraftsQuery } from "~/lib/queries/turf-drafts";
import { zoneGroupsQuery, zonesQuery } from "~/lib/queries/zones";
import { useFadeOnce } from "~/lib/use-fade-once";
import { parseHexRgb } from "~/lib/utils";
import { colorFor } from "~/lib/zone-colors";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/campaigns/$campaignId/cut/$zoneId")({
  // Boundaries + buildings are intentionally out of the loader — they're
  // the heavy queries, and we'd rather get the user to the cutter chrome
  // fast and let the Map curtain hide their fetch than block navigation.
  loader: async ({ context: { queryClient }, params: { campaignId, zoneId } }) => {
    const [campaign] = await Promise.all([
      queryClient.fetchQuery(campaignDetailQuery(campaignId)),
      queryClient.fetchQuery(zoneGroupsQuery()),
      queryClient.fetchQuery(turfDraftsQuery(campaignId, zoneId)),
    ]);

    await Promise.all([
      campaign.zoneGroupId
        ? queryClient.fetchQuery(zonesQuery(campaign.zoneGroupId))
        : Promise.resolve(undefined),
      campaign.segmentId
        ? queryClient.fetchQuery(segmentDetailQuery(campaign.segmentId))
        : Promise.resolve(undefined),
    ]);
  },
  component: CutterPage,
});

// Thin shell so `key={zoneId}` remounts the Cutter on zone change,
// resetting in-progress drawing state, selection, auto-save timer, etc.
function CutterPage() {
  const { campaignId, zoneId } = Route.useParams();
  return <Cutter key={zoneId} campaignId={campaignId} zoneId={zoneId} />;
}

function Cutter({ campaignId, zoneId }: { campaignId: string; zoneId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const shouldFade = useFadeOnce("/campaigns/cut");
  const isDark = useAtomValue(darkAtom);

  const { data: campaign } = useSuspenseQuery(campaignDetailQuery(campaignId));
  const { data: zoneGroups } = useSuspenseQuery(zoneGroupsQuery());
  const { data: drafts } = useSuspenseQuery(turfDraftsQuery(campaignId, zoneId));

  const zoneGroup = zoneGroups.find((g) => g.zoneGroupId === campaign.zoneGroupId) ?? null;

  const { data: zones } = useQuery({
    ...zonesQuery(campaign.zoneGroupId ?? ""),
    enabled: !!campaign.zoneGroupId,
  });
  const zone = zones?.find((z) => z.zoneId === zoneId) ?? null;

  const { data: segmentDetail } = useQuery({
    ...segmentDetailQuery(campaign.segmentId ?? ""),
    enabled: !!campaign.segmentId,
  });

  const { data: boundaryFC } = useQuery({
    ...boundariesGeoJsonQuery(zoneGroup?.keyGroup ?? "", zoneGroup?.updatedAt ?? ""),
    enabled: !!zoneGroup,
  });

  const { data: buildingsResult } = useQuery({
    ...cutterBuildingsQuery(
      zoneId,
      segmentDetail?.criteria,
      zoneGroup && zone ? { keyGroup: zoneGroup.keyGroup, keys: zone.keys } : undefined,
    ),
    enabled: !!segmentDetail?.criteria && !!zone,
  });
  const buildings = buildingsResult?.buildings;

  const pointsBuffer = useMemo(() => {
    if (!buildings) return undefined;
    const buf = new Float32Array(buildings.length * 2);
    for (let i = 0; i < buildings.length; i++) {
      buf[i * 2] = buildings[i]!.longitude;
      buf[i * 2 + 1] = buildings[i]!.latitude;
    }
    return buf;
  }, [buildings]);

  // BBox of the zone's keys' polygons (no unioning needed — bbox accumulates the same).
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

  // In-progress turfs. Lives in the parent so the sidebar list and the
  // drawer share one source of truth. Initialised from loader-fresh drafts.
  const [turfs, setTurfs] = useState<Turf[]>(() =>
    drafts.map((d) => ({
      id: d.turfDraftId,
      vertices: polygonToVertices(d.geometry),
      mode: "editing" as const,
    })),
  );
  const [selectedTurfId, setSelectedTurfId] = useState<string | null>(null);

  // Replace-all save. `scope.id` serializes mutations so rapid commits
  // hit the server in order — last write reliably wins.
  const replaceAllDrafts = useMutation({
    mutationFn: (
      payload: Array<{
        turfDraftId: string;
        geometry: { type: "Polygon"; coordinates: number[][][] };
        name: string | null;
        sortOrder: number;
      }>,
    ) => client.turfDrafts.replaceAll({ campaignId, zoneId, drafts: payload }),
    scope: { id: `turf-drafts-${campaignId}-${zoneId}` },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["turf-drafts", campaignId, zoneId] });
      void queryClient.invalidateQueries({ queryKey: ["turf-stats", campaignId] });
    },
  });

  const mutateDrafts = replaceAllDrafts.mutate;
  const save = useCallback(
    (turfsNow: Turf[]) => {
      const payload = turfsNow
        .filter((t) => t.mode === "editing")
        .map((t, i) => ({
          turfDraftId: t.id,
          geometry: verticesToPolygon(t.vertices),
          name: null,
          sortOrder: i,
        }));
      mutateDrafts(payload);
    },
    [mutateDrafts],
  );

  // Live cursor lng/lat from the drawer. Used by the in-progress turf's
  // count (cursor closes the polygon implicitly) and by per-point colors.
  const [cursorLngLat, setCursorLngLat] = useState<[number, number] | null>(null);

  // Per-turf door + people aggregates. Drawing turfs include the cursor as
  // implicit closing vertex when there are ≥2 vertices.
  const turfCounts = useMemo(() => {
    const out: Record<string, { doors: number; people: number }> = {};
    if (!buildings) return out;
    for (const turf of turfs) {
      let polygon: Array<[number, number]>;
      if (turf.mode === "editing") {
        polygon = turf.vertices;
      } else if (turf.vertices.length >= 2 && cursorLngLat) {
        polygon = [...turf.vertices, cursorLngLat];
      } else {
        continue;
      }
      let doors = 0;
      let people = 0;
      for (const b of buildings) {
        if (pointInPolygon([b.longitude, b.latitude], polygon)) {
          doors += b.doorCount;
          people += b.personCount;
        }
      }
      out[turf.id] = { doors, people };
    }
    return out;
  }, [turfs, buildings, cursorLngLat]);

  const turfRows = useMemo(
    () => turfs.map((t) => ({ id: t.id, counts: turfCounts[t.id] })),
    [turfs, turfCounts],
  );

  const publishSummary = useMemo(() => {
    let count = 0;
    let doors = 0;
    let people = 0;
    for (const t of turfs) {
      if (t.mode !== "editing") continue;
      count += 1;
      const c = turfCounts[t.id];
      if (c) {
        doors += c.doors;
        people += c.people;
      }
    }
    return { count, doors, people };
  }, [turfs, turfCounts]);

  const [sizeByDoors, setSizeByDoors] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);

  const publishMutation = useMutation({
    mutationFn: () => client.turfs.publish({ campaignId, zoneId }),
    onSuccess: () => {
      setPublishOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["turfs"] });
      void queryClient.invalidateQueries({ queryKey: ["turf-stats", campaignId] });
    },
  });

  // Per-point colors. Each building gets the palette color of the first
  // turf that contains it, or a theme-matched default (near-black on
  // light, near-white on dark — matches the segment view's dot color).
  // Recomputes on every cursor move when there's a drawing turf —
  // bounded work (~600 buildings × handful of turfs × ~10 vertices),
  // stays under a frame.
  const pointColors = useMemo(() => {
    if (!buildings) return null;
    const colors = new Uint8Array(buildings.length * 3);
    const DEFAULT_R = isDark ? 229 : 26;
    const DEFAULT_G = isDark ? 229 : 26;
    const DEFAULT_B = isDark ? 229 : 26;
    const polygons: Array<Array<[number, number]> | null> = turfs.map((t) => {
      if (t.mode === "editing") return t.vertices;
      if (t.vertices.length >= 2 && cursorLngLat) return [...t.vertices, cursorLngLat];
      return null;
    });
    const palette: Array<[number, number, number]> = turfs.map((_, ti) =>
      parseHexRgb(colorFor(ti)),
    );
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i]!;
      let assigned: [number, number, number] | null = null;
      for (let ti = 0; ti < polygons.length; ti++) {
        const poly = polygons[ti];
        if (!poly) continue;
        if (pointInPolygon([b.longitude, b.latitude], poly)) {
          assigned = palette[ti]!;
          break;
        }
      }
      if (assigned) {
        colors[i * 3] = assigned[0];
        colors[i * 3 + 1] = assigned[1];
        colors[i * 3 + 2] = assigned[2];
      } else {
        colors[i * 3] = DEFAULT_R;
        colors[i * 3 + 1] = DEFAULT_G;
        colors[i * 3 + 2] = DEFAULT_B;
      }
    }
    return colors;
  }, [buildings, turfs, cursorLngLat, isDark]);

  // Per-point sizes — sqrt-scaled relative to a fixed reference. Off
  // returns null so the layer falls back to scale 1 across the board.
  const SIZE_REF_DOORS = 10;
  const pointSizes = useMemo(() => {
    if (!buildings || !sizeByDoors) return null;
    const sizes = new Float32Array(buildings.length);
    for (let i = 0; i < buildings.length; i++) {
      const d = buildings[i]!.doorCount;
      sizes[i] = d <= SIZE_REF_DOORS ? 1 : Math.sqrt(d / SIZE_REF_DOORS);
    }
    return sizes;
  }, [buildings, sizeByDoors]);

  const removeTurf = (id: string) => {
    setTurfs((ts) => {
      const next = ts.filter((t) => t.id !== id);
      save(next);
      return next;
    });
    setSelectedTurfId((s) => (s === id ? null : s));
  };

  // Document-level deselect-on-outside-click. Clicks on a turf row trigger
  // the deselect (which then reselects via the row's onClick) — that
  // deselect-reselect cycle is the visible flash that confirms which turf
  // the user is now looking at on the map.
  const mapAreaRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selectedTurfId) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (mapAreaRef.current?.contains(target)) return;
      setSelectedTurfId(null);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [selectedTurfId]);

  // Delete / Backspace removes the selected turf (mirrors the trash button).
  // Skipped while typing in any text input.
  useEffect(() => {
    if (!selectedTurfId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      removeTurf(selectedTurfId);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedTurfId]);

  const onBack = () => {
    void navigate({ to: "/campaigns/$campaignId", params: { campaignId } });
  };

  // Map curtain holds until the heavy queries (boundaries + buildings)
  // arrive, so the user sees a fully-formed map rather than empty zone
  // polygons popping into points.
  const mapLoading =
    (!!campaign.segmentId && buildings === undefined) || (!!campaign.zoneGroupId && !boundaryFC);

  return (
    <div className={shouldFade ? "animate-in fade-in duration-100" : undefined}>
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
          <Button variant="outline" disabled>
            <Sparkles />
            Autocut
          </Button>
          <Button
            variant="outline"
            disabled={turfs.length === 0}
            onClick={() => setClearOpen(true)}
          >
            <Eraser />
            Clear
          </Button>
          <Button disabled={publishSummary.count === 0} onClick={() => setPublishOpen(true)}>
            <Send />
            Publish
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-4 h-[calc(100vh-9rem)]">
        <div className="col-span-1 min-h-0">
          <TurfList
            turfs={turfRows}
            selectedTurfId={selectedTurfId}
            onSelect={setSelectedTurfId}
            onRemove={removeTurf}
            emptyMessage="Click the map to draw a turf"
          />
        </div>
        <div ref={mapAreaRef} className="col-span-3 relative h-full">
          <MapProvider>
            <Map
              className="h-full"
              points={pointsBuffer}
              pointColors={pointColors}
              pointSizes={pointSizes}
              fitBounds={fitBounds}
              loading={mapLoading}
              cornerControls={
                <label className="flex items-center gap-3 px-3 py-3 -mt-3">
                  <Switch checked={sizeByDoors} onCheckedChange={setSizeByDoors} />
                  <span>Show door counts</span>
                </label>
              }
            />
            <TurfDrawer
              turfs={turfs}
              setTurfs={setTurfs}
              selectedTurfId={selectedTurfId}
              setSelectedTurfId={setSelectedTurfId}
              onCursorChange={setCursorLngLat}
              onCommit={save}
            />
          </MapProvider>
        </div>
      </div>

      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent>
          <DialogTitle>Clear all turfs?</DialogTitle>
          <DialogDescription>
            Removes every turf you've cut in this zone, including any in-progress turfs. This can't
            be undone.
          </DialogDescription>
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setTurfs([]);
                save([]);
                setSelectedTurfId(null);
                setClearOpen(false);
              }}
            >
              Clear all turfs
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={publishOpen}
        onOpenChange={(next) => {
          // Block close-while-pending so click-outside doesn't strand the
          // user wondering whether the publish landed.
          if (publishMutation.isPending) return;
          setPublishOpen(next);
          if (!next) publishMutation.reset();
        }}
      >
        <DialogContent>
          <DialogTitle>Publish turfs?</DialogTitle>
          <DialogDescription>
            This will publish{" "}
            <span className="font-bold text-foreground">{publishSummary.count}</span> turf
            {publishSummary.count === 1 ? "" : "s"} covering{" "}
            <span className="font-bold text-foreground">
              {publishSummary.doors.toLocaleString()}
            </span>{" "}
            door
            {publishSummary.doors === 1 ? "" : "s"} and{" "}
            <span className="font-bold text-foreground">
              {publishSummary.people.toLocaleString()}
            </span>{" "}
            person
            {publishSummary.people === 1 ? "" : "s"}. You can keep editing after publishing. Every
            time you publish it creates a new set of turf numbers that can be used for canvassing.
          </DialogDescription>
          {publishMutation.error ? (
            <div
              className={
                "rounded-md border border-destructive/40 bg-destructive/10 " +
                "px-3 py-2 text-sm text-destructive"
              }
            >
              {publishMutation.error.message}
            </div>
          ) : null}
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button onClick={() => publishMutation.mutate()} loading={publishMutation.isPending}>
              <Send />
              Publish
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
