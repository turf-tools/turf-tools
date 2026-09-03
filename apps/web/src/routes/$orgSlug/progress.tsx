import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { tintStyle } from "~/components/badge";
import { EditorHeader } from "~/components/editor-header";
import { EditorPage } from "~/components/editor-page";
import { Filter } from "~/components/filter";
import { Icon } from "~/components/icon";
import { Map as MapView } from "~/components/map";
import { NoActiveDataset } from "~/components/no-active-dataset";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { progressColor } from "~/lib/palette";
import { campaignFilterOptions, defaultCampaignId } from "~/lib/campaign-options";
import { bboxOfFeatures } from "~/lib/geometry";
import { hasPermission } from "~/lib/permissions";
import { campaignsListQuery } from "~/lib/queries/campaigns";
import { manifestQuery } from "~/lib/queries/manifest";
import { progressByZoneQuery, progressTargetsQuery } from "~/lib/queries/progress";
import { zonePerimetersQuery } from "~/lib/queries/zones";
import { segmentsListQuery } from "~/lib/queries/segments";
import { useHotkey } from "~/lib/use-hotkey";
import { useZoneSelection } from "~/lib/use-zone-selection";
import { campaignSegmentsVersion } from "~/lib/segment-refs";
import { useFadeOnce } from "~/lib/use-fade-once";
import { cn, revealZoneCard } from "~/lib/utils";

// Page-level selection value for the totals row — the map itself only
// ever sees a list of zone ids.
const ALL_ZONES = "all";

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
    const [manifest, campaigns] = await Promise.all([
      queryClient.fetchQuery(manifestQuery()),
      queryClient.fetchQuery(campaignsListQuery()),
    ]);
    // No active dataset → the progress endpoints only error; the gate
    // renders the no-dataset modal instead.
    if (!manifest) return;
    const [, segments] = await Promise.all([
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
  component: ProgressGate,
});

// Gate, not an inline early-return: the page's suspense queries would fire
// (and error) before a return between hooks could stop them.
function ProgressGate() {
  const { orgSlug } = Route.useParams();
  const { role } = Route.useRouteContext();
  const { data: manifest } = useSuspenseQuery(manifestQuery());
  if (!manifest)
    return (
      <NoActiveDataset
        entity="progress"
        orgSlug={orgSlug}
        canManage={hasPermission(role, "datasets.manage")}
      />
    );
  return <ProgressIndex />;
}

function ProgressIndex() {
  const { campaign: campaignFilter, zones: zonesView } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const shouldFade = useFadeOnce("/progress");
  // Whole-page selection surface with the corner riding out the
  // clear→reselect gesture — mechanics in useZoneSelection. A map click
  // highlights the zone's table row and vice versa.
  const mapWrapperRef = useRef<HTMLDivElement>(null);
  const { selectedZoneId, cornerZoneId, select, clear } = useZoneSelection(mapWrapperRef);
  const onSelectZone = useCallback(
    (zoneId: string | null) => (zoneId !== null ? select(zoneId) : clear()),
    [select, clear],
  );
  // Map fill metric — turf-grain by default (the dispatch signal),
  // person-grain Attempts as the alternate lens (Results' Color-by
  // pattern).
  const [mapMetric, setMapMetric] = useState<"turfs" | "attempted">("turfs");
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
      <EditorHeader title="Progress" subtitle="Turf completion by zone">
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
          icon={<Icon name="paintbrush" className="size-3.5" />}
          label={mapMetric === "turfs" ? "Turfs used" : "Attempts"}
          value={mapMetric}
          options={[
            { value: "turfs", label: "Turfs used" },
            { value: "attempted", label: "Attempts" },
          ]}
          allLabel={null}
          onChange={(next) => {
            if (next === "turfs" || next === "attempted") setMapMetric(next);
          }}
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
      {/* Results' card-table-beside-map construction; no map collapse
          here — this table never overflows horizontally. */}
      <div className="flex min-h-0 flex-1 gap-4">
        <div className="flex min-h-0 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
          <div className="min-h-0 flex-1 px-2 pt-2">
            <ProgressTable
              campaignFilter={campaign}
              showAllZones={zonesView === "all"}
              selectedZoneId={selectedZoneId}
              onSelectZone={onSelectZone}
            />
          </div>
        </div>
        <ProgressMap
          campaignFilter={campaign}
          showAllZones={zonesView === "all"}
          metric={mapMetric}
          selectedZoneId={selectedZoneId}
          cornerZoneId={cornerZoneId}
          onSelectZone={onSelectZone}
          wrapperRef={mapWrapperRef}
        />
      </div>
    </EditorPage>
  );
}

