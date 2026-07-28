import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import {
  ArrowLeft,
  DoorClosed,
  Eraser,
  type LucideIcon,
  Send,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapProvider } from "react-map-gl/maplibre";
import { darkAtom } from "~/lib/atoms/theme";
import { Button } from "~/components/button";
import { Callout } from "~/components/callout";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "~/components/dialog";
import { EditorHeader } from "~/components/editor-header";
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
import type { Criteria } from "~/lib/filters";
import { useFadeOnce } from "~/lib/use-fade-once";
import { parseHexRgb } from "~/lib/utils";
import { colorFor } from "~/lib/zone-colors";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/$orgSlug/campaigns/$campaignId/cut/$zoneId")({
  // Boundaries + buildings are intentionally out of the loader — they're
  // the heavy queries, and we'd rather get the user to the cutter chrome
  // fast and let the Map curtain hide their fetch than block navigation.
  loader: async ({ context: { queryClient }, params: { campaignId, zoneId } }) => {
    // zoneGroupsQuery is already prefetched by the parent campaigns
    // route loader, so we don't refetch it here.
    const [campaign] = await Promise.all([
      queryClient.fetchQuery(campaignDetailQuery(campaignId)),
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

// A metric cell for the cutter's upper-right inset: an icon + a right-aligned
// value (em dash when null).
function StatValue({ icon: Icon, value }: { icon: LucideIcon; value: number | null }) {
  return (
    <span className="flex items-center justify-end gap-1 tabular-nums">
      <Icon className="size-3.5 text-foreground" />
      {value?.toLocaleString() ?? "—"}
    </span>
  );
}

// Thin shell so `key={zoneId}` remounts the Cutter on zone change,
// resetting in-progress drawing state, selection, auto-save timer, etc.
function CutterPage() {
  const { orgSlug, campaignId, zoneId } = Route.useParams();
  return <Cutter key={zoneId} orgSlug={orgSlug} campaignId={campaignId} zoneId={zoneId} />;
}

// Shared between zoned (`./$zoneId`) and zoneless (`./index`) cutter routes.
export function Cutter({
  orgSlug,
  campaignId,
  zoneId,
}: {
  orgSlug: string;
  campaignId: string;
  // `zoneId === null` means the campaign has no zone group — the cutter
  // operates against the full segment (no key filter, fitBounds from
  // the points buffer, drafts/publish RPCs accept null).
  zoneId: string | null;
}) {
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

  const segmentCriteria = segmentDetail?.criteria as Criteria | null | undefined;
  // Zoned: pass keyFilter so the data server narrows buildings to the
  // zone's keys. Zoneless: no keyFilter → all buildings matching the
  // segment criteria. The query is enabled either as soon as we have a
  // segment + zone match (zoned), or as soon as we have a segment at
  // all (zoneless).
  const { data: buildingsResult } = useQuery({
    ...cutterBuildingsQuery(
      zoneId,
      segmentCriteria,
      zoneGroup && zone ? { keyGroup: zoneGroup.keyGroup, keys: zone.keys } : undefined,
    ),
    enabled: !!segmentCriteria && (zoneId === null || !!zone),
  });
  const buildings = buildingsResult?.buildings;

  // Project to MapLibre [0,1] mercator at fp64, subtract the centroid,
  // then store fp32 deltas. fp32 over the tight centered range keeps
  // millimeter precision at z20 (raw lng/lat → mercator in the shader
  // at fp32 loses ~8 px per ULP at z20 — visible jitter).
  const pointsBuffer = useMemo(() => {
    if (!buildings || buildings.length === 0) return undefined;
    const n = buildings.length;
    const merc = new Float64Array(n * 2);
    let ox = 0;
    let oy = 0;
    for (let i = 0; i < n; i++) {
      const b = buildings[i]!;
      const mx = (b.longitude + 180) / 360;
      const my =
        0.5 - Math.log(Math.tan(Math.PI / 4 + (b.latitude * Math.PI) / 360)) / (2 * Math.PI);
      merc[i * 2] = mx;
      merc[i * 2 + 1] = my;
      ox += mx;
      oy += my;
    }
    ox /= n;
    oy /= n;
    const deltas = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      deltas[i * 2] = merc[i * 2]! - ox;
      deltas[i * 2 + 1] = merc[i * 2 + 1]! - oy;
    }
    return { deltas, origin: [ox, oy] as [number, number] };
  }, [buildings]);

  // Zoned: bbox of the zone's keys' polygons (no unioning needed — bbox
  // accumulates the same). Zoneless: bbox of the buildings themselves,
  // which is the natural "fit to what you can cut" framing when there's
  // no zone perimeter to anchor against.
  const fitBounds = useMemo<[number, number, number, number] | null>(() => {
    if (zoneId === null) {
      if (!buildings || buildings.length === 0) return null;
      let minLng = Infinity;
      let minLat = Infinity;
      let maxLng = -Infinity;
      let maxLat = -Infinity;
      for (const b of buildings) {
        if (b.longitude < minLng) minLng = b.longitude;
        if (b.longitude > maxLng) maxLng = b.longitude;
        if (b.latitude < minLat) minLat = b.latitude;
        if (b.latitude > maxLat) maxLat = b.latitude;
      }
      return [minLng, minLat, maxLng, maxLat];
    }
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
    return touched ? [minLng, minLat, maxLng, maxLat] : null;
  }, [zoneId, zone, boundaryFC, buildings]);

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

  // Incremental per-turf containment cache: the building indices each turf
  // contains, keyed on the turf's `vertices` identity (plus the cursor for
  // the drawing turf, whose polygon closes through it). `setTurfs` keeps the
  // referential identity of every turf it doesn't touch, so a single-turf
  // edit (dragging a vertex, or the cursor moving while drawing) misses the
  // cache for only that turf and recomputes only it — per-interaction cost
  // is independent of turf count. Counts and point colors both derive from it.
  type ContainEntry = {
    verts: Turf["vertices"];
    cursor: [number, number] | null;
    indices: number[];
    doors: number;
    people: number;
  };
  const containCacheRef = useRef<Record<string, ContainEntry>>({});
  const cacheBuildingsRef = useRef(buildings);
  const perTurf = useMemo(() => {
    // Buildings changing (initial load / zone switch) invalidates every
    // cached containment set — the indices point into a different array.
    if (cacheBuildingsRef.current !== buildings) {
      containCacheRef.current = {};
      cacheBuildingsRef.current = buildings;
    }
    const cache = containCacheRef.current;
    const rows: Array<{ id: string; indices: number[]; doors: number; people: number }> = [];
    const live = new Set<string>();
    if (buildings) {
      for (const turf of turfs) {
        live.add(turf.id);
        // Only the drawing turf depends on the cursor; closed turfs pin it
        // to null so cursor moves never invalidate their entry.
        const cursor = turf.mode === "drawing" ? cursorLngLat : null;
        const prev = cache[turf.id];
        const cursorSame =
          prev?.cursor === cursor ||
          (!!prev?.cursor &&
            !!cursor &&
            prev.cursor[0] === cursor[0] &&
            prev.cursor[1] === cursor[1]);
        if (prev && prev.verts === turf.vertices && cursorSame) {
          rows.push({ id: turf.id, indices: prev.indices, doors: prev.doors, people: prev.people });
          continue;
        }
        let polygon: Array<[number, number]> | null;
        if (turf.mode === "editing") polygon = turf.vertices;
        else if (turf.vertices.length >= 2 && cursor) polygon = [...turf.vertices, cursor];
        else polygon = null;
        const indices: number[] = [];
        let doors = 0;
        let people = 0;
        if (polygon) {
          for (let i = 0; i < buildings.length; i++) {
            const b = buildings[i]!;
            if (pointInPolygon([b.longitude, b.latitude], polygon)) {
              indices.push(i);
              doors += b.doorCount;
              people += b.personCount;
            }
          }
        }
        cache[turf.id] = { verts: turf.vertices, cursor, indices, doors, people };
        rows.push({ id: turf.id, indices, doors, people });
      }
    }
    // Evict entries for removed turfs so the cache can't grow unbounded.
    for (const id of Object.keys(cache)) if (!live.has(id)) delete cache[id];
    return rows;
  }, [turfs, buildings, cursorLngLat]);

  // A drawing turf contributes a count only with ≥2 vertices and a cursor
  // (its polygon closes through the cursor); below that, no entry. Cheap
  // O(turfs) pass over the cache above.
  const turfCounts = useMemo(() => {
    const byId: Record<string, { doors: number; people: number }> = {};
    for (const t of perTurf) byId[t.id] = { doors: t.doors, people: t.people };
    const out: Record<string, { doors: number; people: number }> = {};
    for (const turf of turfs) {
      const hasPolygon = turf.mode === "editing" || (turf.vertices.length >= 2 && !!cursorLngLat);
      if (!hasPolygon) continue;
      const r = byId[turf.id];
      if (r) out[turf.id] = r;
    }
    return out;
  }, [perTurf, turfs, cursorLngLat]);

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

  // Upper-right inset tallies: uncut people/doors (buildings in no turf —
  // matches the default-colored dots, so it ticks down live while drawing)
  // and average people/doors per committed turf.
  const insetStats = useMemo(() => {
    if (!buildings) return null;
    const assigned = new Set<number>();
    for (const t of perTurf) for (const idx of t.indices) assigned.add(idx);
    let uncutDoors = 0;
    let uncutPeople = 0;
    for (let i = 0; i < buildings.length; i++) {
      if (assigned.has(i)) continue;
      uncutDoors += buildings[i]!.doorCount;
      uncutPeople += buildings[i]!.personCount;
    }
    const n = publishSummary.count;
    return {
      uncutPeople,
      uncutDoors,
      avgPeople: n ? Math.round(publishSummary.people / n) : null,
      avgDoors: n ? Math.round(publishSummary.doors / n) : null,
    };
  }, [buildings, perTurf, publishSummary]);

  // Auto-scroll the turf list to the newest turf on add (mirrors the scripts
  // editor). Cutter remounts per zone (`key={zoneId}`), so the ref resets and
  // the initial drafts don't trigger a scroll.
  const turfListRef = useRef<HTMLDivElement>(null);
  const prevTurfCountRef = useRef(turfs.length);
  useEffect(() => {
    const el = turfListRef.current;
    if (el && turfs.length > prevTurfCountRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
    prevTurfCountRef.current = turfs.length;
  }, [turfs.length]);

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

  // Per-point colors, derived from the same per-turf containment cache.
  // Each building gets the palette color of the first turf that contains it
  // (painted in reverse so the lowest index wins on any transient overlap),
  // or a theme-matched default (near-black on light, near-white on dark).
  // O(buildings) per change and independent of turf count — the containment
  // work already happened incrementally in `perTurf`.
  const pointColors = useMemo(() => {
    if (!buildings) return null;
    const colors = new Uint8Array(buildings.length * 3);
    colors.fill(isDark ? 229 : 26); // grayscale default (R=G=B)
    for (let ti = perTurf.length - 1; ti >= 0; ti--) {
      const [r, g, b] = parseHexRgb(colorFor(ti));
      for (const idx of perTurf[ti]!.indices) {
        colors[idx * 3] = r;
        colors[idx * 3 + 1] = g;
        colors[idx * 3 + 2] = b;
      }
    }
    return colors;
  }, [perTurf, buildings, isDark]);

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

  const removeTurf = useCallback(
    (id: string) => {
      setTurfs((ts) => {
        const next = ts.filter((t) => t.id !== id);
        save(next);
        return next;
      });
      setSelectedTurfId((s) => (s === id ? null : s));
    },
    [save],
  );

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
  // Skipped while typing in any text input. Modifier-held variants are
  // ignored so Mod-Delete on this screen is a no-op rather than a turf
  // remove (no escalation target exists in the cutter).
  useEffect(() => {
    if (!selectedTurfId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (e.metaKey || e.ctrlKey) return;
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
    void navigate({ to: "/$orgSlug/campaigns/$campaignId", params: { orgSlug, campaignId } });
  };

  // Map curtain holds until the heavy queries (boundaries + buildings)
  // arrive, so the user sees a fully-formed map rather than empty zone
  // polygons popping into points.
  const mapLoading =
    (!!campaign.segmentId && buildings === undefined) || (!!campaign.zoneGroupId && !boundaryFC);

  return (
    <div className={shouldFade}>
      <EditorHeader
        title="Turf Cutter"
        subtitle={zoneId === null ? "Full segment" : zone?.name}
        leading={
          <Button variant="outline" size="icon" onClick={onBack} aria-label="Back to campaign">
            <ArrowLeft />
          </Button>
        }
      >
        <Button variant="outline" disabled>
          <Sparkles />
          Autocut
        </Button>
        <Button variant="outline" disabled={turfs.length === 0} onClick={() => setClearOpen(true)}>
          <Eraser />
          Clear
        </Button>
        <Button
          disabled={publishSummary.count === 0}
          onClick={() => {
            // Clear any stale error from a prior failed attempt so the
            // dialog reopens clean. Synchronous so the open render sees
            // both `publishOpen=true` and `error=null` in one pass.
            if (publishMutation.error) publishMutation.reset();
            setPublishOpen(true);
          }}
        >
          <Send />
          Publish
        </Button>
      </EditorHeader>
      <div className="flex gap-4 h-[calc(100vh-9rem)]">
        <div className="w-72 shrink-0 min-h-0">
          <TurfList
            turfs={turfRows}
            selectedTurfId={selectedTurfId}
            onSelect={setSelectedTurfId}
            onRemove={removeTurf}
            emptyMessage="Click the map to draw a turf"
            scrollRef={turfListRef}
          />
        </div>
        <div ref={mapAreaRef} className="flex-1 relative h-full">
          <MapProvider>
            <Map
              className="h-full"
              points={pointsBuffer}
              pointColors={pointColors}
              pointSizes={pointSizes}
              fitBounds={fitBounds}
              loading={mapLoading}
              cornerLowerRight={
                <label className="flex items-center gap-3 px-3 py-3 -mt-3">
                  <Switch checked={sizeByDoors} onCheckedChange={setSizeByDoors} />
                  <span>Show door counts</span>
                </label>
              }
              cornerUpperRight={
                insetStats ? (
                  <div className="grid grid-cols-[auto_auto_auto] items-center gap-x-4 gap-y-1.5 px-3 py-2.5">
                    <span className="text-muted-foreground">Uncut</span>
                    <StatValue icon={UserRound} value={insetStats.uncutPeople} />
                    <StatValue icon={DoorClosed} value={insetStats.uncutDoors} />
                    <span className="text-muted-foreground">Avg</span>
                    <StatValue icon={UserRound} value={insetStats.avgPeople} />
                    <StatValue icon={DoorClosed} value={insetStats.avgDoors} />
                  </div>
                ) : undefined
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
            Removes every turf you've cut in {zoneId === null ? "this campaign" : "this zone"},
            including any in-progress turfs. This can't be undone.
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
            <Callout tone="error" className="mb-5">
              {publishMutation.error.message}
            </Callout>
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
