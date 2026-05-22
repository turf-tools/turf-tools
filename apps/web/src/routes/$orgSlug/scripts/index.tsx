import { createFileRoute, redirect } from "@tanstack/react-router";
import { scriptsListQuery } from "~/lib/queries/scripts";

export const Route = createFileRoute("/$orgSlug/scripts/")({
  loader: async ({ context: { queryClient }, params: { orgSlug } }) => {
    const scripts = await queryClient.fetchQuery(scriptsListQuery());
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
