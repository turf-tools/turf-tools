import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "~/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { ToggleGroup, ToggleGroupItem } from "~/components/toggle-group";
import { tintStyle } from "~/components/badge";
import { emptyFilterFor, type FilterDef, filterKey, isActiveFilter } from "~/lib/filters";
import { BLUE, PINK, PURPLE } from "~/lib/palette";
import { bboxOfFeatures } from "~/lib/geometry";
import { useFilterCatalog } from "~/lib/manifest";
import { campaignFilterOptions, defaultCampaignId } from "~/lib/campaign-options";
import { campaignsListQuery } from "~/lib/queries/campaigns";
import { questionsWithOptionsQuery } from "~/lib/queries/questions";
import { type Condition, resultsAggregateQuery } from "~/lib/queries/results";
import { zonePerimetersQuery } from "~/lib/queries/zones";
import { segmentsListQuery } from "~/lib/queries/segments";
import { DEFAULT_DISPLAY_TIMEZONE } from "~/lib/timezones";
import { useFadeOnce } from "~/lib/use-fade-once";
import { useHotkey } from "~/lib/use-hotkey";
import { cn, revealZoneCard } from "~/lib/utils";
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

// Page-level selection value for the totals row — the map itself only
// ever sees a list of zone ids.
const ALL_ZONES = "all";

function rateOf(row: ZoneFunnelRow): number | null {
  if (row.attempted === 0) return null;
  return row.contacted / row.attempted;
}

