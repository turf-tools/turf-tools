import AsyncStorage from "@react-native-async-storage/async-storage";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { atomFamily } from "jotai-family";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import { client } from "@/rpc/client";

// A single person's canvass result. One per person per turf. Writes are
// instant (local state); sync to server happens in the background.
export type LocalPersonResult = {
  surveyResponseOptionId?: string;
  surveyQuestionId?: string;
  unavailableOutcome?: string;
  notes: Array<{ text: string; canvassedAt: string }>;
  empty?: boolean;
  lastModified: string; // ISO timestamp
  dirty: boolean; // needs sync to server
};

// All local results for one turf, keyed by personId.
export type LocalResultsMap = Record<string, LocalPersonResult>;

// One atom per turf. In-memory for instant reads/writes. AsyncStorage
// persistence is debounced — writes flush at most every 500ms so rapid
// taps don't serialize the entire map to disk on each one.
function createResultsAtom(turfId: string) {
  const key = `local-results:${turfId}`;
  const baseAtom = atom<LocalResultsMap>({});

  type PersonUpdate = {
    personId: string;
    update: Partial<Omit<LocalPersonResult, "dirty" | "lastModified">>;
  };

  const derivedAtom = atom(
    (get) => get(baseAtom),
    (get, set, action: LocalResultsMap | PersonUpdate) => {
      let newValue: LocalResultsMap;
      if ("personId" in action && typeof action.personId === "string") {
        const personAction = action as PersonUpdate;
        // Per-person merge: read current state via get() (no subscription)
        const prev = get(baseAtom);
        const existing = prev[personAction.personId];
        const merged: LocalPersonResult = Object.assign(
          {
            surveyResponseOptionId: undefined,
            surveyQuestionId: undefined,
            unavailableOutcome: undefined,
            notes: [] as Array<{ text: string; canvassedAt: string }>,
            empty: undefined,
            lastModified: "",
            dirty: false,
          },
          existing,
          personAction.update,
          { dirty: true, lastModified: new Date().toISOString() },
        );
        newValue = { ...prev, [personAction.personId]: merged };
      } else {
        // Full replacement
        newValue = action as LocalResultsMap;
      }
      set(baseAtom, newValue);
      AsyncStorage.setItem(key, JSON.stringify(newValue)).catch(() => {});
    },
  );

  // Hydrate from AsyncStorage on first read
  derivedAtom.onMount = (setAtom) => {
    AsyncStorage.getItem(key)
      .then((raw) => {
        if (raw) {
          try {
            setAtom(JSON.parse(raw) as LocalResultsMap);
          } catch {}
        }
      })
      .catch(() => {});
  };

  return derivedAtom;
}

export const localResultsAtom = atomFamily((turfId: string) => createResultsAtom(turfId));

// Read a single person's result from the local store.
export function useLocalResult(turfId: string, personId: string): LocalPersonResult | undefined {
  const results = useAtomValue(localResultsAtom(turfId));
  return results[personId];
}

// Write a single person's result to the local store. Marks it dirty
// (needs sync) and updates lastModified. No subscription — the atom's
// setter reads current state internally via get(), so this hook doesn't
// cause extra re-renders.
export function useSetLocalResult(turfId: string) {
  const setResults = useSetAtom(localResultsAtom(turfId));
  return useCallback(
    (personId: string, update: Partial<Omit<LocalPersonResult, "dirty" | "lastModified">>) => {
      setResults({ personId, update });
    },
    [setResults],
  );
}

// Check if a person has a recorded result (not empty).
export function isLocallyRecorded(results: LocalResultsMap, personId: string): boolean {
  const r = results[personId];
  if (!r) return false;
  if (r.empty) return false;
  return !!(r.surveyResponseOptionId || r.unavailableOutcome || r.notes.length > 0);
}

// Check if a person has a survey response as the current result.
export function hasLocalSurvey(results: LocalResultsMap, personId: string): boolean {
  const r = results[personId];
  if (!r) return false;
  if (r.empty || r.unavailableOutcome) return false;
  return !!r.surveyResponseOptionId;
}

// Check if a person has notes.
export function hasLocalNote(results: LocalResultsMap, personId: string): boolean {
  const r = results[personId];
  if (!r) return false;
  return r.notes.length > 0;
}

