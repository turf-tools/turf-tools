import {
  Camera,
  type CameraRef,
  type CameraStop,
  GeoJSONSource,
  type GeoJSONSourceRef,
  Layer,
  Map,
  NativeUserLocation,
  type ViewStateChangeEvent,
} from "@maplibre/maplibre-react-native";
import * as Location from "expo-location";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Linking,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSharedValue } from "react-native-reanimated";
import type { TurfData } from "@turf-tools/db/schema";
import { useColors } from "@/lib/colors";
import { getMaptilerStyleUrl, isMaptilerKeyConfigured } from "@/lib/maptiler";
import { MapControls } from "./controls";
import { boundsForBuildings, buildFeatureCollection } from "./turf-data";
import { LabelLayers } from "./labels";
import { UserLocationDot } from "./user-location-dot";

type Props = {
  turf: TurfData;
  buildingRoles: Map<string, "contacted" | "unavailable">;
  onBuildingPress?: (buildingId: string) => void;
  isDark?: boolean;
  bottomInset?: number;
};

const BUILDINGS_SOURCE_ID = "turf-buildings";
const BUILDINGS_PINS_LAYER_ID = "turf-building-pins";
const BUILDINGS_LABEL_LAYER_ID = "turf-building-labels";
const CLUSTERS_LAYER_ID = "turf-building-clusters";
const CLUSTERS_LABEL_LAYER_ID = "turf-building-clusters-label";

const CLUSTER_RADIUS = 20;
const CLUSTER_MAX_ZOOM = 18;
const TILE_MAX_ZOOM = 19;

