import { useEffect, useRef } from "react";

export type HotkeyOptions = {
  /** A single key or alternatives that all fire `onMatch`. */
  key: string | string[];
  /** Require ⌘ on macOS / Ctrl elsewhere. */
  mod?: boolean;
  /** Listener only attaches while true. */
  enabled: boolean;
  /** Skip when focus is in a text input or contenteditable. Default true. */
  ignoreInputs?: boolean;
  /** Skip when any `[role="dialog"]` element exists in the DOM. Default true. */
  ignoreOpenDialogs?: boolean;
  onMatch: () => void;
};

export function useHotkey({
  key,
  mod = false,
  enabled,
  ignoreInputs = true,
  ignoreOpenDialogs = true,
  onMatch,
}: HotkeyOptions) {
  // Stable ref so callers don't need to memoize onMatch.
  const onMatchRef = useRef(onMatch);
  onMatchRef.current = onMatch;

  const keysSerialized = Array.isArray(key) ? key.join("|") : key;

  useEffect(() => {
    if (!enabled) return;
    const keys = Array.isArray(key) ? key : [key];
    const handler = (e: KeyboardEvent) => {
      if (!keys.includes(e.key)) return;
      const hasMod = e.metaKey || e.ctrlKey;
      if (mod && !hasMod) return;
      if (!mod && hasMod) return;
      if (ignoreOpenDialogs && document.querySelector('[role="dialog"]')) return;
      if (ignoreInputs) {
        const t = e.target;
        if (
          t instanceof HTMLElement &&
          (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
        ) {
          return;
        }
      }
      e.preventDefault();
      onMatchRef.current();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
    // `key` is captured via the serialized form so array literals don't churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, mod, ignoreInputs, ignoreOpenDialogs, keysSerialized]);
}
