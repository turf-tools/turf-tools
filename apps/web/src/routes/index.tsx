import { createFileRoute, redirect } from "@tanstack/react-router";

// Bounces authed users to their most-recently-used org's overview. Reads
// the membership map from session (set by __root.beforeLoad), so no
// additional DB roundtrip. Tie-broken by org name for stability when
// nothing has been accessed yet.
export const Route = createFileRoute("/")({
  beforeLoad: ({ context }) => {
    if (!context.session) throw redirect({ to: "/login" });
    const orgs = Object.values(context.session.orgsBySlug);
    if (orgs.length === 0) throw redirect({ to: "/login" });
    const recent = [...orgs].sort((a, b) => {
      const at = a.lastAccessedAt?.getTime() ?? 0;
      const bt = b.lastAccessedAt?.getTime() ?? 0;
      if (at !== bt) return bt - at;
      return a.orgName.localeCompare(b.orgName);
    })[0]!;
    throw redirect({ to: "/$orgSlug/overview", params: { orgSlug: recent.orgSlug } });
  },
});
