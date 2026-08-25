import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "~/components/button";
import { EditorHeader } from "~/components/editor-header";
import { EditorPage } from "~/components/editor-page";
import { Filter } from "~/components/filter";
import { Icon } from "~/components/icon";
import { Map as MapView } from "~/components/map";
import { Pill } from "~/components/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
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
import { cn, revealZoneCard } from "~/lib/utils";

// Same thresholds as the turfs board so a given percent reads as the
// same color everywhere.
function progressColor(pct: number) {
  return pct <= 25 ? RED : pct <= 75 ? YELLOW : GREEN;
}

type ProgressSearch = {
  campaign: string | null;
  zones: "all" | null;
};

export const Route = createFileRoute("/$orgSlug/progress")({
  validateSearch: (search): ProgressSearch => ({
    campaign: typeof search.campaign === "string" ? search.campaign : null,
    zones: search.zones === "all" ? "all" : null,
  }),
  loaderDeps: ({ search }) => ({ zones: search.zones, campaign: search.campaign }),
  loader: async ({ context: { queryClient }, deps }) => {
    const [campaigns, , segments] = await Promise.all([
      queryClient.fetchQuery(campaignsListQuery()),
      queryClient.fetchQuery(progressByZoneQuery()),
      deps.zones === "all" ? queryClient.fetchQuery(segmentsListQuery()) : null,
    ]);
    // In the all-zones view the inferred rows are part of the table's
    // first paint — without this they'd flash in after the cut rows.
    const campaignId = deps.campaign ?? defaultCampaignId(campaigns);
    if (segments && campaignId) {
      const scoped = campaigns.filter((c) => c.campaignId === campaignId);
      await queryClient.fetchQuery(
        progressTargetsQuery(campaignId, campaignSegmentsVersion(scoped, segments)),
      );
    }
  },
  component: ProgressIndex,
});

function ProgressIndex() {
  const { campaign: campaignFilter, zones: zonesView } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const shouldFade = useFadeOnce("/progress");
  // Selection is shared: a map click highlights the zone's table row.
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const { data: campaigns } = useSuspenseQuery(campaignsListQuery());

  // Selection can be made from the table, so the whole page is the
  // selection surface (zone-editor convention): clicking chrome outside
  // the map clears. Firing on mousedown is also what makes re-clicking a
  // zone button flash its map outline — clear here, re-select on click.
  const mapWrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selectedZoneId) return;
    const handler = (e: MouseEvent) => {
      if (e.detail >= 2) return;
      const target = e.target as Node | null;
      if (!target) return;
      if (mapWrapperRef.current?.contains(target)) return;
      setSelectedZoneId(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [selectedZoneId]);

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
      <div className="flex min-h-0 flex-1 gap-6">
        <div className="flex w-150 shrink-0 flex-col overflow-hidden">
          <ProgressTable
            campaignFilter={campaign}
            showAllZones={zonesView === "all"}
            selectedZoneId={selectedZoneId}
            onSelectZone={setSelectedZoneId}
          />
        </div>
        <ProgressMap
          campaignFilter={campaign}
          showAllZones={zonesView === "all"}
          selectedZoneId={selectedZoneId}
          onSelectZone={setSelectedZoneId}
          wrapperRef={mapWrapperRef}
        />
      </div>
    </EditorPage>
  );
}

