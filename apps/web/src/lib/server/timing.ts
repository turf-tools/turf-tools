import { AsyncLocalStorage } from "node:async_hooks";

// Request-scoped Server-Timing collector. The server entry (src/server.ts)
// opens a scope per request; server-side code records durations into it
// (the SSR RPC client, getSession); the entry stamps the header once the
// handler settles. Without a scope every record is a no-op, so shared
// code paths can record unconditionally.
export const timingScope = new AsyncLocalStorage<Map<string, number>>();

export function recordTiming(name: string, ms: number) {
  const timings = timingScope.getStore();
  if (timings) timings.set(name, (timings.get(name) ?? 0) + ms);
}

export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    recordTiming(name, performance.now() - t0);
  }
}

export function serverTimingValue(timings: Map<string, number>): string {
  return [...timings].map(([name, dur]) => `${name};dur=${dur.toFixed(1)}`).join(", ");
}
