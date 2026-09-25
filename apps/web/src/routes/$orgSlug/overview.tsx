import { createFileRoute, Link } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { EditorHeader } from "~/components/editor-header";
import { Filter } from "~/components/filter";
import { Icon } from "~/components/icon";
import { Page } from "~/components/page";
import { campaignFilterOptions, scopedCampaignId } from "~/lib/campaign-options";
import { DEFAULT_DISPLAY_TIMEZONE } from "~/lib/timezones";
import { useFadeOnce } from "~/lib/use-fade-once";
import { cn } from "~/lib/utils";
import { campaignsListQuery } from "~/lib/queries/campaigns";
import { progressByZoneQuery } from "~/lib/queries/progress";
import { resultsAggregateQuery, resultsEventsVersionQuery } from "~/lib/queries/results";
import { segmentsListQuery } from "~/lib/queries/segments";
import { scriptsListQuery } from "~/lib/queries/scripts";
import { turfsCountQuery } from "~/lib/queries/turfs";

// Optional: redirects and nav links land here without a campaign.
type OverviewSearch = { campaign?: string };

export const Route = createFileRoute("/$orgSlug/overview")({
  validateSearch: (search): OverviewSearch =>
    typeof search.campaign === "string" ? { campaign: search.campaign } : {},
  // Fresh state per org: the results placeholder and the shown campaign
  // would otherwise carry across the switch.
  remountDeps: ({ params }) => ({ orgSlug: params.orgSlug }),
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      queryClient.fetchQuery(campaignsListQuery()),
      queryClient.fetchQuery(segmentsListQuery()),
      queryClient.fetchQuery(scriptsListQuery()),
      queryClient.fetchQuery(turfsCountQuery()),
      queryClient.fetchQuery(progressByZoneQuery()),
    ]);
  },
  component: Overview,
});

// Lists include archived rows (for the rails' toggle); count only active.
const active = (rows: ReadonlyArray<{ isArchived: boolean }>) =>
  rows.filter((r) => !r.isArchived).length;

const cardClass = cn(
  "flex flex-col gap-1 rounded-lg border border-border bg-card p-4",
  "transition-colors hover:bg-accent",
);

