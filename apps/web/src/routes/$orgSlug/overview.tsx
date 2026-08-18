import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Page } from "~/components/page";
import { useFadeOnce } from "~/lib/use-fade-once";
import { cn } from "~/lib/utils";
import { campaignsListQuery } from "~/lib/queries/campaigns";
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
    ]);
  },
  component: Overview,
});

function Overview() {
  const shouldFade = useFadeOnce("/overview");
  const { orgSlug } = Route.useParams();
  const { data: campaigns } = useQuery(campaignsListQuery());
  const { data: segments } = useQuery(segmentsListQuery());
  const { data: scripts } = useQuery(scriptsListQuery());
  const { data: turfCount } = useQuery(turfsCountQuery());

  return (
    <Page className={shouldFade}>
      <div className="mb-4 flex h-8 items-center justify-between">
        <h1 className="text-xl italic font-extrabold tracking-wide">Overview</h1>
      </div>
      {/* Gate on data so the numbers fade in once with real values rather than
          flashing 0 first — notably on org switch, where the org-scoped query
          key resolves a frame late. Keyed on orgSlug so the fade re-fires per org. */}
      {campaigns && segments && scripts && turfCount != null ? (
        <div
          key={orgSlug}
          className="grid grid-cols-2 gap-4 lg:grid-cols-4 animate-in fade-in duration-100"
        >
          {[
            { label: "Campaigns", count: campaigns.length, to: "/$orgSlug/campaigns" },
            { label: "Segments", count: segments.length, to: "/$orgSlug/segments" },
            { label: "Turfs", count: turfCount, to: "/$orgSlug/turfs" },
            { label: "Scripts", count: scripts.length, to: "/$orgSlug/scripts" },
          ].map((card) => (
            <Link
              key={card.label}
              to={card.to}
              params={{ orgSlug }}
              className={cn(
                "flex flex-col gap-1 rounded-lg border border-border bg-card p-5",
                "transition-colors hover:bg-accent",
              )}
            >
              <span className="text-3xl font-semibold">{card.count}</span>
              <span className="text-sm text-muted-foreground">{card.label}</span>
            </Link>
          ))}
        </div>
      ) : null}
    </Page>
  );
}
