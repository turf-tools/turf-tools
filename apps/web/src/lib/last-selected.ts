// Last-visited entity per (org, section), letting a section's index route
// redirect back to your previous selection instead of its cold-start default.
// Session-scoped on purpose: a reload in the same tab keeps the selection, a
// new browser session starts fresh. Recorded from route components (not
// loaders — those also run on hover preloads, which must not move the
// selection). A stale id is harmless: index loaders validate against the
// fetched list and fall through to their default.

import { useEffect } from "react";

const storageKey = (orgSlug: string, section: string) => `last-selected:${orgSlug}:${section}`;

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