function Overview() {
  const shouldFade = useFadeOnce("/overview");
  const { orgSlug } = Route.useParams();
  const campaignParam = Route.useSearch().campaign ?? null;
  const navigate = Route.useNavigate();
  const { session } = Route.useRouteContext();
  const tz = session?.user.displayTimezone ?? DEFAULT_DISPLAY_TIMEZONE;
  const { data: campaigns } = useQuery(campaignsListQuery());
  const { data: segments } = useQuery(segmentsListQuery());
  const { data: scripts } = useQuery(scriptsListQuery());
  const { data: turfCount } = useQuery(turfsCountQuery());

  // One campaign, like Progress: null floats to the newest. Null here
  // only when the org has no campaigns.
  const campaignFilter = campaigns ? scopedCampaignId(campaignParam, campaigns) : null;
  const campaignLabel = campaigns?.find((c) => c.campaignId === campaignFilter)?.name ?? null;
  // Same keys as the Results loader, so the two share a cache.
  const campaignIds = campaignFilter ? [campaignFilter] : null;
  const { data: eventsVersion, isPlaceholderData: versionStale } = useQuery({
    ...resultsEventsVersionQuery(campaignIds),
    enabled: campaignFilter !== null,
    placeholderData: keepPreviousData,
  });
  const { data: aggregate, isPlaceholderData: aggregateStale } = useQuery({
    ...resultsAggregateQuery(campaignIds, null, tz, [], eventsVersion?.version),
    enabled: campaignFilter !== null && eventsVersion !== undefined && !versionStale,
    placeholderData: keepPreviousData,
  });
  // Both cards switch together, once the new results are in.
  const [shownCampaign, setShownCampaign] = useState<string | null>(null);
  if (aggregate && !versionStale && !aggregateStale && shownCampaign !== campaignFilter) {
    setShownCampaign(campaignFilter);
  }
  const { data: progressRows } = useQuery(progressByZoneQuery());
  const progress = useMemo(() => {
    if (!progressRows || !shownCampaign) return null;
    const out = { zones: 0, turfs: 0, used: 0 };
    // One row per zone with published turfs; a full segment is one zone.
    for (const r of progressRows) {
      if (r.campaignId !== shownCampaign) continue;
      out.zones += 1;
      out.turfs += r.turfs;
      out.used += r.used;
    }
    return out;
  }, [progressRows, shownCampaign]);
  const results = useMemo(() => {
    if (!aggregate) return null;
    const out = { attempted: 0, contacted: 0 };
    for (const r of aggregate.rows) {
      out.attempted += r.attempted;
      out.contacted += r.contacted;
    }
    return out;
  }, [aggregate]);

  return (
    <Page className={shouldFade}>
      <EditorHeader title="Overview" subtitle="Everything at a glance">
        {campaigns && campaignFilter ? (
          <Filter
            icon={<Icon name="megaphone" className="size-3.5" />}
            label={campaignLabel}
            value={campaignFilter}
            options={campaignFilterOptions(campaigns)}
            allLabel={null}
            onChange={(next) => void navigate({ search: { campaign: next ?? undefined } })}
          />
        ) : null}
      </EditorHeader>
      {/* Gate on data so the numbers fade in once with real values rather than
          flashing 0 first — notably on org switch, where the org-scoped query
          key resolves a frame late. */}
      {campaigns && segments && scripts && turfCount != null ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 animate-in fade-in duration-100">
          {[
            { label: "Campaigns", count: active(campaigns), to: "/$orgSlug/campaigns" },
            { label: "Segments", count: active(segments), to: "/$orgSlug/segments" },
            { label: "Turfs", count: turfCount, to: "/$orgSlug/turfs" },
            { label: "Scripts", count: active(scripts), to: "/$orgSlug/scripts" },
          ].map((card) => (
            <Link key={card.label} to={card.to} params={{ orgSlug }} className={cardClass}>
              <Stat value={card.count} label={card.label} />
            </Link>
          ))}
          {/* The pair waits on the results reduction, then appears together. */}
          {progress ? (
            <Link
              to="/$orgSlug/progress"
              params={{ orgSlug }}
              search={{ campaign: campaignParam, zones: null }}
              className={cn(cardClass, "col-span-2 animate-in fade-in duration-100")}
            >
              <div className="flex gap-4">
                <Stat value={progress.zones} label="Zones" />
                <Stat
                  value={progress.turfs - progress.used}
                  secondary={`of ${progress.turfs.toLocaleString()}`}
                  label="Turfs remaining"
                />
              </div>
            </Link>
          ) : null}
          {results ? (
            <Link
              to="/$orgSlug/results"
              params={{ orgSlug }}
              search={{ campaign: campaignParam, day: null }}
              className={cn(cardClass, "col-span-2 animate-in fade-in duration-100")}
            >
              <div className="flex gap-4">
                <Stat value={results.attempted} label="People attempted" />
                <Stat
                  value={results.contacted}
                  secondary={
                    results.attempted > 0
                      ? `(${Math.round((100 * results.contacted) / results.attempted)}%)`
                      : undefined
                  }
                  label="People canvassed"
                />
              </div>
            </Link>
          ) : null}
        </div>
      ) : null}
    </Page>
  );
}

// A count with an optional muted qualifier ("of 28", "(32%)").
function Stat({ value, secondary, label }: { value: number; secondary?: string; label: string }) {
  return (
    <div className="flex flex-1 flex-col gap-1">
      <span className="text-3xl font-semibold">
        {value.toLocaleString()}
        {secondary ? <span className="text-xl text-muted-foreground"> {secondary}</span> : null}
      </span>
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  );
}
