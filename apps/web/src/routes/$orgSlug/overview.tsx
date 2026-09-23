import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, type ReactNode } from "react";
import { EditorHeader } from "~/components/editor-header";
import { Page } from "~/components/page";
import { defaultCampaignId } from "~/lib/campaign-options";
import { DEFAULT_DISPLAY_TIMEZONE } from "~/lib/timezones";
import { useFadeOnce } from "~/lib/use-fade-once";
import { cn } from "~/lib/utils";
import { campaignsListQuery } from "~/lib/queries/campaigns";
import { progressByZoneQuery } from "~/lib/queries/progress";
import { resultsAggregateQuery, resultsEventsVersionQuery } from "~/lib/queries/results";
import { segmentsListQuery } from "~/lib/queries/segments";
import { scriptsListQuery } from "~/lib/queries/scripts";
import { turfsCountQuery } from "~/lib/queries/turfs";

export const Route = createFileRoute("/$orgSlug/overview")({
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
  "flex flex-col gap-1 rounded-lg border border-border bg-card p-3.5",
  "transition-colors hover:bg-accent",
);

function Overview() {
  const shouldFade = useFadeOnce("/overview");
  const { orgSlug } = Route.useParams();
  const { session } = Route.useRouteContext();
  const tz = session?.user.displayTimezone ?? DEFAULT_DISPLAY_TIMEZONE;
  const { data: campaigns } = useQuery(campaignsListQuery());
  const { data: segments } = useQuery(segmentsListQuery());
  const { data: scripts } = useQuery(scriptsListQuery());
  const { data: turfCount } = useQuery(turfsCountQuery());

  // The campaign Progress and Results open on by default.
  const campaign = useMemo(() => {
    if (!campaigns) return null;
    const id = defaultCampaignId(campaigns);
    return campaigns.find((c) => c.campaignId === id) ?? null;
  }, [campaigns]);
  const { data: progressRows } = useQuery(progressByZoneQuery());
  const progress = useMemo(() => {
    if (!progressRows || !campaign) return null;
    const out = { zones: 0, turfs: 0, used: 0 };
    // One row per zone; a zoneless campaign's full segment counts as one.
    for (const r of progressRows) {
      if (r.campaignId !== campaign.campaignId) continue;
      out.zones += 1;
      out.turfs += r.turfs;
      out.used += r.used;
    }
    return out;
  }, [progressRows, campaign]);
  // Same keys as the Results loader, so the two share a cache.
  const { data: eventsVersion } = useQuery({
    ...resultsEventsVersionQuery(campaign ? [campaign.campaignId] : null),
    enabled: campaign !== null,
  });
  const { data: aggregate } = useQuery({
    ...resultsAggregateQuery(
      campaign ? [campaign.campaignId] : null,
      null,
      tz,
      [],
      eventsVersion?.version,
    ),
    enabled: campaign !== null && eventsVersion !== undefined,
  });
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
      <EditorHeader title="Overview" subtitle="Everything at a glance" />
      {/* Gate on data so the numbers fade in once with real values rather than
          flashing 0 first — notably on org switch, where the org-scoped query
          key resolves a frame late. Keyed on orgSlug so the fade re-fires per org. */}
      {campaigns && segments && scripts && turfCount != null ? (
        <div
          key={orgSlug}
          className="grid grid-cols-2 gap-4 lg:grid-cols-4 animate-in fade-in duration-100"
        >
          {[
            { label: "Campaigns", count: active(campaigns), to: "/$orgSlug/campaigns" },
            { label: "Segments", count: active(segments), to: "/$orgSlug/segments" },
            { label: "Turfs", count: turfCount, to: "/$orgSlug/turfs" },
            { label: "Scripts", count: active(scripts), to: "/$orgSlug/scripts" },
          ].map((card) => (
            <Link key={card.label} to={card.to} params={{ orgSlug }} className={cardClass}>
              <CardBadge>Total</CardBadge>
              <Stat value={card.count} label={card.label} />
            </Link>
          ))}
          {/* Gated separately: the results reduction is the slow one. */}
          {campaign && progress ? (
            <Link
              to="/$orgSlug/progress"
              params={{ orgSlug }}
              search={{ campaign: null, zones: null }}
              className={cn(cardClass, "col-span-2 animate-in fade-in duration-100")}
            >
              <CardBadge>{campaign.name}</CardBadge>
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
          {campaign && results ? (
            <Link
              to="/$orgSlug/results"
              params={{ orgSlug }}
              search={{ campaign: null, day: null }}
              className={cn(cardClass, "col-span-2 animate-in fade-in duration-100")}
            >
              <CardBadge>{campaign.name}</CardBadge>
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

// Corner scope label: "Total" or the campaign name.
function CardBadge({ children }: { children: ReactNode }) {
  return (
    <span
      className={cn(
        "mb-1 max-w-full self-end truncate rounded px-1.5 py-0.5",
        "bg-muted text-xs font-medium text-muted-foreground",
      )}
    >
      {children}
    </span>
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
