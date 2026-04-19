import AsyncStorage from "@react-native-async-storage/async-storage";
import { atomWithStorage, createJSONStorage } from "jotai/utils";

// Sync interval in milliseconds. 0 means manual only.
export type SyncInterval = 0 | 60_000 | 300_000 | 1_800_000 | 3_600_000;

const storage = createJSONStorage<SyncInterval>(() => AsyncStorage);

export const syncIntervalAtom = atomWithStorage<SyncInterval>("syncInterval", 300_000, storage);

export const SYNC_OPTIONS: Array<{ value: SyncInterval; label: string }> = [
  { value: 60_000, label: "1 min" },
  { value: 300_000, label: "5 min" },
  { value: 1_800_000, label: "30 min" },
  { value: 3_600_000, label: "1 hour" },
  { value: 0, label: "Manual" },
];
