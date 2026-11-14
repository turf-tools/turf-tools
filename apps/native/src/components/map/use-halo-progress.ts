import { useEffect, useState } from "react";

const HALO_MS = 1800;
// A GeoJSON layer cannot be driven by a Reanimated worklet, so the pulse
// is a small timer. 20fps is enough for a soft halo and avoids
// re-rendering the map at 60fps.
const HALO_FRAME_MS = 50;

export function useHaloProgress(active: boolean): number {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!active) {
      setProgress(0);
      return;
    }

    let cancelled = false;
    const start = Date.now();
    const tick = () => {
      if (cancelled) return;
      const t = ((Date.now() - start) % HALO_MS) / HALO_MS;
      setProgress(1 - (1 - t) ** 2);
    };

    tick();
    const timer = setInterval(tick, HALO_FRAME_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active]);

  return progress;
}
