import {
  Camera,
  type CameraRef,
  CircleLayer,
  MapView,
  ShapeSource,
  type ShapeSourceRef,
  SymbolLayer,
} from "@maplibre/maplibre-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { TurfDataBuilding, TurfData } from "@field-tools/db/schema";
import { getMaptilerStyleUrl, isMaptilerKeyConfigured } from "@/lib/maptiler";
import { LabelLayers } from "./labels";

type Props = {
  turf: TurfData;
  recordedBuildingIds: Set<string>;
  onBuildingPress?: (buildingId: string) => void;
  isDark?: boolean;
  bottomInset?: number;
};

const BUILDINGS_SOURCE_ID = "turf-buildings";
const BUILDINGS_PINS_LAYER_ID = "turf-building-pins";
const BUILDINGS_LABEL_LAYER_ID = "turf-building-labels";
const CLUSTERS_LAYER_ID = "turf-building-clusters";
const CLUSTERS_LABEL_LAYER_ID = "turf-building-clusters-label";

const CLUSTER_RADIUS = 26;
const CLUSTER_MAX_ZOOM = 19;

type BuildingProps = {
  buildingId: string;
  doorCount: number;
  personCount: number;
  recorded: boolean;
};

// Map for the Turf List screen. Uses native MapLibre for GPU-level clustering.
export function TurfMap({
  turf,
  recordedBuildingIds,
  onBuildingPress,
  isDark = false,
  bottomInset = 0,
}: Props) {
  const featureCollection = useMemo(
    () => buildFeatureCollection(turf.buildings, recordedBuildingIds),
    [turf.buildings, recordedBuildingIds],
  );

  const initialBounds = useMemo(() => boundsForBuildings(turf.buildings), [turf.buildings]);
  const cameraRef = useRef<CameraRef>(null);
  const shapeSourceRef = useRef<ShapeSourceRef>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const handleMapLoaded = useCallback(() => setMapLoaded(true), []);

  // Track the actual camera zoom for tap zoom math.
  const actualZoomRef = useRef(0);
  const handleRegionEvent = useCallback((event: { properties?: { zoomLevel?: number } }) => {
    const z = event?.properties?.zoomLevel;
    if (typeof z === "number") actualZoomRef.current = z;
  }, []);

  // Imperative bounds fit AFTER the map style finishes loading.
  useEffect(() => {
    if (!mapLoaded) return;
    cameraRef.current?.fitBounds(
      initialBounds.ne,
      initialBounds.sw,
      [60, 40, 60 + bottomInset, 40],
      0,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapLoaded]);

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
    <MapView
      style={styles.map}
      mapStyle={getMaptilerStyleUrl(isDark)}
      attributionEnabled
      logoEnabled={false}
      onDidFinishLoadingMap={handleMapLoaded}
      onRegionIsChanging={handleRegionEvent}
      onRegionDidChange={handleRegionEvent}
    >
      <Camera ref={cameraRef} />

      <LabelLayers isDark={isDark} />

      <ShapeSource
        ref={shapeSourceRef}
        id={BUILDINGS_SOURCE_ID}
        shape={featureCollection}
        cluster
        clusterRadius={CLUSTER_RADIUS}
        clusterMaxZoomLevel={CLUSTER_MAX_ZOOM}
        clusterProperties={{
          doorCount: [
            ["+", ["accumulated"], ["get", "doorCount"]],
            ["get", "doorCount"],
          ],
          personCount: [
            ["+", ["accumulated"], ["get", "personCount"]],
            ["get", "personCount"],
          ],
          recordedCount: [
            ["+", ["accumulated"], ["get", "recordedCount"]],
            ["case", ["get", "recorded"], 1, 0],
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
            circleColor: [
              "case",
              ["==", ["get", "recordedCount"], ["get", "point_count"]],
              isDark ? "#1A3A45" : "hsl(199, 89%, 80%)",
              isDark ? "#0a0a0a" : "hsl(0, 0%, 88%)",
            ],
            circleStrokeColor: isDark ? "hsl(0, 0%, 40%)" : "hsl(0, 0%, 20%)",
            circleStrokeWidth: 2,
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
              ["==", ["get", "recorded"], true],
              isDark ? "#1A3A45" : "hsl(199, 89%, 80%)",
              isDark ? "#1b1b1b" : "hsl(0, 0%, 100%)",
            ],
            circleStrokeColor: isDark ? "hsl(0, 0%, 40%)" : "hsl(0, 0%, 20%)",
            circleStrokeWidth: 1.5,
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
    </MapView>
  );
}

function buildFeatureCollection(
  buildings: TurfDataBuilding[],
  recordedBuildingIds: Set<string>,
): GeoJSON.FeatureCollection<GeoJSON.Point, BuildingProps> {
  return {
    type: "FeatureCollection",
    features: buildings
      .filter((b) => b.latitude != null && b.longitude != null)
      .map((b) => ({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [b.longitude as number, b.latitude as number],
        },
        properties: {
          buildingId: b.buildingId,
          doorCount: b.doors.length,
          personCount: b.doors.reduce((sum, d) => sum + d.persons.length, 0),
          recorded: recordedBuildingIds.has(b.buildingId),
        },
      })),
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
