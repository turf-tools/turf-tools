import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { FeatureCollection } from "geojson";
import { ArrowLeft, Eraser, Send, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { MapProvider } from "react-map-gl/maplibre";
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
import { colorFor } from "~/lib/zone-colors";
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

  // Buildings scoped to segment ∩ this zone's keys. Each row carries
  // its own buildingId + per-building door/person counts, which the
  // cutter will use to compute "what's inside this drawn polygon"
  // client-side. Until cutting is implemented, we just feed the
  // centroids (lng/lat pairs) into the points layer.
  const segmentQueryKey = segmentDetail?.query ? JSON.stringify(segmentDetail.query) : null;
  const { data: buildingsResult } = useQuery({
    queryKey: ["cutter-buildings", zoneId, segmentQueryKey],
    queryFn: () =>
      client.segments.queryBuildings({
        query: segmentDetail!.query,
        keyFilter: zoneGroup ? { keyGroup: zoneGroup.keyGroup, keys: zone!.keys } : undefined,
      }),
    enabled: !!segmentDetail?.query && !!zone,
    placeholderData: keepPreviousData,
    staleTime: Number.POSITIVE_INFINITY,
    meta: { silent: true },
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

  // Turfs being cut for this zone. Lifted here so the sidebar and
  // the drawer share the same source of truth — the drawer is
  // where vertices get added/closed, the sidebar is where they're
  // listed/named/removed, and they have to agree. Selection is
  // bidirectional: clicking a row or a polygon both write to
  // `selectedTurfId`.
  const [turfs, setTurfs] = useState<Turf[]>([]);
  const [selectedTurfId, setSelectedTurfId] = useState<string | null>(null);

  // Drafts persistence. The server is canonical between cutter
  // mounts; the cutter is canonical *while* mounted. We refetch on
  // every mount and hydrate the local `turfs` state once the fresh
  // fetch lands, then auto-save changes back via a debounced effect
  // below. Silent (`meta.silent`) because the load happens behind
  // the first-load curtain.
  const { data: draftsData, isFetching: draftsFetching } = useQuery({
    queryKey: ["turfDrafts", campaignId, zoneId],
    queryFn: () => client.turfDrafts.list({ campaignId, zoneId }),
    meta: { silent: true },
  });

  // Hydration is one-shot per mount, gated on `isFetching === false`
  // so we hydrate to the post-fetch fresh data — not the cached
  // copy that tanstack-query serves synchronously on a remount
  // (which would be stale relative to whatever the user saved
  // last session).
  const [draftsHydrated, setDraftsHydrated] = useState(false);
  useEffect(() => {
    if (draftsHydrated || !draftsData || draftsFetching) return;
    setTurfs(
      draftsData.map((d) => ({
        id: d.turfDraftId,
        vertices: polygonToVertices(d.geometry),
        mode: "editing" as const,
      })),
    );
    setDraftsHydrated(true);
  }, [draftsData, draftsFetching, draftsHydrated]);

  // Replace-all save mutation. Single round trip, single
  // transaction, no per-row bookkeeping. Not silent — the user
  // wants to see saves in the global indicator. No cache
  // bookkeeping needed: the next mount refetches.
  const replaceAllDrafts = useMutation({
    mutationFn: (
      drafts: Array<{
        turfDraftId: string;
        geometry: { type: "Polygon"; coordinates: number[][][] };
        name: string | null;
        sortOrder: number;
      }>,
    ) => client.turfDrafts.replaceAll({ campaignId, zoneId, drafts }),
  });

  // Auto-save: debounced 500ms after the last change to a *closed*
  // turf. Drawing-mode polygons aren't saved (no committed shape
  // yet), and we don't want every vertex-add during drawing to
  // reschedule a redundant save of the same closed-polygon set —
  // so the effect deps on a signature derived only from editing-
  // mode turfs. The latest `turfs` is read through a ref at fire
  // time so the payload reflects whatever the user has at second
  // 0.5, not at the moment the timer was scheduled. `mutate` is a
  // stable reference per tanstack-query.
  const mutateDrafts = replaceAllDrafts.mutate;
  const turfsRef = useRef(turfs);
  useEffect(() => {
    turfsRef.current = turfs;
  }, [turfs]);
  const saveSignature = useMemo(
    () => JSON.stringify(turfs.filter((t) => t.mode === "editing").map((t) => [t.id, t.vertices])),
    [turfs],
  );
  useEffect(() => {
    if (!draftsHydrated) return;
    const timer = setTimeout(() => {
      const drafts = turfsRef.current
        .filter((t) => t.mode === "editing")
        .map((t, i) => ({
          turfDraftId: t.id,
          geometry: verticesToPolygon(t.vertices),
          name: null,
          sortOrder: i,
        }));
      mutateDrafts(drafts);
    }, 500);
    return () => clearTimeout(timer);
  }, [saveSignature, draftsHydrated, mutateDrafts]);

  // First-load curtain over the map. Same pattern as the editor:
  // wait until data is ready, then fade. Stays gone for the rest of
  // the session. The Map component owns the actual curtain and its
  // own basemap+fitBounds-readiness gating; we just tell it whether
  // our data is ready yet. Sits *after* the drafts hydration block
  // so `draftsHydrated` is in scope (TDZ otherwise).
  const [firstReady, setFirstReady] = useState(false);
  useEffect(() => {
    if (firstReady) return;
    const dataReady =
      !!campaign &&
      !!zone &&
      (!campaign.segmentId || buildings !== undefined) &&
      (!campaign.zoneGroupId || !!boundaryFC) &&
      // Don't lift the curtain until drafts have hydrated, otherwise
      // the user briefly sees an empty list before their saved
      // turfs pop in.
      draftsHydrated;
    if (dataReady) setFirstReady(true);
  }, [firstReady, campaign, zone, buildings, boundaryFC, draftsHydrated]);

  // Live cursor lng/lat from the drawer. Only meaningful for the
  // count of the in-progress drawing turf — that polygon is
  // implicitly closed by a segment from the cursor back to the
  // first vertex, so the count needs the cursor position the same
  // frame to stay live. Null when the cursor is outside the map.
  const [cursorLngLat, setCursorLngLat] = useState<[number, number] | null>(null);

  // Per-turf door + people aggregates over the segment buildings
  // contained in each polygon. Closed (`editing`) turfs use their
  // vertices directly. Drawing turfs with ≥2 vertices include the
  // cursor as the implicit closing vertex, so the user sees a live
  // count of what they'd capture if they closed the polygon now.
  // Below 2 vertices there's no triangle to enclose anything, so
  // the drawing row stays blank. Inlined ray-casting point-in-
  // polygon — fast for the typical scale (~600 buildings × handful
  // of turfs × ~5–20 vertices) even at 60fps cursor updates.
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

  // Publishable totals — only closed polygons participate (drawing-
  // mode turfs aren't saved as drafts, so the server wouldn't see
  // them anyway). Used by the Publish button and dialog summary.
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

  // Toggle for the door-count size encoding. Off by default — the
  // baseline is uniform dots; flicking it on highlights the high-
  // door buildings (50+ doors). Default off because the size
  // encoding is informational, not navigational.
  const [sizeByDoors, setSizeByDoors] = useState(false);

  // Clear-confirmation dialog. Owns its own open flag rather than
  // a ref so the destructive button can't fire from a stale event
  // loop. Local-state-only — no server round trip — so nothing
  // pending/error to track.
  const [clearOpen, setClearOpen] = useState(false);

  // Publish dialog + mutation. Publishing reads server-side drafts
  // (already auto-saved), runs PIP per polygon, and inserts new
  // turfs rows. Drafts are retained — the user can keep editing
  // and re-publish; each publish appends a fresh batch.
  const [publishOpen, setPublishOpen] = useState(false);
  const publishMutation = useMutation({
    mutationFn: () => client.turfs.publish({ campaignId, zoneId }),
    onSuccess: () => {
      setPublishOpen(false);
    },
  });

  // Per-point colors. Each building gets the palette color of the
  // first turf that contains it (matching the sidebar/stroke
  // palette), or a neutral default. Recomputes on every cursor move
  // when there's a drawing turf — that's a lot of point-in-polygon,
  // but the work is bounded (~600 buildings × handful of turfs ×
  // ~10 vertices) and stays under a frame.
  const pointColors = useMemo(() => {
    if (!buildings) return null;
    const colors = new Uint8Array(buildings.length * 3);
    // Unassigned points get a slightly-softer-than-black so the
    // dot mass on the map doesn't read as harsh ink. #1a1a1a is
    // a small step off pure black — same family of "near-black"
    // values worth aligning the rest of the UI to in a follow-up.
    const DEFAULT_R = 26;
    const DEFAULT_G = 26;
    const DEFAULT_B = 26;
    // Pre-derive both polygons and palette per turf so the inner
    // loop just looks up by index. Skipped turfs (drawing with <2
    // vertices, or no cursor) get a null polygon and never match.
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
  }, [buildings, turfs, cursorLngLat]);

  // Per-point sizes — sqrt-scaled relative to a fixed reference
  // (`SIZE_REF_DOORS = 10`). Buildings at or below the reference
  // stay at scale 1 (the zoom-driven base size); a 40-door building
  // is 2× radius, 90-door is 3×. Absolute scale (no median-based
  // normalization) so a 100-door tower looks the same regardless of
  // what else is on screen — the goal is flagging giant buildings,
  // not relative comparison. Returns null when the toggle is off,
  // which makes the layer fall back to scale 1 across the board.
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
    setTurfs((ts) => ts.filter((t) => t.id !== id));
    setSelectedTurfId((s) => (s === id ? null : s));
  };

  // Document-level deselect-on-outside-click. The map's own click
  // handler (in TurfDrawer) covers clicks landing on the map; the
  // row's own onClick covers clicks on a turf in the sidebar.
  // Anything else — empty space below the list, the header,
  // outside the editor — deselects, so users have a way to "step
  // out" of a selection without an explicit deselect button.
  const mapAreaRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selectedTurfId) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (mapAreaRef.current?.contains(target)) return;
      if (target.closest("[data-turf-row]")) return;
      setSelectedTurfId(null);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [selectedTurfId]);

  const onBack = () => {
    void navigate({ to: "/campaigns" });
  };

  return (
    <div>
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
          {/* Autocut is still a stub. */}
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
      <div className="grid grid-cols-4 gap-4 h-[calc(100vh-9.75rem)]">
        <div className="col-span-1 min-h-0">
          <TurfList
            turfs={turfRows}
            selectedTurfId={selectedTurfId}
            onSelect={setSelectedTurfId}
            onRemove={removeTurf}
            // Gated on `firstReady` so the placeholder doesn't
            // flash in before the curtain lifts on first load.
            emptyMessage={firstReady ? "Click the map to draw a turf" : undefined}
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
              loading={!firstReady}
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
          // Block close-while-pending so a click-outside doesn't
          // strand the user wondering whether the publish landed.
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

// Standard ray-casting point-in-polygon test in lng/lat space.
// Used to count buildings inside each turf's polygon (turf bbox is
// small enough that planar testing is fine — no projection
// distortion to worry about). Inlined to avoid a
// `@turf/boolean-point-in-polygon` dep for ten lines.
function pointInPolygon(point: [number, number], polygon: Array<[number, number]>): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Convert the cutter's open-ring vertex list `[[lng,lat],...]` to a
// GeoJSON Polygon (closed ring; first === last). Drafts and
// published turfs both store polygons in this canonical form.
function verticesToPolygon(vertices: Array<[number, number]>): {
  type: "Polygon";
  coordinates: number[][][];
} {
  const ring: number[][] = vertices.map((v) => [v[0], v[1]]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    ring.push([first[0]!, first[1]!]);
  }
  return { type: "Polygon", coordinates: [ring] };
}

// Inverse of `verticesToPolygon` — strip the closing duplicate so
// the in-memory cutter shape matches what the drawer expects.
function polygonToVertices(polygon: {
  type: "Polygon";
  coordinates: number[][][];
}): Array<[number, number]> {
  const ring = polygon.coordinates[0] ?? [];
  const open = ring.slice(0, -1);
  // Defensive: if the ring wasn't closed, slice(-1) drops a real
  // vertex. Detect by checking first vs last; if equal, drop. If
  // not, keep the full ring.
  if (ring.length >= 2) {
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    if (first[0] === last[0] && first[1] === last[1]) {
      return open.map((p) => [p[0]!, p[1]!] as [number, number]);
    }
  }
  return ring.map((p) => [p[0]!, p[1]!] as [number, number]);
}

// "#rrggbb" or "#rgb" → [r, g, b] in 0..255. Used to convert the
// categorical-palette hex strings into bytes for the points layer's
// per-point color VBO.
function parseHexRgb(css: string): [number, number, number] {
  let hex = css.replace(/^#/, "");
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (hex.length !== 6) return [0, 0, 0];
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}
