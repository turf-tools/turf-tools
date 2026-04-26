import { useIsFetching } from "@tanstack/react-query";
import { cn } from "~/lib/utils";
import { Spinner } from "./spinner";

// Global loading indicator. Fades in whenever any React Query request is
// in flight anywhere in the app, and fades out when everything settles.
// Queries opted into `meta: { silent: true }` are excluded — those have
// their own inline spinner (e.g. on the triggering button) and don't
// need to flash the corner indicator.
//
// The spinner is always mounted (kept invisible via opacity), so its
// rotation animation never restarts as users navigate between pages with
// overlapping in-flight fetches.
export function LoadingIndicator() {
  const isFetching =
    useIsFetching({
      predicate: (query) => query.meta?.silent !== true,
    }) > 0;
  return (
    <div
      className={cn(
        // Renders inline (e.g. inside the TopBar's right-side group)
        // rather than as a fixed overlay — keeps it from covering page
        // content and gives it a stable, always-visible slot.
        "pointer-events-none inline-flex items-center",
        // Show instantly (no fade-in) so brief fetches are still visible;
        // fade out gently so the disappearance isn't jarring.
        isFetching ? "opacity-100" : "opacity-0 transition-opacity duration-200",
      )}
      aria-hidden={!isFetching}
    >
      <Spinner size={22} />
    </div>
  );
}