type ProgressRow = {
  campaignId: string;
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
  selectedZoneId,
  onSelectZone,
  wrapperRef,
}: {
  campaignFilter: string | null;
  showAllZones: boolean;
  selectedZoneId: string | null;
  onSelectZone: (zoneId: string | null) => void;
  wrapperRef: RefObject<HTMLDivElement | null>;
}) {
  // campaignFilter is null only when the org has no campaigns at all —
  // everything below degrades to an empty map.
  const { data } = useSuspenseQuery(progressByZoneQuery());
  const { data: campaigns } = useSuspenseQuery(campaignsListQuery());

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

  // Drop the selection when its zone leaves the drawn set (All→Cut
  // toggle, campaign switch) — a readout for an invisible shape reads
  // as a stuck state.
  useEffect(() => {
    if (!showAllZones && selectedZoneId && !byZone.has(selectedZoneId)) onSelectZone(null);
  }, [showAllZones, selectedZoneId, byZone, onSelectZone]);

  useHotkey({
    key: "Escape",
    enabled: selectedZoneId !== null,
    onMatch: () => onSelectZone(null),
  });

  const percentOf = (row: { people: number; attempted: number }) =>
    row.people > 0 ? `${Math.round((100 * row.attempted) / row.people)}%` : "—";
  const selected = selectedZoneId ? (byZone.get(selectedZoneId) ?? null) : null;
  // An uncut zone (clickable in the All view) has no rollup row; its
  // name rides the feature properties.
  const selectedUncutName =
    selectedZoneId && !selected
      ? ((perimeters?.features.find((f) => f.properties?.zoneId === selectedZoneId)?.properties
          ?.zoneName as string | undefined) ?? null)
      : null;
  const hasSelection = Boolean(selected || selectedUncutName);

  // Corner readout answers "what did I just click" without leaving the
  // map; the table's highlighted button is the linked echo with the
  // full numbers. Selection-only — an idle default would flash through
  // every reselect (the outside-click mousedown clears first).
  return (
    <div ref={wrapperRef} className="relative min-h-0 flex-1">
      <MapView
        className="h-full"
        zonePerimeters={coloredPerimeters}
        selectedZoneId={selectedZoneId}
        onZoneClick={(zoneId) => {
          onSelectZone(zoneId);
          revealZoneCard(zoneId);
        }}
        onBackgroundClick={() => onSelectZone(null)}
        fitBounds={fitBounds}
        loading={!coloredPerimeters}
        cornerUpperLeft={
          hasSelection ? (
            <div className="flex flex-col px-3 py-2">
              <span className="flex items-center gap-2">
                <span className="font-semibold">{selected?.zoneName ?? selectedUncutName}</span>
                <button
                  type="button"
                  aria-label="Clear zone selection"
                  onClick={() => onSelectZone(null)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Icon name="x" className="size-3.5" />
                </button>
              </span>
              <span className="text-muted-foreground">
                {selected ? percentOf(selected) : "No turfs cut"}
              </span>
            </div>
          ) : undefined
        }
      />
    </div>
  );
}

function ProgressTable({
  campaignFilter,
  showAllZones,
  selectedZoneId,
  onSelectZone,
}: {
  campaignFilter: string | null;
  showAllZones: boolean;
  selectedZoneId: string | null;
  onSelectZone: (zoneId: string | null) => void;
}) {
  const { data } = useSuspenseQuery(progressByZoneQuery());
  const { data: campaigns } = useSuspenseQuery(campaignsListQuery());
  // Live-evaluated counts for uncut zones — fetched only in the
  // all-zones view, so the default board never touches the data service.
  // Scoped to the selected campaign (archived included — an explicit
  // request for a finished pass is a history view).
  const { data: segments } = useQuery({ ...segmentsListQuery(), enabled: showAllZones });
  const scoped = campaigns.filter((c) => c.campaignId === campaignFilter);
  const { data: targetsData } = useQuery({
    ...progressTargetsQuery(campaignFilter ?? "", campaignSegmentsVersion(scoped, segments)),
    enabled: showAllZones && segments !== undefined && campaignFilter !== null,
  });
  // Hold the all-zones first paint until the inferred rows are in hand —
  // a cut-rows-only table that reshuffles when they land reads as a bug.
  if (showAllZones && campaignFilter !== null && !targetsData) return null;
  const cutKeys = new Set(data.map((r) => `${r.campaignId}:${r.zoneId}`));
  const inferredRows: ProgressRow[] =
    showAllZones && targetsData
      ? targetsData.rows
          .filter((r) => !cutKeys.has(`${r.campaignId}:${r.zoneId}`))
          .map((r) => ({
            campaignId: r.campaignId,
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
  const merged: ProgressRow[] = [...data, ...inferredRows].sort((a, b) =>
    (a.zoneName ?? "").localeCompare(b.zoneName ?? ""),
  );
  const rows = campaignFilter ? merged.filter((r) => r.campaignId === campaignFilter) : merged;

  return (
    <Table containerClassName="min-h-0 flex-1 overflow-y-auto" className="table-fixed">
      <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-background">
        <TableRow>
          <TableHead>Zone</TableHead>
          <TableHead className="w-26">People</TableHead>
          <TableHead className="w-26">Doors</TableHead>
          <TableHead className="w-24">Turfs</TableHead>
          <TableHead className="w-22">Progress</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow className="h-10">
            <TableCell colSpan={5}>
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
              <TableRow
                key={`${r.campaignId}:${r.zoneId ?? "none"}`}
                data-zone-card={r.zoneId ?? undefined}
                // Sticky header overlays the container top; without the
                // margin, upward scrollIntoView parks the row under it.
                className="scroll-mt-10"
              >
                <TableCell>
                  {r.zoneId != null ? (
                    // Border carries the selected state both directions —
                    // click here or on the map. Re-clicking the selected
                    // zone flashes it (the outside-click mousedown clears,
                    // this click re-selects) — a locating aid, same
                    // mechanism as the zone editor's cards.
                    <Button
                      variant="outline"
                      className={cn(
                        "w-full justify-start",
                        r.zoneId === selectedZoneId && "border-foreground dark:border-foreground",
                      )}
                      onClick={() => onSelectZone(r.zoneId)}
                    >
                      <span className="truncate">{r.zoneName ?? "—"}</span>
                    </Button>
                  ) : (
                    <Pill className="min-w-0">
                      <span className="truncate">—</span>
                    </Pill>
                  )}
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
                  {/* used / total; remaining is the visible difference. */}
                  <Pill variant="number">{r.inferred ? null : `${r.used} / ${r.turfs}`}</Pill>
                </TableCell>
                <TableCell>
                  {/* 0% tints red too — matching the map, where red is
                      the work remaining. */}
                  <Pill variant="number" color={pct !== null ? progressColor(pct) : undefined}>
                    {pct !== null ? `${pct}%` : null}
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
