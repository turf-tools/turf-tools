import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { EditorHeader } from "~/components/editor-header";
import { EditorPage } from "~/components/editor-page";
import { Filter } from "~/components/filter";
import { Icon } from "~/components/icon";
import { Map as MapView } from "~/components/map";
import { Pill } from "~/components/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { ToggleGroup, ToggleGroupItem } from "~/components/toggle-group";
import { GREEN, RED, YELLOW } from "~/lib/palette";
import { campaignFilterOptions, defaultCampaignId } from "~/lib/campaign-options";
import { bboxOfFeatures } from "~/lib/geometry";
import { campaignsListQuery } from "~/lib/queries/campaigns";
import { progressByZoneQuery, progressTargetsQuery } from "~/lib/queries/progress";
import { zonePerimetersQuery } from "~/lib/queries/results";
import { segmentsListQuery } from "~/lib/queries/segments";
import { useHotkey } from "~/lib/use-hotkey";
import { campaignSegmentsVersion } from "~/lib/segment-refs";
import { useFadeOnce } from "~/lib/use-fade-once";
import { cn } from "~/lib/utils";

// Same thresholds as the turfs board so a given percent reads as the
// same color everywhere.
function progressColor(pct: number) {
  return pct <= 25 ? RED : pct <= 75 ? YELLOW : GREEN;
}

type ProgressSearch = {
  campaign: string | null;
  zones: "all" | null;
};

type View = "map" | "table";

export const Route = createFileRoute("/$orgSlug/progress")({
  validateSearch: (search): ProgressSearch => ({
    campaign: typeof search.campaign === "string" ? search.campaign : null,
    zones: search.zones === "all" ? "all" : null,
  }),
  loaderDeps: ({ search }) => ({ zones: search.zones }),
  loader: async ({ context: { queryClient }, deps }) => {
    const [campaigns, , segments] = await Promise.all([
      queryClient.fetchQuery(campaignsListQuery()),
      queryClient.fetchQuery(progressByZoneQuery()),
      deps.zones === "all" ? queryClient.fetchQuery(segmentsListQuery()) : null,
    ]);
    // In the all-zones view the inferred rows are part of the table's
    // first paint — without this they'd flash in after the cut rows.
    if (segments) {
      await queryClient.fetchQuery(
        progressTargetsQuery(campaignSegmentsVersion(campaigns, segments)),
      );
    }
  },
  component: ProgressIndex,
});

function ProgressIndex() {
  const { campaign: campaignFilter, zones: zonesView } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const shouldFade = useFadeOnce("/progress");
  const [view, setView] = useState<View>("table");
  const { data: campaigns } = useSuspenseQuery(campaignsListQuery());

  // Always exactly one campaign in scope: cross-campaign progress has no
  // clean denominator (overlapping passes double-count people), so there
  // is no "All campaigns" here. Default = newest active campaign.
  const options = campaignFilterOptions(campaigns);
  const campaign = campaignFilter ?? defaultCampaignId(campaigns);
  const filterLabel = options.find((o) => o.value === campaign)?.label ?? null;

  return (
    // Standalone route (no height-constrained route wrapper like data's),
    // so the viewport height lands here — without it the map's flex-1
    // container collapses to zero.
    <EditorPage className={cn("h-[calc(100vh-3.5rem)]", shouldFade)}>
      <EditorHeader title="Progress">
        <ToggleGroup
          variant="outline"
          value={[view]}
          onValueChange={(values) => {
            const next = values[0];
            if (next === "map" || next === "table") setView(next);
          }}
        >
          <ToggleGroupItem value="map" aria-label="Map">
            <Icon name="map" className="size-3.5" />
          </ToggleGroupItem>
          <ToggleGroupItem value="table" aria-label="Table">
            <Icon name="rows-3" className="size-3.5" />
          </ToggleGroupItem>
        </ToggleGroup>
        <Filter
          icon={<Icon name="waypoints" className="size-3.5" />}
          label={zonesView === "all" ? "All zones" : "Cut zones"}
          value={zonesView}
          options={[{ value: "all", label: "All zones" }]}
          allLabel="Cut zones"
          onChange={(next) =>
            void navigate({
              search: (prev) => ({ ...prev, zones: next === "all" ? "all" : null }),
            })
          }
        />
        <Filter
          icon={<Icon name="megaphone" className="size-3.5" />}
          label={filterLabel}
          value={campaign}
          options={options}
          allLabel={null}
          onChange={(next) => void navigate({ search: (prev) => ({ ...prev, campaign: next }) })}
        />
      </EditorHeader>
      {view === "map" ? (
        <ProgressMap campaignFilter={campaign} showAllZones={zonesView === "all"} />
      ) : (
        <ProgressTable campaignFilter={campaign} showAllZones={zonesView === "all"} />
      )}
    </EditorPage>
  );
}

