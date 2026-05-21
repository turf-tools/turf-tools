import { createFileRoute, redirect } from "@tanstack/react-router";

// Bare `/$orgSlug` lands on the Overview tab so the sidebar's active-link
// indicator has a route to match against.
export const Route = createFileRoute("/$orgSlug/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/$orgSlug/overview", params: { orgSlug: params.orgSlug } });
  },
});
