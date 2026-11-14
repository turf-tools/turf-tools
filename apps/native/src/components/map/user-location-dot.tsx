import { GeoJSONSource, Images, Layer } from "@maplibre/maplibre-react-native";
import { useMemo } from "react";
import { useHaloProgress } from "./use-halo-progress";
import { useUserLocation } from "./use-user-location";
import { coneImageFor, USER_DOT_CONE_IMAGES } from "./user-dot-images";
import { buildUserDotData, buildUserDotLayers, USER_DOT_SOURCE_ID } from "./user-dot-layers";

// MapLibre-rendered "you are here" marker: an outlined dot, a halo, and
// a heading cone. Rendering it as map layers keeps the marker below the
// app chrome, clipped by the viewport, and out of the touch path.
//
// The library's UserLocation/LayerAnnotation path carries a bare Point and
// only exposes GPS course heading. The cone needs compass heading and an
// accuracy tier on the same source, so this owns that source explicitly.
export function UserLocationDot({
  isDark = false,
  enabled = true,
  onPosition,
}: {
  isDark?: boolean;
  enabled?: boolean;
  onPosition?: (position: [number, number]) => void;
}) {
  const { position, heading, headingAccuracy } = useUserLocation({ enabled, onPosition });
  const halo = useHaloProgress(enabled && position != null);
  const coneImage = coneImageFor(headingAccuracy, isDark);

  const data = useMemo(
    () => buildUserDotData({ position, heading, coneImage }),
    [position, heading, coneImage],
  );
  const layers = useMemo(() => buildUserDotLayers({ isDark, halo }), [isDark, halo]);

  return (
    <>
      <Images images={USER_DOT_CONE_IMAGES} />
      <GeoJSONSource id={USER_DOT_SOURCE_ID} data={data}>
        {layers.map((layer) => (
          <Layer key={layer.id} {...layer} />
        ))}
      </GeoJSONSource>
    </>
  );
}
