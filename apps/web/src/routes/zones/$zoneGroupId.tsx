import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { ChevronDown, Diamond, DoorClosed, Plus, Trash2, UserRound } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { Switch } from "~/components/switch";
import { darkAtom } from "~/lib/atoms/theme";
import { segmentDetailQuery, segmentsListQuery } from "~/lib/queries/segments";
import { zoneGroupsQuery, zonesQuery } from "~/lib/queries/zones";
import { useDeferredRadioDropdown } from "~/lib/use-deferred-radio-dropdown";
import { cn } from "~/lib/utils";
import { colorFor, interpolateRamp } from "~/lib/zone-colors";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/zones/$zoneGroupId")({
  loader: async ({ context: { queryClient }, params: { zoneGroupId } }) => {
    const groups = await queryClient.fetchQuery(zoneGroupsQuery());
    const exists = groups.some((g) => g.zoneGroupId === zoneGroupId);
    if (!exists) {
      // Loader at /zones picks the most-recent fallback.
      throw redirect({ to: "/zones" });
    }
    await queryClient.fetchQuery(zonesQuery(zoneGroupId));
  },
  component: ZoneGroupEditor,
});

function ZoneGroupEditor() {
  const queryClient = useQueryClient();
  const { zoneGroupId } = Route.useParams();
  const isDark = useAtomValue(darkAtom);

  const { data: zoneGroups } = useSuspenseQuery(zoneGroupsQuery());
  const activeGroup = zoneGroups.find((g) => g.zoneGroupId === zoneGroupId) ?? null;

  const { data: zones } = useQuery(zonesQuery(zoneGroupId));
  const { data: segments } = useQuery(segmentsListQuery());

  const [activeZoneId, setActiveZoneId] = useState<string | null>(null);

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
      }),
    enabled:
      showSegmentCounts &&
      !!overlaySegmentDetail &&
      overlaySegmentDetail.segmentId === overlaySegmentId &&
      !!activeGroup,
    staleTime: Number.POSITIVE_INFINITY,
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
      void queryClient.invalidateQueries({ queryKey: ["zones", zoneGroupId] });
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
    <div className="grid grid-cols-3 gap-4 h-full">
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
        {zones ? (
          <button
            type="button"
            onClick={() =>
              createZoneMutation.mutate({
                zoneGroupId,
                name: `Zone ${zones.length + 1}`,
              })
            }
            className={cn(
              "flex h-[46px] items-center justify-between gap-2",
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
                {segments?.find((s) => s.segmentId === overlaySegmentId)?.name ?? "Pick a segment…"}
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
  );
}
