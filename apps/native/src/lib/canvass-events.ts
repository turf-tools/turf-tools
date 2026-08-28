import AsyncStorage from "@react-native-async-storage/async-storage";
import { createCollection } from "@tanstack/db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { useLiveQuery } from "@tanstack/react-db";
import { startOfflineExecutor } from "@tanstack/offline-transactions/react-native";
import type { StorageAdapter } from "@tanstack/offline-transactions/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { getDefaultStore } from "jotai";
import { useCallback, useEffect, useState } from "react";
import type { CanvassEventPayload, ResponseValue } from "@turf-tools/db/schema";
import { activeTurfAtom, lastBoundTurf } from "@/lib/atoms/active-turf";
import { canvasserAtom } from "@/lib/atoms/canvasser";
import { syncIntervalAtom } from "@/lib/atoms/sync";
import { FixedReactNativeOnlineDetector } from "@/lib/online-detector";
import { queryClient } from "@/lib/query-client";
import { client } from "@/rpc/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CanvassEvent = {
  sequence: number;
  clientEventId: string | null;
  turfId: string;
  walkId: string | null;
  canvasserId: string | null;
  canvasserName: string | null;
  canvasserPhone: string | null;
  personId: string | null;
  doorId: string | null;
  buildingId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  inputType: string | null;
  createdAt: string;
};

type TurfContext = {
  collection: ReturnType<typeof createCollection_>;
  executor: ReturnType<typeof startOfflineExecutor>;
  recordEvent: (params: RecordEventParams) => void;
};

type RecordEventParams = {
  personId?: string;
  doorId?: string;
  buildingId?: string;
  kind: string;
  payload: CanvassEventPayload;
};

// ---------------------------------------------------------------------------
// AsyncStorage adapter for offline transaction outbox
// From: https://github.com/TanStack/db/blob/main/examples/react-native/shopping-list/src/db/AsyncStorageAdapter.ts
// ---------------------------------------------------------------------------

class AsyncStorageAdapter implements StorageAdapter {
  private prefix = "offline-tx:";
  private getKey(key: string) {
    return `${this.prefix}${key}`;
  }
  async get(key: string) {
    return AsyncStorage.getItem(this.getKey(key));
  }
  async set(key: string, value: string) {
    await AsyncStorage.setItem(this.getKey(key), value);
  }
  async delete(key: string) {
    await AsyncStorage.removeItem(this.getKey(key));
  }
  async keys() {
    const all = await AsyncStorage.getAllKeys();
    return all.filter((k) => k.startsWith(this.prefix)).map((k) => k.slice(this.prefix.length));
  }
  async clear() {
    const keys = await this.keys();
    const prefixed = keys.map((k) => this.getKey(k));
    if (prefixed.length > 0) await AsyncStorage.multiRemove(prefixed);
  }
}

// ---------------------------------------------------------------------------
// Data flow: pull (server → collection), append (collection → server),
// and turf lifecycle
// ---------------------------------------------------------------------------

const turfContexts = new Map<string, TurfContext>();

// Accumulated events + cursor per turf for incremental pulls.
const pullCache = new Map<string, { cursor: number; events: CanvassEvent[] }>();

function createCollection_(turfId: string) {
  return createCollection(
    queryCollectionOptions({
      queryKey: ["canvass-events", turfId] as const,
      queryFn: async (): Promise<CanvassEvent[]> => {
        let cache = pullCache.get(turfId);
        if (!cache) {
          cache = { cursor: 0, events: [] };
          pullCache.set(turfId, cache);
        }
        const result = await client.canvass.pull({ turfId, cursor: cache.cursor });
        if (result.events.length > 0) {
          const newEvents = result.events.map((e) => ({
            ...e,
            createdAt:
              typeof e.createdAt === "string" ? e.createdAt : new Date(e.createdAt).toISOString(),
            payload: e.payload as Record<string, unknown>,
          }));
          cache.events = [...cache.events, ...newEvents];
          cache.cursor = result.cursor;
        }
        return cache.events;
      },
      // Cast needed: pnpm peer-dep isolation creates incompatible QueryClient types
      queryClient: queryClient as never,
      getKey: (event) => event.clientEventId!,
      refetchInterval: (): number | false => {
        const val = getDefaultStore().get(syncIntervalAtom);
        if (typeof val !== "number") return 30_000;
        return val || false;
      },
    }),
  );
}

