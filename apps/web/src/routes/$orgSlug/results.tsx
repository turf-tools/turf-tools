import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { interpolateYlGnBu } from "d3-scale-chromatic";
import { useAtomValue } from "jotai";
import { type CSSProperties, Fragment, type ReactNode, useMemo, useState } from "react";
import { Button } from "~/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/dropdown-menu";
import { EditorHeader } from "~/components/editor-header";
import { EditorPage } from "~/components/editor-page";
import { Filter } from "~/components/filter";
import { FilterValueEditor } from "~/components/filter-editors";
import { Icon } from "~/components/icon";
import { Map as MapView } from "~/components/map";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/popover";
import { ToggleGroup, ToggleGroupItem } from "~/components/toggle-group";
import { darkAtom } from "~/lib/atoms/theme";
import { emptyFilterFor, type FilterDef, filterKey, isActiveFilter } from "~/lib/filters";
import { bboxOfFeatures } from "~/lib/geometry";
import { useFilterCatalog } from "~/lib/manifest";
import { campaignFilterOptions, defaultCampaignId } from "~/lib/campaign-options";
import { campaignsListQuery } from "~/lib/queries/campaigns";
import { questionsWithOptionsQuery } from "~/lib/queries/questions";
import { type Condition, resultsAggregateQuery, zonePerimetersQuery } from "~/lib/queries/results";
import { segmentsListQuery } from "~/lib/queries/segments";
import { DEFAULT_DISPLAY_TIMEZONE } from "~/lib/timezones";
import { useFadeOnce } from "~/lib/use-fade-once";
import { useHotkey } from "~/lib/use-hotkey";
import { cn } from "~/lib/utils";
import type { ResultsAggregate, ZoneFunnelRow } from "~/rpc/web/results";

type ResultsSearch = {
  // Campaign id, "all", or null = default (newest active campaign) — so
  // the default tracks new campaigns without being pinned in the URL.
  campaign: string | null;
  day: string | null;
};

// Resolve the search param to a concrete scope: null = all campaigns.
function scopedCampaignId(
  param: string | null,
  campaigns: ReadonlyArray<{ campaignId: string; createdAt: string | Date; isArchived: boolean }>,
): string | null {
  return param === "all" ? null : (param ?? defaultCampaignId(campaigns));
}

const EMPTY_AGGREGATE = { days: [], rows: [] } as ResultsAggregate;

// One metric today (contact rate); per-question persuasion metrics are
// the planned additions — the dropdown returns when there are two.
function rateOf(row: ZoneFunnelRow): number | null {
  if (row.attempted === 0) return null;
  return row.contacted / row.attempted;
}

// Color-scale domain for contact rate: door-knocking contact rates live
// in 0–20% essentially universally, so a 0–100% scale washes every zone
// into the bottom fifth. Question rates stay 0–100%: options split a
// population that sums to one.
const CONTACT_RATE_MAX = 0.2;

export const Route = createFileRoute("/$orgSlug/results")({
  validateSearch: (search): ResultsSearch => ({
    campaign: typeof search.campaign === "string" ? search.campaign : null,
    day: typeof search.day === "string" ? search.day : null,
  }),
  loaderDeps: ({ search }) => ({ campaign: search.campaign, day: search.day }),
  loader: async ({ context: { queryClient, session }, deps }) => {
    const tz = session?.user.displayTimezone ?? DEFAULT_DISPLAY_TIMEZONE;
    // The default scope is derived from the campaigns list, so it loads first.
    const campaigns = await queryClient.fetchQuery(campaignsListQuery());
    const campaignId = scopedCampaignId(deps.campaign, campaigns);
    await queryClient.fetchQuery(
      resultsAggregateQuery(campaignId ? [campaignId] : null, deps.day, tz, []),
    );
  },
  component: ResultsIndex,
});

