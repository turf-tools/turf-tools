import { Asset } from "expo-asset";
import { useEffect, useMemo } from "react";
import { Layer, Source, useMap } from "react-map-gl/maplibre";
import { useHaloProgress } from "./use-halo-progress";
import { useUserLocation } from "./use-user-location";
import { coneImageFor, USER_DOT_CONE_IMAGES } from "./user-dot-images";
import { buildUserDotData, buildUserDotLayers, USER_DOT_SOURCE_ID } from "./user-dot-layers";

// MapLibre-rendered "you are here" marker: an outlined dot, a halo, and
// a heading cone. The same source and layers run on native and web.
export function UserLocationDot({
  isDark = false,
  enabled = true,
}: {
  isDark?: boolean;
  enabled?: boolean;
}) {
  const { current: mapRef } = useMap();
  const { position, heading, headingAccuracy } = useUserLocation({ enabled });
  const haloProgress = useHaloProgress(enabled && position != null);
  const coneImage = coneImageFor(headingAccuracy, isDark);

  const data = useMemo(
    () => buildUserDotData({ position, heading, coneImage }),
    [position, heading, coneImage],
  );
  const layers = useMemo(
    () => buildUserDotLayers({ isDark, haloProgress }),
    [isDark, haloProgress],
  );

  // The cone sprites are symbol images. Re-add them after style swaps,
  // since changing the basemap clears the style's image registry.
  useEffect(() => {
    const map = mapRef?.getMap();
    if (!map) return;

    let cancelled = false;
    const addImages = async () => {
      if (!map.style) return;
      for (const [name, module] of Object.entries(USER_DOT_CONE_IMAGES)) {
        if (cancelled || map.hasImage(name)) continue;
        const uri = typeof module === "string" ? module : Asset.fromModule(module).uri;
        try {
          const image = await map.loadImage(uri);
          if (!cancelled && !map.hasImage(name)) {
            map.addImage(name, image.data, { pixelRatio: 1 });
          }
        } catch {
          // A missing sprite only costs the cone, never the dot.
        }
      }
    };

    void addImages();
    const onStyleData = () => void addImages();
    map.on("styledata", onStyleData);
    return () => {
      cancelled = true;
      map.off("styledata", onStyleData);
    };
  }, [mapRef]);

  return (
    <Source id={USER_DOT_SOURCE_ID} type="geojson" data={data}>
      {layers.map((layer) => (
        <Layer key={layer.id} {...layer} />
      ))}
    </Source>
  );
}
