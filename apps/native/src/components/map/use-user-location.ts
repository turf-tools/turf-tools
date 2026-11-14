import * as Location from "expo-location";
import { useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";

// Below this, a new fix keeps the previous drawn position: with no
// distance filter, stationary GPS jitter (~1m) would make the dot wander
// while the user stands at a door.
const JITTER_METERS = 2;

// Accepted fixes glide from the current drawn position (the Google Maps
// idiom) instead of teleporting ~1m/s hops. Ease-out over well under the
// fix cadence so the dot settles before the next fix arrives.
const GLIDE_MS = 800;

// Above this, jump instead of gliding: a fix after time backgrounded (or
// a GPS re-lock) can land blocks away, and a cross-map streak reads as a
// glitch, not motion.
const SNAP_METERS = 50;

// Cached fixes are only a cold-start shortcut. Older than this and the dot
// can open a neighbourhood away from where the canvasser actually is.
const LAST_KNOWN_MAX_AGE_MS = 60_000;
const LAST_KNOWN_REQUIRED_ACCURACY_M = 100;

// The map source is updated at ~12Hz rather than every animation frame.
// A GeoJSON source update is much more expensive than a Reanimated
// transform; this keeps the glide smooth without re-rendering React at
// 60fps.
const POSITION_EMIT_MS = 80;

// Heading conditioning, not computation — the OS supplies the heading.
// Low-pass on sin/cos components (never the raw angle — averaging across
// the 359°→0° wrap poisons the mean): in-hand jitter of a degree or two
// reads as shimmer at the beam's rim. Then write only on >EMIT_DEGREES of
// filtered movement so a still phone stays quiet.
const HEADING_ALPHA = 0.8;
const EMIT_DEGREES = 1.5;

const DEG = Math.PI / 180;

// Equirectangular approximation — meters between two [lng, lat] points.
// Fine at walking scale; avoids pulling in a geo library for one check.
export function metersBetween(a: [number, number], b: [number, number]) {
  const dLng = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * DEG);
  const dLat = b[1] - a[1];
  return Math.hypot(dLng, dLat) * 111_320;
}

export type UserLocation = {
  position: [number, number] | null;
  heading: number | null;
  headingAccuracy: number | null;
};

type UseUserLocationOptions = {
  enabled: boolean;
  onPosition?: (position: [number, number]) => void;
};

// StrictMode and the foreground restart can both run start() while the
// first permission request is in flight. Cache the request so the OS
// dialog is not opened twice over the map.
let foregroundPermission: Promise<boolean> | null = null;

function ensureForegroundPermission(): Promise<boolean> {
  foregroundPermission ??= Location.requestForegroundPermissionsAsync()
    .then(({ status }) => {
      const granted = status === "granted";
      if (!granted) foregroundPermission = null;
      return granted;
    })
    .catch(() => {
      foregroundPermission = null;
      return false;
    });
  return foregroundPermission;
}

