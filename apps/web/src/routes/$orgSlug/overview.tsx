import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Page } from "~/components/page";
import { useFadeOnce } from "~/lib/use-fade-once";
import { cn } from "~/lib/utils";
import { campaignsListQuery } from "~/lib/queries/campaigns";
import { segmentsListQuery } from "~/lib/queries/segments";
import { scriptsListQuery } from "~/lib/queries/scripts";
import { turfsListQuery } from "~/lib/queries/turfs";

export const Route = createFileRoute("/$orgSlug/overview")({
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      queryClient.fetchQuery(campaignsListQuery()),
      queryClient.fetchQuery(segmentsListQuery()),
      queryClient.fetchQuery(scriptsListQuery()),
      queryClient.fetchQuery(turfsListQuery(null)),
    ]);
  },
  component: Overview,
});

function Overview() {
  const shouldFade = useFadeOnce("/overview");
  const { orgSlug } = Route.useParams();
  const { data: campaigns = [] } = useQuery(campaignsListQuery());
  const { data: segments = [] } = useQuery(segmentsListQuery());
  const { data: scripts = [] } = useQuery(scriptsListQuery());
  const { data: turfs = [] } = useQuery(turfsListQuery(null));

  const cards: Array<{ label: string; count: number; to: string }> = [
    { label: "Campaigns", count: campaigns.length, to: "/$orgSlug/campaigns" },
    { label: "Segments", count: segments.length, to: "/$orgSlug/segments" },
    { label: "Turfs", count: turfs.length, to: "/$orgSlug/turfs" },
    { label: "Scripts", count: scripts.length, to: "/$orgSlug/scripts" },
  ];

  return (
    <Page className={shouldFade}>
      <div className="mb-4 flex h-8 items-center justify-between">
        <h1 className="text-xl italic font-extrabold tracking-wide">Overview</h1>
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {cards.map((card) => (
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
    </Page>
  );
}
