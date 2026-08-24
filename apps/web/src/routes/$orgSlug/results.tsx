import { createFileRoute } from "@tanstack/react-router";
import { EditorHeader } from "~/components/editor-header";
import { Page } from "~/components/page";
import { useFadeOnce } from "~/lib/use-fade-once";

export const Route = createFileRoute("/$orgSlug/results")({
  component: Results,
});

function Results() {
  const shouldFade = useFadeOnce("/results");
  return (
    <Page className={shouldFade}>
      <EditorHeader title="Results" />
      <p className="text-sm text-muted-foreground">
        Rates and breakdowns over canvass results — attempts, saturation, contact, and persuasion,
        sliceable by segment, date range, and campaign, with a zone map.
      </p>
    </Page>
  );
}
