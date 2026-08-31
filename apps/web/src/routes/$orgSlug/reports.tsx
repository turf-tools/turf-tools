import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type CSSProperties, useState } from "react";
import { Button } from "~/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/dropdown-menu";
import { EditorHeader } from "~/components/editor-header";
import { EditorPage } from "~/components/editor-page";
import { Filter } from "~/components/filter";
import { Icon } from "~/components/icon";
import { ReportCard } from "~/components/report-card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { CANVASS_OUTCOME_OPTIONS } from "~/lib/filters";
import { campaignFilterOptions, scopedCampaignId } from "~/lib/campaign-options";
import { campaignsListQuery } from "~/lib/queries/campaigns";
import { REPORT_PAGE_ROWS, type ReportSort, reportRowsQuery } from "~/lib/queries/reports";
import { tintStyle } from "~/components/badge";
import { formatPersonName } from "~/lib/format";
import { CONTACT_RATE_MAX, progressColor, rateColor } from "~/lib/palette";
import { REPORT_KINDS, type ReportKind, type ReportSummary } from "~/lib/reports";
import { DEFAULT_DISPLAY_TIMEZONE, formatCanvassDay } from "~/lib/timezones";
import { useFadeOnce } from "~/lib/use-fade-once";
import { cn, toTitleCase } from "~/lib/utils";

type ReportsSearch = {
  // Campaign id, "all", or null = default (newest active campaign).
  campaign: string | null;
  day: string | null;
  kind: ReportKind;
};

function isReportKind(value: unknown): value is ReportKind {
  return REPORT_KINDS.includes(value as ReportKind);
}

const KIND_OPTIONS = [
  { value: "people", label: "People" },
  { value: "responses", label: "Responses" },
  { value: "attempts", label: "Attempts" },
  { value: "walks", label: "Walks" },
  { value: "canvassers", label: "Canvassers" },
];

// Matches the server's default recency order, expressed as a column.
function defaultSort(kind: ReportKind): NonNullable<ReportSort> {
  const key =
    kind === "people"
      ? "last_attempt_at"
      : kind === "attempts"
        ? "attempted_at"
        : kind === "walks"
          ? "opened_at"
          : kind === "canvassers"
            ? "last_active_at"
            : "contacted_at";
  return { key, dir: "desc" };
}

export const Route = createFileRoute("/$orgSlug/reports")({
  validateSearch: (search): ReportsSearch => ({
    campaign: typeof search.campaign === "string" ? search.campaign : null,
    day: typeof search.day === "string" ? search.day : null,
    kind: isReportKind(search.kind) ? search.kind : "responses",
  }),
  loaderDeps: ({ search }) => ({ campaign: search.campaign, day: search.day, kind: search.kind }),
  loader: async ({ context: { queryClient, session }, deps }) => {
    const tz = session?.user.displayTimezone ?? DEFAULT_DISPLAY_TIMEZONE;
    // The default scope is derived from the campaigns list, so it loads first.
    const campaigns = await queryClient.fetchQuery(campaignsListQuery());
    const campaignId = scopedCampaignId(deps.campaign, campaigns);
    await queryClient.fetchQuery(
      reportRowsQuery(
        deps.kind,
        campaignId ? [campaignId] : null,
        deps.day,
        tz,
        defaultSort(deps.kind),
        0,
      ),
    );
  },
  component: ReportsIndex,
});

