import { useIsFetching, useIsMutating } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { mapLoadingCountAtom } from "~/lib/atoms/map-loading";
import { cn } from "~/lib/utils";
import { Spinner } from "./spinner";

// Always mounted (opacity-toggled) so the spin animation doesn't restart
// across navigations.
export function LoadingIndicator() {
  // Renders the spinner as visible so first paint shows it before hydration.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const fetching = useIsFetching() > 0;
  const mutating = useIsMutating() > 0;
  // `isLoading` covers navigations; the matches-pending check covers the
  // initial app boot, when no navigation has fired yet but route loaders
  // are still running.
  const routing = useRouterState({
    select: (s) => s.isLoading || s.matches.some((m) => m.status === "pending"),
  });
  // Maps report their curtain here — their style/tile fetches are
  // invisible to the query and router signals above.
  const mapLoading = useAtomValue(mapLoadingCountAtom) > 0;
  const active = !hydrated || fetching || mutating || routing || mapLoading;

  // Pause the spin while hidden because an invisible animation still burns
  // compositor frames forever. Paused once the fade-out ends (transitionend).
  const [resting, setResting] = useState(false);
  useEffect(() => {
    if (active) setResting(false);
  }, [active]);

  return (
    <div
      className={cn(
        "pointer-events-none inline-flex items-center",
        active ? "opacity-100" : "opacity-0 transition-opacity duration-200",
      )}
      aria-hidden={!active}
      onTransitionEnd={(e) => {
        if (e.propertyName === "opacity" && !active) setResting(true);
      }}
    >
      <Spinner
        size={22}
        className={!active && resting ? "[animation-play-state:paused]" : undefined}
      />
    </div>
  );
}
