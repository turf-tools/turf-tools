import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <>
      <h1 className="mb-4 text-xl font-extrabold tracking-wide">Settings</h1>
      <p className="text-muted-foreground">Settings will live here.</p>
    </>
  );
}
