import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { cleanCoords } from "@turf/clean-coords";
import { union } from "@turf/union";
import {
  ChevronDown,
  CircleDotDashed,
  Copy,
  DoorClosed,
  List,
  Pencil,
  Plus,
  Scissors,
  Send,
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
import { boundariesGeoJsonQuery } from "~/lib/queries/boundaries";
import {
  campaignDetailQuery,
  campaignKeyCountsQuery,
  campaignPointsQuery,
  campaignsListQuery,
  type KeyFilter,
} from "~/lib/queries/campaigns";
import { scriptsListQuery } from "~/lib/queries/scripts";
import {
  type SegmentCriteria,
  segmentDetailQuery,
  segmentsListQuery,
} from "~/lib/queries/segments";
import { turfStatsForCampaignQuery } from "~/lib/queries/turfs";
import { zoneGroupsQuery, zonesQuery } from "~/lib/queries/zones";
import { useDeferredRadioDropdown } from "~/lib/use-deferred-radio-dropdown";
import { useDialogMutation } from "~/lib/use-dialog-mutation";
import { useFadeOnce } from "~/lib/use-fade-once";
import { cn } from "~/lib/utils";
import { colorFor } from "~/lib/zone-colors";
import { client } from "~/rpc/client";

type CampaignsSearch = {
  campaignId?: string;
};

function sortByName<T extends { name: string }>(items: ReadonlyArray<T>): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

// Sorted union of all keys across the zone group's zones, used as the
// `keyFilter` for points and per-key counts.
function deriveKeyFilter(
  zoneGroup: { keyGroup: string } | null | undefined,
  zones: Awaited<ReturnType<typeof client.zones.list>> | null | undefined,
): KeyFilter | null {
  if (!zoneGroup || !zones) return null;
  return {
    keyGroup: zoneGroup.keyGroup,
    keys: Array.from(new Set(zones.flatMap((z) => z.keys))).sort(),
  };
}

export const Route = createFileRoute("/campaigns/")({
  validateSearch: (s): CampaignsSearch => ({
    campaignId: typeof s.campaignId === "string" ? s.campaignId : undefined,
  }),
  loaderDeps: ({ search }) => ({ campaignId: search.campaignId }),
  loader: async ({ context: { queryClient }, deps }) => {
    // Tier 0: campaigns list + reference data in parallel.
    const [campaigns, , zoneGroups] = await Promise.all([
      queryClient.fetchQuery(campaignsListQuery()),
      queryClient.fetchQuery(segmentsListQuery()),
      queryClient.fetchQuery(zoneGroupsQuery()),
      queryClient.fetchQuery(scriptsListQuery()),
    ]);

    const fallbackId = sortByName(campaigns)[0]?.campaignId;
    const idInUrl = deps.campaignId;
    const exists = idInUrl ? campaigns.some((c) => c.campaignId === idInUrl) : false;
    if (!idInUrl || !exists) {
      if (fallbackId) {
        throw redirect({ to: "/campaigns", search: { campaignId: fallbackId } });
      }
      return;
    }

    // Tier 1: active campaign detail + turf stats (used by the zones list).
    const [campaign] = await Promise.all([
      queryClient.fetchQuery(campaignDetailQuery(idInUrl)),
      queryClient.fetchQuery(turfStatsForCampaignQuery(idInUrl)),
    ]);

    // Tier 2: bound segment detail + zones, in parallel.
    const [segmentDetail, zones] = await Promise.all([
      campaign.segmentId
        ? queryClient.fetchQuery(segmentDetailQuery(campaign.segmentId))
        : Promise.resolve(undefined),
      campaign.zoneGroupId
        ? queryClient.fetchQuery(zonesQuery(campaign.zoneGroupId))
        : Promise.resolve(undefined),
    ]);

    const zoneGroup = campaign.zoneGroupId
      ? (zoneGroups.find((g) => g.zoneGroupId === campaign.zoneGroupId) ?? undefined)
      : undefined;
    const keyFilter = deriveKeyFilter(zoneGroup, zones);

    // Tier 3: heavy stuff — boundary GeoJSON, points, per-key counts.
    await Promise.all([
      zoneGroup
        ? queryClient.fetchQuery(boundariesGeoJsonQuery(zoneGroup.keyGroup, zoneGroup.updatedAt))
        : Promise.resolve(),
      segmentDetail?.criteria && keyFilter
        ? queryClient.fetchQuery(campaignPointsQuery(segmentDetail.criteria, keyFilter))
        : Promise.resolve(),
      segmentDetail?.criteria && keyFilter
        ? queryClient.fetchQuery(
            campaignKeyCountsQuery(segmentDetail.criteria, keyFilter.keyGroup, keyFilter.keys),
          )
        : Promise.resolve(),
    ]);
  },
  component: CampaignsIndex,
});

// Walks every coord in a polygon/multipolygon FeatureCollection.
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

function CampaignsIndex() {
  const queryClient = useQueryClient();
  const navigate = useNavigate({ from: Route.fullPath });
  const { campaignId: activeCampaignId = null } = Route.useSearch();
  const shouldFade = useFadeOnce("/campaigns");

  const setActiveCampaignId = (id: string | null) => {
    void navigate({ search: { campaignId: id ?? undefined } });
  };

  const { data: campaigns } = useSuspenseQuery(campaignsListQuery());
  const { data: segments } = useSuspenseQuery(segmentsListQuery());
  const { data: zoneGroups } = useSuspenseQuery(zoneGroupsQuery());
  const { data: scripts } = useSuspenseQuery(scriptsListQuery());
  const sortedCampaigns = useMemo(() => sortByName(campaigns), [campaigns]);

  const campaignDropdown = useDeferredRadioDropdown({
    onCommit: (v) => setActiveCampaignId(v || null),
  });

  const activeCampaign = campaigns.find((c) => c.campaignId === activeCampaignId) ?? null;

  // Loader prefetched when `campaignId` is set, so this is a cache hit.
  const { data: campaignDetail } = useQuery({
    ...campaignDetailQuery(activeCampaignId ?? ""),
    enabled: !!activeCampaignId,
  });
  const campaign = campaignDetail ?? activeCampaign;

  const activeZoneGroup = zoneGroups.find((g) => g.zoneGroupId === campaign?.zoneGroupId) ?? null;

  const { data: segmentDetail, isPlaceholderData: segmentDetailStale } = useQuery({
    ...segmentDetailQuery(campaign?.segmentId ?? ""),
    enabled: !!campaign?.segmentId,
    placeholderData: keepPreviousData,
  });

  const { data: zones, isPlaceholderData: zonesStale } = useQuery({
    ...zonesQuery(campaign?.zoneGroupId ?? ""),
    enabled: !!campaign?.zoneGroupId,
    placeholderData: keepPreviousData,
  });

  const { data: turfStats } = useQuery({
    ...turfStatsForCampaignQuery(activeCampaignId ?? ""),
    enabled: !!activeCampaignId,
  });

  const { data: boundaryFC, isPlaceholderData: boundaryStale } = useQuery({
    ...boundariesGeoJsonQuery(activeZoneGroup?.keyGroup ?? "", activeZoneGroup?.updatedAt ?? ""),
    enabled: !!activeZoneGroup,
    placeholderData: keepPreviousData,
  });

  const keyFilter = useMemo(
    () => deriveKeyFilter(activeZoneGroup, zones),
    [activeZoneGroup, zones],
  );

  const { data: pointsBuffer, isPlaceholderData: pointsStale } = useQuery({
    ...(segmentDetail?.criteria && keyFilter
      ? campaignPointsQuery(segmentDetail.criteria, keyFilter)
      : campaignPointsQuery({} as SegmentCriteria, null)),
    enabled: !!segmentDetail?.criteria && !!keyFilter,
    placeholderData: keepPreviousData,
  });

  const { data: keyCountsResult, isPlaceholderData: countsStale } = useQuery({
    ...(segmentDetail?.criteria && keyFilter
      ? campaignKeyCountsQuery(segmentDetail.criteria, keyFilter.keyGroup, keyFilter.keys)
      : campaignKeyCountsQuery({} as SegmentCriteria, "", [])),
    enabled: !!segmentDetail?.criteria && !!keyFilter,
    placeholderData: keepPreviousData,
  });
  const perKeyCounts = keyCountsResult?.counts ?? null;

  // Per-zone totals = sum per-key counts across each zone's keys.
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

  // One unioned polygon per zone, tagged with `zoneId`. Single-key zones
  // short-circuit because turf.union returns null for degenerate inputs.
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
      try {
        const polys = zone.keys
          .map((k) => featuresByKey[k])
          .filter((f): f is Feature<Polygon | MultiPolygon> => !!f);
        if (polys.length === 0) return;
        const raw =
          polys.length === 1
            ? polys[0]!
            : (union({ type: "FeatureCollection", features: polys }) ?? polys[0]!);
        // turf.union output sometimes carries near-duplicate vertices along
        // input-polygon shared edges; cleanCoords drops them. Wrapped in
        // try/catch because cleanCoords throws on rings it considers
        // degenerate (e.g. <4 points after dedup) — one bad zone shouldn't
        // crash the whole page.
        let merged: Feature<Polygon | MultiPolygon>;
        try {
          merged = cleanCoords(raw) as Feature<Polygon | MultiPolygon>;
        } catch {
          merged = raw as Feature<Polygon | MultiPolygon>;
        }
        out.push({
          ...merged,
          properties: { zoneId: zone.zoneId, name: zone.name, color: colorFor(idx) },
        });
      } catch (e) {
        console.warn(`zonePerimeters: skipping zone ${zone.zoneId}`, e);
      }
    });
    return { type: "FeatureCollection", features: out };
  }, [zones, boundaryFC]);

  const fitBounds = useMemo(
    () => (zonePerimeters ? bboxOfPolys(zonePerimeters) : null),
    [zonePerimeters],
  );

  // Curtain stays up until every relevant query has data for the current
  // bindings (no `isPlaceholderData` from a previous binding).
  const ready = (() => {
    if (!campaign) return campaigns.length === 0;
    const s = !!campaign.segmentId;
    const z = !!campaign.zoneGroupId;
    if (s) {
      if (!segmentDetail || segmentDetailStale) return false;
    }
    if (z) {
      if (!zones || zonesStale) return false;
      if (!boundaryFC || boundaryStale) return false;
    }
    if (s && z) {
      if (!pointsBuffer || pointsStale) return false;
      if (!perKeyCounts || countsStale) return false;
    }
    return true;
  })();

  // Selected zone (click on a perimeter pops the inset). Cleared on
  // campaign / zoneGroup change.
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  useEffect(() => {
    setSelectedZoneId(null);
  }, [activeCampaignId, campaign?.zoneGroupId]);

  // Click outside the map wrapper clears the selection.
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

  // The construct path chains zoneGroups.createWithDefaultZone +
  // campaigns.create. Wrapping in one mutation keeps the dialog's
  // pending/error UX coherent across both paths.
  const createCampaign = useDialogMutation({
    mutationFn: async (input: {
      name: string;
      segmentId: string;
      scriptId: string;
      zoneGroupId: string | null;
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
        void queryClient.invalidateQueries({ queryKey: ["zone-groups"] });
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      // Loader picks the alphabetical-first survivor.
      setActiveCampaignId(null);
    },
  });

  const [configOpen, setConfigOpen] = useState(false);
  const [deleteTurfCount, setDeleteTurfCount] = useState(0);

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
      <div className={shouldFade ? "animate-in fade-in duration-100" : undefined}>
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
                  {sortedCampaigns.map((c) => (
                    <DropdownMenuRadioItem key={c.campaignId} value={c.campaignId}>
                      {c.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="outline"
              onClick={() => setConfigOpen(true)}
              disabled={!activeCampaign}
            >
              <Settings2 />
              Configure
            </Button>
            <Button variant="outline" onClick={createCampaign.open}>
              <Plus />
              New campaign
            </Button>
            <Button variant="outline" onClick={renameCampaign.open} disabled={!activeCampaign}>
              <Pencil />
              Rename
            </Button>
            <Button variant="outline" onClick={cloneCampaign.open} disabled={!activeCampaign}>
              <Copy />
              Duplicate
            </Button>
            <Button
              variant="outline"
              onClick={async () => {
                if (!activeCampaignId) return;
                const { count } = await queryClient.fetchQuery({
                  queryKey: ["campaigns", "count-turfs", activeCampaignId],
                  queryFn: () => client.turfs.countForCampaign({ campaignId: activeCampaignId }),
                  staleTime: 0,
                });
                setDeleteTurfCount(count);
                deleteCampaign.open();
              }}
              disabled={!activeCampaign}
            >
              <Trash2 />
              Delete
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 h-[calc(100vh-9.75rem)]">
          {/* Sidebar fades in step with the map curtain. */}
          <div
            className={cn(
              "h-full min-h-0 transition-opacity duration-150",
              ready ? "opacity-100" : "opacity-0",
            )}
          >
            <ZonesList
              zones={zones ?? null}
              selectedZoneId={selectedZoneId}
              zoneCounts={zoneCounts}
              turfStats={turfStats ?? null}
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
              points={pointsBuffer ?? undefined}
              zonePerimeters={zonePerimeters}
              fitBounds={fitBounds}
              selectedZoneId={selectedZoneId}
              onZoneClick={(zoneId) => setSelectedZoneId(zoneId)}
              onBackgroundClick={() => setSelectedZoneId(null)}
              loading={!ready}
            />
          </div>
        </div>
      </div>

      <CreateCampaignDialog
        open={createCampaign.isOpen}
        onOpenChange={createCampaign.onOpenChange}
        pending={createCampaign.isPending}
        error={createCampaign.error}
        segmentOptions={segments.map((s) => ({ value: s.segmentId, label: s.name }))}
        zoneGroupOptions={zoneGroups.map((g) => ({ value: g.zoneGroupId, label: g.name }))}
        scriptOptions={scripts.map((s) => ({ value: s.scriptId, label: s.name }))}
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
        turfCount={deleteTurfCount}
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
        segmentOptions={segments.map((s) => ({ value: s.segmentId, label: s.name }))}
        zoneGroupOptions={zoneGroups.map((g) => ({ value: g.zoneGroupId, label: g.name }))}
        scriptOptions={scripts.map((s) => ({ value: s.scriptId, label: s.name }))}
        onSubmit={(patch) => {
          bind(patch);
          setConfigOpen(false);
        }}
      />
    </>
  );
}

type TurfStats = Record<string, { drafts: number; published: number }>;

function ZonesList({
  zones,
  selectedZoneId,
  zoneCounts,
  turfStats,
  onSelect,
  onCut,
}: {
  zones: Awaited<ReturnType<typeof client.zones.list>> | null;
  selectedZoneId: string | null;
  zoneCounts: Record<string, { doors: number; people: number }> | null;
  turfStats: TurfStats | null;
  onSelect: (zoneId: string) => void;
  onCut: (zoneId: string) => void;
}) {
  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto">
      {zones?.map((zone, idx) => (
        <ZoneRow
          key={zone.zoneId}
          zone={zone}
          color={colorFor(idx)}
          selected={zone.zoneId === selectedZoneId}
          counts={zoneCounts?.[zone.zoneId] ?? null}
          turfStats={turfStats?.[zone.zoneId] ?? null}
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
  turfStats,
  onSelect,
  onCut,
}: {
  zone: { zoneId: string; name: string };
  color: string;
  selected: boolean;
  counts: { doors: number; people: number } | null;
  turfStats: { drafts: number; published: number } | null;
  onSelect: () => void;
  onCut: () => void;
}) {
  const turfCount = turfStats?.drafts ?? 0;
  const hasPublished = (turfStats?.published ?? 0) > 0;
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
      {hasPublished ? (
        <Pill
          variant="number"
          className="size-7 shrink-0 justify-center !px-0 [&_svg]:[stroke-width:2]"
        >
          <Send className="size-4 text-foreground" />
        </Pill>
      ) : null}
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
      <Pill variant="number" className="!w-fit shrink-0 gap-1.5">
        <CircleDotDashed className="size-3.5 text-foreground" />
        {turfCount}
      </Pill>
      <Button
        size="sm"
        variant="outline"
        onClick={(e) => {
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
              "rounded-md border border-border px-2.5 py-1 text-sm active:translate-y-px",
              selected ? "bg-foreground/10" : "bg-background hover:bg-muted",
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
  // The "Zones" dropdown folds two paths: a sentinel "Define automatically"
  // option above the existing zone groups; selecting it reveals a key-group
  // segmented control below. No default — the user picks a path explicitly.
  const [zonesValue, setZonesValue] = useState<string | null>(null);
  const [constructKeyGroup, setConstructKeyGroup] = useState<string>(
    KEY_GROUPS_AVAILABLE[0]!.value,
  );
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
  turfCount,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaignName: string;
  turfCount: number;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  const inUse = turfCount > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {!inUse && <DialogTitle>Delete campaign?</DialogTitle>}
        <DialogDescription>
          {inUse ? (
            <>
              Can't delete <span className="font-medium text-foreground">{campaignName}</span>{" "}
              because it has <span className="font-bold text-foreground">{turfCount}</span>{" "}
              published turf{turfCount === 1 ? "" : "s"}. Turfs can't be removed yet — clearing them
              is a follow-up.
            </>
          ) : (
            <>
              Permanently deletes{" "}
              <span className="font-medium text-foreground">{campaignName}</span>. This can't be
              undone.
            </>
          )}
        </DialogDescription>
        <DialogError error={error} />
        <div className="mt-2 flex justify-end gap-2">
          {inUse ? (
            <DialogClose render={<Button variant="outline" />}>Ok</DialogClose>
          ) : (
            <>
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button variant="destructive" onClick={onConfirm} loading={pending}>
                Delete campaign
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

type SelectOption = { value: string; label: string };

// Sentinel for the "construct fresh zone group from key group" path —
// sits alongside real zone-group ids in the dropdown.
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

  // Resync drafts when the dialog opens.
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
          (questions). You can change the choices here.
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
            "enabled:hover:bg-muted",
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
