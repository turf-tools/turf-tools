import { atomWithStorage, createJSONStorage } from "jotai/utils";

// Filter state shared across the top-level admin pages (/segments, /turfs).
// Object-shaped so additional filter dimensions (tags, status, etc.) can be
// added without breaking the atom's signature or the localStorage key.
// Persisted to localStorage so filters stick across reloads.
export type FilterState = {
  campaignId: string | null;
  // Future extensions to consider:
  // tagIds: string[];
  // status: "draft" | "active" | "archived" | null;
};

const DEFAULT_FILTER: FilterState = {
  campaignId: null,
};

const storage = createJSONStorage<FilterState>(() =>
  typeof window === "undefined"
    ? {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      }
    : window.localStorage,
);

export const filterAtom = atomWithStorage<FilterState>(
  "filter",
  DEFAULT_FILTER,
  storage,
  // Read localStorage synchronously at atom initialization so the client's
  // very first render has the persisted value — avoids the SSR-hydrate
  // flash where the default ("All campaigns") appears briefly before the
  // stored filter takes effect.
  { getOnInit: true },
);
