import { useCallback, useMemo, useRef, useState } from "react";
import MapGL, { Layer, Source, type MapRef } from "react-map-gl/maplibre";
import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import type { TurfData } from "@turf-tools/db/schema";
import { useColors } from "@/lib/colors";
import { getMaptilerStyleUrl, isMaptilerKeyConfigured } from "@/lib/maptiler";
import { MapControls } from "./controls";
import { boundsForBuildings, buildFeatureCollection } from "./turf-data";

// Web implementation of the canvassing map. MapLibre React Native is
// native-only, so this renders through MapLibre GL JS via react-map-gl
// and shares the GeoJSON helpers in turf-data. Layers are written in
// style-spec form (kebab-case paint/layout).
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

export function TurfMap({
  turf,
  buildingRoles,
  onBuildingPress,
  isDark = false,
  bottomInset = 0,
}: Props) {
  const colors = useColors();
  const mapRef = useRef<MapRef>(null);
  const mapBearing = useSharedValue(0);
  const [rotated, setRotated] = useState(false);
  const pressRef = useRef(onBuildingPress);
  pressRef.current = onBuildingPress;

  const featureCollection = useMemo(
    () => buildFeatureCollection(turf.buildings, buildingRoles),
    [turf.buildings, buildingRoles],
  );
  const initialBounds = useMemo(() => boundsForBuildings(turf.buildings), [turf.buildings]);

  const handleMove = useCallback(
    (event: { viewState?: { bearing?: number } }) => {
      const bearing = event.viewState?.bearing ?? 0;
      mapBearing.value = bearing;
      const norm = ((bearing % 360) + 360) % 360;
      const deviation = Math.min(norm, 360 - norm);
      setRotated((prev) => (prev ? deviation > 0.5 : deviation >= 2));
    },
    [mapBearing],
  );

  const handleResetNorth = useCallback(() => {
    mapRef.current?.easeTo({ bearing: 0, duration: 250 });
  }, []);

  // The browser owns location permission here; a denial or missing fix simply
  // does not move the camera.
  const handleLocate = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const map = mapRef.current;
        if (!map) return;
        map.flyTo({
          center: [position.coords.longitude, position.coords.latitude],
          zoom: Math.max(map.getZoom(), 16),
          duration: 400,
        });
      },
      () => {},
      { enableHighAccuracy: false, timeout: 10_000 },
    );
  }, []);

  const handleLoad = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    map.on("click", (event) => {
      // Layers are reapplied on style swaps, so only query ones present.
      const layers = [CLUSTERS_LAYER_ID, BUILDINGS_PINS_LAYER_ID].filter((id) => map.getLayer(id));
      if (layers.length === 0) return;
      const features = map.queryRenderedFeatures(event.point, { layers });
      const feature = features[0];
      if (!feature) return;

      if (feature.properties?.cluster) {
        const source = map.getSource(BUILDINGS_SOURCE_ID) as
          | { getClusterExpansionZoom?: (id: number) => Promise<number> }
          | undefined;
        const clusterId = feature.properties.cluster_id as number;
        const center = (feature.geometry as GeoJSON.Point).coordinates as [number, number];
        void source
          ?.getClusterExpansionZoom?.(clusterId)
          .then((zoom) => {
            map.easeTo({
              center,
              zoom: Math.max(zoom + 0.5, map.getZoom() + 1),
              duration: 350,
            });
          })
          .catch(() => {
            map.easeTo({ center, zoom: map.getZoom() + 2, duration: 350 });
          });
        return;
      }

      const id = feature.properties?.buildingId;
      if (typeof id === "string") pressRef.current?.(id);
    });
  }, []);

  if (!isMaptilerKeyConfigured()) {
    return (
      <View style={styles.missingKey}>
        <Text style={styles.missingKeyText}>
          Set EXPO_PUBLIC_MAPTILER_KEY in apps/native/.env to enable the map.
        </Text>
      </View>
    );
  }

  const clusterColor: ExpressionSpecification = [
    "case",
    ["==", ["get", "minRole"], 0],
    isDark ? "#0a0a0a" : "hsl(0, 0%, 88%)",
    ["==", ["get", "role"], 2],
    colors.contacted.background,
    ["==", ["get", "role"], 1],
    colors.unavailable.background,
    isDark ? "#0a0a0a" : "hsl(0, 0%, 88%)",
  ];

  const layers: LayerSpecification[] = [
    {
      id: `${CLUSTERS_LAYER_ID}-shadow`,
      type: "circle",
      source: BUILDINGS_SOURCE_ID,
      filter: ["has", "point_count"],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["get", "point_count"], 2, 32, 10, 36, 50, 42],
        "circle-color": "hsl(0, 0%, 0%)",
        "circle-opacity": 0.35,
        "circle-blur": 1,
      },
    },
    {
      id: `${BUILDINGS_PINS_LAYER_ID}-shadow`,
      type: "circle",
      source: BUILDINGS_SOURCE_ID,
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 19, 18, 27],
        "circle-color": "hsl(0, 0%, 0%)",
        "circle-opacity": 0.35,
        "circle-blur": 1,
      },
    },
    {
      id: CLUSTERS_LAYER_ID,
      type: "circle",
      source: BUILDINGS_SOURCE_ID,
      filter: ["has", "point_count"],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["get", "point_count"], 2, 20, 10, 24, 50, 30],
        "circle-color": clusterColor,
        "circle-stroke-color": isDark ? "hsl(0, 0%, 80%)" : "hsl(0, 0%, 20%)",
        "circle-stroke-width": isDark ? 1 : 1.5,
      },
    },
    {
      id: CLUSTERS_LABEL_LAYER_ID,
      type: "symbol",
      source: BUILDINGS_SOURCE_ID,
      filter: ["has", "point_count"],
      layout: {
        "text-field": ["get", "doorCount"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 12, 12, 18, 16],
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: { "text-color": isDark ? "hsl(0, 0%, 80%)" : "hsl(0, 0%, 10%)" },
    },
    {
      id: BUILDINGS_PINS_LAYER_ID,
      type: "circle",
      source: BUILDINGS_SOURCE_ID,
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 10, 18, 16],
        "circle-color": [
          "case",
          ["==", ["get", "role"], 2],
          colors.contacted.background,
          ["==", ["get", "role"], 1],
          colors.unavailable.background,
          isDark ? "#1b1b1b" : "hsl(0, 0%, 100%)",
        ] as ExpressionSpecification,
        "circle-stroke-color": isDark ? "hsl(0, 0%, 80%)" : "hsl(0, 0%, 20%)",
        "circle-stroke-width": isDark ? 1 : 1.5,
      },
    },
    {
      id: BUILDINGS_LABEL_LAYER_ID,
      type: "symbol",
      source: BUILDINGS_SOURCE_ID,
      filter: ["!", ["has", "point_count"]],
      layout: {
        "text-field": ["get", "doorCount"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 14, 10, 18, 14],
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: { "text-color": isDark ? "hsl(0, 0%, 80%)" : "hsl(0, 0%, 10%)" },
    },
  ];

  return (
    <View style={styles.map}>
      <MapGL
        ref={mapRef}
        onLoad={handleLoad}
        onMove={handleMove}
        initialViewState={{
          bounds: [
            [initialBounds.sw[0], initialBounds.sw[1]],
            [initialBounds.ne[0], initialBounds.ne[1]],
          ],
          fitBoundsOptions: {
            padding: { top: 60, bottom: 60 + bottomInset, left: 40, right: 40 },
          },
        }}
        attributionControl={false}
        mapStyle={getMaptilerStyleUrl(isDark)}
        style={styles.mapCanvas}
      >
        <Source
          id={BUILDINGS_SOURCE_ID}
          type="geojson"
          data={featureCollection}
          cluster
          clusterRadius={CLUSTER_RADIUS}
          clusterMaxZoom={CLUSTER_MAX_ZOOM}
          clusterProperties={{
            doorCount: [
              ["+", ["accumulated"], ["get", "doorCount"]],
              ["get", "doorCount"],
            ],
            personCount: [
              ["+", ["accumulated"], ["get", "personCount"]],
              ["get", "personCount"],
            ],
            role: [
              ["max", ["accumulated"], ["get", "role"]],
              ["get", "role"],
            ],
            minRole: [
              ["min", ["accumulated"], ["get", "role"]],
              ["get", "role"],
            ],
          }}
        >
          {layers.map((layer) => (
            <Layer key={layer.id} {...layer} />
          ))}
        </Source>
      </MapGL>
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

function AttributionBadge({ isDark }: { isDark: boolean }) {
  const textStyle = {
    fontSize: 10,
    fontFamily: "Geist_400Regular",
    color: isDark ? "#999" : "#555",
  };
  return (
    <View
      style={{
        position: "absolute",
        left: 6,
        bottom: 46,
        flexDirection: "row",
        borderRadius: 4,
        paddingHorizontal: 5,
        paddingVertical: 2,
        backgroundColor: isDark ? "rgba(10,10,10,0.55)" : "rgba(255,255,255,0.55)",
      }}
    >
      <Pressable
        accessibilityRole="link"
        onPress={() => void Linking.openURL("https://www.maptiler.com/copyright/")}
      >
        <Text style={textStyle}>© MapTiler</Text>
      </Pressable>
      <Text style={textStyle}> · </Text>
      <Pressable
        accessibilityRole="link"
        onPress={() => void Linking.openURL("https://www.openstreetmap.org/copyright")}
      >
        <Text style={textStyle}>© OpenStreetMap contributors</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  map: { flex: 1 },
  mapCanvas: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
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
