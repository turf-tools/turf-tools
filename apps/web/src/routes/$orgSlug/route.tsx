import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { homeNavItem, PRIMARY, SECONDARY } from "~/lib/nav";
import { hasPermission } from "~/lib/permissions";
import { bumpOrgLastAccessed } from "~/lib/server/landing-org";

export const Route = createFileRoute("/$orgSlug")({
  beforeLoad: ({ params, context, location }) => {
    if (!context.session) throw redirect({ to: "/login" });
    const org = context.session.orgsBySlug[params.orgSlug];
    if (!org) throw redirect({ to: "/" });
    // Tabs a role can't see redirect to the first one it can; the server
    // enforces the same permissions on every call behind them.
    const section = location.pathname.split("/")[2];
    const tab = [...PRIMARY, ...SECONDARY].find((i) => i.to === `/$orgSlug/${section}`);
    if (tab?.requires && !hasPermission(org.role, tab.requires)) {
      const home = homeNavItem(org.role).to.split("/")[2];
      // `href` (not `to` + params) sidesteps a typed-params inference
      // failure in this layout beforeLoad; same-origin hrefs are still
      // internal SPA navigations, not document reloads.
      throw redirect({ href: `/${params.orgSlug}/${home}` });
    }
    // Fire-and-forget; powers the "/" landing redirect on next visit.
    // Always bumped (even for single-org users) so the value stays
    // current if the user is later added to a second org. Best-effort —
    // failures only log; an unhandled rejection during SSR kills Node.
    bumpOrgLastAccessed({ data: { orgSlug: params.orgSlug } }).catch((e) =>
      console.error("bumpOrgLastAccessed failed", e),
    );
    return {
      organizationId: org.organizationId,
      orgSlug: org.orgSlug,
      orgName: org.orgName,
      role: org.role,
    };
  },
  component: () => <Outlet />,
});
