import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/overview")({
  component: Overview,
});

// Landing page. Eventually a cross-track summary (progress, canvass results,
// upcoming turf assignments). For now it's a "coming soon" stub — leaving it
// intentionally empty so we don't ship a half-baked dashboard that's worse
// than no dashboard.
function Overview() {
  return (
    <>
      <div className="mb-4 flex h-8 items-center justify-between">
        <h1 className="text-xl font-extrabold tracking-wide">Overview</h1>
      </div>
      <p className="text-muted-foreground">Coming soon.</p>
    </>
  );
}
