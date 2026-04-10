import {
  Camera,
  type CameraRef,
  CircleLayer,
  MapView,
  ShapeSource,
  SymbolLayer,
} from "@maplibre/maplibre-react-native";
import Supercluster from "supercluster";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { TurfDataBuilding, TurfData } from "@field-tools/db/schema";
import { isMaptilerKeyConfigured, MAPTILER_STYLE_URL } from "@/lib/maptiler";
import { LabelLayers } from "./labels";

type Props = {
  turf: TurfData;
  recordedBuildingIds: Set<string>;
  onBuildingPress?: (buildingId: string) => void;
  // Pixels to reserve at the bottom of the map when auto-fitting bounds.
  // The List screen uses this to keep the buildings above the bottom sheet.
  bottomInset?: number;
};

const BUILDINGS_SOURCE_ID = "turf-buildings";
const BUILDINGS_PINS_LAYER_ID = "turf-building-pins";
const BUILDINGS_LABEL_LAYER_ID = "turf-building-labels";
const CLUSTERS_LAYER_ID = "turf-building-clusters";
const CLUSTERS_LABEL_LAYER_ID = "turf-building-clusters-label";

const CLUSTER_RADIUS = 36; // pixels — points within this radius cluster together; ~2× the visible circle radius so circles cluster only when they'd visually overlap
const CLUSTER_MAX_ZOOM = 19; // above this zoom, no clustering
const CLUSTER_MIN_ZOOM = 0; // below this zoom, no points

// Properties stored on each building feature passed to Supercluster. Cluster
// features inherit aggregated versions of these via `map`/`reduce` below.
type BuildingProps = {
  buildingId: string;
  doorCount: number;
  personCount: number;
  recorded: boolean;
};

// Properties Supercluster aggregates onto each cluster feature. The library
// computes these via the `map`/`reduce` callbacks we pass to its constructor.
type ClusterProps = {
  personCount: number;
  doorCount: number;
  recordedCount: number;
};

