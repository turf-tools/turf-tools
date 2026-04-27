import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { cleanCoords } from "@turf/clean-coords";
import { union } from "@turf/union";
import { ChevronDown, Copy, Pencil, Plus, Scissors, Trash2 } from "lucide-react";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "~/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "~/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/components/dropdown-menu";
import { Input } from "~/components/input";
import { Map } from "~/components/map";
import { useDialogMutation } from "~/lib/use-dialog-mutation";
import { cn } from "~/lib/utils";
import { colorFor } from "~/lib/zone-colors";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/campaigns/")({
  component: CampaignsIndex,
});

// Walks every coord in a polygon/multipolygon FeatureCollection and
// returns its [minLng, minLat, maxLng, maxLat]. Inlined to avoid a
// dep on @turf/bbox for one straightforward loop.
function bboxOfPolys(fc: FeatureCollection): [number, number, number, number] | null {
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
  for (const f of fc.features) {
    const g = f.geometry;
    if (g.type === "Polygon") {
      for (const ring of g.coordinates) for (const c of ring) visit(c);
    } else if (g.type === "MultiPolygon") {
      for (const poly of g.coordinates) for (const ring of poly) for (const c of ring) visit(c);
    }
  }
  return touched ? [minLng, minLat, maxLng, maxLat] : null;
}

// Campaign editor: a single-item editor (mirrors segments / zones) for
// the campaign that binds together a segment, a zone group, and a
// script. Top bar carries the active-campaign selector + management
// buttons (New / Rename / Save as / Delete). Left column is the three
// FK selectors. Right pane is a map showing the segment's points and
// the zone group's zone perimeters; clicking a zone perimeter pops a
// "Cut" inset that navigates to the turf-cutter route
// (/campaigns/$campaignId/cut/$zoneId).