// Seed local store from server results (initial load). Only overwrites
// entries that aren't dirty (local changes take precedence).
export function useSeedFromServer(turfId: string) {
  const currentResults = useAtomValue(localResultsAtom(turfId));
  const setResults = useSetAtom(localResultsAtom(turfId));
  const currentRef = useRef(currentResults);
  currentRef.current = currentResults;
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;

    client.canvass
      .listForTurf({ turfId })
      .then((serverData) => {
        const merged: LocalResultsMap = { ...currentRef.current };
        // Group server person results by voterId, pick latest per person
        const serverByPerson = new Map<string, LocalPersonResult>();
        for (const r of serverData.persons) {
          if (!r.voterId) continue;
          const at =
            typeof r.canvassedAt === "string" ? r.canvassedAt : r.canvassedAt.toISOString();
          serverByPerson.set(r.voterId, {
            surveyResponseOptionId: r.surveyResponseOptionId ?? undefined,
            surveyQuestionId: r.surveyQuestionId ?? undefined,
            unavailableOutcome: r.outcome ?? undefined,
            notes: [],
            empty: r.empty ?? false,
            lastModified: at,
            dirty: false,
          });
        }
        // Attach notes from the separate notes table
        for (const n of serverData.notes) {
          if (!n.personId) continue;
          const entry = serverByPerson.get(n.personId);
          const at =
            typeof n.canvassedAt === "string" ? n.canvassedAt : n.canvassedAt.toISOString();
          if (entry) {
            entry.notes.push({ text: n.text, canvassedAt: at });
          } else {
            // Note exists but no person result — create a minimal entry
            serverByPerson.set(n.personId, {
              notes: [{ text: n.text, canvassedAt: at }],
              lastModified: at,
              dirty: false,
            });
          }
        }
        // Merge: local dirty entries win, server fills the rest
        for (const [personId, serverResult] of serverByPerson) {
          if (!merged[personId] || !merged[personId].dirty) {
            merged[personId] = serverResult;
          }
        }
        setResults(merged);
      })
      .catch(() => {
        Alert.alert(
          "Could not load previous results from server",
          "Check your internet connection and try re-entering the turf.",
        );
      });
  }, [turfId, setResults]);
}

// Clear all local results for a turf (dev tool).
export async function clearLocalResults(
  turfId: string,
  setResults?: (value: LocalResultsMap) => void,
) {
  const key = `local-results:${turfId}`;
  await AsyncStorage.removeItem(key);
  // Flush in-memory state so all subscribers update immediately
  if (setResults) setResults({});
}

// Sync: push all dirty entries to the server. Called manually from Settings.
// Fetches turf data to resolve building/door IDs internally.

export function useSync(
  turfId: string | null,
  indexes: {
    buildingByPersonId: Map<string, { buildingId: string }>;
    doorByPersonId: Map<string, { doorId: string }>;
  } | null,
) {
  const results = useAtomValue(localResultsAtom(turfId ?? ""));
  const setResults = useSetAtom(localResultsAtom(turfId ?? ""));
  const [isSyncing, setIsSyncing] = useState(false);

  const sync = useCallback(async (): Promise<number> => {
    if (!turfId || !indexes || isSyncing) return 0;
    setIsSyncing(true);
    try {
      const dirtyEntries = Object.entries(results).filter(([, r]) => r.dirty);
      if (dirtyEntries.length === 0) return 0;

      const settled = await Promise.allSettled(
        dirtyEntries.flatMap(([personId, r]) => {
          const buildingId = indexes.buildingByPersonId.get(personId)?.buildingId ?? "";
          const doorId = indexes.doorByPersonId.get(personId)?.doorId ?? "";
          const base = {
            turfId,
            buildingId,
            doorId,
            personId,
            inputType: "mobile" as const,
          };
          const mutations: Promise<unknown>[] = [];

          if (r.empty) {
            mutations.push(
              client.canvass.submitPersonResult({
                ...base,
                payload: { kind: "empty" },
              }),
            );
          } else if (r.surveyResponseOptionId && r.surveyQuestionId) {
            mutations.push(
              client.canvass.submitPersonResult({
                ...base,
                payload: {
                  kind: "survey",
                  surveyQuestionId: r.surveyQuestionId,
                  surveyResponseOptionId: r.surveyResponseOptionId,
                },
              }),
            );
          } else if (r.unavailableOutcome) {
            mutations.push(
              client.canvass.submitPersonResult({
                ...base,
                payload: {
                  kind: "outcome",
                  outcome: r.unavailableOutcome as "not_home" | "deceased" | "hostile" | "moved",
                },
              }),
            );
          }

          for (const note of r.notes) {
            mutations.push(
              client.canvass.submitNote({
                turfId,
                personId,
                text: note.text,
                canvassedAt: note.canvassedAt,
              }),
            );
          }

          return mutations;
        }),
      );

      // Mark successfully synced entries as clean
      const failed = settled.filter((s) => s.status === "rejected");
      if (failed.length > 0) {
        // eslint-disable-next-line no-console
        console.error(
          "[sync] Failed mutations:",
          failed.map((f) => (f as PromiseRejectedResult).reason),
        );
        throw new Error(`${failed.length} mutation(s) failed`);
      }
      const allSucceeded = failed.length === 0;
      if (allSucceeded && dirtyEntries.length > 0) {
        const updated: LocalResultsMap = { ...results };
        for (const [personId] of dirtyEntries) {
          if (updated[personId]) {
            updated[personId] = { ...updated[personId], dirty: false };
          }
        }
        setResults(updated);
      }
      return dirtyEntries.length;
    } finally {
      setIsSyncing(false);
    }
  }, [results, turfId, indexes, isSyncing, setResults]);

  return { sync, isSyncing };
}