// Map for the Turf List screen. Renders the basemap, the OpenMapTiles label
// overlay, and clustered building pins. The parent screen passes a
// `bottomInset` so the camera leaves room for the bottom sheet on initial fit.
//
// Clustering is done CLIENT-SIDE in JS via the `supercluster` npm package
// (the same algorithm MapLibre uses internally), not via the native binding's
// `cluster={true}` prop on ShapeSource. The native binding's clusterProperties
// aggregation doesn't propagate values onto cluster features in this version,
// and getClusterExpansionZoom is unreliable for tightly-packed clusters.
// Doing it in JS gives us full control and reliable behavior.
export function TurfMap({ turf, recordedBuildingIds, onBuildingPress, bottomInset = 0 }: Props) {
  const buildingFeatures = useMemo(
    () => buildBuildingFeatures(turf.buildings, recordedBuildingIds),
    [turf.buildings, recordedBuildingIds],
  );

  const initialBounds = useMemo(() => boundsForBuildings(turf.buildings), [turf.buildings]);
  const cameraRef = useRef<CameraRef>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const handleMapLoaded = useCallback(() => setMapLoaded(true), []);

  // Build a fresh Supercluster index whenever the underlying buildings or
  // recorded set changes. The index loads all features once and serves
  // cluster queries efficiently for any zoom level.
  const cluster = useMemo(() => {
    const sc = new Supercluster<BuildingProps, ClusterProps>({
      radius: CLUSTER_RADIUS,
      maxZoom: CLUSTER_MAX_ZOOM,
      minZoom: CLUSTER_MIN_ZOOM,
      map: (props) => ({
        personCount: props.personCount,
        doorCount: props.doorCount,
        recordedCount: props.recorded ? 1 : 0,
      }),
      reduce: (accumulated, props) => {
        accumulated.personCount += props.personCount;
        accumulated.doorCount += props.doorCount;
        accumulated.recordedCount += props.recordedCount;
      },
    });
    sc.load(buildingFeatures);
    return sc;
  }, [buildingFeatures]);

  // Cluster zoom level — stored as the integer-floored camera zoom. We
  // listen to both `onRegionIsChanging` (live during a gesture) and
  // `onRegionDidChange` (after the gesture ends), which gives live cluster
  // updates as the user pinches. The dedup against the previous floor
  // means consecutive events at the same integer zoom don't re-trigger
  // cluster computation. A turf caps at ~70 doors so the recompute is
  // microseconds of work — no need to throttle.
  //
  // Known imperfection: a double-tap zoom is one user gesture but
  // animates across two integer boundaries, producing two cluster
  // re-layouts. Live attempts to detect "this is an animation, not a
  // pinch" via isUserInteraction or velocity heuristics didn't pan out;
  // we accept the visual flash for now and revisit later.
  const [cameraZoom, setCameraZoom] = useState(0);

  // Track the actual (non-floored) camera zoom alongside the integer state.
  // The float value is what setCamera math should reason about; the integer
  // state is what Supercluster's getClusters needs.
  const actualZoomRef = useRef(0);

  const updateCameraZoom = useCallback((zoomLevel: number) => {
    actualZoomRef.current = zoomLevel;
    const floored = Math.floor(zoomLevel);
    setCameraZoom((prev) => (prev === floored ? prev : floored));
  }, []);

  // Single region-event handler wired to both `onRegionIsChanging` (live
  // during a gesture) and `onRegionDidChange` (after settle). Updates only
  // when the floored zoom changes, so consecutive events at the same
  // integer zoom don't re-trigger cluster computation.
  const handleRegionEvent = useCallback(
    (event: { properties?: { zoomLevel?: number } }) => {
      const z = event?.properties?.zoomLevel;
      if (typeof z === "number") updateCameraZoom(z);
    },
    [updateCameraZoom],
  );

  // Snapshot of clusters/points visible at the current zoom. We pass world
  // bounds (the whole earth) so we get every feature; for ED-scale data
  // this is fast. If we ever scale to thousands of buildings we can switch
  // to viewport-bounds via mapRef.getVisibleBounds() and re-query on pan.
  const visibleFeatures = useMemo(() => {
    const features = cluster.getClusters([-180, -85, 180, 85], cameraZoom);
    return {
      type: "FeatureCollection" as const,
      features,
    };
  }, [cluster, cameraZoom]);

  // Imperative bounds fit AFTER the map style finishes loading. Calling
  // fitBounds before the map is ready silently no-ops, leaving the camera at
  // its default world view.
  useEffect(() => {
    if (!mapLoaded) return;
    cameraRef.current?.fitBounds(
      initialBounds.ne,
      initialBounds.sw,
      [60, 40, 60 + bottomInset, 40],
      0,
    );
    // We only want this to run once after the map first loads. bounds and
    // bottomInset are captured at the moment the map becomes ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapLoaded]);

  const handlePress = useCallback(
    (e: { features: GeoJSON.Feature[] }) => {
      const feature = e.features?.[0];
      if (!feature) return;

      // Cluster features have `cluster: true` and `cluster_id` set by
      // Supercluster. We use the JS Supercluster instance directly to get
      // the expansion zoom — much more reliable than the native binding's
      // getClusterExpansionZoom.
      if (feature.properties?.cluster && typeof feature.properties.cluster_id === "number") {
        if (feature.geometry.type !== "Point") return;
        try {
          const expansionZoom = cluster.getClusterExpansionZoom(feature.properties.cluster_id);
          // Always overshoot enough to guarantee the cluster dissolves into
          // individual pins, even if Supercluster's calculated expansionZoom
          // would still leave them clustered (which can happen for very
          // tight clusters). Use the actual (float) camera zoom — not the
          // integer state — so taps near a zoom boundary still produce a
          // meaningful camera move.
          const targetZoom = Math.max(expansionZoom + 0.5, actualZoomRef.current + 1);

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
          // Cluster id may be stale if the index was rebuilt; ignore.
        }
        return;
      }

      // Otherwise it's an individual building.
      const id = feature.properties?.buildingId;
      if (typeof id === "string") onBuildingPress?.(id);
    },
    [cluster, onBuildingPress, bottomInset],
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
      mapStyle={MAPTILER_STYLE_URL}
      attributionEnabled
      logoEnabled={false}
      onDidFinishLoadingMap={handleMapLoaded}
      onRegionIsChanging={handleRegionEvent}
      onRegionDidChange={handleRegionEvent}
    >
      <Camera ref={cameraRef} />

      <LabelLayers />

      <ShapeSource id={BUILDINGS_SOURCE_ID} shape={visibleFeatures} onPress={handlePress}>
        {/* Shadow layers — render BEFORE the main pin/cluster layers so they
            sit underneath visually. Larger radius pokes the shadow out from
            under the pin, soft blur softens the edge, moderate opacity. */}
        <CircleLayer
          id={`${CLUSTERS_LAYER_ID}-shadow`}
          filter={["==", ["get", "cluster"], true]}
          style={{
            circleRadius: [
              "interpolate",
              ["linear"],
              ["get", "point_count"],
              2,
              42,
              10,
              48,
              50,
              56,
            ],
            circleColor: "hsl(0, 0%, 0%)",
            circleOpacity: 0.35,
            circleBlur: 1,
          }}
        />
        <CircleLayer
          id={`${BUILDINGS_PINS_LAYER_ID}-shadow`}
          filter={["!=", ["get", "cluster"], true]}
          style={{
            circleRadius: ["interpolate", ["linear"], ["zoom"], 14, 25, 18, 36],
            circleColor: "hsl(0, 0%, 0%)",
            circleOpacity: 0.35,
            circleBlur: 1,
          }}
        />

        {/* Cluster bubbles — bigger and shaded so they're visually distinct
            from individual building pins. */}
        <CircleLayer
          id={CLUSTERS_LAYER_ID}
          filter={["==", ["get", "cluster"], true]}
          style={{
            circleRadius: [
              "interpolate",
              ["linear"],
              ["get", "point_count"],
              2,
              26,
              10,
              32,
              50,
              40,
            ],
            circleColor: [
              "case",
              ["==", ["get", "recordedCount"], ["get", "point_count"]],
              "hsl(199, 89%, 80%)", // light blue when fully canvassed
              "hsl(0, 0%, 88%)", // muted gray otherwise
            ],
            circleStrokeColor: "hsl(0, 0%, 20%)",
            circleStrokeWidth: 2,
          }}
        />
        <SymbolLayer
          id={CLUSTERS_LABEL_LAYER_ID}
          filter={["==", ["get", "cluster"], true]}
          style={{
            textField: ["get", "doorCount"],
            textSize: ["interpolate", ["linear"], ["zoom"], 12, 12, 18, 16],
            textColor: "hsl(0, 0%, 10%)",
            textAllowOverlap: true,
            textIgnorePlacement: true,
          }}
        />

        {/* Individual building pins — features without `cluster: true` */}
        <CircleLayer
          id={BUILDINGS_PINS_LAYER_ID}
          filter={["!=", ["get", "cluster"], true]}
          style={{
            circleRadius: ["interpolate", ["linear"], ["zoom"], 14, 13, 18, 22],
            circleColor: [
              "case",
              ["==", ["get", "recorded"], true],
              "hsl(199, 89%, 80%)",
              "hsl(0, 0%, 100%)",
            ],
            circleStrokeColor: "hsl(0, 0%, 20%)",
            circleStrokeWidth: 1.5,
          }}
        />
        <SymbolLayer
          id={BUILDINGS_LABEL_LAYER_ID}
          filter={["!=", ["get", "cluster"], true]}
          style={{
            textField: ["get", "doorCount"],
            textSize: ["interpolate", ["linear"], ["zoom"], 14, 10, 18, 14],
            textColor: "hsl(0, 0%, 10%)",
            textAllowOverlap: true,
            textIgnorePlacement: true,
          }}
        />
      </ShapeSource>
    </MapView>
  );
}

function buildBuildingFeatures(
  buildings: TurfDataBuilding[],
  recordedBuildingIds: Set<string>,
): GeoJSON.Feature<GeoJSON.Point, BuildingProps>[] {
  return buildings
    .filter((b) => b.latitude != null && b.longitude != null)
    .map((b) => ({
      type: "Feature" as const,
      id: b.buildingId,
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
    }));
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
