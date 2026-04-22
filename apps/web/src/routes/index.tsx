import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Home,
});

// Landing page. Eventually a cross-campaign dashboard (progress,
// canvass results, upcoming turf assignments). For now it's a "coming
// soon" stub — leaving it intentionally empty so we don't ship a
// half-baked dashboard that's worse than no dashboard.
function Home() {
  return (
    <>
      <h1 className="mb-4 text-xl font-extrabold tracking-wide">Dashboard</h1>
      <p className="text-muted-foreground">Coming soon.</p>
    </>
  );
}