type ProgressRow = {
  campaignId: string;
  campaignName: string;
  zoneId: string | null;
  zoneName: string | null;
  people: number;
  doors: number;
  turfs: number;
  used: number;
  attempted: number;
  // Uncut zones (all-zones view): counts are live segment evaluations,
  // not frozen cut snapshots; turf columns don't apply.
  inferred?: boolean;
};

function ProgressMap({
  campaignFilter,
  showAllZones,
}: {
  campaignFilter: string | null;
  showAllZones: boolean;
}) {
  // campaignFilter is null only when the org has no campaigns at all —
  // everything below degrades to an empty map.
  const { data } = useSuspenseQuery(progressByZoneQuery());
  const { data: campaigns } = useSuspenseQuery(campaignsListQuery());
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);

  // Zone shapes for the selected campaign's group.
  const scopeCampaign = campaigns.find((c) => c.campaignId === campaignFilter);
  const zoneGroupIds = scopeCampaign?.zoneGroupId ? [scopeCampaign.zoneGroupId] : [];
  const { data: perimeters } = useQuery(zonePerimetersQuery(zoneGroupIds));

  const byZone = useMemo(
    () =>
      new Map(
        data
          .filter((r) => r.campaignId === campaignFilter && r.zoneId)
          .map((r) => [r.zoneId as string, r]),
      ),
    [data, campaignFilter],
  );

  // Same discrete red/yellow/green as the table and turf board, so a
  // zone's fill and its Progress pill always agree. Cut-but-unstarted
  // zones read red (0% ≤ 25) — on this map red is the work remaining,
  // which is the thing being looked for. The Cut view drops uncut zones
  // entirely; the All view keeps them with a faint no-data fill.
  const coloredPerimeters = useMemo(() => {
    if (!perimeters) return undefined;
    const features = showAllZones
      ? perimeters.features
      : perimeters.features.filter((f) => byZone.has(f.properties?.zoneId as string));
    return {
      ...perimeters,
      features: features.map((f) => {
        const row = byZone.get(f.properties?.zoneId as string);
        const pct = row && row.people > 0 ? Math.round((100 * row.attempted) / row.people) : null;
        return {
          ...f,
          properties: {
            ...f.properties,
            ...(pct !== null ? { color: progressColor(pct), opacity: 0.6 } : { opacity: 0.06 }),
          },
        };
      }),
    };
  }, [perimeters, byZone, showAllZones]);

  const fitBounds = useMemo(
    () => (coloredPerimeters ? bboxOfFeatures(coloredPerimeters.features) : null),
    [coloredPerimeters],
  );

  const percentOf = (row: { people: number; attempted: number }) =>
    row.people > 0 ? `${Math.round((100 * row.attempted) / row.people)}%` : "—";
  // Drop the selection when its zone leaves the drawn set (All→Cut
  // toggle, campaign switch) — a readout for an invisible shape reads
  // as a stuck state.
  useEffect(() => {
    if (!showAllZones && selectedZoneId && !byZone.has(selectedZoneId)) setSelectedZoneId(null);
  }, [showAllZones, selectedZoneId, byZone]);

  // Deselection follows map convention (Google Maps et al.): background
  // click within the map, the × button, or Escape — page chrome clicks
  // never touch the selection.
  useHotkey({
    key: "Escape",
    enabled: selectedZoneId !== null,
    onMatch: () => setSelectedZoneId(null),
  });

  const selected = selectedZoneId ? (byZone.get(selectedZoneId) ?? null) : null;
  // An uncut zone (clickable in the All view) has no rollup row; its
  // name rides the feature properties.
  const selectedUncutName =
    selectedZoneId && !selected
      ? ((perimeters?.features.find((f) => f.properties?.zoneId === selectedZoneId)?.properties
          ?.zoneName as string | undefined) ?? null)
      : null;
  const totals = { people: 0, attempted: 0 };
  for (const row of byZone.values()) {
    totals.people += row.people;
    totals.attempted += row.attempted;
  }

  const hasSelection = Boolean(selected || selectedUncutName);
  return (
    <div className="relative min-h-0 flex-1">
      <MapView
        className="h-full"
        zonePerimeters={coloredPerimeters}
        selectedZoneId={selectedZoneId}
        onZoneClick={(zoneId) => setSelectedZoneId(zoneId)}
        onBackgroundClick={() => setSelectedZoneId(null)}
        fitBounds={fitBounds}
        loading={!coloredPerimeters}
        cornerUpperLeft={
          <div className="flex flex-col px-3 py-2">
            <span className="flex items-center gap-2">
              <span className="font-semibold">
                {selected?.zoneName ?? selectedUncutName ?? "All zones"}
              </span>
              {hasSelection ? (
                <button
                  type="button"
                  aria-label="Clear zone selection"
                  onClick={() => setSelectedZoneId(null)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Icon name="x" className="size-3.5" />
                </button>
              ) : null}
            </span>
            <span className="text-muted-foreground">
              {selected ? percentOf(selected) : hasSelection ? "No turfs cut" : percentOf(totals)}
            </span>
          </div>
        }
      />
    </div>
  );
}

