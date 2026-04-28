import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { cleanCoords } from "@turf/clean-coords";
import { union } from "@turf/union";
import {
  ChevronDown,
  Copy,
  DoorClosed,
  List,
  Pencil,
  Plus,
  Scissors,
  Settings2,
  Trash2,
  UserRound,
} from "lucide-react";
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
import { Pill } from "~/components/pill";
import { KEY_GROUPS_AVAILABLE } from "~/lib/key-groups";
import { useDeferredRadioDropdown } from "~/lib/use-deferred-radio-dropdown";
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
// buttons (Configure / New / Rename / Duplicate / Delete). Left column is the three
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
  const campaignDropdown = useDeferredRadioDropdown({ onCommit: setActiveCampaignId });

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
  // drives the points-layer fetch. `isPlaceholderData` flips true
  // while we're showing the previous segment's row during a swap —
  // the `ready` predicate uses it to keep the curtain up until the
  // new segment's mapData has caught up too.
  const { data: segmentDetail, isPlaceholderData: segmentDetailStale } = useQuery({
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
  const { data: mapData, isPlaceholderData: mapDataStale } = useQuery({
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
          // Silent so this inner fetch doesn't keep the global
          // spinner up after the outer mapData query has resolved
          // (each fetchQuery is its own cache slot, so the outer
          // query's `meta: { silent: true }` doesn't propagate).
          meta: { silent: true },
        });
      }
      const keyFilter =
        zones && activeZoneGroup
          ? {
              keyGroup: activeZoneGroup.keyGroup,
              keys: Array.from(new Set(zones.flatMap((z) => z.keys))).sort(),
            }
          : null;

      // Step 2: boundary + points + per-key counts in parallel.
      // The per-key counts feed the click-zone inset (sum of door
      // and people totals across each zone's keys); shared cache
      // slot with the zone editor's overlay so visiting one warms
      // the other.
      const segmentQuery = segmentDetail?.query;
      const [boundaryFC, pointsBuffer, perKeyCounts] = await Promise.all([
        boundariesUrl
          ? fetch(boundariesUrl).then(async (res) => {
              if (!res.ok) throw new Error(`boundaries fetch failed: ${res.status}`);
              return (await res.json()) as FeatureCollection;
            })
          : Promise.resolve<FeatureCollection | null>(null),
        segmentQuery
          ? fetch("/api/query-points", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ query: segmentQuery, keyFilter }),
            }).then(async (res) => {
              if (!res.ok) {
                throw new Error(`query-points failed: ${res.status} ${await res.text()}`);
              }
              return new Float32Array(await res.arrayBuffer());
            })
          : Promise.resolve<Float32Array | null>(null),
        segmentQuery && activeZoneGroup
          ? queryClient
              .fetchQuery({
                queryKey: [
                  "countsByKey",
                  segmentQueryKey,
                  activeZoneGroup.keyGroup,
                  campaign?.zoneGroupId ?? null,
                ],
                queryFn: () =>
                  client.segments.queryCountsByKey({
                    query: segmentQuery,
                    keyGroup: activeZoneGroup.keyGroup,
                    keyFilter: keyFilter ?? undefined,
                  }),
                staleTime: 0,
                meta: { silent: true },
              })
              .then((r) => r.counts)
          : Promise.resolve<Record<string, { doors: number; people: number }> | null>(null),
      ]);
      // Carry the zoneGroupId through to the result so render code
      // can detect "the data we're showing belongs to a different
      // binding than the user is now on." That's how the curtain is
      // derived — pure render-time check, no effects, no races.
      return {
        zones,
        boundaryFC,
        pointsBuffer,
        perKeyCounts,
        zoneGroupId: campaign?.zoneGroupId ?? null,
      };
    },
    enabled: !!boundariesUrl || !!segmentDetail?.query,
    placeholderData: keepPreviousData,
    // Infinite stale: tab-back from elsewhere reuses the cached
    // triple instantly instead of paying for a half-second
    // /api/query-points refetch on every mount. Freshness is
    // preserved by invalidating ["campaign-map-data"] from the
    // zone-editing mutations in the zones editor — so edits there
    // do flow through the next time the user lands here, but
    // navigation alone doesn't.
    staleTime: Number.POSITIVE_INFINITY,
  });
  const zones = mapData?.zones ?? null;
  const boundaryFC = mapData?.boundaryFC ?? null;
  const pointsBuffer = mapData?.pointsBuffer ?? undefined;
  const perKeyCounts = mapData?.perKeyCounts ?? null;

  // Sum per-key counts across each zone's keys → per-zone totals.
  // Used by the click-zone inset.
  const zoneCounts = useMemo(() => {
    if (!perKeyCounts || !zones) return null;
    const out: Record<string, { doors: number; people: number }> = {};
    for (const z of zones) {
      let doors = 0;
      let people = 0;
      for (const k of z.keys) {
        const c = perKeyCounts[k];
        if (c) {
          doors += c.doors;
          people += c.people;
        }
      }
      out[z.zoneId] = { doors, people };
    }
    return out;
  }, [perKeyCounts, zones]);

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

  // Curtain trigger. A single render-time predicate that asks "is
  // the picture we're about to show the picture the current bindings
  // would produce?" Each stage of the load pipeline (campaigns list,
  // active campaign detail, segment detail, map data) gets a check;
  // the curtain stays opaque until every relevant stage has
  // resolved. Pure derivation — no effects, no timers, no races.
  // The Map component combines this with its own basemap+fitBounds
  // readiness internally.
  const ready = (() => {
    if (!campaigns) return false;
    if (campaigns.length === 0) return true;
    if (!campaign) return false;
    if (!campaign.segmentId && !campaign.zoneGroupId) return true;
    if (campaign.segmentId && !segmentDetail) return false;
    if (!mapData) return false;
    // A fresh segment/zone-group/script change leaves
    // `keepPreviousData` rows visible briefly while the new key's
    // fetch is in flight. Both `isPlaceholderData` flags catch that
    // — keeps the curtain up until the underlying data lines up
    // with the current bindings.
    if (segmentDetailStale) return false;
    if (mapDataStale) return false;
    if ((mapData.zoneGroupId ?? null) !== (campaign.zoneGroupId ?? null)) return false;
    return true;
  })();

  // Selected (but not yet cutting) zone. Click on a zone perimeter
  // pops an inset in the upper right with the zone name + a Cut
  // Shared between the map and the zones list: clicking a polygon
  // highlights its row in the list, clicking a row highlights the
  // polygon. Cleared by clicking the basemap or switching campaign /
  // zone group.
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);

  // Drop the selection when the active campaign or its zone group
  // changes — the zone we had selected may no longer exist in scope.
  useEffect(() => {
    setSelectedZoneId(null);
  }, [activeCampaignId, campaign?.zoneGroupId]);

  // Clicking outside the map wrapper also clears the selection. The
  // basemap-click case is already covered by `onBackgroundClick` on
  // Map; this effect handles the broader "click anywhere else on the
  // page" case (header, selector cards, etc.) so the inset doesn't
  // hang around when the user moves on.
  const mapWrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selectedZoneId) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (mapWrapperRef.current?.contains(target)) return;
      setSelectedZoneId(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [selectedZoneId]);

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

  // The modal lets the user either pick an existing zone group OR
  // construct a fresh one from a key group. The construct path
  // chains two RPCs: zoneGroups.createWithDefaultZone first to mint
  // the group + a single zone, then campaigns.create with the new
  // zoneGroupId. Wrapping the chain in one mutation keeps the
  // dialog's pending/error UX coherent (one spinner, one error
  // surface) regardless of which path the user picked.
  const createCampaign = useDialogMutation({
    mutationFn: async (input: {
      name: string;
      segmentId: string;
      scriptId: string;
      zoneGroupId: string | null;
      // When set, a fresh zone group is constructed from this key
      // group's distinct values over the segment, and that new
      // group is bound to the campaign instead of `zoneGroupId`.
      constructFromKeyGroup: string | null;
    }) => {
      let zoneGroupId = input.zoneGroupId;
      if (input.constructFromKeyGroup) {
        const zg = await client.zoneGroups.createWithDefaultZone({
          name: `${input.name} zones`,
          keyGroup: input.constructFromKeyGroup,
          segmentId: input.segmentId,
        });
        zoneGroupId = zg.zoneGroupId;
        // Refresh the zone-groups list so the new group is visible
        // if the user opens Configure later.
        void queryClient.invalidateQueries({ queryKey: ["zoneGroups"] });
      }
      return client.campaigns.create({
        name: input.name,
        segmentId: input.segmentId,
        scriptId: input.scriptId,
        zoneGroupId,
      });
    },
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

  // Configure modal owns its own open state; the bind() commit happens
  // through the same updateCampaignMutation as before, so opening the
  // modal is just a UI thing — no extra mutation wrapper needed.
  const [configOpen, setConfigOpen] = useState(false);

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
          <DropdownMenu {...campaignDropdown.menu}>
            <DropdownMenuTrigger render={<Button variant="outline" />}>
              <List className="size-3.5" />
              <span className={activeCampaign ? undefined : "invisible"}>
                {activeCampaign?.name ?? "—"}
              </span>
              <ChevronDown className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuRadioGroup {...campaignDropdown.radio} value={activeCampaignId ?? ""}>
                {campaigns?.map((c) => (
                  <DropdownMenuRadioItem key={c.campaignId} value={c.campaignId}>
                    {c.name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" onClick={() => setConfigOpen(true)} disabled={!activeCampaign}>
            <Settings2 />
            Configure
          </Button>
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
            Duplicate
          </Button>
          <Button variant="outline" onClick={deleteCampaign.open} disabled={!activeCampaign}>
            <Trash2 />
            Delete
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 h-[calc(100vh-9.75rem)]">
        {/* Zones list — clicking a row syncs to the map's
            selectedZone (highlights the polygon); clicking the Cut
            button on a row jumps straight to the cutter. Status
            badges are placeholders until cut/publish state lands. */}
        {/* Fade the list to match the map curtain — same `ready`
            predicate, same 150ms duration. While transitioning
            between campaigns the previous campaign's zones are
            still in the cache (keepPreviousData), so we don't
            unmount, we just hide them; fade-in on the new side
            shows the new list. */}
        <div
          className={cn(
            "h-full min-h-0 transition-opacity duration-150",
            ready ? "opacity-100" : "opacity-0",
          )}
        >
          <ZonesList
            zones={zones}
            selectedZoneId={selectedZoneId}
            zoneCounts={zoneCounts}
            onSelect={setSelectedZoneId}
            onCut={(zoneId) => {
              if (!activeCampaignId) return;
              void navigate({
                to: "/campaigns/$campaignId/cut/$zoneId",
                params: { campaignId: activeCampaignId, zoneId },
              });
            }}
          />
        </div>

        <div ref={mapWrapperRef} className="relative h-full">
          <Map
            className="h-full"
            points={pointsBuffer}
            zonePerimeters={zonePerimeters}
            fitBounds={fitBounds}
            selectedZoneId={selectedZoneId}
            onZoneClick={(zoneId) => setSelectedZoneId(zoneId)}
            onBackgroundClick={() => setSelectedZoneId(null)}
            loading={!ready}
          />
        </div>
      </div>

      <CreateCampaignDialog
        open={createCampaign.isOpen}
        onOpenChange={createCampaign.onOpenChange}
        pending={createCampaign.isPending}
        error={createCampaign.error}
        segmentOptions={(segments ?? []).map((s) => ({ value: s.segmentId, label: s.name }))}
        zoneGroupOptions={(zoneGroups ?? []).map((g) => ({ value: g.zoneGroupId, label: g.name }))}
        scriptOptions={(scripts ?? []).map((s) => ({ value: s.scriptId, label: s.name }))}
        onSubmit={(values) => createCampaign.mutate(values)}
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

      <ConfigureDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        currentSegmentId={campaign?.segmentId ?? null}
        currentZoneGroupId={campaign?.zoneGroupId ?? null}
        currentScriptId={campaign?.scriptId ?? null}
        segmentOptions={(segments ?? []).map((s) => ({ value: s.segmentId, label: s.name }))}
        zoneGroupOptions={(zoneGroups ?? []).map((g) => ({ value: g.zoneGroupId, label: g.name }))}
        scriptOptions={(scripts ?? []).map((s) => ({ value: s.scriptId, label: s.name }))}
        onSubmit={(patch) => {
          bind(patch);
          setConfigOpen(false);
        }}
      />
    </>
  );
}

// Right-pane list of zones for the active campaign. Rows mirror the
// shape of the click-zone inset on the map — name on the left,
// status pills + Cut button on the right — so users have two
// equivalent paths into the cutter (click the polygon, click the
// row).
//
// Cut/published/stale status pills are placeholders until the
// per-zone cut state lands on the backend.
function ZonesList({
  zones,
  selectedZoneId,
  zoneCounts,
  onSelect,
  onCut,
}: {
  zones: Awaited<ReturnType<typeof client.zones.list>> | null;
  selectedZoneId: string | null;
  zoneCounts: Record<string, { doors: number; people: number }> | null;
  onSelect: (zoneId: string) => void;
  onCut: (zoneId: string) => void;
}) {
  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto">
      {zones?.map((zone, idx) => (
        <ZoneRow
          key={zone.zoneId}
          zone={zone}
          // Same colorFor(idx) used by the map's perimeter fill and
          // the zones editor's sidebar swatches — keeps the visual
          // identity of each zone consistent across surfaces.
          color={colorFor(idx)}
          selected={zone.zoneId === selectedZoneId}
          counts={zoneCounts?.[zone.zoneId] ?? null}
          onSelect={() => onSelect(zone.zoneId)}
          onCut={() => onCut(zone.zoneId)}
        />
      ))}
    </div>
  );
}

function ZoneRow({
  zone,
  color,
  selected,
  counts,
  onSelect,
  onCut,
}: {
  zone: { zoneId: string; name: string };
  color: string;
  selected: boolean;
  counts: { doors: number; people: number } | null;
  onSelect: () => void;
  onCut: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "flex items-center gap-2 rounded-md border bg-card py-2 pr-2 pl-3 text-left",
        selected ? "border-foreground" : "border-border hover:border-muted-foreground",
      )}
    >
      <span
        aria-hidden
        className="mr-1 size-3 shrink-0 rounded-sm border border-border"
        style={{ backgroundColor: color }}
      />
      <span className="flex-1 truncate text-sm">{zone.name}</span>
      {counts ? (
        <>
          <Pill variant="number" className="!w-fit shrink-0 gap-1.5">
            <DoorClosed className="size-3.5 text-foreground" />
            {counts.doors.toLocaleString()}
          </Pill>
          <Pill variant="number" className="!w-fit shrink-0 gap-1.5">
            <UserRound className="size-3.5 text-foreground" />
            {counts.people.toLocaleString()}
          </Pill>
        </>
      ) : null}
      {/* Status pill — placeholder. When cut state lands this swaps
          between "uncut" / "cut" / "published" with the appropriate
          variant. Sits next to the Cut button so the action and the
          state it'll change are colocated. */}
      <Pill variant="text" className="!w-fit shrink-0">
        Uncut
      </Pill>
      <Button
        size="sm"
        variant="outline"
        onClick={(e) => {
          // Stop the row's onClick from also firing (which would
          // re-select what's already implicitly selected and is
          // confusing in screen readers).
          e.stopPropagation();
          onCut();
        }}
      >
        <Scissors />
        Cut
      </Button>
    </div>
  );
}

// Inline button-toggle for the New Campaign modal's "Define from"
// field — only renders when the user has chosen "Define
// automatically" in the Zones dropdown above. Same pill style as
// the enum-filter buttons in the segments editor for visual
// consistency.
function KeyGroupRadio({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {KEY_GROUPS_AVAILABLE.map((kg) => {
        const selected = value === kg.value;
        return (
          <button
            type="button"
            key={kg.value}
            onClick={() => onChange(kg.value)}
            className={cn(
              "rounded-md border px-2.5 py-1 text-sm",
              selected
                ? "border-foreground bg-foreground/10"
                : "border-border bg-background hover:border-muted-foreground",
            )}
          >
            {kg.label}
          </button>
        );
      })}
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
  segmentOptions,
  zoneGroupOptions,
  scriptOptions,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  error: string | null;
  segmentOptions: ReadonlyArray<SelectOption>;
  zoneGroupOptions: ReadonlyArray<SelectOption>;
  scriptOptions: ReadonlyArray<SelectOption>;
  onSubmit: (values: {
    name: string;
    segmentId: string;
    scriptId: string;
    zoneGroupId: string | null;
    constructFromKeyGroup: string | null;
  }) => void;
}) {
  const [name, setName] = useState("");
  const [segmentId, setSegmentId] = useState<string | null>(null);
  const [scriptId, setScriptId] = useState<string | null>(null);
  // Two paths for the "Zones" binding folded into a single
  // dropdown: a sentinel "Define automatically" entry sits above
  // the existing zone groups, and selecting it reveals a key-group
  // segmented control below. No default — the user must pick a
  // path explicitly. The key-group radio is conditional on
  // auto-mode, so it doesn't draw attention until it's relevant.
  const [zonesValue, setZonesValue] = useState<string | null>(null);
  const [constructKeyGroup, setConstructKeyGroup] = useState<string>(
    KEY_GROUPS_AVAILABLE[0]!.value,
  );
  // Reset all fields each time the dialog opens.
  useEffect(() => {
    if (open) {
      setName("");
      setSegmentId(null);
      setScriptId(null);
      setZonesValue(null);
      setConstructKeyGroup(KEY_GROUPS_AVAILABLE[0]!.value);
    }
  }, [open]);

  const isAuto = zonesValue === AUTO_ZONES_SENTINEL;
  const zonesOptions: ReadonlyArray<SelectOption> = [
    { value: AUTO_ZONES_SENTINEL, label: "Define automatically" },
    ...zoneGroupOptions,
  ];
  const validZones = zonesValue !== null && (!isAuto || constructKeyGroup !== "");
  const valid = name.trim().length > 0 && segmentId !== null && scriptId !== null && validZones;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Create new campaign</DialogTitle>
        <DialogDescription>
          A campaign combines a segment (people), a group of zones (geography), and a script
          (questions). Choices can be edited later via Configure.
        </DialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || pending) return;
            onSubmit({
              name: name.trim(),
              segmentId: segmentId!,
              scriptId: scriptId!,
              zoneGroupId: isAuto ? null : zonesValue,
              constructFromKeyGroup: isAuto ? constructKeyGroup : null,
            });
          }}
          className="flex flex-col gap-3"
        >
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-muted-foreground">Name</label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter a name..."
              disabled={pending}
            />
          </div>
          <ConfigField
            label="Segment"
            placeholder="Pick a segment…"
            value={segmentId}
            options={segmentOptions}
            onChange={setSegmentId}
          />
          <ConfigField
            label="Zones"
            placeholder="Pick a zone group…"
            value={zonesValue}
            options={zonesOptions}
            onChange={setZonesValue}
          />
          {isAuto ? (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm text-muted-foreground">Define from</label>
              <KeyGroupRadio value={constructKeyGroup} onChange={setConstructKeyGroup} />
            </div>
          ) : null}
          <ConfigField
            label="Script"
            placeholder="Pick a script…"
            value={scriptId}
            options={scriptOptions}
            onChange={setScriptId}
          />
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

