import { createFileRoute } from "@tanstack/react-router";
import { Page } from "~/components/page";
import { useFadeOnce } from "~/lib/use-fade-once";

export const Route = createFileRoute("/$orgSlug/overview")({
  component: Overview,
});

function Overview() {
  const shouldFade = useFadeOnce("/overview");
  return (
    <Page className={shouldFade ? "animate-in fade-in duration-100" : undefined}>
      <div className="mb-4 flex h-8 items-center justify-between">
        <h1 className="text-xl font-extrabold tracking-wide">Overview</h1>
      </div>
      <p className="text-muted-foreground">Coming soon.</p>
    </Page>
  );
}
