import { createFileRoute, redirect } from "@tanstack/react-router";

// `/` is a pure redirect to `/overview` so the sidebar's Overview tab is the
// single source of truth for the landing page (and its active indicator
// doesn't need a special-case exact match).
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/overview" });
  },
});