// Watches the user's position and heading while `enabled` is true. The
// native path uses expo-location; the web path uses the browser's
// geolocation API because Expo's web heading implementation is a no-op.
export function useUserLocation({ enabled, onPosition }: UseUserLocationOptions): UserLocation {
  const [position, setPosition] = useState<[number, number] | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [headingAccuracy, setHeadingAccuracy] = useState<number | null>(null);

  const appStateRef = useRef(AppState.currentState);
  const onPositionRef = useRef(onPosition);

  useEffect(() => {
    onPositionRef.current = onPosition;
  }, [onPosition]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let generation = 0;

    // `drawn` is where the dot visually is; `target` is the last accepted
    // fix, which the jitter gate compares against.
    let drawn: [number, number] | null = null;
    let target: [number, number] | null = null;
    let raf = 0;
    let lastEmit = 0;

    let positionSub: Location.LocationSubscription | null = null;
    let headingSub: Location.LocationSubscription | null = null;
    let webWatchId: number | null = null;

    const publishPosition = (next: [number, number], force = false) => {
      if (cancelled) return;
      const now = Date.now();
      if (!force && now - lastEmit < POSITION_EMIT_MS) return;
      lastEmit = now;
      onPositionRef.current?.(next);
      setPosition(next);
    };

    const glideTo = (fix: [number, number]) => {
      cancelAnimationFrame(raf);
      const from = drawn;
      if (!from || metersBetween(from, fix) > SNAP_METERS) {
        drawn = fix;
        publishPosition(fix, true);
        return;
      }

      let start: number | null = null;
      const step = (now: number) => {
        start ??= now;
        const t = Math.min(1, (now - start) / GLIDE_MS);
        const eased = 1 - (1 - t) ** 3;
        drawn = [from[0] + (fix[0] - from[0]) * eased, from[1] + (fix[1] - from[1]) * eased];
        publishPosition(drawn, t === 1);
        if (t < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };

    const onFix = (fix: [number, number]) => {
      if (cancelled) return;
      if (target && metersBetween(target, fix) < JITTER_METERS) return;
      target = fix;
      glideTo(fix);
    };

    let sinSum = 0;
    let cosSum = 0;
    let hasHeadingSample = false;
    let emittedHeading: number | null = null;
    let emittedAccuracy: number | null = null;

    const onHeading = (sample: Location.LocationHeadingObject) => {
      if (cancelled) return;

      if (sample.accuracy !== emittedAccuracy) {
        emittedAccuracy = sample.accuracy;
        setHeadingAccuracy(sample.accuracy);
      }

      // trueHeading is -1 until a position fix seeds declination; fall
      // back to magnetic rather than showing nothing.
      const raw = sample.trueHeading >= 0 ? sample.trueHeading : sample.magHeading;
      if (raw < 0) return;

      if (!hasHeadingSample) {
        sinSum = Math.sin(raw * DEG);
        cosSum = Math.cos(raw * DEG);
        hasHeadingSample = true;
      } else {
        sinSum = HEADING_ALPHA * sinSum + (1 - HEADING_ALPHA) * Math.sin(raw * DEG);
        cosSum = HEADING_ALPHA * cosSum + (1 - HEADING_ALPHA) * Math.cos(raw * DEG);
      }

      const filtered = (Math.atan2(sinSum, cosSum) / DEG + 360) % 360;
      const delta =
        emittedHeading == null
          ? Number.POSITIVE_INFINITY
          : Math.abs(((filtered - emittedHeading + 540) % 360) - 180);
      if (delta > EMIT_DEGREES) {
        emittedHeading = filtered;
        setHeading(filtered);
      }
    };

    const startNative = async () => {
      const gen = ++generation;
      try {
        const granted = await ensureForegroundPermission();
        if (!granted || cancelled || gen !== generation) return;

        // Accuracy.High (GPS, ~10m), not Balanced: Balanced maps to
        // kCLLocationAccuracyHundredMeters on iOS, whose wifi-derived
        // fixes can sit still while the user walks a whole turf.
        // Seed from a recent cached fix so the dot appears immediately
        // after a cold mount; a foreground restart keeps the dot's last
        // drawn position instead, since an old cache can be blocks away.
        if (gen === 1) {
          const lastKnown = await Location.getLastKnownPositionAsync({
            maxAge: LAST_KNOWN_MAX_AGE_MS,
            requiredAccuracy: LAST_KNOWN_REQUIRED_ACCURACY_M,
          }).catch(() => null);
          if (cancelled || gen !== generation) return;
          if (lastKnown) {
            onFix([lastKnown.coords.longitude, lastKnown.coords.latitude]);
          }
        }

        const nextPosition = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, distanceInterval: 0 },
          (fix) => onFix([fix.coords.longitude, fix.coords.latitude]),
        );
        if (cancelled || gen !== generation) {
          nextPosition.remove();
          return;
        }
        positionSub?.remove();
        positionSub = nextPosition;

        // Compass failure only costs the cone, never the dot.
        try {
          const nextHeading = await Location.watchHeadingAsync(onHeading);
          if (cancelled || gen !== generation) {
            nextHeading.remove();
            return;
          }
          headingSub?.remove();
          headingSub = nextHeading;
        } catch {
          // No compass, no cone.
        }
      } catch {
        // No location, no dot.
      }
    };

    const stopWatches = () => {
      // Invalidate any start that is still awaiting permission or a watch
      // subscription, then drop what is already live.
      generation += 1;
      positionSub?.remove();
      positionSub = null;
      headingSub?.remove();
      headingSub = null;
      cancelAnimationFrame(raf);
      raf = 0;
    };

    const startWeb = () => {
      // Browsers do not expose a reliable compass heading here, so the web
      // dot renders without the cone.
      if (typeof navigator === "undefined" || !navigator.geolocation) return;
      if (webWatchId != null) navigator.geolocation.clearWatch(webWatchId);
      try {
        webWatchId = navigator.geolocation.watchPosition(
          (fix) => onFix([fix.coords.longitude, fix.coords.latitude]),
          () => {},
          { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 },
        );
      } catch {
        // Insecure contexts and browsers without geolocation leave no dot.
      }
    };

    if (Platform.OS === "web") {
      startWeb();
    } else {
      void startNative();
    }

    // Stop watches while the app is not visible. iOS pauses location
    // watches it deems stationary, and Android can keep the sensors alive
    // behind another app. Restart on foreground so a paused watch does not
    // survive the trip.
    const appState =
      Platform.OS === "web"
        ? null
        : AppState.addEventListener("change", (state) => {
            const previous = appStateRef.current;
            appStateRef.current = state;
            if (state === "active") {
              if (previous !== "active") void startNative();
            } else {
              stopWatches();
            }
          });

    const visibility =
      Platform.OS === "web" && typeof document !== "undefined"
        ? () => {
            if (document.visibilityState === "hidden") {
              if (webWatchId != null && typeof navigator !== "undefined") {
                navigator.geolocation.clearWatch(webWatchId);
                webWatchId = null;
              }
              cancelAnimationFrame(raf);
              raf = 0;
            } else {
              startWeb();
            }
          }
        : null;
    if (visibility) document.addEventListener("visibilitychange", visibility);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      appState?.remove();
      if (visibility) document.removeEventListener("visibilitychange", visibility);
      positionSub?.remove();
      headingSub?.remove();
      if (webWatchId != null && typeof navigator !== "undefined") {
        navigator.geolocation.clearWatch(webWatchId);
      }
    };
  }, [enabled]);

  return { position, heading, headingAccuracy };
}
