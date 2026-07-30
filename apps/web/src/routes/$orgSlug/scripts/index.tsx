import { createFileRoute, redirect } from "@tanstack/react-router";
import { scriptsListQuery } from "~/lib/queries/scripts";

export const Route = createFileRoute("/$orgSlug/scripts/")({
  loader: async ({ context: { queryClient }, params: { orgSlug }, preload }) => {
    const scripts = await queryClient.fetchQuery(scriptsListQuery());
    // Redirect only on real navigations — a redirect thrown during a hover
    // preload gets committed and auto-navigates.
    if (preload) return;
    // Alphabetically first is the default — matches the list-column order.
    const fallback = [...scripts].sort((a, b) => a.name.localeCompare(b.name))[0];
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
      No scripts yet — create one to get started.
    </div>
  );
}
