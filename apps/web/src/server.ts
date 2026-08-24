import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { serverTimingValue, timingScope } from "~/lib/server/timing";

// Custom entry only to stamp a Server-Timing breakdown per request:
// `auth` and `rpc-*` are recorded by getSession and the server-side
// RPC client; `total` is the whole handler.
export default createServerEntry({
  async fetch(request) {
    const timings = new Map<string, number>();
    const t0 = performance.now();
    const response = await timingScope.run(timings, () => handler.fetch(request));
    // One tick so recorder microtasks still in flight land before we stamp.
    await new Promise((resolve) => setTimeout(resolve, 0));
    timings.set("total", performance.now() - t0);
    try {
      response.headers.set("Server-Timing", serverTimingValue(timings));
    } catch {
      // Immutable-header responses (static assets): skip.
    }
    return response;
  },
});
