import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Fragment, useMemo, useRef, useState } from "react";
import { tintStyle } from "~/components/badge";
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
import { useZoneSelection } from "~/lib/use-zone-selection";
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

function wholePercent(rate: number): string {
  return `${Math.round(100 * rate)}%`;
}

function optionRate(row: ZoneFunnelRow, questionId: string, optionId: string): number | null {
  return row.contacted > 0 ? (row.responses[questionId]?.[optionId] ?? 0) / row.contacted : null;
}

function answeredRate(row: ZoneFunnelRow, questionId: string): number | null {
  return row.contacted > 0 ? (row.answered[questionId] ?? 0) / row.contacted : null;
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
  // Whole-page selection surface with the corner riding out the
  // clear→reselect gesture — mechanics in useZoneSelection.
  const mapWrapperRef = useRef<HTMLDivElement>(null);
  const { selectedZoneId, cornerZoneId, select, clear } = useZoneSelection(mapWrapperRef);
  useHotkey({
    key: "Escape",
    enabled: selectedZoneId !== null,
    onMatch: clear,
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

  // Question picks (multi) show every selected question's options as
  // count+rate columns; the map colors by the Color-by pick, whose
  // entries are contact rate plus the selected questions' options — so
  // the "color by which option?" ambiguity is resolved by an explicit
  // pick. Fallbacks are derived: first question when nothing is picked,
  // Color-by falls back to contact rate when its option leaves the set.
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
  // One column per visible option; a question with none (open-ended,
  // or every option archived with no in-scope answers) gets a single
  // "Answered" completion column instead of vanishing when selected.
  type AnswerColumn = {
    question: (typeof questionList)[number];
    option: (typeof questionList)[number]["options"][number] | null;
  };
  const answerColumns = activeQuestions.flatMap((q): AnswerColumn[] => {
    const options = visibleOptions(q);
    return options.length > 0
      ? options.map((o) => ({ question: q, option: o }))
      : [{ question: q, option: null }];
  });
  // Group spans for the question header row above the option columns.
  const questionGroups = activeQuestions.map((q) => ({
    question: q,
    span: Math.max(visibleOptions(q).length, 1),
  }));
  const [metricPick, setMetricPick] = useState<string>("contact");
  // Only real options can color the map — an Answered column's rate is
  // completion, not persuasion.
  const optionColumns = answerColumns.filter(
    (c): c is AnswerColumn & { option: NonNullable<AnswerColumn["option"]> } => c.option !== null,
  );
  const metricColumn = optionColumns.find((c) => c.option.responseOptionId === metricPick);

  const [mapCollapsed, setMapCollapsed] = useState(false);
  // Beside the map, the card sizes to the FIRST selected question's
  // columns (capped so three fit comfortably) and stays put — adding
  // further questions scrolls in-card instead of expanding, so the
  // split never shifts as picks accumulate.
  // An Answered column counts as two option-widths: the question name
  // above it needs the room real questions get from having 2+ options.
  const firstQuestionColumnCount = activeQuestions[0]
    ? visibleOptions(activeQuestions[0]).length || 2
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

  // Map fill follows the Color-by pick on the same discrete bands as
  // the table's badges, so a zone's fill and its badge agree. Keyed on
  // the pick's ids — primitives — so the memo (and the map source
  // feeding off it) holds steady across unrelated re-renders.
  const metricQuestionId = metricColumn?.question.questionId;
  const metricOptionId = metricColumn?.option.responseOptionId;
  const coloredPerimeters = useMemo(() => {
    if (!perimeters) return undefined;
    // Domain-normalized fill position: the picked option's rate (0–100%
    // domain) or contact rate on its 0–20% domain.
    const tOf = (row: ZoneFunnelRow): number | null => {
      if (metricQuestionId && metricOptionId)
        return optionRate(row, metricQuestionId, metricOptionId);
      const rate = rateOf(row);
      return rate === null ? null : Math.min(rate / CONTACT_RATE_MAX, 1);
    };
    // Only walked zones are drawn, matching the table — "where else
    // could we go" is Progress's question. A drawn zone can still lack
    // the picked metric (no contacts under an option metric); it keeps
    // a faint no-data fill.
    const features = perimeters.features.filter((f) => {
      const row = byZone.get(f.properties?.zoneId as string);
      return row !== undefined && row.attempted > 0;
    });
    return {
      ...perimeters,
      features: features.map((f) => {
        const row = byZone.get(f.properties?.zoneId as string);
        const t = row ? tOf(row) : null;
        return {
          ...f,
          properties: {
            ...f.properties,
            ...(t !== null ? { color: rateColor(t), opacity: 0.6 } : { opacity: 0.06 }),
          },
        };
      }),
    };
  }, [perimeters, byZone, metricQuestionId, metricOptionId]);

  const fitBounds = useMemo(
    () => (coloredPerimeters ? bboxOfFeatures(coloredPerimeters.features) : null),
    [coloredPerimeters],
  );

  // The all-zones row is a selection target like any zone: the whole
  // drawn set highlights on the map, the corner shows the aggregate.
  // The corner reads cornerZoneId so a row re-click flashes the outline
  // without blinking the readout.
  const cornerRow =
    cornerZoneId === ALL_ZONES ? totals : cornerZoneId ? (byZone.get(cornerZoneId) ?? null) : null;

  return (
    <EditorPage className={cn("h-[calc(100vh-3.5rem)]", shouldFade)}>
      <EditorHeader title="Results" subtitle="Question responses by zone">
        {/* Question picks (checkboxes) drive the option column groups;
            the Color-by pick (contact rate or any selected question's
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
              ? `${metricColumn.question.name} | ${metricColumn.option.text}`
              : "Contact rate"
          }
          value={metricColumn ? metricPick : "contact"}
          options={[
            { value: "contact", label: "Contact rate" },
            ...optionColumns.map((c) => ({
              value: c.option.responseOptionId,
              // Always question-qualified — an option label alone ("Yes")
              // doesn't say what the map would color by.
              label: `${c.question.name} | ${c.option.text}`,
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
            pill), and only walked zones appear — table and map alike;
            unwalked zones' zero rows are noise here. The card always
            hugs its table; the map absorbs whatever width remains. */}
        <div
          className={cn(
            "flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card",
            mapCollapsed ? "flex-1" : "shrink-0",
          )}
          // +2px: the borders live inside the border-box width; without
          // them the table sits 2px short and grows a phantom scrollbar.
          style={mapCollapsed ? undefined : { width: `calc(${cardRem}rem + 2px)` }}
        >
          <div className="min-h-0 flex-1 px-2 pt-2">
            <Table
              containerClassName="h-full overflow-x-auto overflow-y-auto"
              // border-spacing-y is the table version of the lookup
              // list's gap-0.5 — adjacent hover pills get a hairline gap
              // instead of meeting flush.
              className="table-fixed border-separate border-spacing-y-0.5 [&_tr>th:first-child]:pl-2 [&_tr>td:first-child]:pl-2"
              style={{
                width: `${22 + answerColumns.reduce((n, c) => n + (c.option ? 7 : 14), 0)}rem`,
              }}
            >
              {/* Fixed layout reads column widths from the FIRST header
                  row — which here is the colSpan question row — so the
                  widths live in a colgroup instead. */}
              <colgroup>
                <col style={{ width: "10rem" }} />
                <col style={{ width: "5rem" }} />
                <col style={{ width: "7rem" }} />
                {answerColumns.map((c) => (
                  <col
                    key={c.option?.responseOptionId ?? c.question.questionId}
                    style={{ width: c.option ? "7rem" : "14rem" }}
                  />
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
                      key={c.option?.responseOptionId ?? c.question.questionId}
                      className="truncate"
                      title={`${c.question.name} | ${c.option?.text ?? "Answered"}`}
                    >
                      {c.option?.text ?? "Answered"}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* All-zones totals first — the funnel headline, the
                    reading frame for the rows below, and a selection
                    target like any zone (highlights every zone on the
                    map). */}
                <ZoneRow
                  label={<span>All zones</span>}
                  row={totals}
                  columns={answerColumns}
                  selected={selectedZoneId === ALL_ZONES}
                  onSelect={() => select(ALL_ZONES)}
                />
                {aggregate.rows
                  .filter((r) => r.attempted > 0)
                  .map((r) => {
                    const zoneId = r.zoneId;
                    return (
                      <ZoneRow
                        key={zoneId ?? "none"}
                        label={<span className="truncate">{r.zoneName ?? "—"}</span>}
                        zoneId={zoneId}
                        selected={zoneId != null && zoneId === selectedZoneId}
                        onSelect={zoneId != null ? () => select(zoneId) : undefined}
                        row={r}
                        columns={answerColumns}
                      />
                    );
                  })}
              </TableBody>
            </Table>
          </div>
        </div>
        {/* Collapsed = a slim live sliver, not unmounted — maplibre
            auto-resizes both ways and the strip keeps the map present.
            Sized to the caret button plus breathing room. */}
        <div
          ref={mapWrapperRef}
          className={cn("relative min-h-0", mapCollapsed ? "w-12 shrink-0" : "flex-1")}
        >
          <MapView
            className="h-full"
            zonePerimeters={coloredPerimeters}
            selectedZoneIds={
              selectedZoneId === ALL_ZONES
                ? (perimeters?.features ?? [])
                    // Highlight only the drawn set: walked zones.
                    .filter((f) => (byZone.get(f.properties?.zoneId as string)?.attempted ?? 0) > 0)
                    .map((f) => f.properties?.zoneId as string | undefined)
                    .filter((id): id is string => !!id)
                : selectedZoneId
                  ? [selectedZoneId]
                  : []
            }
            onZoneClick={(zoneId) => {
              select(zoneId);
              revealZoneCard(zoneId);
            }}
            onBackgroundClick={clear}
            fitBounds={fitBounds}
            loading={!coloredPerimeters}
            insetsHidden={mapCollapsed}
            cornerUpperLeft={
              cornerRow ? (
                // Percents only — the table row has the full treatment;
                // the corner is a glance.
                <div className="flex flex-col px-3 py-2">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-semibold">
                      {cornerZoneId === ALL_ZONES ? "All zones" : cornerRow.zoneName}
                    </span>
                    <button
                      type="button"
                      aria-label="Clear zone selection"
                      onClick={clear}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Icon name="x" className="size-3.5" />
                    </button>
                  </span>
                  <span className="text-muted-foreground">
                    Contacts: <RatePercent rate={rateOf(cornerRow)} rateMax={CONTACT_RATE_MAX} />
                  </span>
                  {answerColumns.map((c) => (
                    <span
                      key={c.option?.responseOptionId ?? c.question.questionId}
                      className="truncate text-muted-foreground"
                    >
                      {c.question.name} | {c.option?.text ?? "Answered"}:{" "}
                      <RatePercent
                        rate={
                          c.option
                            ? optionRate(
                                cornerRow,
                                c.question.questionId,
                                c.option.responseOptionId,
                              )
                            : answeredRate(cornerRow, c.question.questionId)
                        }
                        rateMax={1}
                      />
                    </span>
                  ))}
                </div>
              ) : undefined
            }
          />
          {/* The toggle rides the map's upper-right — the sidebar's
              panel-collapse pair, mirrored for a right-side panel; in
              the sliver it is the whole surface. */}
          <Button
            variant="outline"
            size="icon"
            aria-label={mapCollapsed ? "Expand map" : "Collapse map"}
            onClick={() => setMapCollapsed((c) => !c)}
            className="absolute top-2 right-2 z-10"
          >
            <Icon
              name={mapCollapsed ? "panel-right-open" : "panel-right-close"}
              className="size-4 shrink-0"
            />
          </Button>
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
    // Null = the question's single "Answered" completion column.
    option: { responseOptionId: string } | null;
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
        const n = c.option
          ? (row.responses[c.question.questionId]?.[c.option.responseOptionId] ?? 0)
          : (row.answered[c.question.questionId] ?? 0);
        const rate = row.contacted > 0 ? n / row.contacted : null;
        return (
          <TableCell key={c.option?.responseOptionId ?? c.question.questionId} className={cell}>
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
    answered: {},
  };
  for (const r of rows) {
    out.attempted += r.attempted;
    out.contacted += r.contacted;
    for (const [qid, opts] of Object.entries(r.responses)) {
      const q = (out.responses[qid] ??= {});
      for (const [oid, n] of Object.entries(opts)) q[oid] = (q[oid] ?? 0) + n;
    }
    for (const [qid, n] of Object.entries(r.answered)) {
      out.answered[qid] = (out.answered[qid] ?? 0) + n;
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

// The badge's scale as ink alone — corner readouts color the number
// itself, no chip chrome.
function RatePercent({ rate, rateMax }: { rate: number | null; rateMax: number }) {
  if (rate === null) return <>—</>;
  return (
    <span className="badge-fg" style={tintStyle(rateColor(Math.min(rate / rateMax, 1)))}>
      {wholePercent(rate)}
    </span>
  );
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
