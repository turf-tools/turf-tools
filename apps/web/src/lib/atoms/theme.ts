import { atomWithStorage, createJSONStorage } from "jotai/utils";

// Boolean: true = dark mode, false = light mode. Source of truth for the
// dark-mode toggle in the top bar AND for any component that needs to know
// the active theme (e.g. components/map.tsx picks a different MapTiler
// style URL). The actual `.dark` class on <html> is applied as a side
// effect by user-badge's useEffect.
//
// Persisted to localStorage so the choice survives reloads. `getOnInit`
// reads synchronously on the client to avoid a flash on hydration.
const storage = createJSONStorage<boolean>(() =>
  typeof window === "undefined"
    ? {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      }
    : window.localStorage,
);

export const darkAtom = atomWithStorage<boolean>("dark", false, storage, {
  getOnInit: true,
});
