import AsyncStorage from "@react-native-async-storage/async-storage";
import { atom } from "jotai";

export type Canvasser = { name: string; phone: string | null };

const STORAGE_KEY = "canvasser";
const internal = atom<Canvasser | null>(null);

// Who this device's canvasser says they are — attribution stamped onto
// every canvass event. Device-level and persistent: set once at first turf
// open, editable from Settings. This is a
// sign-in sheet, not an account — no credentials, nothing server-side.
export const canvasserAtom = atom(
  (get) => get(internal),
  (_get, set, next: Canvasser | null) => {
    set(internal, next);
    if (next === null) void AsyncStorage.removeItem(STORAGE_KEY);
    else void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  },
);

// Call once on app boot to rehydrate the atom from AsyncStorage.
export async function loadCanvasser(): Promise<Canvasser | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Canvasser) : null;
  } catch {
    return null;
  }
}
