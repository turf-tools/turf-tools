import { keepPreviousData, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { cleanCoords } from "@turf/clean-coords";
import { union } from "@turf/union";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { CircleDotDashed, DoorClosed, Scissors, Send, UserRound } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "~/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "~/components/dialog";
import { Map } from "~/components/map";
import { Pill } from "~/components/pill";
import { Swatch } from "~/components/swatch";
import { useRememberSelection } from "~/lib/last-selected";
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
  segmentCountsQuery,
  segmentsListQuery,
  type SegmentCriteria,
} from "~/lib/queries/segments";
import { turfStatsForCampaignQuery } from "~/lib/queries/turfs";
import { zoneGroupsQuery, zonesQuery } from "~/lib/queries/zones";
import type { Criteria } from "~/lib/filters";
import { cn } from "~/lib/utils";
import { client } from "~/rpc/client";
import { colorFor } from "~/lib/zone-colors";

// Cutting loads every building in the target into the cutter at once; above
// this the cutter bogs down, so we hard-block and steer toward subdividing.
// Thresholded on doors — the count the page actually shows — which also
// bounds buildings (every building has at least one door).
const MAX_CUT_DOORS = 20000;

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

// Reverses the Web Mercator y → lat projection (matches the forward
// transform used in apps/web/src/lib/queries/segments.ts when the points
// buffer is built server-side).
function mercY2Lat(my: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI;
}

