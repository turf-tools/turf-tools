import AsyncStorage from "@react-native-async-storage/async-storage";
import { atom } from "jotai";

const STORAGE_KEY = "created-by-name";
const internal = atom<string | null>(null);

// Canvasser's name as entered by the device user; sent as `createdByName` on
// every canvass event append. Persists across turf switches — unlike the
// active turf, the name belongs to the device, not the binding.
export const createdByNameAtom = atom(
  (get) => get(internal),
  (_get, set, next: string | null) => {
    set(internal, next);
    if (next === null) void AsyncStorage.removeItem(STORAGE_KEY);
    else void AsyncStorage.setItem(STORAGE_KEY, next);
  },
);

export async function loadCreatedByName(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
