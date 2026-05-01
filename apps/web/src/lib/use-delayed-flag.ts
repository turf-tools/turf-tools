import { useEffect, useRef, useState } from "react";

// Debounces a transient boolean (typically a loading/pending flag) so
// fast operations don't flash an indicator and slow ones don't yank
// it away the moment they finish.
//
// - `showAfter`: only flip true once the input has been true this long.
//   Anything that resolves faster never shows a spinner at all.
// - `minVisible`: once shown, stay visible at least this long. Prevents
//   pop-and-disappear when the input clears just after it crossed the
//   `showAfter` threshold.
export function useDelayedFlag(
  value: boolean,
  { showAfter = 100, minVisible = 200 } = {},
): boolean {
  const [shown, setShown] = useState(false);
  const shownAtRef = useRef(0);
  useEffect(() => {
    if (value && !shown) {
      const t = setTimeout(() => {
        shownAtRef.current = Date.now();
        setShown(true);
      }, showAfter);
      return () => clearTimeout(t);
    }
    if (!value && shown) {
      const remaining = Math.max(0, minVisible - (Date.now() - shownAtRef.current));
      if (remaining === 0) {
        setShown(false);
        return;
      }
      const t = setTimeout(() => setShown(false), remaining);
      return () => clearTimeout(t);
    }
  }, [value, shown, showAfter, minVisible]);
  return shown;
}