function CampaignsIndex() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data: campaigns } = useQuery({
    queryKey: ["campaigns"],
    queryFn: () => client.campaigns.list(),
    placeholderData: keepPreviousData,
  });

  const [activeCampaignId, setActiveCampaignId] = useState<string | null>(null);
  const [campaignDropdownOpen, setCampaignDropdownOpen] = useState(false);
  const pendingValueRef = useRef<string | undefined>(undefined);

  // Default to the first campaign once the list loads.
  useEffect(() => {
    if (!activeCampaignId && campaigns && campaigns.length > 0) {
      setActiveCampaignId(campaigns[0].campaignId);
    }
  }, [campaigns, activeCampaignId]);

  const activeCampaign = campaigns?.find((c) => c.campaignId === activeCampaignId) ?? null;

  // Pull the active campaign's row directly. The list payload already
  // carries every FK we need, but a per-campaign query gives us a
  // cache slot to update optimistically when the user changes a
  // binding without invalidating the whole list.
  const { data: activeCampaignDetail } = useQuery({
    queryKey: ["campaign", activeCampaignId],
    queryFn: () => client.campaigns.getById({ campaignId: activeCampaignId! }),
    enabled: !!activeCampaignId,
    placeholderData: keepPreviousData,
  });
  const campaign = activeCampaignDetail ?? activeCampaign;

  // Reference data for the three selectors.
  const { data: segments } = useQuery({
    queryKey: ["segments"],
    queryFn: () => client.segments.list(),
    placeholderData: keepPreviousData,
  });
  const { data: zoneGroups } = useQuery({
    queryKey: ["zoneGroups"],
    queryFn: () => client.zoneGroups.list(),
    placeholderData: keepPreviousData,
  });
  const { data: scripts } = useQuery({
    queryKey: ["scripts"],
    queryFn: () => client.script.list(),
    placeholderData: keepPreviousData,
  });

  const activeZoneGroup = zoneGroups?.find((g) => g.zoneGroupId === campaign?.zoneGroupId) ?? null;

  // Pull the bound segment's full row to get its query JSON, which
  // drives the points-layer fetch.
  const { data: segmentDetail } = useQuery({
    queryKey: ["segment", campaign?.segmentId],
    queryFn: () => client.segments.getById({ segmentId: campaign!.segmentId! }),
    enabled: !!campaign?.segmentId,
    placeholderData: keepPreviousData,
  });

  const boundariesUrl = activeZoneGroup
    ? `${import.meta.env.VITE_DATA_URL}/key-groups/${activeZoneGroup.keyGroup}/geojson?v=${new Date(activeZoneGroup.updatedAt).getTime()}`
    : null;

  // Single coordinated fetch for everything the map needs to render:
  // the zone group's zones, its boundary GeoJSON, and the segment's
  // points (clipped to the zone group's scope when one is bound).
  // Unifying these into one query is what keeps the map flip atomic
  // — separate queries used to race, briefly showing new zones
  // against an old boundary (mismatched keys → empty perimeters)
  // until the slower fetch caught up. `keepPreviousData` keeps the
  // last-good triple visible during the swap.
  //
  // Zones are fetched via `queryClient.fetchQuery` so the cache slot
  // is shared with the zone editor — visiting one editor warms the
  // other. The boundary GeoJSON is a static immutable URL, so the
  // browser HTTP cache makes the second fetch free.
  const segmentQueryKey = segmentDetail?.query ? JSON.stringify(segmentDetail.query) : null;
  const { data: mapData } = useQuery({
    queryKey: [
      "campaign-map-data",
      segmentQueryKey,
      campaign?.zoneGroupId ?? null,
      activeZoneGroup?.keyGroup ?? null,
      activeZoneGroup ? new Date(activeZoneGroup.updatedAt).getTime() : null,
    ],
    queryFn: async () => {
      // Step 1: zones (we need scope keys before firing /api/query-points).
      let zones: Awaited<ReturnType<typeof client.zones.list>> | null = null;
      if (campaign?.zoneGroupId) {
        zones = await queryClient.fetchQuery({
          queryKey: ["zones", campaign.zoneGroupId],
          queryFn: () => client.zones.list({ zoneGroupId: campaign.zoneGroupId! }),
          staleTime: 0,
        });
      }
      const keyFilter =
        zones && activeZoneGroup
          ? {
              keyGroup: activeZoneGroup.keyGroup,
              keys: Array.from(new Set(zones.flatMap((z) => z.keys))).sort(),
            }
          : null;

      // Step 2: boundary + points in parallel.
      const [boundaryFC, pointsBuffer] = await Promise.all([
        boundariesUrl
          ? fetch(boundariesUrl).then(async (res) => {
              if (!res.ok) throw new Error(`boundaries fetch failed: ${res.status}`);
              return (await res.json()) as FeatureCollection;
            })
          : Promise.resolve<FeatureCollection | null>(null),
        segmentDetail?.query
          ? fetch("/api/query-points", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ query: segmentDetail.query, keyFilter }),
            }).then(async (res) => {
              if (!res.ok) {
                throw new Error(`query-points failed: ${res.status} ${await res.text()}`);
              }
              return new Float32Array(await res.arrayBuffer());
            })
          : Promise.resolve<Float32Array | null>(null),
      ]);
      // Carry the zoneGroupId through to the result so render code
      // can detect "the data we're showing belongs to a different
      // binding than the user is now on." That's how the curtain is
      // derived — pure render-time check, no effects, no races.
      return { zones, boundaryFC, pointsBuffer, zoneGroupId: campaign?.zoneGroupId ?? null };
    },
    enabled: !!boundariesUrl || !!segmentDetail?.query,
    placeholderData: keepPreviousData,
    // Default staleTime (0) so zone edits made in the zone editor are
    // picked up when the user lands here. `keepPreviousData` covers
    // the swap; the cost of an extra fetch on remount is small and
    // outweighed by avoiding a "why isn't my edit showing" trap.
    //
    // `silent` keeps the global LoadingIndicator out of this query —
    // the curtain over the map is the loading affordance for it,
    // and double-signaling (curtain + spinner) is confusing,
    // especially because the curtain hides earlier than `isFetching`
    // settles when cache hits short-circuit the visible wait.
    meta: { silent: true },
  });
  const zones = mapData?.zones ?? null;
  const boundaryFC = mapData?.boundaryFC ?? null;
  const pointsBuffer = mapData?.pointsBuffer ?? undefined;

  // One unioned polygon per zone, tagged with `zoneId`. Map renders
  // these as a click-target layer that dispatches into the cutter.
  // Single-key zones short-circuit union (turf.union returns null
  // for degenerate inputs in some versions).
  const zonePerimeters = useMemo<FeatureCollection | undefined>(() => {
    if (!zones || !boundaryFC) return undefined;
    const featuresByKey: Record<string, Feature<Polygon | MultiPolygon>> = {};
    for (const f of boundaryFC.features) {
      const k = f.properties?.key;
      if (
        typeof k === "string" &&
        (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
      ) {
        featuresByKey[k] = f as Feature<Polygon | MultiPolygon>;
      }
    }
    const out: Feature[] = [];
    zones.forEach((zone, idx) => {
      const polys = zone.keys
        .map((k) => featuresByKey[k])
        .filter((f): f is Feature<Polygon | MultiPolygon> => !!f);
      if (polys.length === 0) return;
      const raw =
        polys.length === 1
          ? polys[0]!
          : (union({ type: "FeatureCollection", features: polys }) ?? polys[0]!);
      // turf.union output sometimes carries near-duplicate vertices
      // along input-polygon shared edges; cleanCoords drops the
      // redundant points. Doesn't fully eliminate the dark-triangle
      // tessellation artifact we saw at certain zoom levels (that
      // probably needs server-side ST_Union via DuckDB's GEOS to
      // really clean up), but is cheap defensive hygiene.
      const merged = cleanCoords(raw) as Feature<Polygon | MultiPolygon>;
      // `color` matches the zone editor's per-zone hue (same `colorFor`
      // index → same color across both surfaces).
      out.push({
        ...merged,
        properties: { zoneId: zone.zoneId, name: zone.name, color: colorFor(idx) },
      });
    });
    return { type: "FeatureCollection", features: out };
  }, [zones, boundaryFC]);

  // BBox of all zone perimeters — passed to Map so it fits the viewport
  // to the campaign scope each time we get a fresh perimeter set.
  const fitBounds = useMemo(
    () => (zonePerimeters ? bboxOfPolys(zonePerimeters) : null),
    [zonePerimeters],
  );

  // The Map fires `onLoaded` after MapLibre's `load` event AND its
  // initial fitBounds is applied. Until that happens, the basemap is
  // either still loading tiles or sitting at the default view, so
  // the curtain has to keep covering it even when the data is
  // already cached.
  const [mapLoaded, setMapLoaded] = useState(false);

  // White curtain trigger. A single render-time predicate that asks
  // "is the picture we're about to show the picture the current
  // bindings would produce, on a map that's actually settled?" Each
  // stage of the load pipeline (campaigns list, active campaign
  // detail, segment detail, map data, map mount/fit) gets a check;
  // the curtain stays opaque until every relevant stage has
  // resolved. Pure derivation — no effects, no timers, no races.
  const ready = (() => {
    if (!mapLoaded) return false;
    if (!campaigns) return false;
    if (campaigns.length === 0) return true;
    if (!campaign) return false;
    if (!campaign.segmentId && !campaign.zoneGroupId) return true;
    if (campaign.segmentId && !segmentDetail) return false;
    if (!mapData) return false;
    if ((mapData.zoneGroupId ?? null) !== (campaign.zoneGroupId ?? null)) return false;
    return true;
  })();
  const transitioning = !ready;

  // Selected (but not yet cutting) zone. Click on a zone perimeter
  // pops an inset in the upper right with the zone name + a Cut
  // button — gives the user a confirmation moment before committing
  // to the cutter, and matches the zones editor's click-a-key
  // popup pattern. Cleared by clicking the basemap, switching to a
  // different zone, or campaign/zoneGroup change.
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const selectedZone = zones?.find((z) => z.zoneId === selectedZoneId) ?? null;

  // Drop the selection when the active campaign or its zone group
  // changes — the zone we had selected may no longer exist in scope.
  useEffect(() => {
    setSelectedZoneId(null);
  }, [activeCampaignId, campaign?.zoneGroupId]);

  // Mutations.

  const updateCampaignMutation = useMutation({
    mutationFn: (input: {
      campaignId: string;
      segmentId?: string | null;
      zoneGroupId?: string | null;
      scriptId?: string | null;
    }) => client.campaigns.update(input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: ["campaign", input.campaignId] });
      const previous = queryClient.getQueryData(["campaign", input.campaignId]);
      queryClient.setQueryData(
        ["campaign", input.campaignId],
        (old: Record<string, unknown> | null | undefined) => {
          if (!old) return old;
          const next = { ...old };
          if (input.segmentId !== undefined) next.segmentId = input.segmentId;
          if (input.zoneGroupId !== undefined) next.zoneGroupId = input.zoneGroupId;
          if (input.scriptId !== undefined) next.scriptId = input.scriptId;
          return next;
        },
      );
      return { previous };
    },
    onError: (e, input, ctx) => {
      console.error("campaigns.update failed", e);
      if (ctx?.previous) queryClient.setQueryData(["campaign", input.campaignId], ctx.previous);
    },
  });

  const renameCampaign = useDialogMutation({
    mutationFn: (input: { campaignId: string; name: string }) => client.campaigns.rename(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["campaigns"] }),
  });

  const createCampaign = useDialogMutation({
    mutationFn: (input: { name: string }) => client.campaigns.create(input),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      setActiveCampaignId(created.campaignId);
    },
  });

  const cloneCampaign = useDialogMutation({
    mutationFn: (input: { campaignId: string; newName: string }) => client.campaigns.clone(input),
    onSuccess: ({ campaignId }) => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      setActiveCampaignId(campaignId);
    },
  });

  const deleteCampaign = useDialogMutation({
    mutationFn: (campaignId: string) => client.campaigns.remove({ campaignId }),
    onSuccess: (_res, deletedId) => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      const next = campaigns?.find((c) => c.campaignId !== deletedId);
      setActiveCampaignId(next?.campaignId ?? null);
    },
  });

  // Selector commits — write through `update` for each FK independently.
  const bind = (patch: {
    segmentId?: string | null;
    zoneGroupId?: string | null;
    scriptId?: string | null;
  }) => {
    if (!activeCampaignId) return;
    updateCampaignMutation.mutate({ campaignId: activeCampaignId, ...patch });
  };

  return (
    <>
      <div className="mb-4 flex h-8 items-center justify-between">
        <h1 className="text-xl font-extrabold tracking-wide italic">Campaign Editor</h1>
        <div className="flex items-center gap-2">
          <DropdownMenu
            open={campaignDropdownOpen}
            onOpenChange={setCampaignDropdownOpen}
            onOpenChangeComplete={(isOpen) => {
              if (!isOpen && pendingValueRef.current !== undefined) {
                const v = pendingValueRef.current;
                pendingValueRef.current = undefined;
                setActiveCampaignId(v);
              }
            }}
          >
            <DropdownMenuTrigger render={<Button variant="outline" />}>
              <span>{activeCampaign?.name ?? "—"}</span>
              <ChevronDown className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuRadioGroup
                value={activeCampaignId ?? ""}
                onValueChange={(v) => {
                  pendingValueRef.current = v;
                  setCampaignDropdownOpen(false);
                }}
              >
                {campaigns?.map((c) => (
                  <DropdownMenuRadioItem key={c.campaignId} value={c.campaignId}>
                    {c.name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" onClick={createCampaign.open}>
            <Plus />
            New
          </Button>
          <Button variant="outline" onClick={renameCampaign.open} disabled={!activeCampaign}>
            <Pencil />
            Rename
          </Button>
          <Button variant="outline" onClick={cloneCampaign.open} disabled={!activeCampaign}>
            <Copy />
            Save as
          </Button>
          <Button variant="outline" onClick={deleteCampaign.open} disabled={!activeCampaign}>
            <Trash2 />
            Delete
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 h-[calc(100vh-9.75rem)]">
        <div className="col-span-1 flex flex-col gap-3 overflow-y-auto">
          <SelectorCard
            label="Segment"
            placeholder="Pick a segment…"
            value={campaign?.segmentId ?? null}
            options={(segments ?? []).map((s) => ({ value: s.segmentId, label: s.name }))}
            onChange={(v) => bind({ segmentId: v })}
            disabled={!activeCampaign}
          />
          <SelectorCard
            label="Zone group"
            placeholder="Pick a zone group…"
            value={campaign?.zoneGroupId ?? null}
            options={(zoneGroups ?? []).map((g) => ({
              value: g.zoneGroupId,
              label: g.name,
            }))}
            onChange={(v) => bind({ zoneGroupId: v })}
            disabled={!activeCampaign}
          />
          <SelectorCard
            label="Script"
            placeholder="Pick a script…"
            value={campaign?.scriptId ?? null}
            options={(scripts ?? []).map((s) => ({ value: s.scriptId, label: s.name }))}
            onChange={(v) => bind({ scriptId: v })}
            disabled={!activeCampaign}
          />
        </div>
        <div className="relative col-span-2 h-full overflow-hidden rounded-lg border border-border">
          <Map
            className="h-full"
            points={pointsBuffer}
            zonePerimeters={zonePerimeters}
            fitBounds={fitBounds}
            onZoneClick={(zoneId) => setSelectedZoneId(zoneId)}
            onBackgroundClick={() => setSelectedZoneId(null)}
            onLoaded={() => setMapLoaded(true)}
          />
          {selectedZone ? (
            <div
              className={cn(
                "absolute top-3 right-3 z-10 flex flex-col items-end gap-2",
                "rounded-md border border-border bg-card/95 px-3 py-2 text-sm shadow-sm backdrop-blur",
              )}
            >
              <span>{selectedZone.name}</span>
              <Button
                size="sm"
                onClick={() => {
                  if (!activeCampaignId) return;
                  void navigate({
                    to: "/campaigns/$campaignId/cut/$zoneId",
                    params: { campaignId: activeCampaignId, zoneId: selectedZone.zoneId },
                  });
                }}
              >
                <Scissors />
                Cut
              </Button>
            </div>
          ) : null}
          {/* White curtain over the map while it's resolving the
                  next data triple (zones + boundary + points) and
                  fitting the viewport. Hides the piecewise reveal of
                  the points layer arriving before the perimeter
                  layer, the basemap pan, etc. */}
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-0 bg-background",
              "transition-opacity duration-150",
              transitioning ? "opacity-100" : "opacity-0",
            )}
          />
        </div>
      </div>

      <CreateCampaignDialog
        open={createCampaign.isOpen}
        onOpenChange={createCampaign.onOpenChange}
        pending={createCampaign.isPending}
        error={createCampaign.error}
        onSubmit={(name) => createCampaign.mutate({ name })}
      />

      <SaveAsDialog
        open={cloneCampaign.isOpen}
        onOpenChange={cloneCampaign.onOpenChange}
        defaultName={activeCampaign ? `${activeCampaign.name} (copy)` : ""}
        pending={cloneCampaign.isPending}
        error={cloneCampaign.error}
        onSubmit={(newName) => {
          if (!activeCampaignId) return;
          cloneCampaign.mutate({ campaignId: activeCampaignId, newName });
        }}
      />

      <RenameDialog
        open={renameCampaign.isOpen}
        onOpenChange={renameCampaign.onOpenChange}
        currentName={activeCampaign?.name ?? ""}
        pending={renameCampaign.isPending}
        error={renameCampaign.error}
        onSubmit={(name) => {
          if (!activeCampaignId) return;
          renameCampaign.mutate({ campaignId: activeCampaignId, name });
        }}
      />

      <DeleteDialog
        open={deleteCampaign.isOpen}
        onOpenChange={deleteCampaign.onOpenChange}
        campaignName={activeCampaign?.name ?? ""}
        pending={deleteCampaign.isPending}
        error={deleteCampaign.error}
        onConfirm={() => {
          if (!activeCampaignId) return;
          deleteCampaign.mutate(activeCampaignId);
        }}
      />
    </>
  );
}

function SelectorCard({
  label,
  placeholder,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  placeholder: string;
  value: string | null;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <div className="rounded-md border border-border bg-card px-3 py-3">
      <div className="mb-1.5 text-muted-foreground text-sm">{label}</div>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          disabled={disabled}
          className={cn(
            "flex w-full items-center justify-between gap-1 rounded-md border border-border bg-background px-2 py-1 text-sm",
            "disabled:cursor-not-allowed disabled:opacity-50",
            "enabled:hover:border-muted-foreground",
          )}
        >
          <span className="truncate">{current?.label ?? placeholder}</span>
          <ChevronDown className="size-3.5 shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup
            value={value ?? ""}
            onValueChange={(v) => {
              onChange(v || null);
              setOpen(false);
            }}
          >
            {options.map((o) => (
              <DropdownMenuRadioItem key={o.value} value={o.value}>
                {o.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function DialogError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div
      className={cn(
        "rounded-md border border-destructive/40 bg-destructive/10",
        "px-3 py-2 text-sm text-destructive",
      )}
    >
      {error}
    </div>
  );
}

function CreateCampaignDialog({
  open,
  onOpenChange,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  error: string | null;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState("");
  useEffect(() => {
    if (open) setName("");
  }, [open]);
  const valid = name.trim().length > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Create new campaign</DialogTitle>
        <DialogDescription>
          A campaign binds a segment, a zone group, and a script for a fixed run of canvassing.
          Start with a name and pick the bindings in the editor.
        </DialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || pending) return;
            onSubmit(name.trim());
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter a name..."
              disabled={pending}
            />
          </div>
          <DialogError error={error} />
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!valid} loading={pending}>
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SaveAsDialog({
  open,
  onOpenChange,
  defaultName,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultName: string;
  pending: boolean;
  error: string | null;
  onSubmit: (newName: string) => void;
}) {
  const [name, setName] = useState(defaultName);
  useEffect(() => {
    if (open) setName(defaultName);
  }, [open, defaultName]);
  const valid = name.trim().length > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Duplicate campaign</DialogTitle>
        <DialogDescription>
          Creates a copy of the current campaign, including its bindings.
        </DialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || pending) return;
            onSubmit(name.trim());
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={pending}
            />
          </div>
          <DialogError error={error} />
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!valid} loading={pending}>
              Duplicate
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({
  open,
  onOpenChange,
  currentName,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentName: string;
  pending: boolean;
  error: string | null;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(currentName);
  useEffect(() => {
    if (open) setName(currentName);
  }, [open, currentName]);
  const valid = name.trim().length > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Rename campaign</DialogTitle>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || pending) return;
            onSubmit(name.trim());
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5 mt-3">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={pending}
            />
          </div>
          <DialogError error={error} />
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!valid} loading={pending}>
              Rename
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  open,
  onOpenChange,
  campaignName,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaignName: string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Delete campaign?</DialogTitle>
        <DialogDescription>
          Permanently deletes <span className="font-medium text-foreground">{campaignName}</span>.
          This can't be undone.
        </DialogDescription>
        <DialogError error={error} />
        <div className="mt-2 flex justify-end gap-2">
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={onConfirm} loading={pending}>
            Delete campaign
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
