import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
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
import { darkAtom } from "~/lib/atoms/theme";
import { KEY_GROUPS_AVAILABLE } from "~/lib/key-groups";
import { segmentDetailQuery, segmentsListQuery } from "~/lib/queries/segments";
import { zoneGroupsQuery, zonesQuery } from "~/lib/queries/zones";
import { useDialogMutation } from "~/lib/use-dialog-mutation";
import { useDeferredRadioDropdown } from "~/lib/use-deferred-radio-dropdown";
import { useFadeOnce } from "~/lib/use-fade-once";
import { cn } from "~/lib/utils";
import { colorFor, interpolateRamp } from "~/lib/zone-colors";
import { client } from "~/rpc/client";

type ZonesSearch = {
  groupId?: string;
};

function sortByName<T extends { name: string }>(items: ReadonlyArray<T>): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

export const Route = createFileRoute("/zones/")({
  validateSearch: (s): ZonesSearch => ({
    groupId: typeof s.groupId === "string" ? s.groupId : undefined,
  }),
  loaderDeps: ({ search }) => ({ groupId: search.groupId }),
  loader: async ({ context: { queryClient }, deps }) => {
    const groups = await queryClient.fetchQuery(zoneGroupsQuery());
    const fallbackId = sortByName(groups)[0]?.zoneGroupId;

    const idInUrl = deps.groupId;
    const exists = idInUrl ? groups.some((g) => g.zoneGroupId === idInUrl) : false;

    if (!idInUrl || !exists) {
      if (fallbackId) {
        throw redirect({ to: "/zones", search: { groupId: fallbackId } });
      }
      return;
    }

    await queryClient.fetchQuery(zonesQuery(idInUrl));
  },
  component: ZonesIndex,
});

