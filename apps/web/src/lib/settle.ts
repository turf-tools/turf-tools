import type { QueryClient, QueryKey } from "@tanstack/react-query";

// The settle invariant for server writes: every owned key gets
// cancel → patch → evict → invalidate, in that order.
//
// Cancel must come first: a response that started pre-write would land after
// the patch, overwrite it, and count as fresh for `staleTime`. The invalidate
// below restarts in-flight fetches for *active* queries, but fetches without
// observers (route loaders mid-navigation) are only covered by cancellation.
//
// `patch` owns the setQueryData/navigation choreography — some flows must
// navigate before patching or after (see the archive handlers) — and runs
// after cancellation. Invalidations are fire-and-forget: the patch already
// shows the intended state; the refetch is server reconciliation.
export async function settleMutation(
  queryClient: QueryClient,
  opts: {
    keys: QueryKey[];
    patch?: () => void | Promise<void>;
    evict?: QueryKey[];
  },
): Promise<void> {
  await Promise.all(opts.keys.map((queryKey) => queryClient.cancelQueries({ queryKey })));
  await opts.patch?.();
  for (const queryKey of opts.evict ?? []) queryClient.removeQueries({ queryKey });
  for (const queryKey of opts.keys) void queryClient.invalidateQueries({ queryKey });
}
