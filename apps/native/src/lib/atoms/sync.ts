import AsyncStorage from "@react-native-async-storage/async-storage";
import { atom } from "jotai";
import { atomWithStorage, createJSONStorage } from "jotai/utils";

// Sync interval in milliseconds. 0 means manual only.
export type SyncInterval = 0 | 30_000 | 300_000 | 3_600_000;

const storage = createJSONStorage<SyncInterval>(() => AsyncStorage);

export const syncIntervalAtom = atomWithStorage<SyncInterval>("syncInterval", 30_000, storage);

// True while the user has tapped "Sync now" and the corresponding pull
// is still in flight. Lives at module level (not component state) so
// closing and reopening Settings mid-sync still shows the in-flight
// state, preventing a second tap from queuing a duplicate request.
// Background polls don't touch this — they're silent by design.
export const userSyncingAtom = atom(false);

export const SYNC_OPTIONS: Array<{ value: SyncInterval; label: string }> = [
  { value: 30_000, label: "30 sec" },
  { value: 300_000, label: "5 min" },
  { value: 3_600_000, label: "1 hour" },
  { value: 0, label: "Manual" },
];
