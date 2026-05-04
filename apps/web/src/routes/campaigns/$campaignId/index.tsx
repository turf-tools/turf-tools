import { keepPreviousData, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { cleanCoords } from "@turf/clean-coords";
import { union } from "@turf/union";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { CircleDotDashed, DoorClosed, Scissors, Send, UserRound } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "~/components/button";
import { Map } from "~/components/map";
import { Pill } from "~/components/pill";
import { boundariesGeoJsonQuery } from "~/lib/queries/boundaries";
import {
  campaignDetailQuery,
  campaignKeyCountsQuery,
  campaignPointsQuery,
  campaignsListQuery,
  type KeyFilter,
} from "~/lib/queries/campaigns";
import { type SegmentCriteria, segmentDetailQuery } from "~/lib/queries/segments";
import { turfStatsForCampaignQuery } from "~/lib/queries/turfs";
import { zoneGroupsQuery, zonesQuery } from "~/lib/queries/zones";
import { cn } from "~/lib/utils";
import { client } from "~/rpc/client";
import { colorFor } from "~/lib/zone-colors";

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

export const Route = createFileRoute("/campaigns/$campaignId/")({
  loader: async ({ context: { queryClient }, params: { campaignId } }) => {
    const campaigns = await queryClient.fetchQuery(campaignsListQuery());
    const exists = campaigns.some((c) => c.campaignId === campaignId);
    if (!exists) {
      throw redirect({ to: "/campaigns" });
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
    await Promise.all([
      campaign.segmentId
        ? queryClient.fetchQuery(segmentDetailQuery(campaign.segmentId))
        : Promise.resolve(undefined),
      campaign.zoneGroupId
        ? queryClient.fetchQuery(zonesQuery(campaign.zoneGroupId))
        : Promise.resolve(undefined),
    ]);
  },
  component: CampaignEditor,
});

function CampaignEditor() {
  const navigate = useNavigate();
  const { campaignId } = Route.useParams();

  const { data: campaign } = useSuspenseQuery(campaignDetailQuery(campaignId));
  const { data: zoneGroups } = useSuspenseQuery(zoneGroupsQuery());

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
    if (!campaign) return false;
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
    <div className="grid grid-cols-2 gap-4 h-full">
      {/* Sidebar renders immediately against loader-cached chrome data
          (zones, segmentDetail). The map curtain handles waits for the
          heavy data still fetching in-component. */}
      <div className="h-full min-h-0">
        <ZonesList
          campaignId={campaignId}
          zones={zones ?? null}
          selectedZoneId={selectedZoneId}
          zoneCounts={zoneCounts}
          turfStats={turfStats ?? null}
          onSelect={setSelectedZoneId}
          onCut={(zoneId) => {
            void navigate({
              to: "/campaigns/$campaignId/cut/$zoneId",
              params: { campaignId, zoneId },
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
  );
}

type TurfStats = Record<string, { drafts: number; published: number }>;

function ZonesList({
  campaignId,
  zones,
  selectedZoneId,
  zoneCounts,
  turfStats,
  onSelect,
  onCut,
}: {
  campaignId: string;
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
          campaignId={campaignId}
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
      {/* Keyed by campaignId so all badges remount (and re-fire animate-in)
          on every campaign switch, even when two campaigns share segment
          + zone group bindings and counts/turfStats refs are reused. */}
      {counts ? (
        <Fragment key={campaignId}>
          <Pill
            variant="number"
            className="!w-fit shrink-0 gap-1.5 animate-in fade-in duration-100"
          >
            <DoorClosed className="size-3.5 text-foreground" />
            {counts.doors.toLocaleString()}
          </Pill>
          <Pill
            variant="number"
            className="!w-fit shrink-0 gap-1.5 animate-in fade-in duration-100"
          >
            <UserRound className="size-3.5 text-foreground" />
            {counts.people.toLocaleString()}
          </Pill>
          {hasPublished ? (
            <Pill
              variant="number"
              className="size-7 shrink-0 justify-center !px-0 animate-in fade-in duration-100 [&_svg]:[stroke-width:2]"
            >
              <Send className="size-4 text-foreground" />
            </Pill>
          ) : null}
          <Pill
            variant="number"
            className="!w-fit shrink-0 gap-1.5 animate-in fade-in duration-100"
          >
            <CircleDotDashed className="size-3.5 text-foreground" />
            {turfCount}
          </Pill>
        </Fragment>
      ) : null}
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
