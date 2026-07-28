// In-process pub/sub bridging RPC handlers to SSE subscribers: a scan or
// walk mutation publishes to its org's channel, and every connected
// browser gets a nudge to refetch. Deliberately payload-free — the poll
// remains the source of truth, SSE only collapses its latency — so a
// dropped stream degrades to polling instead of missing events.
//
// Assumes a single web process (true for dev and the compose deployment).
// Multiple replicas would need a shared bus (e.g. PG NOTIFY) behind this
// same interface.

type Listener = () => void;

// Anchored on globalThis: Vite's dev server re-evaluates server modules
// on edit, and a module-level Map would split-brain — publishers writing
// to a fresh instance while subscribers sit on the old one, silently
// dropping every event. Same guard as the native RPC client's HMR state.
const g = globalThis as { __turfToolsLive?: Map<string, Set<Listener>> };
g.__turfToolsLive ??= new Map<string, Set<Listener>>();
const channels = g.__turfToolsLive;

export function publish(organizationId: string) {
  channels.get(organizationId)?.forEach((listener) => listener());
}

export function subscribe(organizationId: string, listener: Listener): () => void {
  let set = channels.get(organizationId);
  if (!set) {
    set = new Set();
    channels.set(organizationId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) channels.delete(organizationId);
  };
}
