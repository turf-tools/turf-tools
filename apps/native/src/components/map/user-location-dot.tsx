import { PointAnnotation } from "@maplibre/maplibre-react-native";
import * as Location from "expo-location";
import { useEffect, useState } from "react";
import { AppState, Image, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

// iOS-only "you are here" marker: a dot with a contrasting outline, a
// subtle expanding halo, and a heading cone (the Google Maps idiom).
// Android renders the SDK-native puck instead (see turf-map): this
// component would need MarkerView there, which fritzes the status bar
// and can crash. Location and heading are watched only while the map is
// mounted, and every failure mode — permission denied, services off, no
// compass — resolves to "no dot" / "no cone": never an alert or
// placeholder.
//
// The rotating cone depends on our patch to @maplibre/maplibre-react-native
// (see patches/): React re-asserts this annotation's layout frame whenever
// its subtree updates, clobbering the map-managed position — without the
// patch the marker ghosts near the map's top-left whenever its coordinate
// is off-screen. Verify against that repro (open a turf far from the
// device) before touching the MLRNPointAnnotation patch hunks.

// The three size knobs. Everything else derives from these: the halo starts
// at the dot's outer edge and expands to HALO_SCALE× it, and the container
// is sized so nothing clips.
const DOT_SIZE = 19; // dot diameter, border included
const OUTLINE_WIDTH = 3;
const HALO_SCALE = 2.25; // halo max diameter as a multiple of the dot

// Cone: a pre-rendered beam sprite under the dot (white-on-alpha, tinted
// per theme; regenerate with scripts/generate-cone-sprites.py — the
// geometry and opacity knobs live there). Width follows reported compass
// accuracy (0–3): the worse the calibration, the wider the beam — and at
// 0 the cone hides entirely, leaving the dot. Rotation is a shared value
// written on the >EMIT_DEGREES cadence, applied on the UI thread.
const CONE_RADIUS = 62;
const CONE_ANGLE_BY_ACCURACY: Record<number, number> = { 3: 55, 2: 75, 1: 100 };
const CONE_SPRITES: Record<number, number> = {
  55: require("../../../assets/map/cone-55.png"),
  75: require("../../../assets/map/cone-75.png"),
  100: require("../../../assets/map/cone-100.png"),
};

// Heading conditioning, not computation — the OS supplies the heading.
// Low-pass on sin/cos components (never the raw angle — averaging across
// the 359°→0° wrap poisons the mean): in-hand jitter of a degree or two
// reads as shimmer at the beam's rim. Then write only on >EMIT_DEGREES of
// filtered movement so a still phone stays quiet.
const HEADING_ALPHA = 0.8; // weight of the previous filtered value
const EMIT_DEGREES = 1.5;

// Below this, a new fix keeps the previous drawn position: with no
// distance filter, stationary GPS jitter (~1m) would make the dot wander
// while the user stands at a door.
const JITTER_METERS = 2;

// Accepted fixes glide the dot from its current drawn position (the
// Google Maps idiom) instead of teleporting ~1m/s hops. Ease-out over
// slightly less than the ~1Hz fix cadence so the dot settles before the
// next fix usually arrives.
const GLIDE_MS = 800;

// Above this, jump instead of gliding: a fix after time backgrounded (or
// a GPS re-lock) can land blocks away, and a cross-map streak reads as
// a glitch, not motion.
const SNAP_METERS = 50;

const DEG = Math.PI / 180;

// Equirectangular approximation — meters between two [lng, lat] points.
// Fine at walking scale; avoids pulling in a geo library for one check.
function metersBetween(a: [number, number], b: [number, number]) {
  const dLng = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * DEG);
  const dLat = b[1] - a[1];
  return Math.hypot(dLng, dLat) * 111_320;
}

