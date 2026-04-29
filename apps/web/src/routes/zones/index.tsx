import { createFileRoute } from "@tanstack/react-router";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Eraser,
  ChevronDown,
  Copy,
  DoorClosed,
  Diamond,
  List,
  Pencil,
  Plus,
  Trash2,
  UserRound,
} from "lucide-react";
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
import { Switch } from "~/components/switch";
import { KEY_GROUPS_AVAILABLE } from "~/lib/key-groups";
import { useDeferredRadioDropdown } from "~/lib/use-deferred-radio-dropdown";
import { useDialogMutation } from "~/lib/use-dialog-mutation";
import { cn } from "~/lib/utils";
import { colorFor, interpolateRamp } from "~/lib/zone-colors";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/zones/")({
  component: ZonesIndex,
});

function ZonesIndex() {
  const queryClient = useQueryClient();

  const { data: zoneGroups } = useQuery({
    queryKey: ["zoneGroups"],
    queryFn: () => client.zoneGroups.list(),
    placeholderData: keepPreviousData,
  });

  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [activeZoneId, setActiveZoneId] = useState<string | null>(null);
  const groupDropdown = useDeferredRadioDropdown({ onCommit: setActiveGroupId });

  // Segment-counts overlay state. The user toggles a switch to enable
  // count shading on the boundary fill, and picks which segment's
  // counts to show. Both pieces of state stick around when the
  // toggle is off — flicking it back on resumes with the same
  // segment selected.
  const [showSegmentCounts, setShowSegmentCounts] = useState(false);
  const [overlaySegmentId, setOverlaySegmentId] = useState<string | null>(null);
  const overlaySegmentDropdown = useDeferredRadioDropdown({
    onCommit: (v) => setOverlaySegmentId(v || null),
  });

  // Key-info popup. Tracks the polygon currently under the cursor —
  // populated by `onPolygonHover` from the Map and cleared when the
  // cursor leaves the boundary layer. Lets users inspect a key's
  // counts without consuming a click (clicks are reserved for zone
  // selection / shift-click for membership editing).
  //
  // `displayedHoverKey` lags `hoveredKey` so the inset can fade out
  // gracefully — without it, the content unmounts the instant the
  // cursor leaves the layer and the fade has nothing to fade.
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [displayedHoverKey, setDisplayedHoverKey] = useState<string | null>(null);
  useEffect(() => {
    if (hoveredKey) setDisplayedHoverKey(hoveredKey);
  }, [hoveredKey]);

  useEffect(() => {
    if (!activeGroupId && zoneGroups && zoneGroups.length > 0) {
      setActiveGroupId(zoneGroups[0].zoneGroupId);
    }
  }, [zoneGroups, activeGroupId]);

  const activeGroup = zoneGroups?.find((g) => g.zoneGroupId === activeGroupId) ?? null;

  const { data: zones } = useQuery({
    queryKey: ["zones", activeGroupId],
    queryFn: () => client.zones.list({ zoneGroupId: activeGroupId! }),
    enabled: !!activeGroupId,
    placeholderData: keepPreviousData,
  });

  // Segments dropdown for the overlay. Reuses the same list payload
  // the segments editor displays.
  const { data: segments } = useQuery({
    queryKey: ["segments"],
    queryFn: () => client.segments.list(),
    placeholderData: keepPreviousData,
  });

  // Pull the overlay segment's full row (with `query`) when one is
  // selected. The list payload omits the query JSON for size; we need
  // the full thing to forward into queryCountsByKey.
  const { data: overlaySegmentDetail } = useQuery({
    queryKey: ["segment", overlaySegmentId],
    queryFn: () => client.segments.getById({ segmentId: overlaySegmentId! }),
    enabled: !!overlaySegmentId,
    placeholderData: keepPreviousData,
  });

  // Per-key counts for the overlay segment, grouped by the active
  // zone group's key column (e.g. ad_ed for nyc_eds). Fires only when
  // the overlay is on, the segment detail has loaded for the current
  // selection, and a zone group is active. Cached on the effective
  // key — segment query JSON plus key group name — so revisits are
  // free and unrelated re-renders don't refetch.
  const overlayQuery = overlaySegmentDetail?.query ?? null;
  const overlayQueryKey = overlayQuery ? JSON.stringify(overlayQuery) : null;
  const { data: overlayCounts } = useQuery({
    queryKey: ["countsByKey", overlayQueryKey, activeGroup?.keyGroup],
    queryFn: () =>
      client.segments.queryCountsByKey({
        query: overlayQuery!,
        keyGroup: activeGroup!.keyGroup,
      }),
    enabled:
      showSegmentCounts &&
      !!overlaySegmentDetail &&
      overlaySegmentDetail.segmentId === overlaySegmentId &&
      !!activeGroup,
    placeholderData: keepPreviousData,
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    setActiveZoneId(null);
  }, [activeGroupId]);

  const updateKeysMutation = useMutation({
    mutationFn: (input: { zoneId: string; keys: string[] }) => client.zones.updateKeys(input),
    onMutate: async ({ zoneId, keys }) => {
      await queryClient.cancelQueries({ queryKey: ["zones", activeGroupId] });
      const previous = queryClient.getQueryData<typeof zones>(["zones", activeGroupId]);
      queryClient.setQueryData<typeof zones>(["zones", activeGroupId], (old) =>
        old?.map((z) => (z.zoneId === zoneId ? { ...z, keys } : z)),
      );
      return { previous };
    },
    onError: (e, _v, ctx) => {
      console.error("zones.updateKeys failed", e);
      if (ctx?.previous) queryClient.setQueryData(["zones", activeGroupId], ctx.previous);
    },
    onSuccess: () => {
      // Campaign editor's mapData snapshot is keyed by zoneGroupId
      // (no zones-version), so a key reassignment here doesn't
      // naturally bust its cache. Invalidate so the next visit to
      // /campaigns sees the new key membership.
      void queryClient.invalidateQueries({ queryKey: ["campaign-map-data"] });
    },
    // No onSettled invalidate of zones list: optimistic write is a
    // complete mirror of what the server stores, so a refetch would
    // just re-fetch identical data and flash the global indicator
    // on every polygon click.
  });

  const renameGroup = useDialogMutation({
    mutationFn: (input: { zoneGroupId: string; name: string }) => client.zoneGroups.rename(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["zoneGroups"] }),
  });

  const createGroup = useDialogMutation({
    mutationFn: (input: { name: string; keyGroup: string }) => client.zoneGroups.create(input),
    onSuccess: (created) => {
      // Optimistically inject the new group into the cache *before*
      // flipping `activeGroupId`, so `activeGroup` resolves
      // immediately on the next render. Without this, there's a
      // window where `activeGroupId` points at a row not yet in the
      // list — `activeGroup` falls back to `null`, `boundariesUrl`
      // goes undefined, the boundaries Source unmounts, and the
      // remount races with feature-state cleanup in a way that
      // crashes MapLibre's render loop.
      queryClient.setQueryData<typeof zoneGroups>(["zoneGroups"], (old) =>
        old ? [...old, created] : [created],
      );
      void queryClient.invalidateQueries({ queryKey: ["zoneGroups"] });
      setActiveGroupId(created.zoneGroupId);
    },
  });

  const cloneGroup = useDialogMutation({
    mutationFn: (input: { zoneGroupId: string; newName: string }) => client.zoneGroups.clone(input),
    onSuccess: ({ zoneGroupId }) => {
      void queryClient.invalidateQueries({ queryKey: ["zoneGroups"] });
      setActiveGroupId(zoneGroupId);
    },
  });

  const clearZones = useDialogMutation({
    mutationFn: (zoneGroupId: string) => client.zones.removeAllInGroup({ zoneGroupId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["zones", activeGroupId] });
      void queryClient.invalidateQueries({ queryKey: ["campaign-map-data"] });
    },
  });

  const deleteGroup = useDialogMutation({
    mutationFn: (zoneGroupId: string) => client.zoneGroups.remove({ zoneGroupId }),
    onSuccess: (_res, deletedId) => {
      void queryClient.invalidateQueries({ queryKey: ["zoneGroups"] });
      // Pick another group (first surviving) so the editor doesn't
      // freeze on a dangling id.
      const next = zoneGroups?.find((g) => g.zoneGroupId !== deletedId);
      setActiveGroupId(next?.zoneGroupId ?? null);
      setActiveZoneId(null);
    },
  });

  const createZoneMutation = useMutation({
    mutationFn: (input: { zoneGroupId: string; name: string }) => client.zones.create(input),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ["zones", activeGroupId] });
      void queryClient.invalidateQueries({ queryKey: ["campaign-map-data"] });
      setActiveZoneId(created.zoneId);
    },
    onError: (e) => console.error("zones.create failed", e),
  });

  const renameZoneMutation = useMutation({
    mutationFn: (input: { zoneId: string; name: string }) => client.zones.rename(input),
    onMutate: async ({ zoneId, name }) => {
      await queryClient.cancelQueries({ queryKey: ["zones", activeGroupId] });
      const previous = queryClient.getQueryData<typeof zones>(["zones", activeGroupId]);
      queryClient.setQueryData<typeof zones>(["zones", activeGroupId], (old) =>
        old?.map((z) => (z.zoneId === zoneId ? { ...z, name } : z)),
      );
      return { previous };
    },
    onError: (e, _v, ctx) => {
      console.error("zones.rename failed", e);
      if (ctx?.previous) queryClient.setQueryData(["zones", activeGroupId], ctx.previous);
    },
    onSuccess: () => {
      // The campaign editor's click-zone inset shows the zone name,
      // so a rename here needs to invalidate its cached snapshot.
      void queryClient.invalidateQueries({ queryKey: ["campaign-map-data"] });
    },
    // No onSettled invalidate of zones list: same reasoning as
    // updateKeysMutation.
  });

  const removeZoneMutation = useMutation({
    mutationFn: (zoneId: string) => client.zones.remove({ zoneId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["zones", activeGroupId] });
      void queryClient.invalidateQueries({ queryKey: ["campaign-map-data"] });
    },
    onError: (e) => console.error("zones.remove failed", e),
  });

  const [renamingZoneId, setRenamingZoneId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const commitRename = (zoneId: string, currentName: string) => {
    const next = renameDraft.trim();
    setRenamingZoneId(null);
    if (next.length === 0 || next === currentName) return;
    renameZoneMutation.mutate({ zoneId, name: next });
  };

  // Per-key fill color. Two modes:
  //
  //  1. No overlay → each zoned key gets its zone's hue. Keys not in
  //     a zone fall through to the map's default unassigned style.
  //
  //  2. Overlay on → every key with a count gets a YlOrRd shade
  //     (pale yellow = low, deep red = high). Zone tints are dropped
  //     entirely; the heatmap stands alone. Square-root scaling on
  //     the count softens the long tail.
  const overlayActive = showSegmentCounts && !!overlayCounts;

  // First-load curtain over the map. Stays opaque until zoneGroups
  // and (if a group is active) its zones have loaded. The Map
  // component owns the actual curtain and its own basemap-readiness
  // gating; we just tell it whether our data is ready yet.
  const [firstReady, setFirstReady] = useState(false);
  useEffect(() => {
    if (firstReady) return;
    const ready = !!zoneGroups && (!activeGroupId || !!zones);
    if (ready) setFirstReady(true);
  }, [firstReady, zoneGroups, activeGroupId, zones]);
  // Counts shape: per key, both door and people totals. Heatmap and
  // zone list read .doors (the canvassing unit); popup shows both.
  type KeyCount = { doors: number; people: number };
  const overlayCountsByKey = overlayActive
    ? (overlayCounts.counts as Record<string, KeyCount>)
    : null;

  const coloringByKey = useMemo(() => {
    if (overlayCountsByKey) {
      let max = 0;
      for (const v of Object.values(overlayCountsByKey)) if (v.doors > max) max = v.doors;
      const out: Record<string, string> = {};
      for (const [key, c] of Object.entries(overlayCountsByKey)) {
        const t = max === 0 ? 0 : Math.sqrt(c.doors / max);
        out[key] = interpolateRamp(t);
      }
      return out;
    }
    const out: Record<string, string> = {};
    zones?.forEach((zone, idx) => {
      const color = colorFor(idx);
      for (const key of zone.keys) out[key] = color;
    });
    return out;
  }, [zones, overlayCountsByKey]);

  // Keys to highlight with a thicker outline — every key in the
  // selected zone. The highlight is the user's visual handle on
  // what they last picked. Hover doesn't enter this state: the
  // cursor itself is enough hover affordance.
  const activeKeys = useMemo(() => {
    if (activeZoneId && zones) {
      return zones.find((z) => z.zoneId === activeZoneId)?.keys;
    }
    return undefined;
  }, [activeZoneId, zones]);

  // Per-zone rollup of the segment counts. When overlay is active,
  // each zone's sidebar swatch+pill uses these (YlOrRd shade for the
  // zone's total, formatted total instead of key count) so the
  // sidebar reads as a sorted summary of the heatmap. Computed in TS
  // by summing the per-key counts across each zone's keys; no extra
  // round trip.
  const zoneOverlay = useMemo(() => {
    if (!overlayCountsByKey || !zones) return null;
    const doors: Record<string, number> = {};
    const people: Record<string, number> = {};
    let maxDoors = 0;
    for (const zone of zones) {
      let d = 0;
      let p = 0;
      for (const k of zone.keys) {
        const c = overlayCountsByKey[k];
        if (c) {
          d += c.doors;
          p += c.people;
        }
      }
      doors[zone.zoneId] = d;
      people[zone.zoneId] = p;
      if (d > maxDoors) maxDoors = d;
    }
    const colors: Record<string, string> = {};
    for (const [zoneId, count] of Object.entries(doors)) {
      const t = maxDoors === 0 ? 0 : Math.sqrt(count / maxDoors);
      colors[zoneId] = interpolateRamp(t);
    }
    return { doors, people, colors };
  }, [overlayCountsByKey, zones]);

  const handlePolygonClick = (key: string, opts: { shiftKey: boolean }) => {
    if (!zones) return;
    if (opts.shiftKey) {
      // Shift-click toggles the key's membership in the active zone
      // (the assignment gesture). No-op if no zone is active —
      // there's nothing to assign to.
      if (!activeZoneId) return;
      const active = zones.find((z) => z.zoneId === activeZoneId);
      if (!active) return;

      if (active.keys.includes(key)) {
        updateKeysMutation.mutate({
          zoneId: activeZoneId,
          keys: active.keys.filter((k) => k !== key),
        });
        return;
      }

      // A key belongs to at most one zone in the group. If another
      // zone already owns it, strip it from there before adding to
      // the active zone — both mutations fire optimistically.
      const previousOwner = zones.find((z) => z.zoneId !== activeZoneId && z.keys.includes(key));
      if (previousOwner) {
        updateKeysMutation.mutate({
          zoneId: previousOwner.zoneId,
          keys: previousOwner.keys.filter((k) => k !== key),
        });
      }
      updateKeysMutation.mutate({
        zoneId: activeZoneId,
        keys: [...active.keys, key],
      });
      return;
    }
    // Plain click → activate the zone that contains this key (or
    // clear active if the key is in no zone). Symmetric with
    // clicking a row in the zone list.
    const owner = zones.find((z) => z.keys.includes(key));
    setActiveZoneId(owner?.zoneId ?? null);
  };

  // ---- Modal state ----
  // The five dialog mutations (createGroup, renameGroup, cloneGroup,
  // clearZones, deleteGroup) own their own open flags via
  // `useDialogMutation`; this local state is only for the data Delete
  // needs to pre-fetch before opening (campaign-usage count).
  const [deleteCampaignCount, setDeleteCampaignCount] = useState(0);

  // Click anywhere outside the map clears both the active zone and
  // any clicked-key selection. Zone-button clicks individually
  // stopPropagation on mousedown (see their `onMouseDown` below) so
  // toggling between zones doesn't flash through a no-selection
  // frame. Empty space in the sidebar still deselects, matching the
  // user's intuition. Skipped while any modal/inline-rename is open
  // so we don't clobber state behind a dialog.
  const mapWrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!activeZoneId) return;
    if (
      createGroup.isOpen ||
      cloneGroup.isOpen ||
      clearZones.isOpen ||
      renameGroup.isOpen ||
      deleteGroup.isOpen ||
      renamingZoneId ||
      // Dropdowns render their content in a portal outside the map
      // wrapper. Without this gate, clicking an item would register
      // as "outside the map" and clear the selection before the
      // dropdown's own onValueChange runs.
      groupDropdown.open ||
      overlaySegmentDropdown.open
    ) {
      return;
    }
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (mapWrapperRef.current?.contains(target)) return;
      // Zone-row clicks fall through to the deselect: the brief
      // no-selection frame between mousedown and click reads as
      // click feedback (the polygon outline blinks on every pick).
      setActiveZoneId(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [
    activeZoneId,
    createGroup.isOpen,
    cloneGroup.isOpen,
    clearZones.isOpen,
    renameGroup.isOpen,
    deleteGroup.isOpen,
    renamingZoneId,
    groupDropdown.open,
    overlaySegmentDropdown.open,
  ]);

  return (
    <>
      <div className="mb-4 flex h-8 items-center justify-between">
        <h1 className="text-xl font-extrabold tracking-wide italic">Zone Editor</h1>
        <div className="flex items-center gap-2">
          <DropdownMenu {...groupDropdown.menu}>
            <DropdownMenuTrigger render={<Button variant="outline" />}>
              <List className="size-3.5" />
              <span className={activeGroup ? undefined : "invisible"}>
                {activeGroup?.name ?? "—"}
              </span>
              <ChevronDown className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuRadioGroup {...groupDropdown.radio} value={activeGroupId ?? ""}>
                {zoneGroups?.map((g) => (
                  <DropdownMenuRadioItem key={g.zoneGroupId} value={g.zoneGroupId}>
                    {g.name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" onClick={createGroup.open}>
            <Plus />
            New group
          </Button>
          <Button variant="outline" onClick={renameGroup.open}>
            <Pencil />
            Rename
          </Button>
          <Button variant="outline" onClick={cloneGroup.open}>
            <Copy />
            Duplicate
          </Button>
          <Button variant="outline" onClick={clearZones.open}>
            <Eraser />
            Clear
          </Button>
          <Button
            variant="outline"
            onClick={async () => {
              if (!activeGroupId) return;
              // Fetch first, open after — avoids a "Checking…" flash in
              // the dialog and keeps the count fresh per click.
              const { count } = await queryClient.fetchQuery({
                queryKey: ["zoneGroups", "countCampaigns", activeGroupId],
                queryFn: () => client.zoneGroups.countCampaigns({ zoneGroupId: activeGroupId }),
                staleTime: 0,
              });
              setDeleteCampaignCount(count);
              deleteGroup.open();
            }}
            disabled={!activeGroup}
          >
            <Trash2 />
            Delete
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 h-[calc(100vh-9.75rem)]">
        <div className="col-span-1 flex flex-col gap-2 overflow-y-auto">
          {zones?.map((zone, idx) => {
            const isActive = zone.zoneId === activeZoneId;
            const isRenaming = renamingZoneId === zone.zoneId;
            return (
              <div
                key={zone.zoneId}
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (isRenaming) return;
                  setActiveZoneId(zone.zoneId);
                }}
                onKeyDown={(e) => {
                  if (isRenaming) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setActiveZoneId(zone.zoneId);
                  }
                }}
                className={cn(
                  "flex items-center gap-2 rounded-md border bg-card py-2 pr-2 pl-3 text-left",
                  isActive ? "border-foreground" : "border-border hover:border-muted-foreground",
                )}
              >
                <span
                  aria-hidden
                  className="mr-1 size-3 shrink-0 rounded-sm border border-border"
                  style={{
                    backgroundColor: zoneOverlay ? zoneOverlay.colors[zone.zoneId] : colorFor(idx),
                  }}
                />
                {isRenaming ? (
                  <Input
                    autoFocus
                    value={renameDraft}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => commitRename(zone.zoneId, zone.name)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename(zone.zoneId, zone.name);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setRenamingZoneId(null);
                      }
                    }}
                    className="h-7 flex-1 px-2 text-sm"
                  />
                ) : (
                  <span
                    className="flex-1 truncate text-sm select-none"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setRenameDraft(zone.name);
                      setRenamingZoneId(zone.zoneId);
                    }}
                  >
                    {zone.name}
                  </span>
                )}
                {zoneOverlay ? (
                  <>
                    <Pill variant="number" className="!w-fit shrink-0 justify-end gap-1.5">
                      <DoorClosed className="size-3.5 text-foreground" />
                      {(zoneOverlay.doors[zone.zoneId] ?? 0).toLocaleString()}
                    </Pill>
                    <Pill variant="number" className="!w-fit shrink-0 justify-end gap-1.5">
                      <UserRound className="size-3.5 text-foreground" />
                      {(zoneOverlay.people[zone.zoneId] ?? 0).toLocaleString()}
                    </Pill>
                  </>
                ) : (
                  <Pill variant="number" className="!w-fit shrink-0 justify-end gap-1.5">
                    <Diamond className="size-3.5 text-foreground" />
                    {zone.keys.length}
                  </Pill>
                )}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="-ml-[1px]"
                  aria-label="Delete zone"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (activeZoneId === zone.zoneId) setActiveZoneId(null);
                    removeZoneMutation.mutate(zone.zoneId);
                  }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            );
          })}
          {activeGroupId && zones ? (
            <button
              type="button"
              onClick={() =>
                createZoneMutation.mutate({
                  zoneGroupId: activeGroupId,
                  name: `Zone ${zones.length + 1}`,
                })
              }
              className={cn(
                "flex items-center justify-between gap-2",
                "rounded-md border border-border bg-card px-3 py-2 text-left",
                "text-muted-foreground hover:border-muted-foreground hover:text-foreground",
              )}
            >
              <div className="flex items-center gap-2">
                <Plus className="size-3.5" />
                <span className="text-sm">New zone</span>
              </div>
            </button>
          ) : null}
        </div>
        <div ref={mapWrapperRef} className="relative col-span-2 h-full">
          <Map
            className="h-full"
            boundariesUrl={
              activeGroup
                ? `${import.meta.env.VITE_DATA_URL}/key-groups/${activeGroup.keyGroup}/geojson?v=${new Date(activeGroup.updatedAt).getTime()}`
                : undefined
            }
            coloringByKey={coloringByKey}
            coloredFillOpacity={0.8}
            activeKeys={activeKeys}
            onPolygonClick={handlePolygonClick}
            onPolygonHover={setHoveredKey}
            onBackgroundClick={() => setActiveZoneId(null)}
            loading={!firstReady}
          />

          {/* Bottom-left: segment-counts overlay control. */}
          <div
            className={cn(
              "absolute bottom-3 left-3 z-10 flex w-64 flex-col gap-2.5",
              "rounded-md border border-border bg-card/95 px-3 py-3 shadow-sm backdrop-blur",
            )}
          >
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Switch
                checked={showSegmentCounts}
                onCheckedChange={(checked) => setShowSegmentCounts(checked)}
              />
              <span>Show segment counts</span>
            </label>
            <DropdownMenu {...overlaySegmentDropdown.menu}>
              <DropdownMenuTrigger
                disabled={!showSegmentCounts}
                className={cn(
                  "flex w-full items-center justify-between gap-1 rounded-md border border-border bg-background px-2 py-1 text-sm",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                  "enabled:hover:border-muted-foreground",
                )}
              >
                <span className="truncate">
                  {segments?.find((s) => s.segmentId === overlaySegmentId)?.name ??
                    "Pick a segment…"}
                </span>
                <ChevronDown className="size-3.5 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuRadioGroup
                  {...overlaySegmentDropdown.radio}
                  value={overlaySegmentId ?? ""}
                >
                  {segments?.map((s) => (
                    <DropdownMenuRadioItem key={s.segmentId} value={s.segmentId}>
                      {s.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Top-right: info popup. Two modes — zone-selected shows
              the zone summary, no-zone-selected + key-clicked shows
              the single key. Auto-dismissed via the document mousedown
              handler (clicks outside the map list) or the basemap
              click (see onBackgroundClick). */}
          {/* Hover-driven key inspector. Active-zone info lives in
              the zone list (sidebar), so the inset is purely the
              "what's this polygon" affordance. Stays mounted with
              opacity transitioned by hover state — so a quick drag
              between polygons reads as content swap rather than
              flicker. `displayedHoverKey` lags so the fade-out has
              content to fade. */}
          {displayedHoverKey ? (
            <div
              aria-hidden={!hoveredKey}
              className={cn(
                "pointer-events-none absolute top-3 right-3 z-10",
                "rounded-md border border-border bg-card/95 px-3 py-2 text-right text-sm shadow-sm backdrop-blur",
                "transition-opacity duration-150",
                hoveredKey ? "opacity-100" : "opacity-0",
              )}
            >
              <div className="flex flex-col items-end gap-2">
                <div className="font-mono">{displayedHoverKey}</div>
                {overlayCountsByKey ? (
                  <div className="flex justify-end gap-1.5">
                    <Pill variant="number" className="!w-fit gap-1.5">
                      <DoorClosed className="size-3.5 text-foreground" />
                      {(overlayCountsByKey[displayedHoverKey]?.doors ?? 0).toLocaleString()}
                    </Pill>
                    <Pill variant="number" className="!w-fit gap-1.5">
                      <UserRound className="size-3.5 text-foreground" />
                      {(overlayCountsByKey[displayedHoverKey]?.people ?? 0).toLocaleString()}
                    </Pill>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <CreateZoneGroupDialog
        open={createGroup.isOpen}
        onOpenChange={createGroup.onOpenChange}
        pending={createGroup.isPending}
        error={createGroup.error}
        onSubmit={(values) => createGroup.mutate(values)}
      />

      <SaveAsDialog
        open={cloneGroup.isOpen}
        onOpenChange={cloneGroup.onOpenChange}
        defaultName={activeGroup ? `${activeGroup.name} (copy)` : ""}
        pending={cloneGroup.isPending}
        error={cloneGroup.error}
        onSubmit={(newName) => {
          if (!activeGroupId) return;
          cloneGroup.mutate({ zoneGroupId: activeGroupId, newName });
        }}
      />

      <ClearDialog
        open={clearZones.isOpen}
        onOpenChange={clearZones.onOpenChange}
        groupName={activeGroup?.name ?? ""}
        pending={clearZones.isPending}
        error={clearZones.error}
        onConfirm={() => {
          if (!activeGroupId) return;
          clearZones.mutate(activeGroupId);
        }}
      />

      <RenameDialog
        open={renameGroup.isOpen}
        onOpenChange={renameGroup.onOpenChange}
        currentName={activeGroup?.name ?? ""}
        pending={renameGroup.isPending}
        error={renameGroup.error}
        onSubmit={(name) => {
          if (!activeGroupId) return;
          if (name === activeGroup?.name) {
            renameGroup.close();
            return;
          }
          renameGroup.mutate({ zoneGroupId: activeGroupId, name });
        }}
      />

      <DeleteDialog
        open={deleteGroup.isOpen}
        onOpenChange={deleteGroup.onOpenChange}
        groupName={activeGroup?.name ?? ""}
        campaignCount={deleteCampaignCount}
        pending={deleteGroup.isPending}
        error={deleteGroup.error}
        onConfirm={() => {
          if (!activeGroupId) return;
          deleteGroup.mutate(activeGroupId);
        }}
      />
    </>
  );
}

// Inline error block for dialog action mutations. Renders nothing when
// there's no error, so callers can drop it in unconditionally.
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
        <DialogTitle>Rename group</DialogTitle>
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

function CreateZoneGroupDialog({
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
  onSubmit: (values: { name: string; keyGroup: string }) => void;
}) {
  const [name, setName] = useState("");
  const [keyGroup, setKeyGroup] = useState(KEY_GROUPS_AVAILABLE[0]!.value);

  useEffect(() => {
    if (open) {
      setName("");
      setKeyGroup(KEY_GROUPS_AVAILABLE[0]!.value);
    }
  }, [open]);

  const valid = name.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Create new group</DialogTitle>
        <DialogDescription>
          A zone group is a named set of zones, all built from the same kind of administrative unit.
          If you want to change the unit, you'll need to create a new group.
        </DialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || pending) return;
            onSubmit({ name: name.trim(), keyGroup });
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Name</label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter a name..."
              disabled={pending}
            />
          </div>
          <div className="flex flex-col gap-1.5 mt-1">
            <label className="text-sm font-medium text-foreground">Unit type</label>
            <div className="flex flex-wrap gap-1.5">
              {KEY_GROUPS_AVAILABLE.map((kg) => {
                const selected = keyGroup === kg.value;
                return (
                  <button
                    type="button"
                    key={kg.value}
                    onClick={() => setKeyGroup(kg.value)}
                    disabled={pending}
                    className={
                      selected
                        ? "rounded-md border border-foreground bg-foreground/10 px-2.5 py-1 text-sm disabled:opacity-50"
                        : "rounded-md border border-border bg-background px-2.5 py-1 text-sm hover:border-muted-foreground disabled:opacity-50"
                    }
                  >
                    {kg.label}
                  </button>
                );
              })}
            </div>
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
        <DialogTitle>Duplicate group</DialogTitle>
        <DialogDescription>
          Creates a copy of the current group, including all zones. The new group uses the same unit
          type.
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

function DeleteDialog({
  open,
  onOpenChange,
  groupName,
  campaignCount,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupName: string;
  campaignCount: number;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  const inUse = campaignCount > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {!inUse && <DialogTitle>Delete zone group?</DialogTitle>}
        <DialogDescription>
          {inUse ? (
            <>
              Can't delete <span className="font-medium text-foreground">{groupName}</span> because
              it is used by {campaignCount} campaign{campaignCount === 1 ? "" : "s"}. Detach or
              delete those campaigns first, then try again.
            </>
          ) : (
            <>
              Permanently deletes <span className="font-medium text-foreground">{groupName}</span>{" "}
              and every zone inside it. This can't be undone.
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
                Delete group
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ClearDialog({
  open,
  onOpenChange,
  groupName,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupName: string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Clear all zones?</DialogTitle>
        <DialogDescription>
          Deletes every zone in <span className="font-medium text-foreground">{groupName}</span>.
          The group itself is kept; you can start fresh with new zones. This can't be undone.
        </DialogDescription>
        <DialogError error={error} />
        <div className="mt-2 flex justify-end gap-2">
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={onConfirm} loading={pending}>
            Clear all zones
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
