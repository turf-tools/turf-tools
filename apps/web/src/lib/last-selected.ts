// Last-visited entity per (org, section), letting a section's index route
// redirect back to your previous selection instead of its cold-start default.
// Session-scoped on purpose: a reload in the same tab keeps the selection, a
// new browser session starts fresh. Recorded from route components (not
// loaders — those also run on hover preloads, which must not move the
// selection). A stale id is harmless: index loaders validate against the
// fetched list and fall through to their default.

import { useCallback, useEffect, useSyncExternalStore } from "react";

const storageKey = (orgSlug: string, section: string) => `last-selected:${orgSlug}:${section}`;

function removeSelection(orgSlug: string, section: string) {
  try {
    sessionStorage.removeItem(storageKey(orgSlug, section));
  } catch {
    // Best-effort — losing the memory just means the default selection.
  }
}

// try/catch: sessionStorage is absent during SSR and can throw in private modes.
export function rememberSelection(orgSlug: string, section: string, id: string) {
  try {
    sessionStorage.setItem(storageKey(orgSlug, section), id);
  } catch {
    // Best-effort — losing the memory just means the default selection.
  }
}

export function recallSelection(orgSlug: string, section: string): string | null {
  try {
    return sessionStorage.getItem(storageKey(orgSlug, section));
  } catch {
    return null;
  }
}

// Record the visited entity so the section's index redirects back to it.
export function useRememberSelection(orgSlug: string, section: string, id: string) {
  useEffect(() => {
    rememberSelection(orgSlug, section, id);
  }, [orgSlug, section, id]);
}

// In-editor UI state (view modes, overlay selections) remembered the same
// way, as component state. Reads go through useSyncExternalStore so the
// hydration render matches the server (which can't see sessionStorage) —
// the remembered value applies right after; client-side mounts recall it on
// their first render. Stale ids are the caller's problem, same as the index
// loaders: validate against the fetched list and fall through to `fallback`.
const listeners = new Set<() => void>();
export function useRememberedState(
  orgSlug: string,
  section: string,
  fallback: string | null,
): [string | null, (v: string | null) => void] {
  const value = useSyncExternalStore(
    subscribeRemembered,
    () => recallSelection(orgSlug, section) ?? fallback,
    () => fallback,
  );
  const set = useCallback(
    (v: string | null) => {
      if (v == null) removeSelection(orgSlug, section);
      else rememberSelection(orgSlug, section, v);
      for (const l of listeners) l();
    },
    [orgSlug, section],
  );
  return [value, set];
}

function subscribeRemembered(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// Remembered selection while it still exists, else alphabetically first —
// matching the list-column order.
export function recallOrFirst<T extends { name: string }>(
  orgSlug: string,
  section: string,
  items: readonly T[],
  id: (item: T) => string,
): T | undefined {
  const remembered = recallSelection(orgSlug, section);
  return (
    items.find((item) => id(item) === remembered) ??
    [...items].sort((a, b) => a.name.localeCompare(b.name))[0]
  );
}