export function UserLocationDot({ isDark = false }: { isDark?: boolean }) {
  const [coord, setCoord] = useState<[number, number] | null>(null);
  const [coneAngle, setConeAngle] = useState<number | null>(null);
  const headingDeg = useSharedValue(0);

  useEffect(() => {
    let posSub: Location.LocationSubscription | null = null;
    let headSub: Location.LocationSubscription | null = null;
    let cancelled = false;
    // Generation counter drops stale async starts: a restart that begins
    // while a previous one is still awaiting would otherwise leak the
    // earlier watchers.
    let generation = 0;

    // Glide state. `drawn` is where the dot visually is right now (it
    // trails `target` mid-animation); `target` is the last accepted fix,
    // which the jitter gate compares against. Plain rAF interpolation,
    // not RN Animated — see the reanimated note below for why Animated
    // loops are avoided in this file, and a PointAnnotation coordinate
    // needs a re-render per frame either way.
    let drawn: [number, number] | null = null;
    let target: [number, number] | null = null;
    let raf = 0;

    const glideTo = (fix: [number, number]) => {
      cancelAnimationFrame(raf);
      const from = drawn;
      if (!from || metersBetween(from, fix) > SNAP_METERS) {
        drawn = fix;
        setCoord(fix);
        return;
      }
      let start: number | null = null;
      const step = (now: number) => {
        start ??= now;
        const t = Math.min(1, (now - start) / GLIDE_MS);
        const e = 1 - (1 - t) ** 3; // ease-out cubic
        drawn = [from[0] + (fix[0] - from[0]) * e, from[1] + (fix[1] - from[1]) * e];
        setCoord(drawn);
        if (t < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };

    // Heading filter state, per watcher lifetime.
    let sinSum = 0;
    let cosSum = 0;
    let hasSample = false;
    let emitted: number | null = null;
    let tier = 0;

    const onHeading = (h: Location.LocationHeadingObject) => {
      if (h.accuracy !== tier) {
        tier = h.accuracy;
        setConeAngle(CONE_ANGLE_BY_ACCURACY[tier] ?? null);
      }
      // trueHeading is -1 until a position fix seeds declination; fall
      // back to magnetic rather than showing nothing.
      const raw = h.trueHeading >= 0 ? h.trueHeading : h.magHeading;
      if (raw < 0) return;
      if (!hasSample) {
        sinSum = Math.sin(raw * DEG);
        cosSum = Math.cos(raw * DEG);
        hasSample = true;
      } else {
        sinSum = HEADING_ALPHA * sinSum + (1 - HEADING_ALPHA) * Math.sin(raw * DEG);
        cosSum = HEADING_ALPHA * cosSum + (1 - HEADING_ALPHA) * Math.cos(raw * DEG);
      }
      const filtered = (Math.atan2(sinSum, cosSum) / DEG + 360) % 360;
      const delta = emitted == null ? Infinity : Math.abs(((filtered - emitted + 540) % 360) - 180);
      if (delta > EMIT_DEGREES) {
        emitted = filtered;
        headingDeg.value = filtered;
      }
    };

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
        // distanceInterval 0 streams ~1Hz fixes: a 5m filter delivered
        // movement in visible hops at walking speed. The radio runs
        // either way — the filter only gated delivery, not power.
        const nextPos = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, distanceInterval: 0 },
          (pos) => {
            const fix: [number, number] = [pos.coords.longitude, pos.coords.latitude];
            if (target && metersBetween(target, fix) < JITTER_METERS) return;
            target = fix;
            glideTo(fix);
          },
        );
        if (cancelled || gen !== generation) {
          nextPos.remove();
          return;
        }
        posSub?.remove();
        posSub = nextPos;
        // Compass failure only costs the cone, never the dot.
        try {
          const nextHead = await Location.watchHeadingAsync(onHeading);
          if (cancelled || gen !== generation) {
            nextHead.remove();
            return;
          }
          headSub?.remove();
          headSub = nextHead;
        } catch {
          // No compass, no cone — silent by design.
        }
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
      cancelAnimationFrame(raf);
      appState.remove();
      posSub?.remove();
      headSub?.remove();
    };
  }, [headingDeg]);

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

  const coneStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${headingDeg.value}deg` }],
  }));

  if (coord == null) return null;

  const dotColor = isDark ? "#ffffff" : "#000000";
  const ringColor = isDark ? "#000000" : "#ffffff";
  const containerSize = Math.max(Math.ceil(DOT_SIZE * HALO_SCALE), CONE_RADIUS * 2);

  const marker = (
    <View
      pointerEvents="none"
      className="items-center justify-center"
      style={{ width: containerSize, height: containerSize }}
    >
      {coneAngle != null && (
        <Animated.View
          style={[
            { position: "absolute", width: CONE_RADIUS * 2, height: CONE_RADIUS * 2 },
            coneStyle,
          ]}
        >
          <Image
            source={CONE_SPRITES[coneAngle]}
            style={{ width: CONE_RADIUS * 2, height: CONE_RADIUS * 2, tintColor: dotColor }}
          />
        </Animated.View>
      )}
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
  );

  // PointAnnotation with `enabled: false` — the map's annotation hit-test
  // skips disabled views, so a tap on the dot falls through to whatever
  // map layer is underneath (e.g. the building being stood at). The prop
  // is exposed by our patch to @maplibre/maplibre-react-native (see
  // patches/); MapLibre itself honors it in annotationTagAtPoint.
  return (
    <PointAnnotation id="user-location-dot" coordinate={coord} enabled={false}>
      {marker}
    </PointAnnotation>
  );
}
