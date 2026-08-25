import { Icon } from "~/components/icon";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { Reorder, useDragControls } from "motion/react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "~/components/button";
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
import { Swatch } from "~/components/swatch";
import { Switch } from "~/components/switch";
import { darkAtom } from "~/lib/atoms/theme";
import { useRememberedState, useRememberSelection } from "~/lib/last-selected";
import { manifestQuery } from "~/lib/queries/manifest";
import { liveAwareStaleTime, segmentDetailQuery, segmentsListQuery } from "~/lib/queries/segments";
import { zoneGroupsQuery, zonesQuery } from "~/lib/queries/zones";
import { segmentRefsVersion } from "~/lib/segment-refs";
import { useDeferredRadioDropdown } from "~/lib/use-deferred-radio-dropdown";
import { useHotkey } from "~/lib/use-hotkey";
import { cn, revealZoneCard } from "~/lib/utils";
import { colorFor, interpolateRamp } from "~/lib/zone-colors";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/$orgSlug/zones/$zoneGroupId")({
  loader: async ({ context: { queryClient }, params: { orgSlug, zoneGroupId }, preload }) => {
    const groups = await queryClient.fetchQuery(zoneGroupsQuery());
    const exists = groups.some((g) => g.zoneGroupId === zoneGroupId);
    if (!exists) {
      // Redirect only on real navigations — a redirect thrown during a
      // hover preload gets committed and auto-navigates. Loader at /zones
      // picks the most-recent fallback.
      if (preload) return;
      throw redirect({ to: "/$orgSlug/zones", params: { orgSlug } });
    }
    await queryClient.fetchQuery(zonesQuery(zoneGroupId));
  },
  component: ZoneGroupEditor,
});

