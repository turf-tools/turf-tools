import { useEffect, useState } from "react";

// Per-route one-time fade-in. Returns a className string suitable for
// the page wrapper:
//   - First visit in this page session: starts at opacity-0, then flips
//     to opacity-100 with a CSS transition after hydration. Works in
//     SSR + prod (transition runs post-hydration, not at HTML parse
//     time the way a CSS keyframe would).
//   - Subsequent visits to the same key: returns the opacity-100 string
//     immediately, no fade.
const consumed = new Set<string>();

export function useFadeOnce(key: string): string {
  const [ready, setReady] = useState(() => consumed.has(key));
  useEffect(() => {
    if (ready) return;
    consumed.add(key);
    const r = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(r);
  }, [key, ready]);
  return ready ? "opacity-100 transition-opacity duration-100" : "opacity-0";
}
