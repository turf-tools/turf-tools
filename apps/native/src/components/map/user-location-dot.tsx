import { MarkerView } from "@maplibre/maplibre-react-native";
import * as Location from "expo-location";
import { useEffect, useState } from "react";
import { AppState, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

// Minimal "you are here" marker: a dot with a contrasting outline and a
// subtle expanding halo (the Google Maps idiom). Location is watched only
// while the map is mounted, and every failure mode — permission denied,
// services off, watch error — resolves to "no dot": never a prompt, alert,
// or placeholder.

// The three size knobs. Everything else derives from these: the halo starts
// at the dot's outer edge and expands to HALO_SCALE× it, and the container
// is sized to the halo's max so nothing clips.
const DOT_SIZE = 19; // dot diameter, border included
const OUTLINE_WIDTH = 3;
const HALO_SCALE = 2.25; // halo max diameter as a multiple of the dot

export function UserLocationDot({ isDark = false }: { isDark?: boolean }) {
  const [coord, setCoord] = useState<[number, number] | null>(null);

  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;
    // Generation counter drops stale async starts: a restart that begins
    // while a previous one is still awaiting would otherwise leak the
    // earlier watcher.
    let generation = 0;

    // Accuracy.High (GPS, ~10m), not Balanced: Balanced maps to
    // kCLLocationAccuracyHundredMeters on iOS, whose wifi-derived fixes
    // can sit still while the user walks a whole turf — the 5m distance
    // filter compares reported fixes, so the dot froze at the open-time
    // position on device (simulator location jumps masked it).
    const start = async () => {
      const gen = ++generation;
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted" || cancelled || gen !== generation) return;
        const next = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, distanceInterval: 5 },
          (pos) => setCoord([pos.coords.longitude, pos.coords.latitude]),
        );
        if (cancelled || gen !== generation) {
          next.remove();
          return;
        }
        sub?.remove();
        sub = next;
      } catch {
        // No location, no dot — silent by design.
      }
    };
    void start();

    // Restart on foreground: iOS pauses watches it deems stationary
    // (pausesLocationUpdatesAutomatically defaults true and isn't exposed
    // by expo's foreground watch API), and a pause straddling a
    // background/lock cycle is not reliably resumed — a fresh watch
    // un-sticks it after the phone spent time locked in a pocket.
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") void start();
    });
    return () => {
      cancelled = true;
      appState.remove();
      sub?.remove();
    };
  }, []);

  // Reanimated, not the legacy Animated API: native-driver Animated loops
  // attach to a node graph that dies when re-renders/Fast Refresh recreate
  // the view (react-native#14219) — the halo froze on every hot reload.
  // Reanimated's UI-thread worklets re-bind per render, so the pulse
  // survives edits. Gated on hasCoord so the repeat only runs while the
  // marker exists; keyed off hasCoord (not coord) so position updates don't
  // restart it.
  const progress = useSharedValue(0);
  const hasCoord = coord != null;
  useEffect(() => {
    if (!hasCoord) return;
    progress.value = 0;
    // ReduceMotion.Never: reanimated otherwise honors the OS Reduce Motion
    // setting by skipping to the end state — which leaves the halo at
    // opacity 0, i.e. invisible, forever. A ~30px soft pulse is far below
    // the motion scale that setting exists for (Google Maps pulses its dot
    // unconditionally too), and the frozen alternative reads as a bug.
    progress.value = withRepeat(
      withTiming(1, {
        duration: 1800,
        easing: Easing.out(Easing.quad),
        reduceMotion: ReduceMotion.Never,
      }),
      -1,
      false,
      undefined,
      ReduceMotion.Never,
    );
    return () => cancelAnimation(progress);
  }, [hasCoord, progress]);

  const haloStyle = useAnimatedStyle(() => ({
    opacity: 0.35 * (1 - progress.value),
    transform: [{ scale: 1 + (HALO_SCALE - 1) * progress.value }],
  }));

  if (coord == null) return null;

  const dotColor = isDark ? "#ffffff" : "#000000";
  const ringColor = isDark ? "#000000" : "#ffffff";
  const containerSize = Math.ceil(DOT_SIZE * HALO_SCALE);

  return (
    <MarkerView coordinate={coord} allowOverlap>
      <View
        pointerEvents="none"
        className="items-center justify-center"
        style={{ width: containerSize, height: containerSize }}
      >
        <Animated.View
          style={[
            {
              position: "absolute",
              width: DOT_SIZE,
              height: DOT_SIZE,
              borderRadius: DOT_SIZE / 2,
              backgroundColor: dotColor,
            },
            haloStyle,
          ]}
        />
        <View
          className="rounded-full"
          style={{
            width: DOT_SIZE,
            height: DOT_SIZE,
            borderWidth: OUTLINE_WIDTH,
            backgroundColor: dotColor,
            borderColor: ringColor,
          }}
        />
      </View>
    </MarkerView>
  );
}