function ZonesIndex() {
  const queryClient = useQueryClient();
  const navigate = useNavigate({ from: Route.fullPath });
  const { groupId: activeGroupId = null } = Route.useSearch();
  const shouldFade = useFadeOnce("/zones");
  const isDark = useAtomValue(darkAtom);

  const setActiveGroupId = (id: string | null) => {
    void navigate({ search: { groupId: id ?? undefined } });
  };

  const { data: zoneGroups } = useSuspenseQuery(zoneGroupsQuery());
  const sortedZoneGroups = useMemo(() => sortByName(zoneGroups), [zoneGroups]);

  const [activeZoneId, setActiveZoneId] = useState<string | null>(null);
  const groupDropdown = useDeferredRadioDropdown({
    onCommit: (v) => setActiveGroupId(v || null),
  });

  // Segment-counts overlay. State sticks across toggle off/on so flicking
  // back resumes with the same segment.
  const [showSegmentCounts, setShowSegmentCounts] = useState(false);
  const [overlaySegmentId, setOverlaySegmentId] = useState<string | null>(null);
  const overlaySegmentDropdown = useDeferredRadioDropdown({
    onCommit: (v) => setOverlaySegmentId(v || null),
  });

  // `displayedHoverKey` lags `hoveredKey` so the popup's fade-out has
  // content to fade.
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [displayedHoverKey, setDisplayedHoverKey] = useState<string | null>(null);
  useEffect(() => {
    if (hoveredKey) setDisplayedHoverKey(hoveredKey);
  }, [hoveredKey]);

  const activeGroup = zoneGroups.find((g) => g.zoneGroupId === activeGroupId) ?? null;

  const { data: zones } = useQuery({
    ...zonesQuery(activeGroupId ?? ""),
    enabled: !!activeGroupId,
  });

  const { data: segments } = useQuery(segmentsListQuery());

  // Full row for the segment — list payload omits `query` for size.
  const { data: overlaySegmentDetail } = useQuery({
    ...segmentDetailQuery(overlaySegmentId ?? ""),
    enabled: !!overlaySegmentId,
  });

  // Key-determined: same query + keyGroup always yields the same result.
  const overlayCriteria = overlaySegmentDetail?.criteria ?? null;
  const overlayCriteriaKey = overlayCriteria ? JSON.stringify(overlayCriteria) : null;
  const { data: overlayCounts } = useQuery({
    queryKey: ["counts-by-key", overlayCriteriaKey, activeGroup?.keyGroup],
    queryFn: () =>
      client.segments.countByKey({
        criteria: overlayCriteria!,
        keyGroup: activeGroup!.keyGroup,
        keyFilter: null,
      }),
    enabled:
      showSegmentCounts &&
      !!overlaySegmentDetail &&
      overlaySegmentDetail.segmentId === overlaySegmentId &&
      !!activeGroup,
    staleTime: Number.POSITIVE_INFINITY,
  });

  // Reset zone selection on group change.
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
    // No invalidate of zones list: optimistic write is a complete mirror,
    // so refetching would just flash the spinner on every polygon click.
    // Cross-page propagation is automatic — campaign editor's points/counts
    // queries key on the resolved zone keys, so a key change here busts
    // their cache via key change rather than explicit invalidation.
  });

  const renameGroup = useDialogMutation({
    mutationFn: (input: { zoneGroupId: string; name: string }) => client.zoneGroups.rename(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["zone-groups"] }),
  });

  const createGroup = useDialogMutation({
    mutationFn: (input: { name: string; keyGroup: string }) => client.zoneGroups.create(input),
    onSuccess: (created) => {
      // Inject before navigating so the loader's URL-validates-against-list
      // check sees the new group instead of redirecting back to the survivor.
      queryClient.setQueryData<typeof zoneGroups>(["zone-groups"], (old) =>
        old ? [...old, created] : [created],
      );
      void queryClient.invalidateQueries({ queryKey: ["zone-groups"] });
      setActiveGroupId(created.zoneGroupId);
    },
  });

  const cloneGroup = useDialogMutation({
    mutationFn: (input: { zoneGroupId: string; newName: string }) => client.zoneGroups.clone(input),
    onSuccess: (created) => {
      queryClient.setQueryData<typeof zoneGroups>(["zone-groups"], (old) =>
        old ? [...old, created] : [created],
      );
      void queryClient.invalidateQueries({ queryKey: ["zone-groups"] });
      setActiveGroupId(created.zoneGroupId);
    },
  });

  const clearZones = useDialogMutation({
    mutationFn: (zoneGroupId: string) => client.zones.removeAllInGroup({ zoneGroupId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["zones", activeGroupId] });
    },
  });

  const deleteGroup = useDialogMutation({
    mutationFn: (zoneGroupId: string) => client.zoneGroups.remove({ zoneGroupId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["zone-groups"] });
      // Loader picks the alphabetical-first survivor.
      setActiveGroupId(null);
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
    onMutate: ({ zoneId, name }) => {
      // Sync so the cache update lands before React re-renders after
      // commitRename clears renamingZoneId — otherwise the span briefly
      // shows the old cached name. Fire-and-forget cancellation: it
      // initiates synchronously, only the resolution is async.
      void queryClient.cancelQueries({ queryKey: ["zones", activeGroupId] });
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
    // No invalidate: optimistic update on ["zones", id] propagates to all
    // consumers (campaign editor reads the same cache slot).
  });

  const removeZoneMutation = useMutation({
    mutationFn: (zoneId: string) => client.zones.remove({ zoneId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["zones", activeGroupId] });
    },
    onError: (e) => console.error("zones.remove failed", e),
  });

  const [renamingZoneId, setRenamingZoneId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  // Delete / Backspace removes the active zone (mirrors the trash button).
  // Skipped while typing in any text input so the rename flow isn't hijacked.
  useEffect(() => {
    if (!activeZoneId) return;
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
      const id = activeZoneId;
      setActiveZoneId(null);
      removeZoneMutation.mutate(id);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [activeZoneId, removeZoneMutation]);

  const commitRename = (zoneId: string, currentName: string) => {
    const next = renameDraft.trim();
    setRenamingZoneId(null);
    if (next.length === 0 || next === currentName) return;
    renameZoneMutation.mutate({ zoneId, name: next });
  };

  // Two coloring modes: no overlay → zone hue per key; overlay on → YlOrRd
  // heatmap on doors with sqrt scaling.
  const overlayActive = showSegmentCounts && !!overlayCounts;

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
        out[key] = interpolateRamp(t, isDark);
      }
      return out;
    }
    const out: Record<string, string> = {};
    zones?.forEach((zone, idx) => {
      const color = colorFor(idx);
      for (const key of zone.keys) out[key] = color;
    });
    return out;
  }, [zones, overlayCountsByKey, isDark]);

  // Keys with a thicker outline — every key in the selected zone.
  const activeKeys = useMemo(() => {
    if (activeZoneId && zones) {
      return zones.find((z) => z.zoneId === activeZoneId)?.keys;
    }
    return undefined;
  }, [activeZoneId, zones]);

  // Per-zone rollup of segment counts — sums per-key counts across each
  // zone's keys, no extra round trip. Drives the sidebar's pills/colors.
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
      colors[zoneId] = interpolateRamp(t, isDark);
    }
    return { doors, people, colors };
  }, [overlayCountsByKey, zones, isDark]);

  const handlePolygonClick = (key: string, opts: { shiftKey: boolean }) => {
    if (!zones) return;
    if (opts.shiftKey) {
      // Shift-click toggles the key's membership in the active zone.
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

      // A key belongs to at most one zone — strip from the previous owner
      // before adding to the active zone.
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
    // Plain click activates the zone that contains the key (or clears).
    const owner = zones.find((z) => z.keys.includes(key));
    setActiveZoneId(owner?.zoneId ?? null);
  };

  // Snapshotted at click time so the dialog body keeps showing the
  // just-deleted name during its close animation, even after the URL
  // has reactively swapped to the fallback zone group.
  const [deleteSnapshot, setDeleteSnapshot] = useState({ name: "", campaignCount: 0 });

  // Click outside the map clears the active zone. Suppressed while any
  // modal/inline-rename is open and while a dropdown is open — dropdowns
  // portal their content outside the map wrapper, so a click on an item
  // would otherwise register as outside-the-map.
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
      groupDropdown.open ||
      overlaySegmentDropdown.open
    ) {
      return;
    }
    const handler = (e: MouseEvent) => {
      // Skip the second click of a double-click so dbl-click to rename
      // doesn't deselect-then-reselect a second time (one visible flash
      // from click 1 is what we want).
      if (e.detail >= 2) return;
      const target = e.target as Node | null;
      if (!target) return;
      if (mapWrapperRef.current?.contains(target)) return;
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
      <div className={shouldFade ? "animate-in fade-in duration-100" : undefined}>
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
                  {sortedZoneGroups.map((g) => (
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
                // Fetch before opening so the dialog has the count up front.
                const { count } = await queryClient.fetchQuery({
                  queryKey: ["zone-groups", "count-campaigns", activeGroupId],
                  queryFn: () => client.zoneGroups.countCampaigns({ zoneGroupId: activeGroupId }),
                  staleTime: 0,
                });
                setDeleteSnapshot({ name: activeGroup?.name ?? "", campaignCount: count });
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
                      backgroundColor: zoneOverlay
                        ? zoneOverlay.colors[zone.zoneId]
                        : colorFor(idx),
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
                  ? `/api/boundaries/${activeGroup.keyGroup}/geojson?v=${new Date(activeGroup.updatedAt).getTime()}`
                  : undefined
              }
              coloringByKey={coloringByKey}
              coloredFillOpacity={0.8}
              activeKeys={activeKeys}
              onPolygonClick={handlePolygonClick}
              onPolygonHover={setHoveredKey}
              onBackgroundClick={() => setActiveZoneId(null)}
            />

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

            {/* Hover-driven key inspector. Stays mounted, opacity-toggled,
                so cursor drags between polygons read as content swap. */}
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
        groupName={deleteSnapshot.name}
        campaignCount={deleteSnapshot.campaignCount}
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
                    className={cn(
                      "rounded-md border border-border px-2.5 py-1 text-sm disabled:opacity-50 active:translate-y-px",
                      selected ? "bg-foreground/10" : "bg-background hover:bg-muted",
                    )}
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