function ZoneGroupEditor() {
  const queryClient = useQueryClient();
  const { orgSlug, zoneGroupId } = Route.useParams();
  // The zones index redirects back here next visit.
  useRememberSelection(orgSlug, "zones", zoneGroupId);
  const isDark = useAtomValue(darkAtom);

  const { data: zoneGroups } = useSuspenseQuery(zoneGroupsQuery());
  const activeGroup = zoneGroups.find((g) => g.zoneGroupId === zoneGroupId) ?? null;

  const { data: zones } = useQuery(zonesQuery(zoneGroupId));
  const { data: segments } = useQuery(segmentsListQuery());
  // Prefetched by the zones layout loader — cache hit. Carries the active
  // dataset versionId, the version stamp for boundary geometry.
  const { data: manifestRow } = useQuery(manifestQuery());

  const [activeZoneId, setActiveZoneId] = useState<string | null>(null);

  // Segment-counts overlay. The segment sticks across toggle off/on and
  // across visits (session-remembered, like the zone group itself); a
  // remembered segment that no longer exists drops to no selection.
  const [showSegmentCounts, setShowSegmentCounts] = useState(false);
  const [rememberedSegmentId, setOverlaySegmentId] = useRememberedState(
    orgSlug,
    "zones-overlay-segment",
    null,
  );
  const overlaySegmentId = segments?.some((s) => s.segmentId === rememberedSegmentId)
    ? rememberedSegmentId
    : null;
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

  // Full row for the segment — list payload omits `query` for size.
  const { data: overlaySegmentDetail } = useQuery({
    ...segmentDetailQuery(overlaySegmentId ?? ""),
    enabled: !!overlaySegmentId,
  });

  // Keyed on the criteria hash plus the ref-closure version — the hash alone
  // is byte-identical when only a *referenced* segment's contents change.
  const overlayCriteria = overlaySegmentDetail?.criteria ?? null;
  const overlayCriteriaKey = overlayCriteria ? JSON.stringify(overlayCriteria) : null;
  const { data: overlayCounts } = useQuery({
    queryKey: [
      "counts-by-key",
      overlayCriteriaKey,
      activeGroup?.keyGroup,
      segmentRefsVersion(overlayCriteria, segments),
    ],
    queryFn: () =>
      client.segments.countByKey({
        criteria: overlayCriteria!,
        keyGroup: activeGroup!.keyGroup,
      }),
    enabled:
      showSegmentCounts &&
      !!overlaySegmentDetail &&
      overlaySegmentDetail.segmentId === overlaySegmentId &&
      !!activeGroup,
    staleTime: liveAwareStaleTime(overlayCriteria, segments),
  });

  const updateKeysMutation = useMutation({
    mutationFn: (input: { zoneId: string; keys: string[] }) => client.zones.updateKeys(input),
    onMutate: async ({ zoneId, keys }) => {
      await queryClient.cancelQueries({ queryKey: ["zones", zoneGroupId] });
      const previous = queryClient.getQueryData<typeof zones>(["zones", zoneGroupId]);
      queryClient.setQueryData<typeof zones>(["zones", zoneGroupId], (old) =>
        old?.map((z) => (z.zoneId === zoneId ? { ...z, keys } : z)),
      );
      return { previous };
    },
    onError: (e, _v, ctx) => {
      console.error("zones.updateKeys failed", e);
      if (ctx?.previous) queryClient.setQueryData(["zones", zoneGroupId], ctx.previous);
    },
    // No invalidate of zones list: optimistic write is a complete mirror,
    // so refetching would just flash the spinner on every polygon click.
    // Cross-page propagation is automatic — campaign editor's points/counts
    // queries key on the resolved zone keys, so a key change here busts
    // their cache via key change rather than explicit invalidation.
  });

  const createZoneMutation = useMutation({
    mutationFn: (input: { zoneGroupId: string; name: string }) => client.zones.create(input),
    onSuccess: (created) => {
      setActiveZoneId(created.zoneId);
      return queryClient.invalidateQueries({
        queryKey: ["zones", zoneGroupId],
      });
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
      void queryClient.cancelQueries({ queryKey: ["zones", zoneGroupId] });
      const previous = queryClient.getQueryData<typeof zones>(["zones", zoneGroupId]);
      queryClient.setQueryData<typeof zones>(["zones", zoneGroupId], (old) =>
        old?.map((z) => (z.zoneId === zoneId ? { ...z, name } : z)),
      );
      return { previous };
    },
    onError: (e, _v, ctx) => {
      console.error("zones.rename failed", e);
      if (ctx?.previous) queryClient.setQueryData(["zones", zoneGroupId], ctx.previous);
    },
  });

  const removeZoneMutation = useMutation({
    mutationFn: (zoneId: string) => client.zones.remove({ zoneId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["zones", zoneGroupId] });
    },
    onError: (e) => console.error("zones.remove failed", e),
  });

  const [renamingZoneId, setRenamingZoneId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  // While a drag is active, the visual list reorders via `draft`; the query
  // cache only updates on drop. Mirrors the segment editor's step reorder.
  const [draftZones, setDraftZones] = useState<typeof zones | null>(null);
  const displayZones = draftZones ?? zones;

  const reorderZonesMutation = useMutation({
    mutationFn: (input: { zoneGroupId: string; zoneIds: string[] }) => client.zones.reorder(input),
    onMutate: async ({ zoneIds }) => {
      await queryClient.cancelQueries({ queryKey: ["zones", zoneGroupId] });
      const previous = queryClient.getQueryData<typeof zones>(["zones", zoneGroupId]);
      // Object, not Map: the `Map` identifier here is the map component.
      const byId = Object.fromEntries((previous ?? []).map((z) => [z.zoneId, z]));
      queryClient.setQueryData<typeof zones>(["zones", zoneGroupId], (old) =>
        old ? zoneIds.map((id) => byId[id]).filter((z) => z !== undefined) : old,
      );
      return { previous };
    },
    onError: (e, _v, ctx) => {
      console.error("zones.reorder failed", e);
      if (ctx?.previous) queryClient.setQueryData(["zones", zoneGroupId], ctx.previous);
    },
    // No invalidate: the optimistic write is a complete mirror of the new
    // order, and the campaign editor reads the same ["zones", id] cache.
  });

  const handleZoneDragEnd = () => {
    if (!draftZones) return;
    const next = draftZones.map((z) => z.zoneId);
    const current = (zones ?? []).map((z) => z.zoneId);
    if (next.join("\n") !== current.join("\n")) {
      reorderZonesMutation.mutate({ zoneGroupId, zoneIds: next });
    }
    setDraftZones(null);
  };

  // Auto-scroll the zone list to the bottom when a zone is added so the new
  // card (and the New zone button) stay in view even when the list
  // overflows. Tracked per-group so switching groups doesn't read "count
  // grew"; while zones are loading, 0→N is data arrival, not a user add.
  const zoneListRef = useRef<HTMLDivElement>(null);
  const prevZonesRef = useRef<{ zoneGroupId: string; length: number } | null>(null);
  useEffect(() => {
    if (!zones) return;
    const prev = prevZonesRef.current;
    if (
      prev &&
      prev.zoneGroupId === zoneGroupId &&
      zones.length > prev.length &&
      zoneListRef.current
    ) {
      zoneListRef.current.scrollTo({
        top: zoneListRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
    prevZonesRef.current = { zoneGroupId, length: zones.length };
  }, [zones, zoneGroupId]);

  // Delete / Backspace removes the active zone (mirrors the trash button).
  // Skipped while typing in any text input so the rename flow isn't hijacked.
  // Mod-Delete escalates to the route-level zone-group delete and is
  // skipped here.
  useEffect(() => {
    if (!activeZoneId) return;
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
      const id = activeZoneId;
      setActiveZoneId(null);
      removeZoneMutation.mutate(id);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [activeZoneId, removeZoneMutation]);

  // Space toggles the heatmap overlay so the user can flick between
  // zone-color and segment-counts views without taking their hand off
  // the mouse. Browser default (scroll) is preempted by useHotkey.
  useHotkey({
    key: " ",
    enabled: true,
    onMatch: () => setShowSegmentCounts((s) => !s),
  });

  const commitRename = (zoneId: string, currentName: string) => {
    const next = renameDraft.trim();
    setRenamingZoneId(null);
    if (next.length === 0 || next === currentName) return;
    renameZoneMutation.mutate({ zoneId, name: next });
  };

  // Two coloring modes: no overlay → zone hue per key; overlay on → YlOrRd
  // heatmap on doors with sqrt scaling.
  const overlayActive = showSegmentCounts && !!overlayCounts;

  // Overlay on but counts still in flight (fresh toggle or segment switch):
  // blank the fills rather than cycling through zone colors on the way to
  // the new heatmap.
  const overlayPending = showSegmentCounts && !!overlaySegmentId && !overlayCounts;

  type KeyCount = { doors: number; people: number };
  const overlayCountsByKey = overlayActive
    ? (overlayCounts.counts as Record<string, KeyCount>)
    : null;

  const coloringByKey = useMemo(() => {
    if (overlayPending) return {};
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
  }, [zones, overlayCountsByKey, overlayPending, isDark]);

  // Keys with a thicker outline — every key in the selected zone.
  const activeKeys = useMemo(() => {
    if (activeZoneId && zones) {
      return zones.find((z) => z.zoneId === activeZoneId)?.keys;
    }
    return undefined;
  }, [activeZoneId, zones]);

  // Per-zone rollup of segment counts — sums per-key counts across each
  // zone's keys, no extra round trip. Drives the sidebar's pills/colors.
  // Swatch color is the mean of the zone's keys' positions on the map's
  // ramp (per-key doors / max key doors), so the swatch matches how the
  // zone's area reads on the map; the pills carry the exact totals.
  const zoneOverlay = useMemo(() => {
    if (!overlayCountsByKey || !zones) return null;
    let maxKeyDoors = 0;
    for (const v of Object.values(overlayCountsByKey))
      if (v.doors > maxKeyDoors) maxKeyDoors = v.doors;
    const doors: Record<string, number> = {};
    const people: Record<string, number> = {};
    const colors: Record<string, string> = {};
    for (const zone of zones) {
      let d = 0;
      let p = 0;
      let tSum = 0;
      for (const k of zone.keys) {
        const c = overlayCountsByKey[k];
        if (c) {
          d += c.doors;
          p += c.people;
        }
        if (maxKeyDoors > 0) tSum += Math.sqrt((c?.doors ?? 0) / maxKeyDoors);
      }
      doors[zone.zoneId] = d;
      people[zone.zoneId] = p;
      const t = zone.keys.length > 0 ? tSum / zone.keys.length : 0;
      colors[zone.zoneId] = interpolateRamp(t, isDark);
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
    // Map-originated activation only: surface the card in the list (a
    // card click never scrolls — it's already in view).
    if (owner) revealZoneCard(owner.zoneId);
  };

  // Click outside the map clears the active zone. Suppressed while a
  // dropdown is open — the dropdown portals outside the map wrapper, so
  // a click on an item would otherwise register as outside-the-map.
  const mapWrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!activeZoneId) return;
    if (renamingZoneId || overlaySegmentDropdown.open) return;
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
  }, [activeZoneId, renamingZoneId, overlaySegmentDropdown.open]);

  return (
    <div className="flex gap-4 h-full">
      <div ref={zoneListRef} className="w-86 shrink-0 flex flex-col gap-2 overflow-y-auto">
        {/* Mounted only when non-empty: an empty group div still takes a slot
            in the parent's gap, nudging the New-zone card off the top edge. */}
        {displayZones?.length ? (
          <Reorder.Group
            axis="y"
            values={displayZones}
            onReorder={setDraftZones}
            as="div"
            className="flex flex-col gap-2"
          >
            {displayZones?.map((zone, idx) => {
              const isActive = zone.zoneId === activeZoneId;
              const isRenaming = renamingZoneId === zone.zoneId;
              return (
                <ReorderZoneItem key={zone.zoneId} zone={zone} onDragEnd={handleZoneDragEnd}>
                  {(dragControls) => (
                    <div
                      data-zone-card={zone.zoneId}
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
                        "flex flex-col gap-1.5 rounded-md border bg-card p-2 pl-3 text-left",
                        isActive
                          ? "border-foreground"
                          : "border-border hover:border-muted-foreground",
                      )}
                    >
                      {/* min-h matches the campaign card's top row so both
                          cards share one height. */}
                      <div className="flex min-h-8 items-center gap-2">
                        <button
                          type="button"
                          className="shrink-0 cursor-grab touch-none text-muted-foreground/40 hover:text-muted-foreground"
                          aria-label="Drag to reorder"
                          onPointerDown={(e) => dragControls.start(e)}
                        >
                          <Icon name="grip-vertical" className="size-3.5" />
                        </button>
                        {/* Heatmap swatches: 90% opacity sits visually with
                            the map's 0.8 fills (different grounds wash color
                            differently), and colorless while counts are in
                            flight, like the map's blanked fills. */}
                        <Swatch
                          color={
                            overlayPending
                              ? undefined
                              : zoneOverlay
                                ? zoneOverlay.colors[zone.zoneId]
                                : colorFor(idx)
                          }
                          className={cn("mr-1 size-4", zoneOverlay && "opacity-90")}
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
                            className="min-w-0 flex-1 truncate text-sm select-none"
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              setRenameDraft(zone.name);
                              setRenamingZoneId(zone.zoneId);
                            }}
                          >
                            {zone.name}
                          </span>
                        )}
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="ml-auto h-8"
                          aria-label="Delete zone"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (activeZoneId === zone.zoneId) setActiveZoneId(null);
                            removeZoneMutation.mutate(zone.zoneId);
                          }}
                        >
                          <Icon name="trash-2" className="size-4" />
                        </Button>
                      </div>
                      <div className="flex min-h-8 items-center gap-1.5">
                        <Pill variant="number" className="!w-fit shrink-0 gap-1.5">
                          <Icon name="diamond" className="size-3.5 text-foreground" />
                          {zone.keys.length}
                        </Pill>
                        {zoneOverlay ? (
                          <>
                            <Pill variant="number" className="!w-fit shrink-0 gap-1.5">
                              <Icon name="user-round" className="size-3.5 text-foreground" />
                              {(zoneOverlay.people[zone.zoneId] ?? 0).toLocaleString()}
                            </Pill>
                            <Pill variant="number" className="!w-fit shrink-0 gap-1.5">
                              <Icon name="door-closed" className="size-3.5 text-foreground" />
                              {(zoneOverlay.doors[zone.zoneId] ?? 0).toLocaleString()}
                            </Pill>
                          </>
                        ) : null}
                      </div>
                    </div>
                  )}
                </ReorderZoneItem>
              );
            })}
          </Reorder.Group>
        ) : null}
        {zones ? (
          <button
            type="button"
            disabled={createZoneMutation.isPending}
            onClick={() =>
              createZoneMutation.mutate({
                zoneGroupId,
                name: `Zone ${zones.length + 1}`,
              })
            }
            className={cn(
              "flex h-11 items-center justify-between gap-2",
              "rounded-md border border-border bg-card px-3 py-2 text-left",
              "text-muted-foreground hover:border-muted-foreground hover:text-foreground",
            )}
          >
            <div className="flex items-center gap-2">
              <Icon name="plus" className="size-3.5" />
              <span className="text-sm">New zone</span>
            </div>
          </button>
        ) : null}
      </div>
      <div ref={mapWrapperRef} className="relative flex-1 min-w-0 h-full">
        <Map
          className="h-full"
          boundariesUrl={
            activeGroup
              ? `/api/web/${orgSlug}/boundaries/${activeGroup.keyGroup}/geojson?v=${manifestRow?.versionId ?? ""}`
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
              // Skip click-to-focus so Space goes to the global toggle
              // hotkey instead of re-activating the focused switch.
              // Tab-to-focus still works, so keyboard users keep
              // Space-to-activate.
              onMouseDown={(e) => e.preventDefault()}
            />
            <span>Show segment counts</span>
          </label>
          <DropdownMenu {...overlaySegmentDropdown.menu}>
            <DropdownMenuTrigger
              disabled={!showSegmentCounts}
              render={<Button variant="outline" className="w-full justify-between" />}
            >
              <span className="min-w-0 truncate">
                {(() => {
                  const s = segments?.find((s) => s.segmentId === overlaySegmentId);
                  if (!s) return "Pick a segment…";
                  return s.isArchived ? `${s.name} (Archived)` : s.name;
                })()}
              </span>
              <Icon name="chevron-down" className="size-3.5 shrink-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuRadioGroup
                {...overlaySegmentDropdown.radio}
                value={overlaySegmentId ?? ""}
              >
                {segments
                  ?.filter((s) => !s.isArchived || s.segmentId === overlaySegmentId)
                  .map((s) => (
                    <DropdownMenuRadioItem key={s.segmentId} value={s.segmentId}>
                      {s.name}
                      {s.isArchived ? " (Archived)" : null}
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
                    <Icon name="user-round" className="size-3.5 text-foreground" />
                    {(overlayCountsByKey[displayedHoverKey]?.people ?? 0).toLocaleString()}
                  </Pill>
                  <Pill variant="number" className="!w-fit gap-1.5">
                    <Icon name="door-closed" className="size-3.5 text-foreground" />
                    {(overlayCountsByKey[displayedHoverKey]?.doors ?? 0).toLocaleString()}
                  </Pill>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// Per-item drag controls need a hook, so the card body renders through a
// child component. Matches the segment editor's ReorderStepRow settings:
// position-only layout animation, no drag momentum.
function ReorderZoneItem({
  zone,
  onDragEnd,
  children,
}: {
  zone: { zoneId: string };
  onDragEnd: () => void;
  children: (dragControls: ReturnType<typeof useDragControls>) => ReactNode;
}) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={zone}
      dragListener={false}
      dragControls={controls}
      as="div"
      onDragEnd={onDragEnd}
      layout="position"
      transition={{
        layout: { type: "tween", duration: 0.15, ease: "easeOut" },
      }}
      dragTransition={{ bounceStiffness: 10000, bounceDamping: 500, power: 0 }}
    >
      {children(controls)}
    </Reorder.Item>
  );
}
