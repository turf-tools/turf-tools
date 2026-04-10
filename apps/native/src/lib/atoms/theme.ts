import AsyncStorage from "@react-native-async-storage/async-storage";
import { atomWithStorage, createJSONStorage } from "jotai/utils";

export type Theme = "light" | "dark";

const storage = createJSONStorage<Theme>(() => AsyncStorage);

// Persisted theme preference. Read from any component via `useAtom(themeAtom)`.
// Defaults to "light" on first launch.
export const themeAtom = atomWithStorage<Theme>("theme", "light", storage);