// bbox in [west, south, east, north] from the origin-relative fp32
// mercator delta buffer used by the points layer. Used as a fitBounds
// fallback when there's no zone perimeter to fit to.
function bboxOfMercDeltas(buffer: {
  deltas: Float32Array;
  origin: [number, number];
}): [number, number, number, number] | null {
  if (buffer.deltas.length === 0) return null;
  const [ox, oy] = buffer.origin;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < buffer.deltas.length; i += 2) {
    const x = buffer.deltas[i]!;
    const y = buffer.deltas[i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const minLng = (ox + minX) * 360 - 180;
  const maxLng = (ox + maxX) * 360 - 180;
  // Smaller mercator y = larger latitude (top of the map).
  const maxLat = mercY2Lat(oy + minY);
  const minLat = mercY2Lat(oy + maxY);
  return [minLng, minLat, maxLng, maxLat];
}

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

export const Route = createFileRoute("/$orgSlug/campaigns/$campaignId/")({
  loader: async ({ context: { queryClient }, params: { orgSlug, campaignId }, preload }) => {
    const campaigns = await queryClient.fetchQuery(campaignsListQuery());
    const exists = campaigns.some((c) => c.campaignId === campaignId);
    if (!exists) {
      // Redirect only on real navigations — a redirect thrown during a
      // hover preload gets committed and auto-navigates.
      if (preload) return;
      throw redirect({ to: "/$orgSlug/campaigns", params: { orgSlug } });
    }
    // Chrome essentials: campaign detail + turf stats + bound segment +
    // zones. Awaited so the sidebar (zones list) and header snap to the
    // new campaign immediately on navigation. Heavy map data
    // (boundary GeoJSON, points buffer, per-key counts) is fetched
    // in-component; the map's `loading` curtain hides the wait.
    const [campaign] = await Promise.all([
      queryClient.fetchQuery(campaignDetailQuery(campaignId)),
      queryClient.fetchQuery(turfStatsForCampaignQuery(campaignId)),
    ]);
    if (campaign.zoneGroupId) {
      await queryClient.fetchQuery(zonesQuery(campaign.zoneGroupId));
    }
    // segmentsListQuery is prefetched by the parent campaigns layout
    // loader, so we read segment name + criteria from there via find()
    // — matches how the script and zone-group lookups work and keeps
    // a rename's optimistic list patch visible without a hard reload.
  },
  component: CampaignEditor,
});

function CampaignEditor() {
  const navigate = useNavigate();
  const { orgSlug, campaignId } = Route.useParams();
  // The campaigns index redirects back here next visit.
  useRememberSelection(orgSlug, "campaigns", campaignId);

  const { data: campaign } = useSuspenseQuery(campaignDetailQuery(campaignId));
  const { data: zoneGroups } = useSuspenseQuery(zoneGroupsQuery());
  // Scripts + segments lists are pre-fetched by the parent campaigns
  // route loader so these resolve from cache. We look up the bound
  // segment/script/zone-group by id via find(); using the list lets a
  // rename's optimistic patch surface here without a separate detail
  // cache to keep in sync.
  const { data: scripts } = useSuspenseQuery(scriptsListQuery());
  const { data: segments } = useSuspenseQuery(segmentsListQuery());

  const activeZoneGroup = zoneGroups.find((g) => g.zoneGroupId === campaign?.zoneGroupId) ?? null;
  const activeScript = scripts.find((s) => s.scriptId === campaign?.scriptId) ?? null;
  const activeSegment = segments.find((s) => s.segmentId === campaign?.segmentId) ?? null;

  const { data: zones, isPlaceholderData: zonesStale } = useQuery({
    ...zonesQuery(campaign?.zoneGroupId ?? ""),
    enabled: !!campaign?.zoneGroupId,
    placeholderData: keepPreviousData,
  });

  const { data: turfStats } = useQuery({
    ...turfStatsForCampaignQuery(campaignId),
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

  const segmentCriteria = activeSegment?.criteria as Criteria | null | undefined;

  // Points run for both zoned and zoneless campaigns. When `keyFilter` is
  // null the query asks the data server for *all* segment-matching points
  // (no zone-keyed narrowing), which is the right answer for zoneless.
  const { data: pointsBuffer, isPlaceholderData: pointsStale } = useQuery({
    ...campaignPointsQuery(segmentCriteria ?? ({} as SegmentCriteria), keyFilter),
    enabled: !!segmentCriteria,
    placeholderData: keepPreviousData,
  });

  // Per-key counts only matter when zoned (zoneCounts sums them per zone).
  // For zoneless we use segmentCountsQuery below instead, which returns
  // segment-wide totals directly.
  const { data: keyCountsResult, isPlaceholderData: countsStale } = useQuery({
    ...(segmentCriteria && keyFilter
      ? campaignKeyCountsQuery(segmentCriteria, keyFilter.keyGroup, keyFilter.keys)
      : campaignKeyCountsQuery({} as SegmentCriteria, "", [])),
    enabled: !!segmentCriteria && !!keyFilter,
    placeholderData: keepPreviousData,
  });
  const perKeyCounts = keyCountsResult?.counts ?? null;

  // Segment-wide totals for zoneless campaigns — drives the header card's
  // Buildings/Doors/People numbers when there's no zone group to sum from.
  const { data: segmentTotals } = useQuery({
    ...segmentCountsQuery(segmentCriteria ?? ({} as Criteria)),
    enabled: !!segmentCriteria && !campaign?.zoneGroupId,
  });

  // Per-zone totals = sum per-key counts across each zone's keys.
  // Returns null when the underlying counts query is still resolving
  // for the new binding — otherwise mixing stale (previous campaign's)
  // counts with current zones gives mismatched/zero numbers in the
  // sidebar pills. Better to drop the pills until real data lands.
  const zoneCounts = useMemo(() => {
    if (!perKeyCounts || !zones || countsStale) return null;
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
  }, [perKeyCounts, zones, countsStale]);

  // Campaign-wide turf stats. Null until the stats load — zeros are a fact
  // of a loaded result, never a stand-in for one that hasn't arrived.
  const totals = useMemo(() => {
    if (!turfStats) return null;
    let drafts = 0;
    let active = 0;
    let published = 0;
    for (const s of Object.values(turfStats)) {
      drafts += s.drafts;
      active += s.active;
      published += s.published;
    }
    return { drafts, active, published };
  }, [turfStats]);

  // One unioned polygon per zone, tagged with `zoneId`. Single-key zones
  // short-circuit because turf.union returns null for degenerate inputs.
  // Bails when zoneless — `zones` and `boundaryFC` use placeholderData,
  // so without this guard a zoned→zoneless switch flashes the previous
  // campaign's polygons.
  const zonePerimeters = useMemo<FeatureCollection | undefined>(() => {
    if (!campaign?.zoneGroupId) return undefined;
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
  }, [zones, boundaryFC, campaign?.zoneGroupId]);

  // Prefer zone perimeters for the fit when we have them (matches the
  // visible boundary on the map). Fall back to the points cloud for
  // zoneless campaigns so the map still lands somewhere sensible.
  const fitBounds = useMemo(() => {
    if (zonePerimeters) return bboxOfPolys(zonePerimeters);
    if (pointsBuffer) return bboxOfMercDeltas(pointsBuffer);
    return null;
  }, [zonePerimeters, pointsBuffer]);

  // Curtain stays up until every relevant query has data for the current
  // bindings (no `isPlaceholderData` from a previous binding).
  const ready = (() => {
    if (!campaign) return false;
    const s = !!campaign.segmentId;
    const z = !!campaign.zoneGroupId;
    if (s) {
      // The segments list is loader-prefetched and rerendered via
      // useSuspenseQuery, so `activeSegment` is always fresh — no
      // separate staleness gate needed for the segment binding.
      if (!activeSegment) return false;
      // Points fire as soon as we have a segment, zoned or not.
      if (!pointsBuffer || pointsStale) return false;
    }
    if (z) {
      if (!zones || zonesStale) return false;
      if (!boundaryFC || boundaryStale) return false;
      if (!perKeyCounts || countsStale) return false;
    } else if (s) {
      // Zoneless: header totals come from segmentTotals instead of
      // per-zone aggregation.
      if (!segmentTotals) return false;
    }
    return true;
  })();

  const [limitOpen, setLimitOpen] = useState(false);
  // Snapshot the offending count separately from the open flag so the body
  // doesn't flash to 0 during the dialog's close animation.
  const [limitCount, setLimitCount] = useState(0);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  useEffect(() => {
    setSelectedZoneId(null);
  }, [campaignId, campaign?.zoneGroupId]);

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

  // Delete / Backspace is a no-op here — campaigns can't be deleted from
  // this view via keyboard. preventDefault keeps the browser default
  // (and the focus-visible flicker) from happening.
  useEffect(() => {
    if (!selectedZoneId) return;
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
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedZoneId]);

  return (
    <div className="flex gap-4 h-full">
      {/* Sidebar renders immediately against loader-cached chrome data
          (zones + segment binding). The map curtain handles waits for
          the heavy data still fetching in-component. */}
      <div className="w-128 shrink-0 h-full min-h-0">
        <ZonesList
          campaignId={campaignId}
          zones={zones ?? null}
          selectedZoneId={selectedZoneId}
          zoneCounts={zoneCounts}
          turfStats={turfStats ?? null}
          totals={totals}
          // Null-until-loaded mirror of zoneCounts[zoneId] — gates the
          // FullSegmentRow's pills so they fade in cleanly instead of
          // flashing zeros first.
          fullSegmentCounts={
            segmentTotals
              ? { doors: segmentTotals.doorCount, people: segmentTotals.personCount }
              : null
          }
          segmentName={activeSegment?.name ?? null}
          scriptName={activeScript?.name ?? null}
          zoneGroupName={activeZoneGroup?.name ?? null}
          onSelect={setSelectedZoneId}
          onCut={(zoneId) => {
            const doors =
              zoneId === null
                ? (segmentTotals?.doorCount ?? 0)
                : (zoneCounts?.[zoneId]?.doors ?? 0);
            if (doors > MAX_CUT_DOORS) {
              setLimitCount(doors);
              setLimitOpen(true);
              return;
            }
            if (zoneId === null) {
              void navigate({
                to: "/$orgSlug/campaigns/$campaignId/cut",
                params: { orgSlug, campaignId },
              });
            } else {
              void navigate({
                to: "/$orgSlug/campaigns/$campaignId/cut/$zoneId",
                params: { orgSlug, campaignId, zoneId },
              });
            }
          }}
        />
      </div>

      <div ref={mapWrapperRef} className="relative flex-1 min-w-0 h-full">
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

      <Dialog open={limitOpen} onOpenChange={setLimitOpen}>
        <DialogContent>
          <DialogTitle>Too many doors</DialogTitle>
          <DialogDescription>
            Turf cutting is currently limited to{" "}
            <span className="font-bold text-foreground">{MAX_CUT_DOORS.toLocaleString()}</span>{" "}
            doors and you have{" "}
            <span className="font-bold text-foreground">{limitCount.toLocaleString()}</span>. Try
            again with a smaller segment or use zones to subdivide.
          </DialogDescription>
          <div className="mt-2 flex justify-end">
            <DialogClose render={<Button variant="outline" />}>Ok</DialogClose>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

type TurfStats = Record<string, { drafts: number; published: number; active: number }>;

function ZonesList({
  campaignId,
  zones,
  selectedZoneId,
  zoneCounts,
  turfStats,
  totals,
  fullSegmentCounts,
  segmentName,
  scriptName,
  zoneGroupName,
  onSelect,
  onCut,
}: {
  campaignId: string;
  zones: Awaited<ReturnType<typeof client.zones.list>> | null;
  selectedZoneId: string | null;
  zoneCounts: Record<string, { doors: number; people: number }> | null;
  turfStats: TurfStats | null;
  totals: {
    drafts: number;
    active: number;
    published: number;
  } | null;
  fullSegmentCounts: { doors: number; people: number } | null;
  segmentName: string | null;
  scriptName: string | null;
  zoneGroupName: string | null;
  onSelect: (zoneId: string) => void;
  // `null` means navigate to the zoneless cutter route.
  onCut: (zoneId: string | null) => void;
}) {
  // When there's no zone group, the user can still cut turfs — they're
  // just scoped to the full segment instead of a zone. Surface that as a
  // single row that looks like a ZoneRow so the layout doesn't change
  // shape between zoned and zoneless campaigns.
  const zoneless = zoneGroupName === null;
  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto">
      <ConfigSummary segmentName={segmentName} scriptName={scriptName} totals={totals} />
      {zoneless ? (
        <FullSegmentRow
          campaignId={campaignId}
          counts={fullSegmentCounts}
          // Zoneless turfs land under the empty-string key in
          // statsForCampaign — see the sentinel comment there.
          turfStats={turfStats?.[""] ?? null}
          onCut={() => onCut(null)}
        />
      ) : (
        zones?.map((zone, idx) => (
          <ZoneRow
            key={zone.zoneId}
            campaignId={campaignId}
            zone={zone}
            color={colorFor(idx)}
            selected={zone.zoneId === selectedZoneId}
            counts={zoneCounts?.[zone.zoneId] ?? null}
            turfStats={turfStats?.[zone.zoneId] ?? null}
            onSelect={() => onSelect(zone.zoneId)}
            onCut={() => onCut(zone.zoneId)}
          />
        ))
      )}
    </div>
  );
}

function ConfigSummary({
  segmentName,
  scriptName,
  totals,
}: {
  segmentName: string | null;
  scriptName: string | null;
  totals: {
    drafts: number;
    active: number;
    published: number;
  } | null;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-card px-3 py-2">
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col">
          <span className="text-muted-foreground">Segment</span>
          <span className="truncate">{segmentName}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-muted-foreground">Script</span>
          <span className="truncate">{scriptName}</span>
        </div>
      </div>
      <hr className="my-1 border-t border-border" />
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Draft turfs" value={totals?.drafts ?? null} />
        <Stat label="Published turfs" value={totals?.published ?? null} />
        <Stat label="Active turfs" value={totals?.active ?? null} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex flex-col">
      <span className="text-muted-foreground">{label}</span>
      {/* Non-breaking space holds the row height while the value resolves;
          the value span mounts on arrival so fade-in fires, matching the
          sibling pills. */}
      <span className="tabular-nums">
        {value === null ? (
          " "
        ) : (
          <span className="animate-in fade-in duration-100">{value.toLocaleString()}</span>
        )}
      </span>
    </div>
  );
}

function FullSegmentRow({
  campaignId,
  counts,
  turfStats,
  onCut,
}: {
  campaignId: string;
  counts: { doors: number; people: number } | null;
  turfStats: { drafts: number; published: number; active: number } | null;
  onCut: () => void;
}) {
  return (
    <div
      className={cn(
        "flex h-11 items-center gap-2 rounded-md border border-border bg-card py-2 pr-2 pl-3 text-left",
      )}
    >
      <span className="flex-1 truncate text-sm">Full segment</span>
      {/* Keyed by campaignId — matches the ZoneRow pattern so pills
          remount + re-fire animate-in on every campaign switch. */}
      {counts ? (
        <Fragment key={campaignId}>
          <Pill
            variant="number"
            className="!w-fit shrink-0 gap-1.5 animate-in fade-in duration-100"
          >
            <UserRound className="size-3.5 text-foreground" />
            {counts.people.toLocaleString()}
          </Pill>
          <Pill
            variant="number"
            className="!w-fit shrink-0 gap-1.5 animate-in fade-in duration-100"
          >
            <DoorClosed className="size-3.5 text-foreground" />
            {counts.doors.toLocaleString()}
          </Pill>
          {turfStats ? (
            <>
              {turfStats.published > 0 ? (
                <Pill
                  variant="number"
                  className="!w-fit shrink-0 gap-1.5 animate-in fade-in duration-100 [&_svg]:[stroke-width:2]"
                >
                  <Send className="size-3.5 text-foreground" />
                  {turfStats.published.toLocaleString()}
                </Pill>
              ) : null}
              <Pill
                variant="number"
                className="!w-fit shrink-0 gap-1.5 animate-in fade-in duration-100"
              >
                <CircleDotDashed className="size-3.5 text-foreground" />
                {turfStats.drafts}
              </Pill>
            </>
          ) : null}
        </Fragment>
      ) : null}
      <Button variant="outline" className="h-[31px]" onClick={onCut}>
        <Scissors />
        Cut
      </Button>
    </div>
  );
}

function ZoneRow({
  campaignId,
  zone,
  color,
  selected,
  counts,
  turfStats,
  onSelect,
  onCut,
}: {
  campaignId: string;
  zone: { zoneId: string; name: string };
  color: string;
  selected: boolean;
  counts: { doors: number; people: number } | null;
  turfStats: { drafts: number; published: number; active: number } | null;
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
        "flex h-11 items-center gap-2 rounded-md border bg-card py-2 pr-2 pl-3 text-left",
        selected ? "border-foreground" : "border-border hover:border-muted-foreground",
      )}
    >
      <Swatch color={color} className="mr-1" />
      <span className="flex-1 truncate text-sm">{zone.name}</span>
      {/* Keyed by campaignId so all badges remount (and re-fire animate-in)
          on every campaign switch, even when two campaigns share segment
          + zone group bindings and counts/turfStats refs are reused. */}
      {counts ? (
        <Fragment key={campaignId}>
          <Pill
            variant="number"
            className="!w-fit shrink-0 gap-1.5 animate-in fade-in duration-100"
          >
            <UserRound className="size-3.5 text-foreground" />
            {counts.people.toLocaleString()}
          </Pill>
          <Pill
            variant="number"
            className="!w-fit shrink-0 gap-1.5 animate-in fade-in duration-100"
          >
            <DoorClosed className="size-3.5 text-foreground" />
            {counts.doors.toLocaleString()}
          </Pill>
          {turfStats ? (
            <>
              {turfStats.published > 0 ? (
                <Pill
                  variant="number"
                  className="!w-fit shrink-0 gap-1.5 animate-in fade-in duration-100 [&_svg]:[stroke-width:2]"
                >
                  <Send className="size-3.5 text-foreground" />
                  {turfStats.published.toLocaleString()}
                </Pill>
              ) : null}
              <Pill
                variant="number"
                className="!w-fit shrink-0 gap-1.5 animate-in fade-in duration-100"
              >
                <CircleDotDashed className="size-3.5 text-foreground" />
                {turfStats.drafts}
              </Pill>
            </>
          ) : null}
        </Fragment>
      ) : null}
      <Button
        variant="outline"
        className="h-[31px]"
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
