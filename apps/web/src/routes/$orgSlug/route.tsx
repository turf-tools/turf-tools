import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { bumpOrgLastAccessed } from "~/lib/server/landing-org";

export const Route = createFileRoute("/$orgSlug")({
  beforeLoad: ({ params, context }) => {
    if (!context.session) throw redirect({ to: "/login" });
    const org = context.session.orgsBySlug[params.orgSlug];
    if (!org) throw redirect({ to: "/" });
    // Fire-and-forget; powers the "/" landing redirect on next visit.
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
