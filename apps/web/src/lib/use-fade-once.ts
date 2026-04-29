import { useState } from "react";

// Returns `true` the first time `key` is seen in a page session, else
// `false`. Gates a one-time fade-in per route on cold boot.
const consumed = new Set<string>();

export function useFadeOnce(key: string): boolean {
  const [shouldFade] = useState(() => {
    if (consumed.has(key)) return false;
    consumed.add(key);
    return true;
  });
  return shouldFade;
}
