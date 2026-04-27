import { createFileRoute } from "@tanstack/react-router";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { interpolateYlOrRd } from "d3-scale-chromatic";
import {
  BrushCleaning,
  ChevronDown,
  Copy,
  DoorClosed,
  Hash,
  List,
  Pencil,
  Plus,
  Trash2,
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
import { useDialogMutation } from "~/lib/use-dialog-mutation";
import { cn } from "~/lib/utils";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/zones/")({
  component: ZonesIndex,
});

// Distinct fill colors for zones in a group. Tailwind's 500 scale across
// the rainbow, shuffled so adjacent zones land on far-apart hues — up to
// 17 zones render distinctly; beyond that the cycle repeats.
const ZONE_COLORS = [
  "#3b82f6", // blue-500
  "#f97316", // orange-500
  "#22c55e", // green-500
  "#d946ef", // fuchsia-500
  "#eab308", // yellow-500
  "#06b6d4", // cyan-500
  "#ec4899", // pink-500
  "#84cc16", // lime-500
  "#8b5cf6", // violet-500
  "#10b981", // emerald-500
  "#f43f5e", // rose-500
  "#0ea5e9", // sky-500
  "#f59e0b", // amber-500
  "#a855f7", // purple-500
  "#14b8a6", // teal-500
  "#ef4444", // red-500
  "#6366f1", // indigo-500
];
function colorFor(i: number): string {
  return ZONE_COLORS[i % ZONE_COLORS.length]!;
}

// Hardcoded for now — eventually will come from a data-service registry
// endpoint that enumerates which `boundaries.*` tables exist for an org.
const KEY_GROUPS_AVAILABLE = [
  { value: "nyc_eds", label: "NYC EDs" },
  { value: "nyc_zips", label: "NYC ZIPs" },
];

