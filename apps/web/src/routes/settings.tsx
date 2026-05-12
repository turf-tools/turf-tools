import { createFileRoute } from "@tanstack/react-router";
import { Page } from "~/components/page";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <Page>
      <div className="mb-4 flex h-8 items-center justify-between">
        <h1 className="text-xl font-extrabold tracking-wide">Settings</h1>
      </div>
      <p className="text-muted-foreground">Coming soon.</p>
    </Page>
  );
}
