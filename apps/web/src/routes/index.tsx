import { createFileRoute, redirect } from "@tanstack/react-router";
import { resolveLandingOrgSlug } from "~/lib/server/landing-org";

// Bounces authed users to their most-recently-used org's overview. The auth
// gate lives in __root.tsx — by the time this runs we know there's a session.
export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const orgSlug = await resolveLandingOrgSlug();
    if (!orgSlug) throw redirect({ to: "/login" });
    throw redirect({ to: "/$orgSlug/overview", params: { orgSlug } });
  },
});
