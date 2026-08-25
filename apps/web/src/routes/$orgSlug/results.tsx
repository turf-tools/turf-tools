import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { interpolateYlGnBu } from "d3-scale-chromatic";
import { type CSSProperties, type ReactNode, useMemo, useState } from "react";
import { Button } from "~/components/button";
import { EditorHeader } from "~/components/editor-header";
import { EditorPage } from "~/components/editor-page";
import { Filter } from "~/components/filter";
import { Icon } from "~/components/icon";
import { Map as MapView } from "~/components/map";
import { campaignsListQuery } from "~/lib/queries/campaigns";
import { questionsWithOptionsQuery } from "~/lib/queries/questions";
import { resultsAggregateQuery, zonePerimetersQuery } from "~/lib/queries/results";
import { DEFAULT_DISPLAY_TIMEZONE } from "~/lib/timezones";
import { useFadeOnce } from "~/lib/use-fade-once";
import { cn } from "~/lib/utils";
import type { ZoneFunnelRow } from "~/rpc/web/results";

type ResultsSearch = {
  campaign: string | null;
  day: string | null;
};

// One metric today (contact rate); per-question persuasion metrics are
// the planned additions — the dropdown returns when there are two.
function rateOf(row: ZoneFunnelRow): number | null {
  if (row.attempted === 0) return null;
  return row.contacted / row.attempted;
}

export const Route = createFileRoute("/$orgSlug/results")({
  validateSearch: (search): ResultsSearch => ({
    campaign: typeof search.campaign === "string" ? search.campaign : null,
    day: typeof search.day === "string" ? search.day : null,
  }),
  loaderDeps: ({ search }) => ({ campaign: search.campaign, day: search.day }),
  loader: async ({ context: { queryClient, session }, deps }) => {
    const tz = session?.user.displayTimezone ?? DEFAULT_DISPLAY_TIMEZONE;
    await Promise.all([
      queryClient.fetchQuery(campaignsListQuery()),
      queryClient.fetchQuery(
        resultsAggregateQuery(deps.campaign ? [deps.campaign] : null, deps.day, tz),
      ),
    ]);
  },
  component: ResultsIndex,
});

function ResultsIndex() {
  const { campaign: campaignFilter, day: dayFilter } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const shouldFade = useFadeOnce("/results");
  const { session } = Route.useRouteContext();
  const tz = session?.user.displayTimezone ?? DEFAULT_DISPLAY_TIMEZONE;
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);

  const { data: campaigns } = useSuspenseQuery(campaignsListQuery());
  const current = campaigns.filter((c) => !c.isArchived);
  const campaignOptions = current.map((c) => ({ value: c.campaignId, label: c.name }));
  const campaignLabel =
    campaignFilter === null
      ? "All campaigns"
      : (campaignOptions.find((o) => o.value === campaignFilter)?.label ?? null);

  const { data: aggregate } = useSuspenseQuery(
    resultsAggregateQuery(campaignFilter ? [campaignFilter] : null, dayFilter, tz),
  );

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

  // Color each zone by the selected rate on the same absolute 0-100%
  // YlGnBu scale as the badges, so a zone's fill and its badges agree.
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
              ? { color: interpolateYlGnBu(rate), opacity: 0.6 }
              : { opacity: 0.06 }),
          },
        };
      }),
    };
  }, [perimeters, byZone]);

  const fitBounds = useMemo(
    () => (coloredPerimeters ? bboxOfFeatures(coloredPerimeters.features) : null),
    [coloredPerimeters],
  );

  const selectedRow = selectedZoneId ? (byZone.get(selectedZoneId) ?? null) : null;
  const scope = selectedRow ?? sumRows(aggregate.rows);

  return (
    <EditorPage className={cn("h-[calc(100vh-3.5rem)]", shouldFade)}>
      <EditorHeader title="Results">
        {/* Static mock of header filter chips — unwired, judging layout.
            Add opens a modal; each added filter lives here as a chip. */}
        <Button variant="outline" className="max-w-56 min-w-0 shrink">
          <span className="truncate">Zohran support</span>
          <Icon name="x" className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
        <Button variant="outline" className="max-w-56 min-w-0 shrink">
          <span className="truncate">Age</span>
          <Icon name="x" className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
        <Button variant="outline">
          <Icon name="funnel" className="size-3.5" />
          Add filter
        </Button>
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
            void navigate({ search: (prev) => ({ ...prev, campaign: next, day: null }) })
          }
        />
      </EditorHeader>
      <div className="flex min-h-0 flex-1 gap-6">
        <div className="flex w-104 shrink-0 flex-col gap-4 overflow-y-auto pb-4">
          <FunnelPanel
            scope={scope}
            targeted={selectedRow ? selectedRow.targeted : aggregate.targeted}
          />
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
    targeted: null,
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

// Rate badges share the map's YlGnBu scale (rates are 0–100%) at the
// map's fill opacity; ink flips light/dark by background luminance.
function rateBadgeStyle(rate: number): CSSProperties {
  const [r, g, b] = (interpolateYlGnBu(rate).match(/\d+/g) ?? ["0", "0", "0"]).map(Number);
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

function CountCell({ count, rate }: { count: number; rate: number | null }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="font-mono text-sm tabular-nums">{count.toLocaleString()}</span>
      {rate !== null ? (
        <span
          className="rounded px-1.5 py-0.5 font-mono text-sm tabular-nums"
          style={rateBadgeStyle(rate)}
        >
          {(100 * rate).toFixed(1)}%
        </span>
      ) : null}
    </span>
  );
}

const FUNNEL_GRID = "grid grid-cols-2 items-center gap-2";

function FunnelPanel({ scope, targeted }: { scope: ZoneFunnelRow; targeted: number | null }) {
  const stages: Array<{ label: string; count: number; denom: number | null }> = [
    ...(targeted !== null ? [{ label: "Targeted", count: targeted, denom: null }] : []),
    { label: "Attempted", count: scope.attempted, denom: targeted },
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
          <CountCell count={s.count} rate={rateOrNull(s.count, s.denom)} />
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
            <div className="grid h-10 grid-cols-2 items-center gap-2 text-sm">
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
                    className="grid h-10 grid-cols-2 items-center gap-2"
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

function bboxOfFeatures(features: GeoJSON.Feature[]): [number, number, number, number] | null {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  const visit = (coords: unknown) => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number" && typeof coords[1] === "number") {
      minLng = Math.min(minLng, coords[0] as number);
      maxLng = Math.max(maxLng, coords[0] as number);
      minLat = Math.min(minLat, coords[1] as number);
      maxLat = Math.max(maxLat, coords[1] as number);
      return;
    }
    for (const c of coords) visit(c);
  };
  for (const f of features) {
    if ("coordinates" in f.geometry) visit(f.geometry.coordinates);
  }
  if (!Number.isFinite(minLng)) return null;
  return [minLng, minLat, maxLng, maxLat];
}