async function appendEventToServer(turfId: string, event: CanvassEvent) {
  const payload = event.payload as unknown as CanvassEventPayload;
  const base = {
    turfId,
    walkId: event.walkId ?? undefined,
    personId: event.personId ?? undefined,
    doorId: event.doorId ?? undefined,
    buildingId: event.buildingId ?? undefined,
    createdAt: event.createdAt,
    canvasserName: event.canvasserName ?? undefined,
    canvasserPhone: event.canvasserPhone ?? undefined,
    inputType: "mobile",
    clientEventId: event.clientEventId ?? undefined,
  };

  if (payload.kind === "note") {
    await client.canvass.appendNote({
      ...base,
      text: payload.text,
    });
  } else {
    await client.canvass.appendResult({ ...base, payload });
  }
}

function createTurfContext(turfId: string): TurfContext {
  const collection = createCollection_(turfId);

  const executor = startOfflineExecutor({
    collections: { events: collection as never },
    storage: new AsyncStorageAdapter(),
    // Workaround for TanStack/db#1490 — upstream RN detector has races
    // that strand the outbox after airplane-mode-off. Drop the override
    // (and the file) when upstream ships a fix.
    onlineDetector: new FixedReactNativeOnlineDetector(),
    mutationFns: {
      appendEvent: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await appendEventToServer(turfId, mutation.modified as CanvassEvent);
        }
        // Pull so confirmed server data is in place before optimistic state is removed
        await queryClient.invalidateQueries({ queryKey: ["canvass-events", turfId] });
      },
    },
  });

  const buildEvent = (params: RecordEventParams) => {
    // Walk stamp: the live binding at record time (or the last binding,
    // for a flush that lands mid-unbind), guarded on turfId so a stale
    // context for another turf can't claim the walk.
    const active = getDefaultStore().get(activeTurfAtom) ?? lastBoundTurf();
    return {
      // Placeholder values — server assigns sequence. canvasserId stays null
      // (reserved); attribution is the client-claimed `canvasser` stamp, read
      // from the device identity at record time so mid-shift edits in Settings
      // apply to subsequent events.
      sequence: 0,
      canvasserId: null,
      canvasserName: getDefaultStore().get(canvasserAtom)?.name ?? null,
      canvasserPhone: getDefaultStore().get(canvasserAtom)?.phone ?? null,
      clientEventId: crypto.randomUUID(),
      turfId,
      walkId: active?.turfId === turfId ? (active.walkId ?? null) : null,
      personId: params.personId ?? null,
      doorId: params.doorId ?? null,
      buildingId: params.buildingId ?? null,
      kind: params.kind,
      payload: params.payload as Record<string, unknown>,
      inputType: "mobile",
      createdAt: new Date().toISOString(),
    };
  };

  const recordEvent = executor.createOfflineAction({
    mutationFnName: "appendEvent",
    onMutate: (params: RecordEventParams) => {
      collection.insert(buildEvent(params));
    },
  });

  return { collection, executor, recordEvent };
}

function getTurfContext(turfId: string): TurfContext {
  let ctx = turfContexts.get(turfId);
  if (!ctx) {
    ctx = createTurfContext(turfId);
    turfContexts.set(turfId, ctx);
  }
  return ctx;
}

// Call on turf entry. Resets the pull cursor and fetches everything
// from the server, picking up any events from other canvassers.
// `invalidateQueries` marks the query stale so `preload` triggers one
// fresh fetch via the collection's observer, and `preload` resolves only
// when the collection reaches `ready` — so the turf screen renders with
// data on its first paint instead of flashing empty.
export async function openTurf(turfId: string) {
  pullCache.delete(turfId);
  const { collection } = getTurfContext(turfId);
  // Invalidate the script cache so script-content edits propagate
  // when a canvasser reopens a turf.
  await queryClient.invalidateQueries({ queryKey: ["script"] });
  await queryClient.invalidateQueries({ queryKey: ["canvass-events", turfId] });
  await (collection as unknown as { preload: () => Promise<void> }).preload();
}

// Wipe the in-memory pull cache for every turf. AsyncStorage.clear() and
// queryClient.clear() can't reach this module-level Map, so the Settings
// "Reset app state" hook needs to call this explicitly — otherwise stale
// cursor + events leak through into the next session-within-runtime.
export function clearPullCache() {
  pullCache.clear();
}