function ZonesIndex() {
  const queryClient = useQueryClient();

  const { data: zoneGroups } = useQuery({
    queryKey: ["zoneGroups"],
    queryFn: () => client.zoneGroups.list(),
    placeholderData: keepPreviousData,
  });

  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [activeZoneId, setActiveZoneId] = useState<string | null>(null);
  const [groupOpen, setGroupOpen] = useState(false);
  const pendingValueRef = useRef<string | undefined>(undefined);

  // Segment-counts overlay state. The user toggles a switch to enable
  // count shading on the boundary fill, and picks which segment's
  // counts to show. Both pieces of state stick around when the
  // toggle is off — flicking it back on resumes with the same
  // segment selected.
  const [showSegmentCounts, setShowSegmentCounts] = useState(false);
  const [overlaySegmentId, setOverlaySegmentId] = useState<string | null>(null);
  const [overlaySegmentOpen, setOverlaySegmentOpen] = useState(false);

  // Key-info popup. Visible when the user has clicked a key while no
  // zone is selected (zone-selected mode reserves clicks for
  // assignment, see `handlePolygonClick`).
  const [clickedKey, setClickedKey] = useState<string | null>(null);

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
    setClickedKey(null);
  }, [activeGroupId]);

  // Selecting a zone enters assignment mode; the info popup belongs to
  // no-zone-selected mode, so clear it.
  useEffect(() => {
    if (activeZoneId) setClickedKey(null);
  }, [activeZoneId]);

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
    // No onSettled invalidate: optimistic write is a complete mirror of
    // what the server stores, so a refetch would just re-fetch identical
    // data and flash the global indicator on every polygon click.
  });

  const renameGroup = useDialogMutation({
    mutationFn: (input: { zoneGroupId: string; name: string }) => client.zoneGroups.rename(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["zoneGroups"] }),
  });

  const createGroup = useDialogMutation({
    mutationFn: (input: { name: string; keyGroup: string }) => client.zoneGroups.create(input),
    onSuccess: (created) => {
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["zones", activeGroupId] }),
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
    // No onSettled invalidate: same reasoning as updateKeysMutation.
  });

  const removeZoneMutation = useMutation({
    mutationFn: (zoneId: string) => client.zones.remove({ zoneId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["zones", activeGroupId] }),
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
        out[key] = interpolateYlOrRd(t);
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

  // Keys to highlight with a thicker outline. The selected zone's
  // keys, or the clicked key if no zone is selected. Same rule with
  // or without the overlay — the highlight is the user's visual
  // handle on what they last picked.
  const activeKeys = useMemo(() => {
    if (activeZoneId && zones) {
      return zones.find((z) => z.zoneId === activeZoneId)?.keys;
    }
    if (clickedKey) return [clickedKey];
    return undefined;
  }, [activeZoneId, zones, clickedKey]);

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
      colors[zoneId] = interpolateYlOrRd(t);
    }
    return { doors, people, colors };
  }, [overlayCountsByKey, zones]);

  const handlePolygonClick = (key: string) => {
    // No zone selected → key click reveals the info popup; otherwise
    // the click toggles membership in the active zone (assignment
    // works regardless of whether the segment-counts overlay is on).
    if (!activeZoneId) {
      setClickedKey(key);
      return;
    }
    if (!zones) return;
    const active = zones.find((z) => z.zoneId === activeZoneId);
    if (!active) return;

    if (active.keys.includes(key)) {
      updateKeysMutation.mutate({
        zoneId: activeZoneId,
        keys: active.keys.filter((k) => k !== key),
      });
      return;
    }

    // A key belongs to at most one zone in the group. If another zone
    // already owns it, strip it from there before adding to the active
    // zone — both mutations fire optimistically.
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
    if (!activeZoneId && !clickedKey) return;
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
      groupOpen ||
      overlaySegmentOpen
    ) {
      return;
    }
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (mapWrapperRef.current?.contains(target)) return;
      // Zone-box clicks must not fire the deselect: the box's own
      // onClick already toggles activeZoneId, and clearing here on
      // mousedown would flash through a no-selection frame between
      // mousedown and click.
      if (target instanceof Element && target.closest("[data-zone-button]")) return;
      setActiveZoneId(null);
      setClickedKey(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [
    activeZoneId,
    clickedKey,
    createGroup.isOpen,
    cloneGroup.isOpen,
    clearZones.isOpen,
    renameGroup.isOpen,
    deleteGroup.isOpen,
    renamingZoneId,
    groupOpen,
    overlaySegmentOpen,
  ]);

  return (
    <>
      <div className="mb-4 flex h-8 items-center justify-between">
        <h1 className="text-xl font-extrabold tracking-wide italic">Zone Editor</h1>
        <div className="flex items-center gap-2">
          <DropdownMenu
            open={groupOpen}
            onOpenChange={setGroupOpen}
            onOpenChangeComplete={(isOpen) => {
              if (!isOpen && pendingValueRef.current !== undefined) {
                const v = pendingValueRef.current;
                pendingValueRef.current = undefined;
                setActiveGroupId(v);
              }
            }}
          >
            <DropdownMenuTrigger render={<Button variant="outline" />}>
              <List className="size-3.5" />
              <span className={activeGroup ? undefined : "invisible"}>
                {activeGroup?.name ?? "—"}
              </span>
              <ChevronDown className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuRadioGroup
                value={activeGroupId ?? ""}
                onValueChange={(v) => {
                  pendingValueRef.current = v;
                  setGroupOpen(false);
                }}
              >
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
            <BrushCleaning />
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
                data-zone-button=""
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
                  <>
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
                    <button
                      type="button"
                      aria-label="Rename zone"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenameDraft(zone.name);
                        setRenamingZoneId(zone.zoneId);
                      }}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  aria-label="Delete zone"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (activeZoneId === zone.zoneId) setActiveZoneId(null);
                    removeZoneMutation.mutate(zone.zoneId);
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Trash2 className="size-3.5" />
                </button>
                <Pill variant="number" className="!w-fit shrink-0 justify-end gap-1.5">
                  {zoneOverlay ? (
                    <>
                      <DoorClosed className="size-3.5 text-foreground" />
                      {(zoneOverlay.doors[zone.zoneId] ?? 0).toLocaleString()}
                    </>
                  ) : (
                    <>
                      <Hash className="size-3.5 text-foreground" />
                      {zone.keys.length}
                    </>
                  )}
                </Pill>
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
        <div
          ref={mapWrapperRef}
          className="relative col-span-2 h-full overflow-hidden rounded-lg border border-border"
        >
          <Map
            className="h-full"
            boundariesUrl={
              activeGroup
                ? `${import.meta.env.VITE_DATA_URL}/key-groups/${activeGroup.keyGroup}/geojson?v=${new Date(activeGroup.updatedAt).getTime()}`
                : undefined
            }
            coloringByKey={coloringByKey}
            coloredFillOpacity={overlayActive ? 1 : 0.4}
            activeKeys={activeKeys}
            onPolygonClick={handlePolygonClick}
            onBackgroundClick={() => setClickedKey(null)}
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
            <DropdownMenu open={overlaySegmentOpen} onOpenChange={setOverlaySegmentOpen}>
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
                  value={overlaySegmentId ?? ""}
                  onValueChange={(v) => {
                    setOverlaySegmentId(v || null);
                    setOverlaySegmentOpen(false);
                  }}
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
          {(() => {
            const activeZone = activeZoneId
              ? (zones?.find((z) => z.zoneId === activeZoneId) ?? null)
              : null;
            if (!activeZone && !clickedKey) return null;
            return (
              <div
                className={cn(
                  "absolute top-3 right-3 z-10",
                  "rounded-md border border-border bg-card/95 px-3 py-2 text-right text-sm shadow-sm backdrop-blur",
                )}
              >
                <div className="space-y-2">
                  {activeZone ? (
                    <>
                      <div>
                        <div className="text-muted-foreground">Zone</div>
                        <div>{activeZone.name}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Count</div>
                        <div className="font-mono">{activeZone.keys.length}</div>
                      </div>
                      {zoneOverlay ? (
                        <>
                          <div>
                            <div className="text-muted-foreground">People</div>
                            <div className="font-mono">
                              {(zoneOverlay.people[activeZone.zoneId] ?? 0).toLocaleString()}
                            </div>
                          </div>
                          <div>
                            <div className="text-muted-foreground">Doors</div>
                            <div className="font-mono">
                              {(zoneOverlay.doors[activeZone.zoneId] ?? 0).toLocaleString()}
                            </div>
                          </div>
                        </>
                      ) : null}
                    </>
                  ) : clickedKey ? (
                    <>
                      <div>
                        <div className="text-muted-foreground">Key</div>
                        <div className="font-mono">{clickedKey}</div>
                      </div>
                      {overlayCountsByKey ? (
                        <>
                          <div>
                            <div className="text-muted-foreground">People</div>
                            <div className="font-mono">
                              {(overlayCountsByKey[clickedKey]?.people ?? 0).toLocaleString()}
                            </div>
                          </div>
                          <div>
                            <div className="text-muted-foreground">Doors</div>
                            <div className="font-mono">
                              {(overlayCountsByKey[clickedKey]?.doors ?? 0).toLocaleString()}
                            </div>
                          </div>
                        </>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </div>
            );
          })()}
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