function wholePercent(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(100 * rate)}%`;
}

// Color-scale domain for contact rate: door-knocking contact rates live
// in 0–20% essentially universally, so a 0–100% scale washes every zone
// into the bottom fifth. Answer rates stay 0–100%: options split a
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
    await Promise.all([
      queryClient.fetchQuery(
        resultsAggregateQuery(campaignId ? [campaignId] : null, deps.day, tz, []),
      ),
      // Question/option selectors paint with real labels on first render.
      queryClient.fetchQuery(questionsWithOptionsQuery()),
    ]);
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
  useHotkey({
    key: "Escape",
    enabled: selectedZoneId !== null,
    onMatch: () => setSelectedZoneId(null),
  });

  // Selection can be made from the table, so the whole page is the
  // selection surface (zone-editor convention, same as Progress):
  // clicking chrome outside the map clears. Firing on mousedown is also
  // what makes re-clicking a zone button flash its map outline.
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

  // Question picks (multi) show every selected question's options as
  // count+rate columns; the map colors by the Metric dropdown, whose
  // entries are contact rate plus the selected questions' options — so
  // the "color by which option?" ambiguity is resolved by an explicit
  // pick. Fallbacks are derived: first question when nothing is picked,
  // metric falls back to contact rate when its option leaves the set.
  const { data: questions } = useQuery(questionsWithOptionsQuery());
  const questionList = questions ?? [];
  const [questionPicks, setQuestionPicks] = useState<string[]>([]);
  const [questionMenuOpen, setQuestionMenuOpen] = useState(false);
  const pickedQuestions = questionList.filter((q) => questionPicks.includes(q.questionId));
  const activeQuestions = pickedQuestions.length > 0 ? pickedQuestions : questionList.slice(0, 1);
  const totals = sumRows(aggregate.rows);
  // Archived options stay visible while they carry answers in scope —
  // archive hides options from pickers, never from history.
  const visibleOptions = (q: (typeof questionList)[number]) =>
    q.options.filter(
      (o) => !o.archived || (totals.responses[q.questionId]?.[o.responseOptionId] ?? 0) > 0,
    );
  const answerColumns = activeQuestions.flatMap((q) =>
    visibleOptions(q).map((o) => ({ question: q, option: o })),
  );
  // Group spans for the question header row above the option columns.
  const questionGroups = activeQuestions
    .map((q) => ({ question: q, span: visibleOptions(q).length }))
    .filter((g) => g.span > 0);
  const [metricPick, setMetricPick] = useState<string>("contact");
  const metricColumn = answerColumns.find((c) => c.option.responseOptionId === metricPick);

  const [mapHidden, setMapHidden] = useState(false);
  // Beside the map, the card sizes to the FIRST selected question's
  // columns (capped so three fit comfortably) and stays put — adding
  // further questions scrolls in-card instead of expanding, so the
  // split never shifts as picks accumulate.
  const firstQuestionColumnCount = activeQuestions[0]
    ? visibleOptions(activeQuestions[0]).length
    : 0;
  const cardRem = Math.min(23 + firstQuestionColumnCount * 7, 23 + 3 * 7);

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

  const optionRate = (row: ZoneFunnelRow, questionId: string, optionId: string): number | null =>
    row.contacted > 0 ? (row.responses[questionId]?.[optionId] ?? 0) / row.contacted : null;

  // Map fill follows the metric dropdown on the same discrete bands as
  // the table's badges, so a zone's fill and its badge agree.
  const coloredPerimeters = useMemo(() => {
    if (!perimeters) return undefined;
    return {
      ...perimeters,
      features: perimeters.features.map((f) => {
        const row = byZone.get(f.properties?.zoneId as string);
        const t =
          row === undefined
            ? null
            : metricColumn
              ? optionRate(
                  row,
                  metricColumn.question.questionId,
                  metricColumn.option.responseOptionId,
                )
              : rateOf(row) === null
                ? null
                : Math.min((rateOf(row) as number) / CONTACT_RATE_MAX, 1);
        return {
          ...f,
          properties: {
            ...f.properties,
            ...(t !== null ? { color: rateColor(t), opacity: 0.6 } : { opacity: 0.06 }),
          },
        };
      }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perimeters, byZone, metricColumn]);

  const fitBounds = useMemo(
    () => (coloredPerimeters ? bboxOfFeatures(coloredPerimeters.features) : null),
    [coloredPerimeters],
  );

  // The all-zones row is a selection target like any zone: every zone
  // highlights on the map, the corner shows the aggregate.
  const selectedRow =
    selectedZoneId === ALL_ZONES
      ? totals
      : selectedZoneId
        ? (byZone.get(selectedZoneId) ?? null)
        : null;

  return (
    <EditorPage className={cn("h-[calc(100vh-3.5rem)]", shouldFade)}>
      <EditorHeader title="Results" subtitle="Question responses by zone">
        {/* Question picks (checkboxes) drive the option column groups;
            the metric pick (contact rate or any selected question's
            option) drives the map fill, falling back to contact rate
            when its option leaves the set. */}
        <DropdownMenu open={questionMenuOpen} onOpenChange={setQuestionMenuOpen}>
          <DropdownMenuTrigger
            render={<Button variant="outline" className="max-w-56 min-w-0 shrink" />}
          >
            <Icon name="clipboard-pen" className="size-3.5" />
            <span className="truncate">
              {activeQuestions.length === 1
                ? (activeQuestions[0]?.name ?? "Questions")
                : `${activeQuestions.length} questions`}
            </span>
            <Icon name="chevron-down" className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-96 w-64 overflow-y-auto">
            {questionList.map((q) => (
              <DropdownMenuCheckboxItem
                key={q.questionId}
                closeOnClick={false}
                checked={activeQuestions.some((a) => a.questionId === q.questionId)}
                onCheckedChange={(checked) => {
                  const current = activeQuestions.map((a) => a.questionId);
                  // Unchecking the only selection would fall back to the
                  // default question anyway — read the click as "done"
                  // and just close.
                  if (!checked && current.length === 1) {
                    setQuestionMenuOpen(false);
                    return;
                  }
                  setQuestionPicks(
                    checked
                      ? [...current, q.questionId]
                      : current.filter((id) => id !== q.questionId),
                  );
                }}
              >
                <span className="truncate">{q.name}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Filter
          icon={<Icon name="paintbrush" className="size-3.5" />}
          label={
            metricColumn
              ? `${metricColumn.question.name}: ${metricColumn.option.text}`
              : "Contact rate"
          }
          value={metricColumn ? metricPick : "contact"}
          options={[
            { value: "contact", label: "Contact rate" },
            ...answerColumns.map((c) => ({
              value: c.option.responseOptionId,
              // Always question-qualified — an option label alone ("Yes")
              // doesn't say what the map would color by.
              label: `${c.question.name}: ${c.option.text}`,
            })),
          ]}
          allLabel={null}
          onChange={(next) => next !== null && setMetricPick(next)}
        />
        {/* Scope cluster: Add filter (chips appear on the row below),
            then date and campaign. */}
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
          // Campaign switches reset the day filter — the selected day may
          // not exist in the new campaign, and anything smarter than a
          // reset breeds corner cases.
          onChange={(next) =>
            void navigate({ search: (prev) => ({ ...prev, campaign: next ?? "all", day: null }) })
          }
        />
        <Button
          variant="outline"
          size="icon"
          aria-label={mapHidden ? "Show map" : "Hide map"}
          onClick={() => setMapHidden((h) => !h)}
        >
          <Icon name="map" className="size-3.5" />
        </Button>
      </EditorHeader>
      {/* Chips live on their own row, appearing with the first filter
          and leaving with the last — the control row above never
          reflows. */}
      {filters.length > 0 ? (
        <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
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
        </div>
      ) : null}
      {/* gap-4 between bordered cards (lookup precedent); EditorPage
          already carries the page's bottom padding. */}
      <div className="flex min-h-0 flex-1 gap-4">
        {/* Reports' compact card table: rows are the selection surface
            (click selects on the map), the hover pill is the linked echo
            (a map click scrolls to the row and its highlight is the same
            pill), and only walked zones appear — uncut zones can't have
            attempts, and their zero rows are noise here (the map still
            shows them with the faint no-data fill). The card always hugs
            its table; the map absorbs whatever width remains. */}
        <div
          className={cn(
            "flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card",
            mapHidden ? "flex-1" : "shrink-0",
          )}
          // +2px: the borders live inside the border-box width; without
          // them the table sits 2px short and grows a phantom scrollbar.
          style={mapHidden ? undefined : { width: `calc(${cardRem}rem + 2px)` }}
        >
          <div className="min-h-0 flex-1 px-2 pt-2">
            <Table
              containerClassName="h-full overflow-x-auto overflow-y-auto"
              // border-spacing-y is the table version of the lookup
              // list's gap-0.5 — adjacent hover pills get a hairline gap
              // instead of meeting flush.
              className="table-fixed border-separate border-spacing-y-0.5 [&_tr>th:first-child]:pl-2 [&_tr>td:first-child]:pl-2"
              style={{ width: `${22 + answerColumns.length * 7}rem` }}
            >
              {/* Fixed layout reads column widths from the FIRST header
                  row — which here is the colSpan question row — so the
                  widths live in a colgroup instead. */}
              <colgroup>
                <col style={{ width: "10rem" }} />
                <col style={{ width: "5rem" }} />
                <col style={{ width: "7rem" }} />
                {answerColumns.map((c) => (
                  <col key={c.option.responseOptionId} style={{ width: "7rem" }} />
                ))}
              </colgroup>
              <TableHeader className="[&_th]:sticky [&_th]:z-10 [&_th]:bg-card">
                {/* One uniform strip grid shared with Progress: every
                    row — header or data — has the same h-8 pitch. This
                    page's strips are [questions, headers, totals,
                    zones...]; the question strip stays (blank) when no
                    questions are in scope so nothing below it moves. */}
                <TableRow className="[&_th]:top-0 [&_th]:h-8">
                  <TableHead colSpan={3} />
                  {questionGroups.map((g) => (
                    <TableHead
                      key={g.question.questionId}
                      colSpan={g.span}
                      className="truncate"
                      title={g.question.name}
                    >
                      {g.question.name}
                    </TableHead>
                  ))}
                </TableRow>
                <TableRow className="[&_th]:top-8 [&_th]:h-8">
                  <TableHead>Zone</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Contacts</TableHead>
                  {answerColumns.map((c) => (
                    <TableHead
                      key={c.option.responseOptionId}
                      className="truncate"
                      title={`${c.question.name}: ${c.option.text}`}
                    >
                      {c.option.text}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* All-zones totals first — the funnel headline and the
                    reading frame for the rows below. Not a selection
                    target: it IS the no-selection state. */}
                <ZoneRow
                  label={<span>All zones</span>}
                  row={totals}
                  columns={answerColumns}
                  selected={selectedZoneId === ALL_ZONES}
                  onSelect={() => setSelectedZoneId(ALL_ZONES)}
                />
                {aggregate.rows
                  .filter((r) => r.attempted > 0)
                  .map((r) => (
                    <ZoneRow
                      key={r.zoneId ?? "none"}
                      label={<span className="truncate">{r.zoneName ?? "—"}</span>}
                      zoneId={r.zoneId}
                      selected={r.zoneId != null && r.zoneId === selectedZoneId}
                      onSelect={r.zoneId != null ? () => setSelectedZoneId(r.zoneId) : undefined}
                      row={r}
                      columns={answerColumns}
                    />
                  ))}
              </TableBody>
            </Table>
          </div>
        </div>
        <div ref={mapWrapperRef} className={cn("relative min-h-0 flex-1", mapHidden && "hidden")}>
          <MapView
            className="h-full"
            zonePerimeters={coloredPerimeters}
            selectedZoneIds={
              selectedZoneId === ALL_ZONES
                ? (perimeters?.features ?? [])
                    .map((f) => f.properties?.zoneId as string | undefined)
                    .filter((id): id is string => !!id)
                : selectedZoneId
                  ? [selectedZoneId]
                  : []
            }
            onZoneClick={(zoneId) => {
              setSelectedZoneId(zoneId);
              revealZoneCard(zoneId);
            }}
            onBackgroundClick={() => setSelectedZoneId(null)}
            fitBounds={fitBounds}
            loading={!coloredPerimeters}
            cornerUpperLeft={
              selectedRow ? (
                // Percents only — the table row has the full treatment;
                // the corner is a glance.
                <div className="flex flex-col px-3 py-2">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-semibold">
                      {selectedZoneId === ALL_ZONES ? "All zones" : selectedRow.zoneName}
                    </span>
                    <button
                      type="button"
                      aria-label="Clear zone selection"
                      onClick={() => setSelectedZoneId(null)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Icon name="x" className="size-3.5" />
                    </button>
                  </span>
                  <span className="text-muted-foreground">
                    Contacts: {wholePercent(rateOf(selectedRow))}
                  </span>
                  {answerColumns.map((c) => (
                    <span
                      key={c.option.responseOptionId}
                      className="truncate text-muted-foreground"
                    >
                      {c.question.name}: {c.option.text}{" "}
                      {wholePercent(
                        optionRate(selectedRow, c.question.questionId, c.option.responseOptionId),
                      )}
                    </span>
                  ))}
                </div>
              ) : undefined
            }
          />
        </div>
      </div>
    </EditorPage>
  );
}

// One zone's funnel + per-option cells (rate badge leading its count,
// so the percentages form one clean tabular column per metric); the
// totals row and zone rows share their number formatting exactly. Cell
// backgrounds carry hover and selection (same pill), so the end caps
// can round.
function ZoneRow({
  label,
  zoneId,
  selected = false,
  onSelect,
  row,
  columns,
}: {
  label: React.ReactNode;
  zoneId?: string | null;
  selected?: boolean;
  onSelect?: () => void;
  row: ZoneFunnelRow;
  columns: ReadonlyArray<{
    question: { questionId: string };
    option: { responseOptionId: string };
  }>;
}) {
  const contactRate = rateOf(row);
  const cell = cn(
    "truncate px-2 whitespace-nowrap",
    onSelect && "group-hover:bg-muted/50 first:rounded-l-md last:rounded-r-md",
    selected && "bg-muted/50",
  );
  return (
    <TableRow
      data-zone-card={zoneId ?? undefined}
      // Sticky header overlays the container top; without the margin,
      // upward scrollIntoView parks the row under it.
      // h-8 = the lookup list's row height exactly (text-sm + py-1.5);
      // the badge fills it with the same 4px breathing room.
      className={cn("group h-8 scroll-mt-10", onSelect && "cursor-pointer")}
      onClick={onSelect}
    >
      <TableCell className={cell}>{label}</TableCell>
      <TableCell className={cn(cell, "tabular-nums")}>{row.attempted.toLocaleString()}</TableCell>
      <TableCell className={cell}>
        <span className="flex items-center gap-1.5">
          <RateBadge rate={contactRate} rateMax={CONTACT_RATE_MAX} />
          <span className="tabular-nums">{row.contacted.toLocaleString()}</span>
        </span>
      </TableCell>
      {columns.map((c) => {
        const n = row.responses[c.question.questionId]?.[c.option.responseOptionId] ?? 0;
        const rate = row.contacted > 0 ? n / row.contacted : null;
        return (
          <TableCell key={c.option.responseOptionId} className={cell}>
            <span className="flex items-center gap-1.5">
              <RateBadge rate={rate} rateMax={1} />
              <span className="tabular-nums">{n.toLocaleString()}</span>
            </span>
          </TableCell>
        );
      })}
    </TableRow>
  );
}

// Sum stage counts across zones for the totals row.
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

// Discrete 3-band magnitude scale — pink → purple → blue: the one
// Observable10 hue-chain that avoids the RYG status hues entirely
// (green/yellow mean done/underway next door on Progress), falls
// monotonically in CIELAB lightness with even ~12 L* steps ("darker =
// more" actually orders), and rotates through adjacent hues (magenta →
// violet → blue). Same banding rule as Progress's RYG (breaks at 25%
// and 75% of the metric's domain); badges ride the shared tint math and
// the map fills match exactly.
function rateColor(t: number): string {
  return t <= 0.25 ? PINK : t <= 0.75 ? PURPLE : BLUE;
}

// `rateMax` sets the color domain only — the printed percent is always
// the true rate. Whole percent, zero-padded to two digits — every badge
// is the same width, so the column of badges reads as its own tabular
// structure.
function RateBadge({ rate, rateMax }: { rate: number | null; rateMax: number }) {
  if (rate === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className="badge-tint rounded px-1.5 py-0.5 font-mono text-sm tabular-nums"
      style={tintStyle(rateColor(Math.min(rate / rateMax, 1)))}
    >
      {String(Math.round(100 * rate)).padStart(2, "0")}%
    </span>
  );
}