// Map for the Turf List screen. Uses native MapLibre for GPU-level clustering.
export function TurfMap({
  turf,
  buildingRoles,
  onBuildingPress,
  isDark = false,
  bottomInset = 0,
}: Props) {
  const colors = useColors();
  // Android shows a black frame between the map view mounting and its
  // first fully-rendered frame (maplibre-react-native #367 — no upstream
  // fix). Cover with a theme-colored pane until the map reports ready;
  // iOS doesn't flash, so it keeps its untouched path.
  const [mapFullyRendered, setMapFullyRendered] = useState(Platform.OS === "ios");
  // Android only (iOS's custom dot requests permission itself). The
  // native Android puck never prompts — it checks permission once at
  // style load, silently bails, and never retries — so request via the
  // OS dialog and mount only after the grant. Deferred until the map's
  // first full frame: the dialog over the initializing GL surface leaves
  // it mis-sized (stretched map, offset taps). Denied → no dot, silently.
  const [locationGranted, setLocationGranted] = useState(false);
  useEffect(() => {
    if (Platform.OS !== "android" || !mapFullyRendered) return;
    let cancelled = false;
    Location.requestForegroundPermissionsAsync()
      .then(({ status }) => {
        if (!cancelled && status === "granted") setLocationGranted(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mapFullyRendered]);
  const featureCollection = useMemo(
    () => buildFeatureCollection(turf.buildings, buildingRoles),
    [turf.buildings, buildingRoles],
  );

  const initialBounds = useMemo(() => boundsForBuildings(turf.buildings), [turf.buildings]);
  const cameraRef = useRef<CameraRef>(null);
  const shapeSourceRef = useRef<GeoJSONSourceRef>(null);

  // Track the actual camera zoom for tap zoom math, and the bearing for
  // the compass needle (shared value — per-frame, no re-render) plus its
  // visibility (state — changes only at the show/hide thresholds).
  const actualZoomRef = useRef(0);
  const mapBearing = useSharedValue(0);
  const [rotated, setRotated] = useState(false);
  // Both region events feed this handler: the IsChanging stream for live
  // tracking, and the DidChange for
  // the settle frame, which is the only carrier of an animation's final
  // heading — without it a reset-north stops a hair short of 0 and the
  // compass never hides.
  const handleRegionEvent = useCallback(
    (event: NativeSyntheticEvent<ViewStateChangeEvent>) => {
      const { zoom: z, bearing: h } = event.nativeEvent;
      if (typeof z === "number") actualZoomRef.current = z;
      if (typeof h === "number") {
        mapBearing.value = h;
        // Visibility is purely bearing-derived: appear once clearly
        // rotated, disappear once essentially at north — anything that
        // lands the camera on 0 (the reset animation, iOS's release-snap
        // to north) hides it through the same rule. The gap between the
        // thresholds absorbs settle jitter.
        const norm = ((h % 360) + 360) % 360;
        const deviation = Math.min(norm, 360 - norm);
        setRotated((prev) => (prev ? deviation > 0.5 : deviation >= 2));
      }
    },
    [mapBearing],
  );
  // Camera stops ride a diffed native prop, and gestures never touch
  // it — so a stop identical to the previous one (tap locate twice from
  // the same fix, tap the compass twice) is elided and the camera stays
  // put. Flip-flop a millisecond of duration so every stop is unique.
  // Callers that want motion must pass an easing: a stop without one
  // jumps regardless of duration.
  const stopNonceRef = useRef(0);
  const setCameraStop = useCallback((stop: CameraStop) => {
    stopNonceRef.current = 1 - stopNonceRef.current;
    cameraRef.current?.setStop({
      ...stop,
      duration: (stop.duration ?? 0) + stopNonceRef.current,
    });
  }, []);

  const handleResetNorth = useCallback(() => {
    setCameraStop({ bearing: 0, duration: 250, easing: "ease" });
  }, [setCameraStop]);

  // Center on the user at a working zoom. Cached fix first so the common
  // case is instant; a fresh fix only when there's none. Any failure —
  // permission denied, services off — moves nothing: never an alert.
  const handleLocate = useCallback(async () => {
    try {
      const last = await Location.getLastKnownPositionAsync();
      const pos =
        last ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
      if (!pos) return;
      setCameraStop({
        center: [pos.coords.longitude, pos.coords.latitude],
        zoom: Math.max(actualZoomRef.current, 16),
        duration: 400,
        easing: "ease",
      });
    } catch {
      // No location, no movement — silent by design.
    }
  }, [setCameraStop]);

  const handlePress = useCallback(
    async (event: NativeSyntheticEvent<{ features: GeoJSON.Feature[] }>) => {
      const feature = event.nativeEvent.features?.[0];
      if (!feature) return;

      // Cluster tap — use native getClusterExpansionZoom.
      if (feature.properties?.cluster) {
        if (feature.geometry.type !== "Point") return;
        try {
          const clusterId = feature.properties?.cluster_id as number;
          const expansionZoom = await shapeSourceRef.current?.getClusterExpansionZoom(clusterId);
          const targetZoom = Math.max(
            (expansionZoom ?? actualZoomRef.current) + 0.5,
            actualZoomRef.current + 1,
          );
          setCameraStop({
            center: feature.geometry.coordinates as [number, number],
            zoom: targetZoom,
            padding: { top: 60, bottom: 60 + bottomInset, left: 40, right: 40 },
            duration: 350,
          });
        } catch {
          // Fallback: just zoom in
          setCameraStop({
            center: feature.geometry.coordinates as [number, number],
            zoom: actualZoomRef.current + 2,
            duration: 350,
          });
        }
        return;
      }

      // Individual building tap.
      const id = feature.properties?.buildingId;
      if (typeof id === "string") onBuildingPress?.(id);
    },
    [onBuildingPress, bottomInset, setCameraStop],
  );

  if (!isMaptilerKeyConfigured()) {
    return (
      <View style={styles.missingKey}>
        <Text style={styles.missingKeyText}>
          Set EXPO_PUBLIC_MAPTILER_KEY in apps/native/.env to enable the map.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.map}>
      <Map
        style={styles.map}
        // v11 renders into a GLSurfaceView on Android by default, which draws
        // over sibling React Native views. This screen puts the bottom sheet,
        // the controls and the attribution badge on top of the map, so keep the
        // TextureView the previous major used.
        androidView="texture"
        mapStyle={getMaptilerStyleUrl(isDark)}
        attribution={false}
        logo={false}
        compass={false}
        touchPitch={false}
        // Tints the Android native user-location puck. On iOS it's the
        // inherited fallback for the heading cone's template image — the
        // image's own tintColor is dropped when the screen re-attaches
        // after a push, and UIKit's default fallback is system blue.
        tintColor={isDark ? "#ffffff" : "#000000"}
        onDidFinishRenderingMapFully={() => setMapFullyRendered(true)}
        onRegionIsChanging={handleRegionEvent}
        onRegionDidChange={handleRegionEvent}
      >
        <Camera
          ref={cameraRef}
          initialViewState={{
            bounds: [
              initialBounds.sw[0],
              initialBounds.sw[1],
              initialBounds.ne[0],
              initialBounds.ne[1],
            ],
            padding: { top: 60, bottom: 60 + bottomInset, left: 40, right: 40 },
          }}
        />

        <LabelLayers isDark={isDark} />

        <GeoJSONSource
          ref={shapeSourceRef}
          id={BUILDINGS_SOURCE_ID}
          data={featureCollection}
          cluster
          clusterRadius={CLUSTER_RADIUS}
          clusterMaxZoom={CLUSTER_MAX_ZOOM}
          maxzoom={TILE_MAX_ZOOM}
          clusterProperties={{
            doorCount: [
              ["+", ["accumulated"], ["get", "doorCount"]],
              ["get", "doorCount"],
            ],
            personCount: [
              ["+", ["accumulated"], ["get", "personCount"]],
              ["get", "personCount"],
            ],
            // Aggregate min + max role so the cluster can stay neutral when any
            // member is unrecorded (min = 0), and otherwise color by the
            // strongest signal (max). Mirrors the per-building rule that only
            // colors a building once *every* person is recorded.
            role: [
              ["max", ["accumulated"], ["get", "role"]],
              ["get", "role"],
            ],
            minRole: [
              ["min", ["accumulated"], ["get", "role"]],
              ["get", "role"],
            ],
            recordedCount: [
              ["+", ["accumulated"], ["get", "recordedCount"]],
              ["case", [">", ["get", "role"], 0], 1, 0],
            ],
          }}
          onPress={handlePress}
          hitbox={{ top: 2, right: 2, bottom: 2, left: 2 }}
        >
          {/* Shadow layers */}
          <Layer
            type="circle"
            id={`${CLUSTERS_LAYER_ID}-shadow`}
            filter={["has", "point_count"]}
            style={{
              circleRadius: [
                "interpolate",
                ["linear"],
                ["get", "point_count"],
                2,
                32,
                10,
                36,
                50,
                42,
              ],
              circleColor: "hsl(0, 0%, 0%)",
              circleOpacity: 0.35,
              circleBlur: 1,
            }}
          />
          <Layer
            type="circle"
            id={`${BUILDINGS_PINS_LAYER_ID}-shadow`}
            filter={["!", ["has", "point_count"]]}
            style={{
              circleRadius: ["interpolate", ["linear"], ["zoom"], 14, 19, 18, 27],
              circleColor: "hsl(0, 0%, 0%)",
              circleOpacity: 0.35,
              circleBlur: 1,
            }}
          />

          {/* Cluster bubbles */}
          <Layer
            type="circle"
            id={CLUSTERS_LAYER_ID}
            filter={["has", "point_count"]}
            style={{
              circleRadius: [
                "interpolate",
                ["linear"],
                ["get", "point_count"],
                2,
                20,
                10,
                24,
                50,
                30,
              ],
              // Neutral when any member is unrecorded; otherwise color by the
              // strongest role across the cluster.
              circleColor: [
                "case",
                ["==", ["get", "minRole"], 0],
                isDark ? "#0a0a0a" : "hsl(0, 0%, 88%)",
                ["==", ["get", "role"], 2],
                colors.contacted.background,
                ["==", ["get", "role"], 1],
                colors.unavailable.background,
                isDark ? "#0a0a0a" : "hsl(0, 0%, 88%)",
              ],
              circleStrokeColor: isDark ? "hsl(0, 0%, 80%)" : "hsl(0, 0%, 20%)",
              circleStrokeWidth: isDark ? 1 : 1.5,
            }}
          />
          <Layer
            type="symbol"
            id={CLUSTERS_LABEL_LAYER_ID}
            filter={["has", "point_count"]}
            style={{
              textField: ["get", "doorCount"],
              textSize: ["interpolate", ["linear"], ["zoom"], 12, 12, 18, 16],
              textColor: isDark ? "hsl(0, 0%, 80%)" : "hsl(0, 0%, 10%)",
              textAllowOverlap: true,
              textIgnorePlacement: true,
            }}
          />

          {/* Individual building pins */}
          <Layer
            type="circle"
            id={BUILDINGS_PINS_LAYER_ID}
            filter={["!", ["has", "point_count"]]}
            style={{
              circleRadius: ["interpolate", ["linear"], ["zoom"], 14, 10, 18, 16],
              circleColor: [
                "case",
                ["==", ["get", "role"], 2],
                colors.contacted.background,
                ["==", ["get", "role"], 1],
                colors.unavailable.background,
                isDark ? "#1b1b1b" : "hsl(0, 0%, 100%)",
              ],
              circleStrokeColor: isDark ? "hsl(0, 0%, 80%)" : "hsl(0, 0%, 20%)",
              circleStrokeWidth: isDark ? 1 : 1.5,
            }}
          />
          <Layer
            type="symbol"
            id={BUILDINGS_LABEL_LAYER_ID}
            filter={["!", ["has", "point_count"]]}
            style={{
              textField: ["get", "doorCount"],
              textSize: ["interpolate", ["linear"], ["zoom"], 14, 10, 18, 14],
              textColor: isDark ? "hsl(0, 0%, 80%)" : "hsl(0, 0%, 10%)",
              textAllowOverlap: true,
              textIgnorePlacement: true,
            }}
          />
        </GeoJSONSource>

        {/* Forked per platform. iOS: the custom dot + heading cone — the
          SDK-native iOS puck is a view that swallows taps on whatever is
          under it (no pass-through), and can only show a tiny heading
          arrow outside camera-follow mode. Android: the SDK-native puck,
          GL-rendered so taps pass through — the custom dot would need
          MarkerView there, which fritzes the status bar and can crash. */}
        {Platform.OS === "ios" ? (
          <UserLocationDot isDark={isDark} mapBearing={mapBearing} />
        ) : (
          locationGranted && (
            <NativeUserLocation mode="heading" androidPreferredFramesPerSecond={30} />
          )
        )}
      </Map>
      {!mapFullyRendered && (
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFillObject,
            { backgroundColor: isDark ? "#0a0a0a" : "#fcfcfc" },
          ]}
        />
      )}
      <AttributionBadge isDark={isDark} />
      <MapControls
        bearing={mapBearing}
        rotated={rotated}
        onResetNorth={handleResetNorth}
        onLocate={handleLocate}
        isDark={isDark}
      />
    </View>
  );
}

// Required by MapTiler's terms on every plan (text form; only the logo is
// waivable) and by OSM's ODbL guidelines, which want it visible by default
// — the built-in ⓘ was buried under the bottom sheet and reads as app UI
// anyway. Sits just above the sheet's collapsed peek. Tap opens the
// license pages.
function AttributionBadge({ isDark }: { isDark: boolean }) {
  return (
    <Pressable
      onPress={() =>
        Alert.alert("Map data", "© MapTiler © OpenStreetMap contributors", [
          {
            text: "MapTiler",
            onPress: () => void Linking.openURL("https://www.maptiler.com/copyright/"),
          },
          {
            text: "OpenStreetMap",
            onPress: () => void Linking.openURL("https://www.openstreetmap.org/copyright"),
          },
          { text: "Close", style: "cancel" },
        ])
      }
      style={{
        position: "absolute",
        left: 6,
        // Sheet's collapsed snap is 40 — stay above it.
        bottom: 46,
        borderRadius: 4,
        paddingHorizontal: 5,
        paddingVertical: 2,
        backgroundColor: isDark ? "rgba(10,10,10,0.55)" : "rgba(255,255,255,0.55)",
      }}
    >
      <Text
        style={{
          fontSize: 10,
          fontFamily: "Geist_400Regular",
          color: isDark ? "#999" : "#555",
        }}
      >
        © MapTiler © OpenStreetMap contributors
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  map: { flex: 1 },
  missingKey: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#f5f5f5",
  },
  missingKeyText: {
    fontFamily: "Geist_400Regular",
    color: "#444",
    textAlign: "center",
  },
});
