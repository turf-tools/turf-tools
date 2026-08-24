import { AsyncLocalStorage } from "node:async_hooks";

// Request-scoped Server-Timing collector. Every server entry point (the
// SSR handler in src/server.ts, the /api routes) opens a scope, code
// anywhere below records into it, and the entry point stamps the header.
// Recorders no-op without a scope, so shared code paths can record
// unconditionally.

export type TimingStore = {
  durations: Map<string, number>;
  // Pre-formatted entries relayed from upstream services.
  raw: string[];
};

export const timingScope = new AsyncLocalStorage<TimingStore>();

export function newTimingStore(): TimingStore {
  return { durations: new Map(), raw: [] };
}

// Repeated names accumulate — several calls to the same phase in one
// request report their sum.
export function recordTiming(name: string, ms: number) {
  const store = timingScope.getStore();
  if (store) store.durations.set(name, (store.durations.get(name) ?? 0) + ms);
}

export function recordRawTiming(value: string) {
  const store = timingScope.getStore();
  if (store) store.raw.push(value);
}

export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    recordTiming(name, performance.now() - t0);
  }
}

export function serverTimingValue(store: TimingStore): string {
  const durations = [...store.durations].map(([name, dur]) => `${name};dur=${dur.toFixed(1)}`);
  return [...durations, ...store.raw].join(", ");
}
