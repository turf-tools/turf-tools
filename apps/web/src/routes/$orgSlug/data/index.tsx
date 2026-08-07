import { createFileRoute, redirect } from "@tanstack/react-router";
import { EditorHeader } from "~/components/editor-header";
import { EditorPage } from "~/components/editor-page";
import { recallSelection } from "~/lib/last-selected";
import { datasetsListQuery } from "~/lib/queries/datasets";

export const Route = createFileRoute("/$orgSlug/data/")({
  loader: async ({ context: { queryClient }, params: { orgSlug }, preload }) => {
    const rows = await queryClient.fetchQuery(datasetsListQuery());
    // Redirect only on real navigations — a redirect thrown during a hover
    // preload gets committed and auto-navigates.
    if (preload) return;
    // Last-visited dataset first; cold start lands on the active one (the
    // dataset you're running on beats alphabetical order), then first-by-name.
    // Filtering to unarchived versions drops fully-archived datasets — they
    // stay reachable from the rail toggle but never win the redirect.
    const current = rows.filter((r) => !r.isArchived);
    const remembered = recallSelection(orgSlug, "data");
    const fallback =
      current.find((r) => r.datasetId === remembered) ??
      current.find((r) => r.isActive) ??
      current[0];
    if (fallback) {
      throw redirect({
        to: "/$orgSlug/data/$datasetId",
        params: { orgSlug, datasetId: fallback.datasetId },
      });
    }
  },
  component: DataEmpty,
});

function DataEmpty() {
  return (
    <EditorPage>
      <EditorHeader title="Data" subtitle="Voter files and other imported datasets" />
      <p className="text-sm text-muted-foreground">
        No active datasets yet, import one to get started.
      </p>
    </EditorPage>
  );
}