// Pull latest from server (used by "Sync now" button). Assumes the user is
// in a turf, so the collection already has active observers — refetchQueries
// triggers queryFn through those observers and resolves when the fetch
// (and thus the collection update) completes.
export async function pullCanvassEvents(turfId: string) {
  await queryClient.refetchQueries(
    { queryKey: ["canvass-events", turfId] },
    { throwOnError: true },
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

// All events for a turf. One live query and screens derive what they need.
// Passing the collection directly (instead of a query builder) avoids the
// liveQueryCollection wrapper's loading→ready handshake, so populated data
// is available on the first render.
export function useCanvassEvents(turfId: string) {
  const { collection } = getTurfContext(turfId);
  const { data } = useLiveQuery(collection);
  return (data as unknown as CanvassEvent[]) ?? [];
}

export function useRecordEvent(turfId: string) {
  const { recordEvent } = getTurfContext(turfId);
  return useCallback((params: RecordEventParams) => recordEvent(params), [recordEvent]);
}

// Snapshot of sync health for the status line in Settings. Pull state
// (last success / last failure) comes from react-query's query cache;
// `pendingCount` is the executor's outbox depth, polled at 1s since the
// offline-transactions API has no subscription primitive. The same
// 1s tick also keeps the "N min ago" relative-time labels fresh.
export type SyncStatus = {
  lastPullAt: number | null;
  lastErrorAt: number | null;
  pendingCount: number;
};

export function useSyncStatus(turfId: string | null): SyncStatus {
  const queryClient = useQueryClient();
  const [, forceTick] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);

  // Subscribe to cache changes for the canvass-events query so the
  // status text updates when a pull (background or user) settles.
  useEffect(() => {
    if (!turfId) return;
    const cache = queryClient.getQueryCache();
    return cache.subscribe((event) => {
      const key = event.query.queryKey;
      if (Array.isArray(key) && key[0] === "canvass-events" && key[1] === turfId) {
        forceTick((t) => t + 1);
      }
    });
  }, [queryClient, turfId]);

  // Poll the executor's pending count + re-render the relative-time
  // strings. 5s is enough since the displayed time has minute
  // granularity and pendingCount changes are tied to online-transitions.
  useEffect(() => {
    if (!turfId) return;
    const ctx = getTurfContext(turfId);
    const update = () => {
      setPendingCount(ctx.executor.getPendingCount());
      forceTick((t) => t + 1);
    };
    update();
    const id = setInterval(update, 5000);
    return () => clearInterval(id);
  }, [turfId]);

  if (!turfId) return { lastPullAt: null, lastErrorAt: null, pendingCount: 0 };
  const state = queryClient.getQueryState(["canvass-events", turfId]);
  return {
    lastPullAt: state?.dataUpdatedAt || null,
    lastErrorAt: state?.errorUpdatedAt || null,
    pendingCount,
  };
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

export type PersonSummary = {
  // Only the "unavailable" outcomes (not_home / deceased / hostile / moved)
  // surface here — that's what the screen's mode logic switches on. A result
  // whose outcome is "canvassed" maps to null, because the screen shows a
  // contacted person through their responses (responsesByQuestion), not an
  // outcome. The authoritative outcome (incl. "canvassed") lives on the result.
  currentOutcome: string | null;
  notes: CanvassEvent[];
  // questionId -> answer: selected option ids or free text. Only
  // meaningful entries (≥1 option / non-blank text) are stored.
  responsesByQuestion: Map<string, ResponseValue>;
};

// Current state per person = the latest "result" snapshot + all notes.
// A result carries the entity's complete disposition, so there's no replay:
// the newest result wins outright.
export function derivePersonSummaries(events: CanvassEvent[]) {
  const map = new Map<string, PersonSummary>();
  const sorted = [...events].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  for (const event of sorted) {
    if (!event.personId) continue;
    let summary = map.get(event.personId);
    if (!summary) {
      summary = { currentOutcome: null, notes: [], responsesByQuestion: new Map() };
      map.set(event.personId, summary);
    }
    if (event.kind === "note") {
      summary.notes.push(event);
    } else if (event.kind === "result") {
      const payload = event.payload as {
        outcome: string | null;
        responses: Record<string, { optionIds?: string[]; text?: string }>;
      };
      // Latest result wins (events are sorted ascending) — overwrite both fields.
      const responses = new Map<string, ResponseValue>();
      for (const [questionId, value] of Object.entries(payload.responses ?? {})) {
        if (value?.optionIds?.length) responses.set(questionId, { optionIds: value.optionIds });
        else if (value?.text?.trim()) responses.set(questionId, { text: value.text });
      }
      summary.responsesByQuestion = responses;
      summary.currentOutcome = payload.outcome === "canvassed" ? null : payload.outcome;
    }
  }
  return map;
}

// Notes alone don't count — they're surfaced via hasNotes.
export function isRecorded(summaries: Map<string, PersonSummary>, personId: string): boolean {
  const s = summaries.get(personId);
  if (!s) return false;
  return s.currentOutcome != null || s.responsesByQuestion.size > 0;
}

export function hasResponses(summaries: Map<string, PersonSummary>, personId: string): boolean {
  return (summaries.get(personId)?.responsesByQuestion.size ?? 0) > 0;
}

export function hasNotes(summaries: Map<string, PersonSummary>, personId: string): boolean {
  return (summaries.get(personId)?.notes.length ?? 0) > 0;
}
