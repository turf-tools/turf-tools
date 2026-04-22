import { atomWithStorage, createJSONStorage } from "jotai/utils";

// Filter state shared across list-style pages (/lists, /turfs). Object-
// shaped so additional filter dimensions (tags, status, etc.) can be
// added without breaking the atom's signature or the localStorage key.
// Persisted to localStorage so filters stick across reloads.
export type ListFilter = {
  trackId: string | null;
  // Future extensions to consider:
  // tagIds: string[];
  // status: "draft" | "active" | "archived" | null;
};

const DEFAULT_FILTER: ListFilter = {
  trackId: null,
};

const storage = createJSONStorage<ListFilter>(() =>
  typeof window === "undefined"
    ? {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      }
    : window.localStorage,
);

export const listFilterAtom = atomWithStorage<ListFilter>(
  "listFilter",
  DEFAULT_FILTER,
  storage,
  // Read localStorage synchronously at atom initialization so the client's
  // very first render has the persisted value — avoids the SSR-hydrate
  // flash where the default ("All tracks") appears briefly before the
  // stored filter takes effect.
  { getOnInit: true },
);