// Bindings editor — segment, zone group, script in one form. Local
// draft state is initialised from the props on open and committed
// only on Save, so users can experiment without writing partial
// state through to the campaign. Eventually the place to surface
// "this change will invalidate N cut zones" warnings, hence its own
// dialog rather than reusing the management buttons' dialog
// machinery.
type SelectOption = { value: string; label: string };

// Sentinel value the New Campaign modal's "Zones" dropdown uses to
// represent "construct a fresh zone group from a key group" — sits
// alongside real zone-group ids in the same dropdown so the user
// can pick existing-or-auto in one click. Picked to be impossible
// as a real zone group id (UUIDs are 36 chars, this isn't).
const AUTO_ZONES_SENTINEL = "__auto__";

function ConfigureDialog({
  open,
  onOpenChange,
  currentSegmentId,
  currentZoneGroupId,
  currentScriptId,
  segmentOptions,
  zoneGroupOptions,
  scriptOptions,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentSegmentId: string | null;
  currentZoneGroupId: string | null;
  currentScriptId: string | null;
  segmentOptions: ReadonlyArray<SelectOption>;
  zoneGroupOptions: ReadonlyArray<SelectOption>;
  scriptOptions: ReadonlyArray<SelectOption>;
  onSubmit: (patch: {
    segmentId: string | null;
    zoneGroupId: string | null;
    scriptId: string | null;
  }) => void;
}) {
  const [segmentId, setSegmentId] = useState(currentSegmentId);
  const [zoneGroupId, setZoneGroupId] = useState(currentZoneGroupId);
  const [scriptId, setScriptId] = useState(currentScriptId);

  // Re-sync drafts whenever the dialog opens — the user might have
  // edited bindings via some other path (or switched campaigns)
  // since the last open. Only running on `open` true→ avoids
  // clobbering in-progress edits while the dialog is up.
  useEffect(() => {
    if (open) {
      setSegmentId(currentSegmentId);
      setZoneGroupId(currentZoneGroupId);
      setScriptId(currentScriptId);
    }
  }, [open, currentSegmentId, currentZoneGroupId, currentScriptId]);

  const dirty =
    segmentId !== currentSegmentId ||
    zoneGroupId !== currentZoneGroupId ||
    scriptId !== currentScriptId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Configure campaign</DialogTitle>
        <DialogDescription>
          A campaign combines a segment (people), a group of zones (geography), and a script
          (quesitons). You can change the choices here.
        </DialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!dirty) {
              onOpenChange(false);
              return;
            }
            onSubmit({ segmentId, zoneGroupId, scriptId });
          }}
          className="mt-2 flex flex-col gap-3"
        >
          <ConfigField
            label="Segment"
            placeholder="Pick a segment…"
            value={segmentId}
            options={segmentOptions}
            onChange={setSegmentId}
          />
          <ConfigField
            label="Zones"
            placeholder="Pick a zone group…"
            value={zoneGroupId}
            options={zoneGroupOptions}
            onChange={setZoneGroupId}
          />
          <ConfigField
            label="Script"
            placeholder="Pick a script…"
            value={scriptId}
            options={scriptOptions}
            onChange={setScriptId}
          />
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!dirty}>
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConfigField({
  label,
  placeholder,
  value,
  options,
  onChange,
}: {
  // Empty string suppresses the label — used for the "Zones"
  // composite field where the radio toggle owns the label slot
  // and the dropdown sits unlabeled below it.
  label: string;
  placeholder: string;
  value: string | null;
  options: ReadonlyArray<SelectOption>;
  onChange: (value: string | null) => void;
}) {
  const dd = useDeferredRadioDropdown({ onCommit: (v) => onChange(v || null) });
  const current = options.find((o) => o.value === value);
  return (
    <div className="flex flex-col gap-1.5">
      {label ? <label className="text-sm text-muted-foreground">{label}</label> : null}
      <DropdownMenu {...dd.menu}>
        <DropdownMenuTrigger
          className={cn(
            "flex w-full items-center justify-between gap-1 rounded-md border border-border bg-background px-2 py-1 text-sm",
            "enabled:hover:border-muted-foreground",
          )}
        >
          <span className="truncate">{current?.label ?? placeholder}</span>
          <ChevronDown className="size-3.5 shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[var(--anchor-width)]">
          <DropdownMenuRadioGroup {...dd.radio} value={value ?? ""}>
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
