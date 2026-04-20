import AsyncStorage from "@react-native-async-storage/async-storage";
import { createCollection } from "@tanstack/db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { useLiveQuery } from "@tanstack/react-db";
import { startOfflineExecutor } from "@tanstack/offline-transactions/react-native";
import type { StorageAdapter } from "@tanstack/offline-transactions/react-native";
import { getDefaultStore } from "jotai";
import { useCallback } from "react";
import type { CanvassEventPayload } from "@field-tools/db/schema";
import { syncIntervalAtom } from "@/lib/atoms/sync";
import { queryClient } from "@/lib/query-client";
import { client } from "@/rpc/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CanvassEvent = {
  sequence: number;
  eventId: string | null;
  turfId: string;
  userId: string;
  personId: string | null;
  doorId: string | null;
  buildingId: string | null;
  type: string;
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
  type: string;
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
      getKey: (event) => event.eventId!,
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

  if (payload.kind === "note") {
    await client.canvass.appendNote({
      turfId,
      personId: event.personId ?? undefined,
      doorId: event.doorId ?? undefined,
      buildingId: event.buildingId ?? undefined,
      text: payload.text,
      canvassedAt: payload.canvassedAt,
      inputType: "mobile",
      eventId: event.eventId ?? undefined,
    });
  } else if (event.personId) {
    await client.canvass.appendPersonResult({
      turfId,
      buildingId: event.buildingId ?? undefined,
      doorId: event.doorId ?? undefined,
      personId: event.personId,
      payload: payload as unknown as {
        kind: "survey";
        surveyQuestionId: string;
        surveyResponseOptionId: string;
      },
      inputType: "mobile",
      eventId: event.eventId ?? undefined,
    });
  } else if (event.doorId) {
    await client.canvass.appendDoorResult({
      turfId,
      doorId: event.doorId,
      outcome: (payload as unknown as { outcome: string }).outcome as "address_not_found",
      inputType: "mobile",
      eventId: event.eventId ?? undefined,
    });
  } else if (event.buildingId) {
    await client.canvass.appendBuildingResult({
      turfId,
      buildingId: event.buildingId,
      outcome: (payload as unknown as { outcome: string }).outcome as "inaccessible",
      inputType: "mobile",
      eventId: event.eventId ?? undefined,
    });
  }
}

function createTurfContext(turfId: string): TurfContext {
  const collection = createCollection_(turfId);

  const executor = startOfflineExecutor({
    collections: { events: collection as never },
    storage: new AsyncStorageAdapter(),
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

  const recordEvent = executor.createOfflineAction({
    mutationFnName: "appendEvent",
    onMutate: (params: RecordEventParams) => {
      collection.insert({
        // Placeholder values — server assigns sequence, userId comes from auth
        sequence: 0,
        userId: "",
        eventId: crypto.randomUUID(),
        turfId,
        personId: params.personId ?? null,
        doorId: params.doorId ?? null,
        buildingId: params.buildingId ?? null,
        type: params.type,
        payload: params.payload as Record<string, unknown>,
        inputType: "mobile",
        createdAt: new Date().toISOString(),
      });
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
  await queryClient.invalidateQueries({ queryKey: ["canvass-events", turfId] });
  await (collection as unknown as { preload: () => Promise<void> }).preload();
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

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

export type PersonSummary = {
  latestResult: CanvassEvent | null;
  notes: CanvassEvent[];
};

export function derivePersonSummaries(events: CanvassEvent[]) {
  const map = new Map<string, PersonSummary>();
  const sorted = [...events].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  for (const event of sorted) {
    if (!event.personId) continue;
    let summary = map.get(event.personId);
    if (!summary) {
      summary = { latestResult: null, notes: [] };
      map.set(event.personId, summary);
    }
    if (event.type === "note") {
      summary.notes.push(event);
    } else {
      summary.latestResult = event;
    }
  }
  return map;
}

export function isRecorded(summaries: Map<string, PersonSummary>, personId: string): boolean {
  const s = summaries.get(personId);
  if (!s?.latestResult) return false;
  return s.latestResult.type !== "empty";
}

export function hasSurvey(summaries: Map<string, PersonSummary>, personId: string): boolean {
  return summaries.get(personId)?.latestResult?.type === "survey";
}

export function hasNotes(summaries: Map<string, PersonSummary>, personId: string): boolean {
  return (summaries.get(personId)?.notes.length ?? 0) > 0;
}
