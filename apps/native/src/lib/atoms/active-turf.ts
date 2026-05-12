import AsyncStorage from "@react-native-async-storage/async-storage";
import { atom } from "jotai";

export type ActiveTurf = { host: string; turfId: string };

const STORAGE_KEY = "active-turf";
const internal = atom<ActiveTurf | null>(null);

// The (host, turfId) pair that scopes everything the app does. Writes mirror
// to AsyncStorage so the binding survives app restart; clearing (set to null)
// removes it. Source of truth for "is the user bound to a turf" — replaces
// the older in-memory `currentTurfIdAtom`.
export const activeTurfAtom = atom(
  (get) => get(internal),
  (_get, set, next: ActiveTurf | null) => {
    set(internal, next);
    if (next === null) void AsyncStorage.removeItem(STORAGE_KEY);
    else void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  },
);

// Call once on app boot to rehydrate the atom from AsyncStorage.
export async function loadActiveTurf(): Promise<ActiveTurf | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ActiveTurf) : null;
  } catch {
    return null;
  }
}
