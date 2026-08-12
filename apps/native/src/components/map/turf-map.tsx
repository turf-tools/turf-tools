import {
  Camera,
  type CameraRef,
  CircleLayer,
  MapView,
  ShapeSource,
  type ShapeSourceRef,
  SymbolLayer,
  UserLocation,
} from "@maplibre/maplibre-react-native";
import * as Location from "expo-location";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Linking, Pressable, StyleSheet, Text, View, Platform } from "react-native";
import type { TurfDataBuilding, TurfData } from "@turf-tools/db/schema";
import { useColors } from "@/lib/colors";
import { getMaptilerStyleUrl, isMaptilerKeyConfigured } from "@/lib/maptiler";
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

type BuildingProps = {
  buildingId: string;
  doorCount: number;
  personCount: number;
  // 0 = no result, 1 = unavailable (any recorded), 2 = contacted (any response).
  // Encoded as a number so the cluster aggregation can take the max — response
  // dominates unavailable, unavailable dominates none.
  role: 0 | 1 | 2;
};

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
  // Unlike mapFullyRendered this starts false on iOS too: a PointAnnotation
  // mounted before the map's first fully-rendered frame (warm location →
  // instant first fix) ends up attached but never claimed by the map when
  // its coordinate is off-viewport, showing as a ghost dot pinned near the
  // top-left corner at its raw layout frame. Mounted after, an off-viewport
  // annotation stays invisible until panned into view.
  const [mapReady, setMapReady] = useState(false);
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
  const shapeSourceRef = useRef<ShapeSourceRef>(null);

  // Track the actual camera zoom for tap zoom math.
  const actualZoomRef = useRef(0);
  const handleRegionEvent = useCallback((event: { properties?: { zoomLevel?: number } }) => {
    const z = event?.properties?.zoomLevel;
    if (typeof z === "number") actualZoomRef.current = z;
  }, []);

  const handlePress = useCallback(
    async (e: { features: GeoJSON.Feature[] }) => {
      const feature = e.features?.[0];
      if (!feature) return;

      // Cluster tap — use native getClusterExpansionZoom.
      if (feature.properties?.cluster) {
        if (feature.geometry.type !== "Point") return;
        try {
          const expansionZoom = await shapeSourceRef.current?.getClusterExpansionZoom(feature);
          const targetZoom = Math.max(
            (expansionZoom ?? actualZoomRef.current) + 0.5,
            actualZoomRef.current + 1,
          );
          cameraRef.current?.setCamera({
            centerCoordinate: feature.geometry.coordinates as [number, number],
            zoomLevel: targetZoom,
            padding: {
              paddingTop: 60,
              paddingBottom: 60 + bottomInset,
              paddingLeft: 40,
              paddingRight: 40,
            },
            animationDuration: 350,
          });
        } catch {
          // Fallback: just zoom in
          cameraRef.current?.setCamera({
            centerCoordinate: feature.geometry.coordinates as [number, number],
            zoomLevel: actualZoomRef.current + 2,
            animationDuration: 350,
          });
        }
        return;
      }

      // Individual building tap.
      const id = feature.properties?.buildingId;
      if (typeof id === "string") onBuildingPress?.(id);
    },
    [onBuildingPress, bottomInset],
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
      <MapView
        style={styles.map}
        mapStyle={getMaptilerStyleUrl(isDark)}
        attributionEnabled={false}
        logoEnabled={false}
        rotateEnabled={false}
        pitchEnabled={false}
        // Tints the SDK-native user-location dot (attribution and compass
        // are disabled, so nothing else picks it up).
        tintColor={isDark ? "#ffffff" : "#000000"}
        onDidFinishRenderingMapFully={() => {
          setMapFullyRendered(true);
          setMapReady(true);
        }}
        onRegionIsChanging={handleRegionEvent}
        onRegionDidChange={handleRegionEvent}
      >
        <Camera
          ref={cameraRef}
          defaultSettings={{
            bounds: {
              ne: initialBounds.ne,
              sw: initialBounds.sw,
              paddingTop: 60,
              paddingBottom: 60 + bottomInset,
              paddingLeft: 40,
              paddingRight: 40,
            },
          }}
        />

        <LabelLayers isDark={isDark} />

        <ShapeSource
          ref={shapeSourceRef}
          id={BUILDINGS_SOURCE_ID}
          shape={featureCollection}
          cluster
          clusterRadius={CLUSTER_RADIUS}
          clusterMaxZoomLevel={CLUSTER_MAX_ZOOM}
          maxZoomLevel={TILE_MAX_ZOOM}
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
          hitbox={{ width: 4, height: 4 }}
        >
          {/* Shadow layers */}
          <CircleLayer
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
          <CircleLayer
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
          <CircleLayer
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
          <SymbolLayer
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
          <CircleLayer
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
          <SymbolLayer
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
        </ShapeSource>

        {/* Forked per platform. iOS: the custom dot + heading cone — the
          SDK-native iOS puck can only show a tiny heading arrow outside
          camera-follow mode. Android: the SDK-native puck (tinted via the
          map tintColor) — the custom dot would need MarkerView there,
          which fritzes the status bar and can crash. */}
        {Platform.OS === "ios"
          ? mapReady && <UserLocationDot isDark={isDark} />
          : locationGranted && (
              <UserLocation
                renderMode="native"
                androidRenderMode="compass"
                androidPreferredFramesPerSecond={30}
              />
            )}
      </MapView>
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
        right: 6,
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

function buildFeatureCollection(
  buildings: TurfDataBuilding[],
  buildingRoles: Map<string, "contacted" | "unavailable">,
): GeoJSON.FeatureCollection<GeoJSON.Point, BuildingProps> {
  return {
    type: "FeatureCollection",
    features: buildings
      .filter((b) => b.latitude != null && b.longitude != null)
      .map((b) => {
        const r = buildingRoles.get(b.buildingId);
        const role: 0 | 1 | 2 = r === "contacted" ? 2 : r === "unavailable" ? 1 : 0;
        return {
          type: "Feature" as const,
          geometry: {
            type: "Point" as const,
            coordinates: [b.longitude as number, b.latitude as number],
          },
          properties: {
            buildingId: b.buildingId,
            doorCount: b.doors.length,
            personCount: b.doors.reduce((sum, d) => sum + d.persons.length, 0),
            role,
          },
        };
      }),
  };
}

function boundsForBuildings(buildings: TurfDataBuilding[]): {
  ne: [number, number];
  sw: [number, number];
} {
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  for (const b of buildings) {
    if (b.latitude == null || b.longitude == null) continue;
    if (b.latitude < minLat) minLat = b.latitude;
    if (b.latitude > maxLat) maxLat = b.latitude;
    if (b.longitude < minLng) minLng = b.longitude;
    if (b.longitude > maxLng) maxLng = b.longitude;
  }
  if (!Number.isFinite(minLat)) {
    return { ne: [-73.96, 40.78], sw: [-73.98, 40.76] };
  }
  return { ne: [maxLng, maxLat], sw: [minLng, minLat] };
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