// RYG percent chip in Results' rate-badge shape: content width, mono,
// whole percent zero-padded to two digits; discrete progress colors
// through the shared badge tint math.
function ProgressChip({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className="badge-tint rounded px-1.5 py-0.5 font-mono text-sm tabular-nums"
      style={tintStyle(progressColor(pct))}
    >
      {String(pct).padStart(2, "0")}%
    </span>
  );
}

// The chip's scale as ink alone — corner readouts color the number
// itself, no chip chrome.
function ProgressPercent({ pct }: { pct: number | null }) {
  if (pct === null) return <>—</>;
  return (
    <span className="badge-fg" style={tintStyle(progressColor(pct))}>
      {pct}%
    </span>
  );
}

// Cell backgrounds carry hover and selection (same pill), so the end
// caps can round.
const zoneCell = (selectable: boolean, selected: boolean) =>
  cn(
    "truncate px-2 whitespace-nowrap",
    selectable && "group-hover:bg-muted/50 first:rounded-l-md last:rounded-r-md",
    selected && "bg-muted/50",
  );

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
  metric,
  selectedZoneId,
  cornerZoneId,
  onSelectZone,
  wrapperRef,
}: {
  campaignFilter: string | null;
  showAllZones: boolean;
  metric: "turfs" | "attempted";
  selectedZoneId: string | null;
  cornerZoneId: string | null;
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

  // Fill follows the Color-by pick: turf-grain used/total (the dispatch
  // signal, default) or person-grain attempted/people. Same discrete
  // red/yellow/green thresholds as the turf board either way. The Cut
  // view drops uncut zones entirely; the All view keeps them with a
  // faint no-data fill.
  const coloredPerimeters = useMemo(() => {
    if (!perimeters) return undefined;
    const pctFor = (row: { turfs: number; used: number; people: number; attempted: number }) =>
      metric === "turfs"
        ? row.turfs > 0
          ? Math.round((100 * row.used) / row.turfs)
          : null
        : row.people > 0
          ? Math.round((100 * row.attempted) / row.people)
          : null;
    const features = showAllZones
      ? perimeters.features
      : perimeters.features.filter((f) => byZone.has(f.properties?.zoneId as string));
    return {
      ...perimeters,
      features: features.map((f) => {
        const row = byZone.get(f.properties?.zoneId as string);
        const pct = row ? pctFor(row) : null;
        return {
          ...f,
          properties: {
            ...f.properties,
            ...(pct !== null ? { color: progressColor(pct), opacity: 0.6 } : { opacity: 0.06 }),
          },
        };
      }),
    };
  }, [perimeters, byZone, showAllZones, metric]);

  const fitBounds = useMemo(
    () => (coloredPerimeters ? bboxOfFeatures(coloredPerimeters.features) : null),
    [coloredPerimeters],
  );

  // Drop the selection when its zone leaves the drawn set (All→Cut
  // toggle, campaign switch) — a readout for an invisible shape reads
  // as a stuck state.
  useEffect(() => {
    if (
      !showAllZones &&
      selectedZoneId &&
      selectedZoneId !== ALL_ZONES &&
      !byZone.has(selectedZoneId)
    )
      onSelectZone(null);
  }, [showAllZones, selectedZoneId, byZone, onSelectZone]);

  useHotkey({
    key: "Escape",
    enabled: selectedZoneId !== null,
    onMatch: () => onSelectZone(null),
  });

  const allSelected = selectedZoneId === ALL_ZONES;
  // Corner values ride cornerZoneId (see useZoneSelection): a row
  // re-click flashes the outline without blinking the readout.
  const cornerAll = cornerZoneId === ALL_ZONES;
  const selected = !cornerAll && cornerZoneId ? (byZone.get(cornerZoneId) ?? null) : null;
  // All-zones selection aggregates the campaign's cut rows — the
  // table's totals-row accounting exactly, zoneless rows included.
  const cornerStats = cornerAll
    ? data
        .filter((r) => r.campaignId === campaignFilter)
        .reduce(
          (t, r) => ({
            people: t.people + r.people,
            attempted: t.attempted + r.attempted,
            turfs: t.turfs + r.turfs,
            used: t.used + r.used,
          }),
          { people: 0, attempted: 0, turfs: 0, used: 0 },
        )
    : selected;
  const attemptedPct =
    cornerStats && cornerStats.people > 0
      ? Math.round((100 * cornerStats.attempted) / cornerStats.people)
      : null;
  const turfsUsedPct =
    cornerStats && cornerStats.turfs > 0
      ? Math.round((100 * cornerStats.used) / cornerStats.turfs)
      : null;
  // An uncut zone (clickable in the All view) has no rollup row; its
  // name rides the feature properties.
  const selectedUncutName =
    !cornerAll && cornerZoneId && !selected
      ? ((perimeters?.features.find((f) => f.properties?.zoneId === cornerZoneId)?.properties
          ?.zoneName as string | undefined) ?? null)
      : null;
  const hasSelection = Boolean(cornerAll || selected || selectedUncutName);

  // Corner readout answers "what did I just click" without leaving the
  // map; the table's highlighted row is the linked echo with the
  // full numbers. Selection-only — an idle default would flash through
  // every reselect (the outside-click mousedown clears first).
  return (
    <div ref={wrapperRef} className="relative min-h-0 flex-1">
      <MapView
        className="h-full"
        zonePerimeters={coloredPerimeters}
        selectedZoneIds={
          allSelected
            ? (perimeters?.features ?? [])
                // Highlight only the drawn set: the Cut view omits
                // uncut zones.
                .filter((f) => showAllZones || byZone.has(f.properties?.zoneId as string))
                .map((f) => f.properties?.zoneId as string | undefined)
                .filter((id): id is string => !!id)
            : selectedZoneId
              ? [selectedZoneId]
              : []
        }
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
                <span className="font-semibold">
                  {cornerAll ? "All zones" : (selected?.zoneName ?? selectedUncutName)}
                </span>
                <button
                  type="button"
                  aria-label="Clear zone selection"
                  onClick={() => onSelectZone(null)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Icon name="x" className="size-3.5" />
                </button>
              </span>
              {cornerStats ? (
                <>
                  <span className="text-muted-foreground">
                    Attempts: <ProgressPercent pct={attemptedPct} />
                  </span>
                  <span className="text-muted-foreground">
                    Turfs used: <ProgressPercent pct={turfsUsedPct} />
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">No turfs cut</span>
              )}
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

  // Totals over CUT zones only — the number is "progress through our cut
  // turf", so uncut zones' live-evaluated counts stay out even in the
  // all-zones view.
  const cut = rows.filter((r) => !r.inferred);
  const totals = cut.reduce(
    (t, r) => ({
      people: t.people + r.people,
      doors: t.doors + r.doors,
      attempted: t.attempted + r.attempted,
      turfs: t.turfs + r.turfs,
      used: t.used + r.used,
    }),
    { people: 0, doors: 0, attempted: 0, turfs: 0, used: 0 },
  );
  const totalsTurfPct = totals.turfs > 0 ? Math.round((100 * totals.used) / totals.turfs) : null;
  const totalsPersonPct =
    totals.people > 0 ? Math.round((100 * totals.attempted) / totals.people) : null;
  const totalsCell = zoneCell(true, selectedZoneId === ALL_ZONES);

  return (
    <Table
      containerClassName="h-full overflow-y-auto"
      className="table-fixed border-separate border-spacing-y-0.5 [&_tr>th:first-child]:pl-2 [&_tr>td:first-child]:pl-2"
      style={{ width: "40rem" }}
    >
      {/* One uniform strip grid shared with Results: every row — header
          or data — has the same h-8 pitch; this page's strips are just
          [headers, zones...]. */}
      <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-card [&_th]:h-8">
        <TableRow>
          <TableHead style={{ width: "10rem" }}>Zone</TableHead>
          <TableHead style={{ width: "5rem" }}>People</TableHead>
          <TableHead style={{ width: "5rem" }}>Doors</TableHead>
          <TableHead style={{ width: "7rem" }}>Attempts</TableHead>
          <TableHead style={{ width: "7rem" }}>Turfs used</TableHead>
          <TableHead style={{ width: "6rem" }}>Turfs left</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow className="h-8">
            <TableCell colSpan={6} className="px-2 text-muted-foreground">
              No results
            </TableCell>
          </TableRow>
        ) : (
          <>
            {/* All-zones totals first, matching Results — the reading
                frame for the rows below, and a selection target like any
                zone (highlights every zone on the map). */}
            <TableRow
              className="group h-8 scroll-mt-10 cursor-pointer"
              onClick={() => onSelectZone(ALL_ZONES)}
            >
              <TableCell className={totalsCell}>
                <span>All zones</span>
              </TableCell>
              <TableCell className={cn(totalsCell, "tabular-nums")}>
                {totals.people.toLocaleString()}
              </TableCell>
              <TableCell className={cn(totalsCell, "tabular-nums")}>
                {totals.doors.toLocaleString()}
              </TableCell>
              <TableCell className={totalsCell}>
                <span className="flex items-center gap-1.5">
                  <ProgressChip pct={totalsPersonPct} />
                  <span className="tabular-nums">{totals.attempted.toLocaleString()}</span>
                </span>
              </TableCell>
              <TableCell className={totalsCell}>
                <span className="flex items-center gap-1.5">
                  <ProgressChip pct={totalsTurfPct} />
                  <span className="tabular-nums">{totals.used.toLocaleString()}</span>
                </span>
              </TableCell>
              <TableCell className={cn(totalsCell, "tabular-nums")}>
                {totals.turfs > 0 ? (
                  `${totals.turfs - totals.used} / ${totals.turfs}`
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
            </TableRow>
            {rows.map((r) => {
              // Turf-grain drives the Progress % (and the map's default
              // fill): this is the dispatch board, and person-grain
              // overstates capacity once all turf is out but plateaued
              // mid-walk. Person-grain "Attempts" (any outcome / cut
              // people) rides along for the typical-completion glance.
              const turfPct =
                r.inferred || r.turfs === 0 ? null : Math.round((100 * r.used) / r.turfs);
              const personPct = r.inferred
                ? null
                : r.people > 0
                  ? Math.round((100 * r.attempted) / r.people)
                  : null;
              const selectable = r.zoneId != null;
              const selected = selectable && r.zoneId === selectedZoneId;
              const cell = zoneCell(selectable, selected);
              return (
                <TableRow
                  key={`${r.campaignId}:${r.zoneId ?? "none"}`}
                  data-zone-card={r.zoneId ?? undefined}
                  // Sticky header overlays the container top; without the
                  // margin, upward scrollIntoView parks the row under it.
                  className={cn("group h-8 scroll-mt-10", selectable && "cursor-pointer")}
                  onClick={selectable ? () => onSelectZone(r.zoneId) : undefined}
                >
                  <TableCell className={cell}>
                    <span className="truncate">
                      {/* Null zone = turf cut against the whole segment. */}
                      {r.zoneName ?? "Full segment"}
                    </span>
                  </TableCell>
                  <TableCell className={cn(cell, "tabular-nums", r.inferred && "italic")}>
                    {r.people.toLocaleString()}
                  </TableCell>
                  <TableCell className={cn(cell, "tabular-nums", r.inferred && "italic")}>
                    {r.doors.toLocaleString()}
                  </TableCell>
                  <TableCell className={cell}>
                    {/* Badge leads, count follows — Results' cell pattern. */}
                    <span className="flex items-center gap-1.5">
                      <ProgressChip pct={personPct} />
                      {!r.inferred ? (
                        <span className="tabular-nums">{r.attempted.toLocaleString()}</span>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className={cell}>
                    {/* 0% tints red too — matching the map, where red is
                      the work remaining. */}
                    <span className="flex items-center gap-1.5">
                      <ProgressChip pct={turfPct} />
                      {!r.inferred ? (
                        <span className="tabular-nums">{r.used.toLocaleString()}</span>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className={cn(cell, "tabular-nums")}>
                    {/* The dispatch number — the row's punchline. */}
                    {r.inferred ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      `${r.turfs - r.used} / ${r.turfs}`
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </>
        )}
      </TableBody>
    </Table>
  );
}
