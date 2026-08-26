import { createFileRoute } from "@tanstack/react-router";
import { EditorHeader } from "~/components/editor-header";
import { Page } from "~/components/page";
import { useFadeOnce } from "~/lib/use-fade-once";

export const Route = createFileRoute("/$orgSlug/reports")({
  component: Reports,
});

function Reports() {
  const shouldFade = useFadeOnce("/reports");
  return (
    <Page className={shouldFade}>
      <EditorHeader title="Reports" subtitle="Browse and export detailed results" />
      <p className="text-sm text-muted-foreground">Coming soon</p>
    </Page>
  );
}
