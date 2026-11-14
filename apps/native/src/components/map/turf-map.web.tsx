import { useCallback, useMemo, useRef, useState } from "react";
import MapGL, {
  Layer,
  type MapLayerMouseEvent,
  type MapRef,
  Source,
  type ViewStateChangeEvent,
} from "react-map-gl/maplibre";
import type { GeoJSONSource } from "maplibre-gl";
import { StyleSheet, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import type { TurfData } from "@turf-tools/db/schema";
import { useColors } from "@/lib/colors";
import { getMaptilerStyleUrl, isMaptilerKeyConfigured } from "@/lib/maptiler";
import { MapControls } from "./controls";
import { AttributionBadge, MissingKeyNotice } from "./map-chrome";
import { mapPadding as getMapPadding } from "./map-padding";
import { boundsForBuildings, buildFeatureCollection } from "./turf-data";
import {
  buildTurfLayers,
  CLUSTER_MAX_ZOOM,
  CLUSTER_RADIUS,
  TILE_MAX_ZOOM,
  TURF_CLUSTER_LABELS_LAYER_ID,
  TURF_CLUSTER_PROPERTIES,
  TURF_CLUSTERS_LAYER_ID,
  TURF_LABELS_LAYER_ID,
  TURF_PINS_LAYER_ID,
  TURF_SOURCE_ID,
} from "./turf-layers";
import { UserLocationDot } from "./user-location-dot";

// Web implementation of the canvassing map. MapLibre React Native is
// native-only, so this renders through MapLibre GL JS via react-map-gl
// and shares the layer specs in turf-layers.
type Props = {
  turf: TurfData;
  buildingRoles: Map<string, "contacted" | "unavailable">;
  onBuildingPress?: (buildingId: string) => void;
  isDark?: boolean;
  bottomInset?: number;
};

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
  const [mapReady, setMapReady] = useState(false);

  const featureCollection = useMemo(
    () => buildFeatureCollection(turf.buildings, buildingRoles),
    [turf.buildings, buildingRoles],
  );
  const initialBounds = useMemo(() => boundsForBuildings(turf.buildings), [turf.buildings]);
  const padding = useMemo(() => getMapPadding(bottomInset), [bottomInset]);
  const layers = useMemo(() => buildTurfLayers({ isDark, colors }), [colors, isDark]);

  const handleMove = useCallback(
    (event: ViewStateChangeEvent) => {
      const bearing = event.viewState.bearing;
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

  const handleClick = useCallback(
    (event: MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (!feature) return;

      if (feature.properties?.cluster) {
        const map = mapRef.current;
        if (!map || feature.geometry.type !== "Point") return;
        const clusterId = feature.properties.cluster_id;
        if (typeof clusterId !== "number") return;

        const source = map.getSource(TURF_SOURCE_ID) as GeoJSONSource | undefined;
        const center = feature.geometry.coordinates as [number, number];
        void source
          ?.getClusterExpansionZoom(clusterId)
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
      if (typeof id === "string") onBuildingPress?.(id);
    },
    [onBuildingPress],
  );

  if (!isMaptilerKeyConfigured()) {
    return <MissingKeyNotice isDark={isDark} />;
  }

  return (
    <View style={styles.map}>
      <MapGL
        ref={mapRef}
        onLoad={() => setMapReady(true)}
        onMove={handleMove}
        onClick={handleClick}
        interactiveLayerIds={[
          TURF_CLUSTERS_LAYER_ID,
          TURF_CLUSTER_LABELS_LAYER_ID,
          TURF_PINS_LAYER_ID,
          TURF_LABELS_LAYER_ID,
        ]}
        initialViewState={{
          bounds: [
            [initialBounds.sw[0], initialBounds.sw[1]],
            [initialBounds.ne[0], initialBounds.ne[1]],
          ],
          fitBoundsOptions: { padding },
        }}
        attributionControl={false}
        mapStyle={getMaptilerStyleUrl(isDark)}
        style={styles.mapCanvas}
      >
        <Source
          id={TURF_SOURCE_ID}
          type="geojson"
          data={featureCollection}
          cluster
          clusterRadius={CLUSTER_RADIUS}
          clusterMaxZoom={CLUSTER_MAX_ZOOM}
          maxzoom={TILE_MAX_ZOOM}
          clusterProperties={TURF_CLUSTER_PROPERTIES}
        >
          {layers.map((layer) => (
            <Layer key={layer.id} {...layer} />
          ))}
        </Source>
        <UserLocationDot isDark={isDark} enabled={mapReady} />
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

const styles = StyleSheet.create({
  map: { flex: 1 },
  mapCanvas: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
});
