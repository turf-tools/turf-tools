import { useIsFetching, useIsMutating } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { cn } from "~/lib/utils";
import { Spinner } from "./spinner";

// Always mounted (opacity-toggled) so the spin animation doesn't restart
// across navigations.
export function LoadingIndicator() {
  const fetching = useIsFetching() > 0;
  const mutating = useIsMutating() > 0;
  // `isLoading` covers navigations; the matches-pending check covers the
  // initial app boot, when no navigation has fired yet but route loaders
  // are still running.
  const routing = useRouterState({
    select: (s) => s.isLoading || s.matches.some((m) => m.status === "pending"),
  });
  const active = fetching || mutating || routing;
  return (
    <div
      className={cn(
        "pointer-events-none inline-flex items-center",
        active ? "opacity-100" : "opacity-0 transition-opacity duration-200",
      )}
      aria-hidden={!active}
    >
      <Spinner size={22} />
    </div>
  );
}
