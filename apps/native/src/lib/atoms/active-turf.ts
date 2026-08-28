import AsyncStorage from "@react-native-async-storage/async-storage";
import { atom } from "jotai";

// walkId is the sign-out recorded at bind, stamped onto every event.
// Absent on bindings persisted before the stamp existed.
export type ActiveTurf = { host: string; turfId: string; walkId?: string };

const STORAGE_KEY = "active-turf";
const internal = atom<ActiveTurf | null>(null);

// Survives the unbind: the debounced last result can flush during the
// unbind teardown, after the atom is already null — the walk stamp falls
// back to this so that event still attributes to the walk it belongs to.
let lastBound: ActiveTurf | null = null;
export function lastBoundTurf(): ActiveTurf | null {
  return lastBound;
}

// The (host, turfId) pair that scopes everything the app does. Writes mirror
// to AsyncStorage so the binding survives app restart; clearing (set to null)
// removes it. Source of truth for "is the user bound to a turf."
export const activeTurfAtom = atom(
  (get) => get(internal),
  (_get, set, next: ActiveTurf | null) => {
    set(internal, next);
    if (next !== null) lastBound = next;
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
