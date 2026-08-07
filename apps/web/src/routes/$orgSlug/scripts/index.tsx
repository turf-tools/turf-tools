import { createFileRoute, redirect } from "@tanstack/react-router";
import { recallOrFirst } from "~/lib/last-selected";
import { scriptsListQuery } from "~/lib/queries/scripts";

export const Route = createFileRoute("/$orgSlug/scripts/")({
  loader: async ({ context: { queryClient }, params: { orgSlug }, preload }) => {
    const scripts = await queryClient.fetchQuery(scriptsListQuery());
    // Redirect only on real navigations — a redirect thrown during a hover
    // preload gets committed and auto-navigates.
    if (preload) return;
    // Archived scripts stay reachable from the rail but never win the
    // index redirect.
    const active = scripts.filter((s) => !s.isArchived);
    const fallback = recallOrFirst(orgSlug, "scripts", active, (s) => s.scriptId);
    if (fallback) {
      throw redirect({
        to: "/$orgSlug/scripts/$scriptId",
        params: { orgSlug, scriptId: fallback.scriptId },
      });
    }
  },
  component: ScriptsEmpty,
});

function ScriptsEmpty() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      No active scripts yet, create one to get started.
    </div>
  );
}