function ProgressTable({
  campaignFilter,
  showAllZones,
}: {
  campaignFilter: string | null;
  showAllZones: boolean;
}) {
  const { data } = useSuspenseQuery(progressByZoneQuery());
  const { data: campaigns } = useSuspenseQuery(campaignsListQuery());
  // Live-evaluated counts for uncut zones — fetched only in the
  // all-zones view, so the default board never touches the data service.
  const { data: segments } = useQuery({ ...segmentsListQuery(), enabled: showAllZones });
  const { data: targetsData } = useQuery({
    ...progressTargetsQuery(campaignSegmentsVersion(campaigns, segments)),
    enabled: showAllZones && segments !== undefined,
  });
  // Hold the all-zones first paint until the inferred rows are in hand —
  // a cut-rows-only table that reshuffles when they land reads as a bug.
  if (showAllZones && !targetsData) return null;
  const campaignName = new Map(campaigns.map((c) => [c.campaignId, c.name]));
  const cutKeys = new Set(data.map((r) => `${r.campaignId}:${r.zoneId}`));
  const inferredRows: ProgressRow[] =
    showAllZones && targetsData
      ? targetsData.rows
          .filter((r) => !cutKeys.has(`${r.campaignId}:${r.zoneId}`))
          .map((r) => ({
            campaignId: r.campaignId,
            campaignName: campaignName.get(r.campaignId) ?? "",
            zoneId: r.zoneId,
            zoneName: r.zoneName,
            people: r.people,
            doors: r.doors,
            turfs: 0,
            used: 0,
            attempted: 0,
            inferred: true,
          }))
      : [];
  const merged: ProgressRow[] = [...data, ...inferredRows].sort(
    (a, b) =>
      a.campaignName.localeCompare(b.campaignName) ||
      (a.zoneName ?? "").localeCompare(b.zoneName ?? ""),
  );
  const rows = campaignFilter ? merged.filter((r) => r.campaignId === campaignFilter) : merged;

  return (
    <Table containerClassName="min-h-0 flex-1 overflow-y-auto" className="table-fixed">
      <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-background">
        <TableRow>
          {/* 60/40 split of the flexible space between the two name
              columns — zone names run longer than campaign names.
              Campaign sits far right like on the turfs board. */}
          <TableHead className="w-[36%]">Zone</TableHead>
          <TableHead className="w-28">People</TableHead>
          <TableHead className="w-28">Doors</TableHead>
          <TableHead className="w-20">Turfs</TableHead>
          <TableHead className="w-20">Used</TableHead>
          <TableHead className="w-26">Remaining</TableHead>
          <TableHead className="w-24">Progress</TableHead>
          <TableHead className="w-[24%]">Campaign</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow className="h-10">
            <TableCell colSpan={8}>
              <Pill>
                <span>No results</span>
              </Pill>
            </TableCell>
          </TableRow>
        ) : (
          rows.map((r) => {
            const pct = r.inferred
              ? null
              : r.people > 0
                ? Math.round((100 * r.attempted) / r.people)
                : null;
            return (
              <TableRow key={`${r.campaignId}:${r.zoneId ?? "none"}`}>
                <TableCell>
                  <Pill className="min-w-0">
                    <span className="truncate">{r.zoneName ?? "—"}</span>
                  </Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number" className={cn("gap-1.5", r.inferred && "italic")}>
                    <Icon name="user-round" className="size-3.5 shrink-0 text-foreground" />
                    {r.people.toLocaleString()}
                  </Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number" className={cn("gap-1.5", r.inferred && "italic")}>
                    <Icon name="door-closed" className="size-3.5 shrink-0 text-foreground" />
                    {r.doors.toLocaleString()}
                  </Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number">{r.inferred ? null : r.turfs.toLocaleString()}</Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number">{r.inferred ? null : r.used.toLocaleString()}</Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number">
                    {r.inferred ? null : (r.turfs - r.used).toLocaleString()}
                  </Pill>
                </TableCell>
                <TableCell>
                  <Pill
                    variant="number"
                    color={pct !== null && pct > 0 ? progressColor(pct) : undefined}
                  >
                    {pct !== null ? `${pct}%` : null}
                  </Pill>
                </TableCell>
                <TableCell>
                  <Pill className="min-w-0">
                    <span className="truncate">{r.campaignName}</span>
                  </Pill>
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}
