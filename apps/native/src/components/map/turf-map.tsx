import {
  Camera,
  type CameraRef,
  type CameraStop,
  GeoJSONSource,
  type GeoJSONSourceRef,
  Layer,
  Map,
  type ViewStateChangeEvent,
} from "@maplibre/maplibre-react-native";
import * as Location from "expo-location";
import { useCallback, useMemo, useRef, useState } from "react";
import { type NativeSyntheticEvent, Platform, StyleSheet, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import type { TurfData } from "@turf-tools/db/schema";
import { useColors } from "@/lib/colors";
import { getMaptilerStyleUrl, isMaptilerKeyConfigured } from "@/lib/maptiler";
import { MapControls } from "./controls";
import { AttributionBadge, MissingKeyNotice } from "./map-chrome";
import { getMapPadding } from "./map-padding";
import { boundsForBuildings, buildFeatureCollection } from "./turf-data";
import {
  buildTurfLayers,
  CLUSTER_MAX_ZOOM,
  CLUSTER_RADIUS,
  TILE_MAX_ZOOM,
  TURF_CLUSTER_PROPERTIES,
  TURF_SOURCE_ID,
} from "./turf-layers";
import { LabelLayers } from "./labels";
import { UserLocationDot } from "./user-location-dot";

type Props = {
  turf: TurfData;
  buildingRoles: Map<string, "contacted" | "unavailable">;
  onBuildingPress?: (buildingId: string) => void;
  isDark?: boolean;
  bottomInset?: number;
  paused?: boolean;
};

export function TurfMap({
  turf,
  buildingRoles,
  onBuildingPress,
  isDark = false,
  bottomInset = 0,
  paused = false,
}: Props) {
  const colors = useColors();
  // Android flashes black between the map view mounting and its first
  // fully-rendered frame (maplibre-react-native #367, no upstream fix).
  // Cover it with a theme-colored pane until the map reports ready; iOS
  // starts ready.
  const [mapFullyRendered, setMapFullyRendered] = useState(Platform.OS === "ios");
  const featureCollection = useMemo(
    () => buildFeatureCollection(turf.buildings, buildingRoles),
    [turf.buildings, buildingRoles],
  );
  const initialBounds = useMemo(() => boundsForBuildings(turf.buildings), [turf.buildings]);
  const mapPadding = useMemo(() => getMapPadding(bottomInset), [bottomInset]);
  const layers = useMemo(() => buildTurfLayers({ isDark, colors }), [colors, isDark]);

  const cameraRef = useRef<CameraRef>(null);
  const buildingsSourceRef = useRef<GeoJSONSourceRef>(null);
  const userPositionRef = useRef<[number, number] | null>(null);

  const handleUserPosition = useCallback((position: [number, number]) => {
    userPositionRef.current = position;
  }, []);

  // The compass needle reads bearing on the UI thread; the ref is for the
  // tap and locate math, which runs in JS.
  const actualZoomRef = useRef(0);
  const mapBearing = useSharedValue(0);
  const [rotated, setRotated] = useState(false);

  // Both region streams feed this: IsChanging for live tracking, and
  // DidChange for the settle frame, the only carrier of an animation's
  // final bearing. Without it a reset-north stops a hair short of 0 and
  // the compass never hides.
  const handleRegionEvent = useCallback(
    (event: NativeSyntheticEvent<ViewStateChangeEvent>) => {
      const { zoom, bearing } = event.nativeEvent;
      if (typeof zoom === "number") actualZoomRef.current = zoom;
      if (typeof bearing !== "number") return;

      mapBearing.value = bearing;
      // Visibility is purely bearing-derived: appear once clearly
      // rotated, disappear once essentially at north. The gap between
      // the thresholds absorbs settle jitter.
      const norm = ((bearing % 360) + 360) % 360;
      const deviation = Math.min(norm, 360 - norm);
      setRotated((prev) => (prev ? deviation > 0.5 : deviation >= 2));
    },
    [mapBearing],
  );

  // Default the padding so locate and cluster stops keep the camera centre
  // the initial fit used. `setStop` is imperative, so identical stops are
  // not diffed; every call runs.
  const setCameraStop = useCallback(
    (stop: CameraStop) => {
      void cameraRef.current?.setStop({
        padding: mapPadding,
        ...stop,
      });
    },
    [mapPadding],
  );

  const handleResetNorth = useCallback(() => {
    setCameraStop({ bearing: 0, duration: 250, easing: "ease" });
  }, [setCameraStop]);

  // Center on the user at a working zoom. The dot already owns the live
  // fix, so use that first; the cached and fresh lookups are only for the
  // case where the watch has not produced a position yet.
  const handleLocate = useCallback(async () => {
    try {
      const live = userPositionRef.current;
      if (live) {
        setCameraStop({
          center: live,
          zoom: Math.max(actualZoomRef.current, 16),
          duration: 400,
          easing: "ease",
        });
        return;
      }

      const last = await Location.getLastKnownPositionAsync({
        maxAge: 30_000,
        requiredAccuracy: 100,
      });
      const pos =
        last ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }));
      if (!pos) return;
      setCameraStop({
        center: [pos.coords.longitude, pos.coords.latitude],
        zoom: Math.max(actualZoomRef.current, 16),
        duration: 400,
        easing: "ease",
      });
    } catch {
      // No location, no movement.
    }
  }, [setCameraStop]);

  const handlePress = useCallback(
    async (event: NativeSyntheticEvent<{ features: GeoJSON.Feature[] }>) => {
      const feature = event.nativeEvent.features?.[0];
      if (!feature) return;

      if (feature.properties?.cluster) {
        if (feature.geometry.type !== "Point") return;
        try {
          const clusterId = feature.properties.cluster_id;
          if (typeof clusterId !== "number") return;
          const expansionZoom =
            await buildingsSourceRef.current?.getClusterExpansionZoom(clusterId);
          const targetZoom = Math.max(
            (expansionZoom ?? actualZoomRef.current) + 0.5,
            actualZoomRef.current + 1,
          );
          setCameraStop({
            center: feature.geometry.coordinates as [number, number],
            zoom: targetZoom,
            duration: 350,
            easing: "ease",
          });
        } catch {
          setCameraStop({
            center: feature.geometry.coordinates as [number, number],
            zoom: actualZoomRef.current + 2,
            duration: 350,
            easing: "ease",
          });
        }
        return;
      }

      const id = feature.properties?.buildingId;
      if (typeof id === "string") onBuildingPress?.(id);
    },
    [onBuildingPress, setCameraStop],
  );

  if (!isMaptilerKeyConfigured()) {
    return <MissingKeyNotice isDark={isDark} />;
  }

  return (
    <View style={styles.map}>
      <Map
        style={styles.map}
        // GLSurfaceView (the Android default) draws over sibling React
        // Native views, and the bottom sheet, controls and attribution
        // badge sit on top of this map. TextureView keeps them visible.
        androidView="texture"
        mapStyle={getMaptilerStyleUrl(isDark)}
        attribution={false}
        logo={false}
        compass={false}
        touchPitch={false}
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
            padding: mapPadding,
          }}
        />

        <LabelLayers isDark={isDark} />

        <GeoJSONSource
          ref={buildingsSourceRef}
          id={TURF_SOURCE_ID}
          data={featureCollection}
          cluster
          clusterRadius={CLUSTER_RADIUS}
          clusterMaxZoom={CLUSTER_MAX_ZOOM}
          maxzoom={TILE_MAX_ZOOM}
          clusterProperties={TURF_CLUSTER_PROPERTIES}
          onPress={handlePress}
          hitbox={{ top: 2, right: 2, bottom: 2, left: 2 }}
        >
          {layers.map((layer) => (
            <Layer key={layer.id} {...layer} />
          ))}
        </GeoJSONSource>

        <UserLocationDot
          isDark={isDark}
          enabled={mapFullyRendered && !paused}
          onPosition={handleUserPosition}
        />
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

const styles = StyleSheet.create({
  map: { flex: 1 },
});
