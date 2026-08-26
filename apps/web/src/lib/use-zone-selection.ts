import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

// Zone selection for the reporting pages' table+map split. The whole
// page is the selection surface: a mousedown on chrome outside the map
// clears, a row click re-selects, and that pass through null is what
// flashes the map outline on a re-click (the locating aid).
//
// The corner readout must not flash through the same gap, so it reads
// `cornerZoneId`, which skips the transient null: the outline clears on
// mousedown, the corner waits for the gesture's click to land. A row's
// own onClick re-selects before the document-level click fires (bubble
// order), so a row-to-row move switches the corner directly; a click on
// plain chrome clears it.
export function useZoneSelection(mapWrapperRef: RefObject<HTMLDivElement | null>) {
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [cornerZoneId, setCornerZoneId] = useState<string | null>(null);
  // The one-shot click listener reads the selection as of the click,
  // not as of its own creation.
  const selectedRef = useRef<string | null>(null);

  const select = useCallback((zoneId: string) => {
    selectedRef.current = zoneId;
    setSelectedZoneId(zoneId);
    setCornerZoneId(zoneId);
  }, []);
  const clear = useCallback(() => {
    selectedRef.current = null;
    setSelectedZoneId(null);
    setCornerZoneId(null);
  }, []);

  useEffect(() => {
    if (!selectedZoneId) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (mapWrapperRef.current?.contains(target)) return;
      selectedRef.current = null;
      setSelectedZoneId(null);
      document.addEventListener(
        "click",
        () => {
          if (selectedRef.current === null) setCornerZoneId(null);
        },
        { once: true },
      );
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [selectedZoneId, mapWrapperRef]);

  return { selectedZoneId, cornerZoneId, select, clear };
}
