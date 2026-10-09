import { createFileRoute, redirect } from "@tanstack/react-router";
import { homeNavItem } from "~/lib/nav";

// Bare `/$orgSlug` is the org's home: the first tab the role can see. Every
// reroute that needs a safe landing targets this route rather than a tab.
export const Route = createFileRoute("/$orgSlug/")({
  beforeLoad: ({ context, params }) => {
    const home = homeNavItem(context.role).to.split("/")[2];
    throw redirect({ href: `/${params.orgSlug}/${home}` });
  },
});