function ResultsIndex() {
  const { campaign: campaignParam, day: dayFilter } = Route.useSearch();
  // Conditions are page state, not URL state: URL churn on every toggle
  // read as noise, and routing them through the loader made adding a
  // chip wait on the refetch. A deliberate share-link affordance can
  // serialize them later.
  const [filters, setFiltersState] = useState<Condition[]>([]);
  const navigate = useNavigate({ from: Route.fullPath });
  const shouldFade = useFadeOnce("/results");
  const { session } = Route.useRouteContext();
  const tz = session?.user.displayTimezone ?? DEFAULT_DISPLAY_TIMEZONE;
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  // Deselection follows map convention (Google Maps et al.): background
  // click within the map, the × button, or Escape — page chrome clicks
  // never touch the selection.
  useHotkey({
    key: "Escape",
    enabled: selectedZoneId !== null,
    onMatch: () => setSelectedZoneId(null),
  });

  const { data: campaigns } = useSuspenseQuery(campaignsListQuery());
  const campaignOptions = campaignFilterOptions(campaigns);
  // Parity with Progress: default = newest active campaign. "All
  // campaigns" stays reachable for cross-pass totals — its per-person
  // reduction only makes sense for campaigns run as passes, so the
  // combined view is a deliberate selection, not the landing state.
  const campaignFilter = scopedCampaignId(campaignParam, campaigns);
  const campaignLabel =
    campaignFilter === null
      ? "All campaigns"
      : (campaignOptions.find((o) => o.value === campaignFilter)?.label ?? null);

  // Only leaves with values constrain anything — a just-added empty
  // chip changes nothing until edited, so it triggers no refetch.
  const activeFilters = filters.filter((c) => isActiveFilter(c.filter));
  // Plain useQuery: suspense would ignore keepPreviousData and unmount
  // the page (and the map, mid-teardown) on every key change. The loader
  // prefetches the unfiltered scope, so data is present on first paint;
  // the empty fallback only covers transient states.
  const { data } = useQuery(
    resultsAggregateQuery(campaignFilter ? [campaignFilter] : null, dayFilter, tz, activeFilters),
  );
  const aggregate = data ?? EMPTY_AGGREGATE;

  // Condition chips; the popover edits one leaf in place.
  const { sections, definitionFor } = useFilterCatalog();
  const { data: allSegments } = useQuery(segmentsListQuery());
  const [openFilter, setOpenFilter] = useState<number | null>(null);
  const addFilter = (def: FilterDef) => {
    setFiltersState([...filters, { filter: emptyFilterFor(def), negated: false }]);
    setOpenFilter(filters.length);
  };
  const updateFilter = (idx: number, next: Partial<Condition>) =>
    setFiltersState(filters.map((c, i) => (i === idx ? { ...c, ...next } : c)));
  const removeFilter = (idx: number) => {
    setOpenFilter(null);
    setFiltersState(filters.filter((_, i) => i !== idx));
  };
  // No canvass leaves here: outcomes/responses are this page's outputs,
  // and conditioning on them reads circular. Targeting-time use stays in
  // the segment editor (reachable via a segment reference if truly needed).
  const addableSections = sections
    .map((section) =>
      section.filter(
        (d) => d.kind !== "all" && d.kind !== "canvass-outcome" && d.kind !== "canvass-response",
      ),
    )
    .filter((section) => section.length > 0);

  const dayOptions = aggregate.days.map((d) => ({
    value: d,
    label: formatCanvassDay(d),
  }));
  const dayLabel =
    dayFilter === null
      ? "All dates"
      : (dayOptions.find((o) => o.value === dayFilter)?.label ?? null);

  // Zone shapes for every zone group the scoped campaigns reference —
  // archived campaigns included: their results are history, not noise.
  const scopeCampaigns = campaignFilter
    ? campaigns.filter((c) => c.campaignId === campaignFilter)
    : campaigns;
  const zoneGroupIds = [
    ...new Set(scopeCampaigns.map((c) => c.zoneGroupId).filter((id): id is string => !!id)),
  ];
  const { data: perimeters } = useQuery(zonePerimetersQuery(zoneGroupIds));

  const byZone = useMemo(() => new Map(aggregate.rows.map((r) => [r.zoneId, r])), [aggregate]);

  // Color each zone by contact rate on the same absolute 0-20% YlGnBu
  // scale as the funnel's contact badge, so a zone's fill and its badge
  // agree.
  const isDark = useAtomValue(darkAtom);
  const coloredPerimeters = useMemo(() => {
    if (!perimeters) return undefined;
    return {
      ...perimeters,
      features: perimeters.features.map((f) => {
        const row = byZone.get(f.properties?.zoneId as string);
        const rate = row ? rateOf(row) : null;
        return {
          ...f,
          properties: {
            ...f.properties,
            ...(rate !== null
              ? { color: rateRamp(Math.min(rate / CONTACT_RATE_MAX, 1), isDark), opacity: 0.6 }
              : { opacity: 0.06 }),
          },
        };
      }),
    };
  }, [perimeters, byZone, isDark]);

  const fitBounds = useMemo(
    () => (coloredPerimeters ? bboxOfFeatures(coloredPerimeters.features) : null),
    [coloredPerimeters],
  );

  const selectedRow = selectedZoneId ? (byZone.get(selectedZoneId) ?? null) : null;
  const scope = selectedRow ?? sumRows(aggregate.rows);

  return (
    <EditorPage className={cn("h-[calc(100vh-3.5rem)]", shouldFade)}>
      <EditorHeader title="Results">
        {filters.map((c, i) => {
          const def = definitionFor(filterKey(c.filter));
          return (
            <Popover
              key={i}
              open={openFilter === i}
              onOpenChange={(open) => setOpenFilter(open ? i : null)}
            >
              <PopoverTrigger
                render={<Button variant="outline" className="max-w-56 min-w-0 shrink" />}
              >
                <span className="truncate">{def?.label ?? "Filter"}</span>
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label="Remove filter"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFilter(i);
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Icon name="x" className="size-3.5 shrink-0" />
                </span>
              </PopoverTrigger>
              <PopoverContent align="start" className="flex w-96 flex-col gap-3 p-3">
                {/* Membership verbs, not the segment editor's pipeline
                    verbs: chips are flat and unordered, so each states
                    its effect — who's in, who's out. */}
                <ToggleGroup
                  variant="outline"
                  size="sm"
                  value={[c.negated ? "exclude" : "include"]}
                  onValueChange={(values) => {
                    const next = values[0];
                    if (next === "include" || next === "exclude")
                      updateFilter(i, { negated: next === "exclude" });
                  }}
                >
                  <ToggleGroupItem value="include">Include</ToggleGroupItem>
                  <ToggleGroupItem value="exclude">Exclude</ToggleGroupItem>
                </ToggleGroup>
                <FilterValueEditor
                  filter={c.filter}
                  def={def}
                  onChange={(next) => updateFilter(i, { filter: next })}
                  currentSegmentId=""
                  allSegments={allSegments ?? []}
                />
              </PopoverContent>
            </Popover>
          );
        })}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" />}>
            <Icon name="funnel" className="size-3.5" />
            Add filter
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-96 w-56 overflow-y-auto">
            {addableSections.map((section, si) => (
              <Fragment key={si}>
                {si > 0 ? <DropdownMenuSeparator /> : null}
                {section.map((d) => (
                  <DropdownMenuItem key={d.key} onClick={() => addFilter(d)}>
                    {d.label}
                  </DropdownMenuItem>
                ))}
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Filter
          icon={<Icon name="calendar" className="size-3.5" />}
          label={dayLabel}
          value={dayFilter}
          options={dayOptions}
          allLabel="All dates"
          onChange={(next) => void navigate({ search: (prev) => ({ ...prev, day: next }) })}
        />
        <Filter
          icon={<Icon name="megaphone" className="size-3.5" />}
          label={campaignLabel}
          value={campaignFilter}
          options={campaignOptions}
          allLabel="All campaigns"
          // No eager selection clear: mutating state here repaints the old
          // page mid-transition (a visible flash). A selected zone absent
          // from the new scope falls back to Summary via the byZone lookup.
          // Campaign switches reset the day filter — the selected day may
          // not exist in the new campaign, and anything smarter than a
          // reset breeds corner cases.
          onChange={(next) =>
            void navigate({ search: (prev) => ({ ...prev, campaign: next ?? "all", day: null }) })
          }
        />
      </EditorHeader>
      <div className="flex min-h-0 flex-1 gap-6">
        <div className="flex w-96 shrink-0 flex-col gap-4 overflow-y-auto pb-4">
          <FunnelPanel scope={scope} />
          <QuestionsPanel scope={scope} />
        </div>
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
              selectedRow ? (
                <div className="flex items-center gap-2 px-3 py-2">
                  <span className="font-semibold">{selectedRow.zoneName}</span>
                  <button
                    type="button"
                    aria-label="Clear zone selection"
                    onClick={() => setSelectedZoneId(null)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Icon name="x" className="size-3.5" />
                  </button>
                </div>
              ) : (
                <div className="flex flex-col px-3 py-2">
                  <span className="font-semibold">All zones</span>
                  <span className="text-muted-foreground">Click a zone to see its results</span>
                </div>
              )
            }
          />
        </div>
      </div>
    </EditorPage>
  );
}

// Sum stage counts across zones for the all-zones view.
function sumRows(rows: ZoneFunnelRow[]): ZoneFunnelRow {
  const out: ZoneFunnelRow = {
    zoneId: null,
    zoneName: null,
    attempted: 0,
    contacted: 0,
    responses: {},
  };
  for (const r of rows) {
    out.attempted += r.attempted;
    out.contacted += r.contacted;
    for (const [qid, opts] of Object.entries(r.responses)) {
      const q = (out.responses[qid] ??= {});
      for (const [oid, n] of Object.entries(opts)) q[oid] = (q[oid] ?? 0) + n;
    }
  }
  return out;
}

// "2026-08-23" → "Aug 23, 2026". Split manually — Date parsing would
// re-interpret the day in UTC and shift it across midnight.
function formatCanvassDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
  return `${months[(m ?? 1) - 1]} ${d}, ${y}`;
}

function rateOrNull(num: number, denom: number | null): number | null {
  if (denom === null || denom === 0) return null;
  return num / denom;
}

// Inverted in dark mode like the segment-overlay ramp: high rates stay
// the bright, most-visible end on a dark basemap. Badges follow so fill
// and badge always agree.
function rateRamp(t: number, isDark: boolean): string {
  return interpolateYlGnBu(isDark ? 1 - t : t);
}

// Rate badges share the map's YlGnBu scale at the map's fill opacity;
// ink flips light/dark by background luminance. Takes the domain-
// normalized position (0–1), not the raw rate.
function rateBadgeStyle(t: number, isDark: boolean): CSSProperties {
  const [r, g, b] = (rateRamp(t, isDark).match(/\d+/g) ?? ["0", "0", "0"]).map(Number);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return {
    backgroundColor: `rgba(${r}, ${g}, ${b}, 0.6)`,
    color: lum > 0.55 ? "hsl(0 0% 12%)" : "hsl(0 0% 98%)",
  };
}

// Card chrome shared by the funnel and question groups: title row, thin
// separators between rows, gray labels, ink counts, percent badges.
function ReportCard({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-card">
      {/* Dividers inset from the card edge: rows sit inside a margin,
          so divide-y lines stop at the padding. */}
      <div className="mx-3 divide-y divide-border/60">{children}</div>
    </div>
  );
}

// `rateMax` sets the color domain only — the printed percent is always
// the true rate.
function CountCell({
  count,
  rate,
  rateMax = 1,
}: {
  count: number;
  rate: number | null;
  rateMax?: number;
}) {
  const isDark = useAtomValue(darkAtom);
  return (
    <span className="flex items-center gap-1.5">
      <span className="font-mono text-sm tabular-nums">{count.toLocaleString()}</span>
      {rate !== null ? (
        <span
          className="rounded px-1.5 py-0.5 font-mono text-sm tabular-nums"
          style={rateBadgeStyle(Math.min(rate / rateMax, 1), isDark)}
        >
          {(100 * rate).toFixed(1)}%
        </span>
      ) : null}
    </span>
  );
}

const FUNNEL_GRID = "grid grid-cols-[3fr_2fr] items-center gap-2";

function FunnelPanel({ scope }: { scope: ZoneFunnelRow }) {
  const stages: Array<{ label: string; count: number; denom: number | null }> = [
    { label: "Attempted", count: scope.attempted, denom: null },
    { label: "Contacted", count: scope.contacted, denom: scope.attempted },
  ];
  return (
    <ReportCard>
      <div className={cn(FUNNEL_GRID, "h-10 text-sm")}>
        <span className="font-semibold">Summary</span>
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Icon name="user-round" className="size-3.5 shrink-0 [stroke-width:2.5]" />
          People
        </span>
      </div>
      {stages.map((s) => (
        <div key={s.label} className={cn(FUNNEL_GRID, "h-10")}>
          <span className="text-sm text-muted-foreground">{s.label}</span>
          {/* Contacted/attempted is the contact rate — color it on the
              same 0-20% domain as the map. */}
          <CountCell
            count={s.count}
            rate={rateOrNull(s.count, s.denom)}
            rateMax={s.label === "Contacted" ? CONTACT_RATE_MAX : 1}
          />
        </div>
      ))}
    </ReportCard>
  );
}

function QuestionsPanel({ scope }: { scope: ZoneFunnelRow }) {
  const { data: questions } = useQuery(questionsWithOptionsQuery());
  if (!questions) return null;
  const answered = questions.filter((q) => scope.responses[q.questionId]);
  if (answered.length === 0) return null;
  return (
    <>
      {answered.map((q) => {
        const counts = scope.responses[q.questionId] ?? {};
        return (
          <ReportCard key={q.questionId}>
            {/* Responses ride person results only, so a lone People column. */}
            <div className="grid h-10 grid-cols-[3fr_2fr] items-center gap-2 text-sm">
              <span className="truncate font-semibold">{q.name}</span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Icon name="user-round" className="size-3.5 shrink-0 [stroke-width:2.5]" />
                People
              </span>
            </div>
            {q.options
              .filter((o) => !o.archived || counts[o.responseOptionId])
              .map((o) => {
                const n = counts[o.responseOptionId] ?? 0;
                return (
                  <div
                    key={o.responseOptionId}
                    className="grid h-10 grid-cols-[3fr_2fr] items-center gap-2"
                  >
                    <span className="truncate text-sm text-muted-foreground">{o.text}</span>
                    <CountCell count={n} rate={rateOrNull(n, scope.contacted)} />
                  </div>
                );
              })}
          </ReportCard>
        );
      })}
    </>
  );
}
