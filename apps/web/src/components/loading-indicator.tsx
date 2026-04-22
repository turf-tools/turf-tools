import { useIsFetching } from "@tanstack/react-query";
import { cn } from "~/lib/utils";
import { Spinner } from "./spinner";

// Global loading indicator. Fades in whenever any React Query request is
// in flight anywhere in the app, and fades out when everything settles.
// The spinner is always mounted (kept invisible via opacity), so its
// rotation animation never restarts as users navigate between pages with
// overlapping in-flight fetches.
export function LoadingIndicator() {
  const isFetching = useIsFetching() > 0;
  return (
    <div
      className={cn(
        "pointer-events-none fixed right-6 bottom-6 z-50",
        // Show instantly (no fade-in) so brief fetches are still visible;
        // fade out gently so the disappearance isn't jarring.
        isFetching ? "opacity-100" : "opacity-0 transition-opacity duration-200",
      )}
      aria-hidden={!isFetching}
    >
      <Spinner size={42} />
    </div>
  );
}