function ReportsIndex() {
  const { orgSlug } = Route.useParams();
  const { campaign: campaignParam, day: dayFilter, kind } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const shouldFade = useFadeOnce("/reports");
  const { session } = Route.useRouteContext();
  const tz = session?.user.displayTimezone ?? DEFAULT_DISPLAY_TIMEZONE;

  const { data: campaigns } = useSuspenseQuery(campaignsListQuery());
  const campaignOptions = campaignFilterOptions(campaigns);
  const campaignFilter = scopedCampaignId(campaignParam, campaigns);
  const campaignLabel =
    campaignFilter === null
      ? "All campaigns"
      : (campaignOptions.find((o) => o.value === campaignFilter)?.label ?? null);

  // The default order is a real column (each mode's timestamp, newest
  // first), so the Sort dropdown always shows a concrete selection. The
  // pick is keyed to its kind (the pager's scopeKey pattern): a kind
  // switch derives the reset in the same render — an eager setState
  // reset re-renders the outgoing kind against its cold-load cache, a
  // flash of the old table snapped back to default order.
  const [sortPick, setSortPick] = useState<{
    kind: ReportKind;
    sort: NonNullable<ReportSort>;
  } | null>(null);
  const sortableColumns = DISPLAY_COLUMNS[kind].filter((c) => c.sortKey);
  const activeSort = sortPick && sortPick.kind === kind ? sortPick.sort : defaultSort(kind);
  const sortLabel = sortableColumns.find((c) => c.sortKey === activeSort.key)?.label;

  // Any scope change starts back at the first page: the pager's offset
  // only survives while the rest of the query key is unchanged.
  const scopeKey = JSON.stringify([kind, campaignFilter, dayFilter, activeSort]);
  const [page, setPage] = useState({ key: scopeKey, offset: 0 });
  const offset = page.key === scopeKey ? page.offset : 0;
  const onPage = (next: number) => setPage({ key: scopeKey, offset: next });

  // Dim only while old data stands in for a new key (isPlaceholderData),
  // never during background refetches of correct data — the segments/
  // lookup convention.
  const { data, isPlaceholderData: stale } = useQuery(
    reportRowsQuery(
      kind,
      campaignFilter ? [campaignFilter] : null,
      dayFilter,
      tz,
      activeSort,
      offset,
    ),
  );

  const tableColumns = displayColumns(kind, data?.questionColumns ?? []);

  const dayOptions = (data?.days ?? []).map((d) => ({
    value: d,
    label: formatCanvassDay(d),
  }));
  const dayLabel =
    dayFilter === null
      ? "All dates"
      : (dayOptions.find((o) => o.value === dayFilter)?.label ?? null);

  const downloadHref = (format: "csv" | "parquet") => {
    const params = new URLSearchParams({ kind, format });
    if (campaignFilter) params.set("campaign", campaignFilter);
    if (dayFilter) {
      params.set("day", dayFilter);
      params.set("tz", tz);
    }
    params.set("sort", activeSort.key);
    params.set("dir", activeSort.dir);
    return `/api/web/${orgSlug}/report-export?${params.toString()}`;
  };

  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + (data?.rows.length ?? 0), total);

  return (
    <EditorPage className={cn("h-[calc(100vh-3.5rem)]", shouldFade)}>
      <EditorHeader title="Reports" subtitle="Browse and export detailed records">
        {/* No population filters here: segment-sense conditions on a row
            report read ambiguously (rows vs universe). Filters, when they
            come, filter rows — Date is the only one so far; add more only
            on real demand. */}
        {/* The trigger's leading icon carries the direction — on the
            dropdown it reads unambiguously as current state, unlike a
            glyph on the toggle button. */}
        <Filter
          icon={
            <Icon
              name={activeSort.dir === "desc" ? "arrow-down" : "arrow-up"}
              className="size-3.5"
            />
          }
          label={sortLabel ?? null}
          value={activeSort.key}
          options={sortableColumns.map((c) => ({ value: c.sortKey ?? "", label: c.label }))}
          allLabel={null}
          onChange={(next) => {
            if (next === null) return;
            const col = sortableColumns.find((c) => c.sortKey === next);
            setSortPick({ kind, sort: { key: next, dir: col?.defaultDir ?? "asc" } });
          }}
        />
        {/* Static icon: a direction glyph reads ambiguously (current state
            vs what a click does) — toggle and let the data show it. */}
        <Button
          variant="outline"
          size="icon"
          aria-label="Toggle sort direction"
          onClick={() =>
            setSortPick({
              kind,
              sort: { ...activeSort, dir: activeSort.dir === "asc" ? "desc" : "asc" },
            })
          }
        >
          <Icon name="arrow-down-up" className="size-3.5" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" />}>
            <Icon name="download" className="size-3.5" />
            Export
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => (window.location.href = downloadHref("csv"))}>
              CSV
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => (window.location.href = downloadHref("parquet"))}>
              Parquet
            </DropdownMenuItem>
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
          // not exist in the new campaign.
          onChange={(next) =>
            void navigate({ search: (prev) => ({ ...prev, campaign: next ?? "all", day: null }) })
          }
        />
        {/* Rightmost = outermost: the report type is the frame everything
            else scopes down. */}
        <Filter
          icon={<Icon name="files" className="size-3.5" />}
          label={KIND_OPTIONS.find((o) => o.value === kind)?.label ?? null}
          value={kind}
          options={KIND_OPTIONS}
          allLabel={null}
          // Mode switches reset the day filter (each mode derives its own
          // day list, so a carried day can silently filter the new mode
          // to nothing); the sort resets by derivation — sortPick is
          // keyed to its kind, so no state write happens here.
          onChange={(next) => {
            if (isReportKind(next)) {
              void navigate({ search: (prev) => ({ ...prev, kind: next, day: null }) });
            }
          }}
        />
      </EditorHeader>
      {data ? (
        <div className="flex min-h-0 flex-1 gap-4">
          <SummaryRail kind={kind} total={total} summary={data.summary} stale={stale} />
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card">
            {total === 0 ? (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                {kind === "walks"
                  ? "No walks in this scope"
                  : kind === "canvassers"
                    ? "No canvassers in this scope"
                    : "No canvass results in this scope"}
              </div>
            ) : (
              // px-2 on the scroll region + px-2 cells = text lands at the
              // card's 16px inset while the row-hover pill starts 8px in,
              // matching the lookup list's rounded inset highlight.
              <div
                className={cn("min-h-0 flex-1 px-2 pt-2 transition-opacity", stale && "opacity-60")}
              >
                <Table
                  containerClassName="h-full overflow-y-auto"
                  className="table-fixed [&_tr>th:first-child]:pl-2 [&_tr>td:first-child]:pl-2"
                  style={{ width: `${tableColumns.reduce((w, c) => w + c.width, 0)}rem` }}
                >
                  <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-card [&_th]:h-8">
                    <TableRow>
                      {tableColumns.map((col) => (
                        <TableHead
                          key={col.label}
                          className="truncate"
                          style={{ width: `${col.width}rem` }}
                          // Tooltip only when the header actually truncates
                          // (long question names).
                          onMouseEnter={(e) => {
                            const el = e.currentTarget;
                            if (el.scrollWidth > el.clientWidth) el.title = col.label;
                            else el.removeAttribute("title");
                          }}
                        >
                          {col.label}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {records(data).map((record, ri) => (
                      // Row hover as a reading aid (like the lookup list),
                      // not interactivity — it tracks a row across a wide
                      // horizontal scroll. Backgrounds live on the cells so
                      // the pill's end caps can round.
                      <TableRow key={ri} className="group">
                        {tableColumns.map((col) => {
                          const value = col.value(record);
                          const style = col.style?.(record);
                          return (
                            <TableCell
                              key={col.label}
                              className={cn(
                                "truncate px-2 whitespace-nowrap",
                                "group-hover:bg-muted/50 first:rounded-l-md last:rounded-r-md",
                                col.numeric && "tabular-nums",
                                style && "badge-fg",
                              )}
                              style={style}
                              // Tooltip only when the cell actually truncates.
                              onMouseEnter={(e) => {
                                const el = e.currentTarget;
                                if (el.scrollWidth > el.clientWidth) el.title = value;
                                else el.removeAttribute("title");
                              }}
                            >
                              {value}
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            <div className="flex h-11 shrink-0 items-center justify-between border-t border-border px-4 text-sm text-muted-foreground">
              <span className={cn("transition-opacity", stale && "opacity-60")}>
                {total.toLocaleString()} row{total === 1 ? "" : "s"}
              </span>
              {total > REPORT_PAGE_ROWS ? (
                <div className="flex items-center gap-2">
                  <span>
                    {from.toLocaleString()}–{to.toLocaleString()}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={offset === 0}
                    onClick={() => onPage(Math.max(0, offset - REPORT_PAGE_ROWS))}
                  >
                    <Icon name="chevron-left" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={offset + REPORT_PAGE_ROWS >= total}
                    onClick={() => onPage(offset + REPORT_PAGE_ROWS)}
                  >
                    <Icon name="chevron-right" />
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </EditorPage>
  );
}

// VAN-style totals rail: an accounting of the extract itself (Results
// owns population analysis). Counts only, no rates; the bars reuse the
// segment cascade's fill language. Responses bars = answers per person
// in the file (completion, not persuasion); attempts bars = share of
// attempts by outcome.
function SummaryRail({
  kind,
  total,
  summary,
  stale,
}: {
  kind: ReportKind;
  total: number;
  summary: ReportSummary;
  stale: boolean;
}) {
  const totals: [string, number][] =
    kind === "walks"
      ? [
          ["Walks", total],
          ["Canvassers", summary.canvassers ?? 0],
          ["Turfs", summary.turfs ?? 0],
          ["Attempts", summary.attempts ?? 0],
          ["Contacts", summary.contacts ?? 0],
        ]
      : kind === "canvassers"
        ? [
            ["Canvassers", total],
            ["Walks", summary.walks ?? 0],
            ["Attempts", summary.attempts ?? 0],
            ["Contacts", summary.contacts ?? 0],
          ]
        : kind === "people"
          ? // Current-state only: the outcome bars below carry the
            // breakdown (Canvassed there = people currently canvassed);
            // historical contact counts live in the Contacts column and
            // the Attempts/Responses reports.
            [["People", total]]
          : [
              [kind === "responses" ? "Responses" : "Attempts", total],
              ["People", summary.people ?? 0],
            ];

  const bars =
    kind === "responses"
      ? (summary.questions ?? []).map((q) => ({
          label: q.label,
          count: q.count,
          // Multi-selects can push a question past one answer per person.
          fraction: summary.people ? Math.min(q.count / summary.people, 1) : 0,
        }))
      : kind === "attempts" || kind === "people"
        ? // Attempts: share of attempts by outcome. People: share of
          // people by current state — the two agree only when nobody was
          // re-attempted.
          orderedOutcomes(summary.outcomes ?? {}).map(([key, n]) => ({
            label: OUTCOME_LABELS.get(key) ?? key,
            count: n,
            fraction: total ? n / total : 0,
          }))
        : [];

  return (
    <div
      className={cn("flex w-64 shrink-0 flex-col gap-4 transition-opacity", stale && "opacity-60")}
    >
      <ReportCard>
        <div className="flex h-10 items-center text-sm font-semibold">Summary</div>
        {totals.map(([label, value]) => (
          <div key={label} className="flex h-10 items-center justify-between text-sm">
            <span>{label}</span>
            <span className="text-muted-foreground tabular-nums">{value.toLocaleString()}</span>
          </div>
        ))}
      </ReportCard>
      {bars.length > 0 ? (
        // Stretches so its bottom edge lines up with the table card; the
        // flex-1 filler leaves the space below the last bar empty. The
        // bars separate the rows themselves — no hairlines.
        <ReportCard className="flex min-h-0 flex-1 flex-col overflow-hidden" divided={false}>
          <div className="flex h-10 shrink-0 items-center text-sm font-semibold">
            {kind === "responses" ? "Questions" : "Outcomes"}
          </div>
          {bars.map((b) => (
            <div key={b.label} className="shrink-0 py-2">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{b.label}</span>
                <span className="text-muted-foreground tabular-nums">
                  {b.count.toLocaleString()}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-foreground/30"
                  style={{ width: `${Math.round(100 * b.fraction)}%` }}
                />
              </div>
            </div>
          ))}
          <div className="flex-1" />
        </ReportCard>
      ) : null}
    </div>
  );
}

// Canonical outcome order first, anything unexpected after by count.
function orderedOutcomes(outcomes: Record<string, number>): [string, number][] {
  const known = CANVASS_OUTCOME_OPTIONS.map((o) => o.value).filter((v) => v in outcomes);
  const extras = Object.keys(outcomes)
    .filter((k) => !known.includes(k))
    .sort((a, b) => (outcomes[b] ?? 0) - (outcomes[a] ?? 0));
  return [...known, ...extras].map((k) => [k, outcomes[k] ?? 0]);
}

type ReportRecord = Record<string, string | number | null>;

// Zip the wire's parallel columns/rows into keyed records — the display
// specs pick from these; downloads carry the full column set.
function records(data: { columns: string[]; rows: (string | number | null)[][] }): ReportRecord[] {
  return data.rows.map((row) =>
    Object.fromEntries(data.columns.map((c, i) => [c, row[i] ?? null])),
  );
}

function text(value: string | number | null | undefined): string {
  return value == null || value === "" ? "—" : String(value);
}

function personName(r: ReportRecord): string {
  return (
    formatPersonName(
      r.first_name as string | null,
      r.middle_name as string | null,
      r.last_name as string | null,
      r.name_suffix as string | null,
    ) || "—"
  );
}

// Full mailing line minus zip4: "123 Main St, Apt 2, Brooklyn, NY 11215".
function personAddress(r: ReportRecord): string {
  const street = [toTitleCase(String(r.address_line_1 ?? "")), r.address_line_2]
    .filter(Boolean)
    .join(", ");
  const place = [toTitleCase(String(r.city ?? "")), [r.state, r.zip5].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  return [street, place].filter(Boolean).join(", ") || "—";
}

const OUTCOME_LABELS = new Map(CANVASS_OUTCOME_OPTIONS.map((o) => [o.value, o.label]));

// "2026-08-23 14:00" (server-formatted in the display timezone) →
// "08/23/26 02:00 PM", matching formatDateTime. String-parsed so the
// browser's own timezone can't shift it.
function formatStamp(value: string | number | null): string {
  if (typeof value !== "string") return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!m) return value;
  const hour = Number(m[4]);
  const meridiem = hour >= 12 ? "PM" : "AM";
  const clock = hour % 12 === 0 ? 12 : hour % 12;
  return `${m[2]}/${m[3]}/${m[1].slice(2)} ${String(clock).padStart(2, "0")}:${m[5]} ${meridiem}`;
}

// Width in rem; `numeric` renders tabular figures. Column objects are
// shared across kinds so the same column is the same width on every tab,
// and the table is fixed-layout at the summed width — no per-view or
// per-page reflow. `sortKey` is the server's allowlisted sort key —
// deliberately sparse (name, timestamps, question); add keys only when a
// real need appears, the server allowlist already covers more. `defaultDir`
// is the direction a fresh pick starts in — timestamps newest-first,
// text A→Z.
type DisplayColumn = {
  label: string;
  width: number;
  numeric?: boolean;
  sortKey?: string;
  defaultDir?: "asc" | "desc";
  value: (r: ReportRecord) => string;
  style?: (r: ReportRecord) => CSSProperties | undefined;
};

// Rates arrive as percent numbers (e.g. 22.6) or null when the
// denominator is missing.
function percent(value: string | number | null): string {
  return value == null ? "—" : `${value}%`;
}

// Shared shape for count/rate columns: tabular figures, unsorted.
function count(key: string) {
  return {
    numeric: true as const,
    value: (r: ReportRecord) => text(r[key]),
  };
}

function stampColumn(label: string, key: string): DisplayColumn {
  return {
    label,
    width: 11,
    numeric: true,
    sortKey: key,
    defaultDir: "desc",
    value: (r) => formatStamp(r[key] ?? null),
  };
}

const NAME_COLUMN: DisplayColumn = { label: "Name", width: 11, sortKey: "name", value: personName };
const ADDRESS_COLUMN: DisplayColumn = { label: "Address", width: 24, value: personAddress };
const CANVASSER_COLUMN: DisplayColumn = {
  label: "Canvasser",
  width: 11,
  value: (r) => text(r.canvasser),
};
const TURF_COLUMN: DisplayColumn = {
  label: "Turf",
  width: 6,
  numeric: true,
  value: (r) => text(r.turf),
};
const ZONE_COLUMN: DisplayColumn = { label: "Zone", width: 8, value: (r) => text(r.zone) };
const CAMPAIGN_COLUMN: DisplayColumn = {
  label: "Campaign",
  width: 10,
  value: (r) => text(r.campaign),
};
const OUTCOME_COLUMN: DisplayColumn = {
  label: "Outcome",
  width: 7,
  value: (r) => OUTCOME_LABELS.get(String(r.outcome)) ?? text(r.outcome),
};
const PERSON_ID_COLUMNS: DisplayColumn[] = [
  { label: "Person ID", width: 14, numeric: true, value: (r) => text(r.external_id) },
  { label: "Person ID type", width: 8, value: (r) => text(r.external_id_type) },
];
const CONTACT_RATE_COLUMN: DisplayColumn = {
  label: "Contact rate",
  width: 7,
  sortKey: "contact_rate",
  defaultDir: "desc",
  ...count("contact_rate"),
  value: (r) => percent(r.contact_rate),
  // Results' pink -> purple -> blue scale over its 0-20% domain, so a
  // given rate reads as the same color on both pages.
  style: (r) =>
    r.contact_rate == null
      ? undefined
      : tintStyle(rateColor(Math.min(Number(r.contact_rate) / 100 / CONTACT_RATE_MAX, 1))),
};
const WALK_ID_COLUMN: DisplayColumn = {
  label: "Walk ID",
  width: 13,
  numeric: true,
  value: (r) => text(r.walk_id),
};

// Column grammar, every kind: the row's own facts (when → what → who) →
// the person (when the row has one) → measures → question columns →
// place lookups → keys. People is the person, so it opens with
// Name/Address and interleaves measures with their recency stamps.
const DISPLAY_COLUMNS: Record<ReportKind, DisplayColumn[]> = {
  people: [
    NAME_COLUMN,
    ADDRESS_COLUMN,
    { label: "Attempts", width: 6, sortKey: "attempts", defaultDir: "desc", ...count("attempts") },
    { label: "Contacts", width: 6, sortKey: "contacts", defaultDir: "desc", ...count("contacts") },
    stampColumn("Last attempt", "last_attempt_at"),
    stampColumn("Last contact", "last_contact_at"),
    {
      label: "Last outcome",
      width: 8,
      sortKey: "last_outcome",
      value: (r) => OUTCOME_LABELS.get(String(r.last_outcome)) ?? text(r.last_outcome),
    },
    // Question columns (the latest snapshot's answers) splice in here.
    // No turf/zone: those are event detail — the Attempts report answers
    // "where". Campaign labels which pass's truth the row carries.
    CAMPAIGN_COLUMN,
    ...PERSON_ID_COLUMNS,
  ],
  responses: [
    NAME_COLUMN,
    { label: "Question", width: 12, sortKey: "question", value: (r) => text(r.question) },
    { label: "Answer", width: 10, value: (r) => text(r.answer) },
    CANVASSER_COLUMN,
    stampColumn("Contacted at", "contacted_at"),
    ADDRESS_COLUMN,
    TURF_COLUMN,
    ZONE_COLUMN,
    CAMPAIGN_COLUMN,
    ...PERSON_ID_COLUMNS,
    { label: "Question ID", width: 13, numeric: true, value: (r) => text(r.question_id) },
    { label: "Response option ID", width: 13, numeric: true, value: (r) => text(r.option_id) },
  ],
  attempts: [
    stampColumn("Attempted at", "attempted_at"),
    OUTCOME_COLUMN,
    CANVASSER_COLUMN,
    NAME_COLUMN,
    ADDRESS_COLUMN,
    // Question columns (this attempt's snapshot) splice in here.
    TURF_COLUMN,
    ZONE_COLUMN,
    CAMPAIGN_COLUMN,
    ...PERSON_ID_COLUMNS,
    WALK_ID_COLUMN,
  ],
  walks: [
    // The turf is the walk's identity (a walk is a sign-out OF a turf),
    // so it leads as the row's "what"; zone/campaign stay generic place.
    TURF_COLUMN,
    { label: "Turf code", width: 7, numeric: true, value: (r) => text(r.turf_code) },
    stampColumn("Opened at", "opened_at"),
    // Walks rarely get closed, so the last attributed event stands in for
    // "when this walk actually wound down" (closed at is download-only).
    stampColumn("Last activity", "last_activity_at"),
    CANVASSER_COLUMN,
    CONTACT_RATE_COLUMN,
    {
      label: "Progress",
      width: 7,
      sortKey: "progress",
      defaultDir: "desc",
      ...count("progress"),
      value: (r) => percent(r.progress),
      // RYG text, badge-free — turf-board thresholds, darkened through the
      // badge foreground math (badge-fg applies wherever `style` is set).
      style: (r) => (r.progress == null ? undefined : tintStyle(progressColor(Number(r.progress)))),
    },
    { label: "People", width: 6, ...count("people") },
    { label: "Doors", width: 6, ...count("doors") },
    { label: "Attempts", width: 6, ...count("attempts") },
    { label: "Contacts", width: 6, ...count("contacts") },
    ZONE_COLUMN,
    CAMPAIGN_COLUMN,
    WALK_ID_COLUMN,
  ],
  canvassers: [
    { label: "Canvasser", width: 11, sortKey: "canvasser", value: (r) => text(r.canvasser) },
    { label: "Walks", width: 6, sortKey: "walks", defaultDir: "desc", ...count("walks") },
    stampColumn("First active", "first_active_at"),
    stampColumn("Last active", "last_active_at"),
    CONTACT_RATE_COLUMN,
    { label: "Attempts", width: 6, sortKey: "attempts", defaultDir: "desc", ...count("attempts") },
    { label: "Contacts", width: 6, ...count("contacts") },
    { label: "Phone", width: 9, numeric: true, value: (r) => text(r.phone) },
  ],
};

// Question columns come from the data (they vary with campaign scope);
// each snapshot-carrying kind declares its splice point in the grammar —
// people after the state columns, attempts after the person.
const QUESTION_SPLICE: Partial<Record<ReportKind, string>> = {
  people: "Last outcome",
  attempts: "Address",
};

function displayColumns(kind: ReportKind, questionColumns: string[]): DisplayColumn[] {
  const after = QUESTION_SPLICE[kind];
  if (!after || questionColumns.length === 0) return DISPLAY_COLUMNS[kind];
  const base = DISPLAY_COLUMNS[kind];
  const at = base.findIndex((c) => c.label === after) + 1;
  const generated = questionColumns.map(
    (q): DisplayColumn => ({ label: q, width: 12, value: (r) => text(r[q]) }),
  );
  return [...base.slice(0, at), ...generated, ...base.slice(at)];
}
