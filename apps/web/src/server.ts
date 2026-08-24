import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { newTimingStore, serverTimingValue, timingScope } from "~/lib/server/timing";

// Custom entry only to stamp a Server-Timing breakdown per request:
// `auth` and `rpc-*` are recorded by getSession and the server-side
// RPC client; `total` is the whole handler.
export default createServerEntry({
  async fetch(request) {
    const store = newTimingStore();
    const t0 = performance.now();
    const response = await timingScope.run(store, () => handler.fetch(request));
    // One tick so recorder microtasks still in flight land before we stamp.
    await new Promise((resolve) => setTimeout(resolve, 0));
    store.durations.set("total", performance.now() - t0);
    try {
      // /api routes stamp their own (richer) header inside the handler;
      // leave those alone.
      if (!response.headers.has("Server-Timing")) {
        response.headers.set("Server-Timing", serverTimingValue(store));
      }
    } catch {
      // Immutable-header responses (static assets): skip.
    }
    return response;
  },
});
