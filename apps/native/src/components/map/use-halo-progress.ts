import { useEffect, useState } from "react";
import { AppState, Platform } from "react-native";

const HALO_MS = 1800;
// The reset needs its own committed frame before the next run starts.
// Fabric coalesces the two updates when they land in the same tick, which
// leaves the halo at opacity 0 for every cycle after the first.
const HALO_RESET_MS = 100;

export type HaloFrame = {
  progress: number;
  transitionMs: number;
};

const IDLE: HaloFrame = { progress: 0, transitionMs: 0 };

// The halo is a map layer, so the pulse runs on MapLibre's paint transition
// clock instead of a React timer per frame. Two renders per cycle are enough:
// one to start the transition, one to snap back before the next cycle.
export function useHaloProgress(active: boolean): HaloFrame {
  const [frame, setFrame] = useState<HaloFrame>(IDLE);
  const [appActive, setAppActive] = useState(AppState.currentState === "active");

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setAppActive(
        state === "active" &&
          (Platform.OS !== "web" ||
            typeof document === "undefined" ||
            document.visibilityState === "visible"),
      );
    });

    let removeVisibility: (() => void) | undefined;
    if (Platform.OS === "web" && typeof document !== "undefined") {
      const onVisibility = () => {
        setAppActive(document.visibilityState === "visible");
      };
      document.addEventListener("visibilitychange", onVisibility);
      onVisibility();
      removeVisibility = () => document.removeEventListener("visibilitychange", onVisibility);
    }

    return () => {
      subscription.remove();
      removeVisibility?.();
    };
  }, []);

  useEffect(() => {
    if (!active || !appActive) {
      setFrame(IDLE);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cycle = () => {
      if (cancelled) return;
      setFrame({ progress: 1, transitionMs: HALO_MS });
      timer = setTimeout(() => {
        if (cancelled) return;
        setFrame(IDLE);
        timer = setTimeout(cycle, HALO_RESET_MS);
      }, HALO_MS);
    };

    cycle();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, appActive]);

  return frame;
}
