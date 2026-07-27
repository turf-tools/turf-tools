import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { bumpOrgLastAccessed } from "~/lib/server/landing-org";

export const Route = createFileRoute("/$orgSlug")({
  beforeLoad: ({ params, context, location }) => {
    if (!context.session) throw redirect({ to: "/login" });
    const org = context.session.orgsBySlug[params.orgSlug];
    if (!org) throw redirect({ to: "/" });
    // Field leads get exactly the turfs board plus personal pages;
    // everything else lands on turfs. The RPC allowlist is the real
    // boundary — this keeps navigation coherent.
    if (org.role === "lead") {
      const section = location.pathname.split("/")[2];
      if (!section || !["turfs", "settings", "account"].includes(section)) {
        throw redirect({ href: `/${params.orgSlug}/turfs` });
      }
    }
    // Fire-and-forget; powers the "/" landing redirect on next visit.
    // Always bumped (even for single-org users) so the value stays
    // current if the user is later added to a second org.
    void bumpOrgLastAccessed({ data: { orgSlug: params.orgSlug } });
    return {
      organizationId: org.organizationId,
      orgSlug: org.orgSlug,
      orgName: org.orgName,
      role: org.role,
    };
  },
  component: () => <Outlet />,
});
