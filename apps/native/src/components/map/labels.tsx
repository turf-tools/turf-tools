import { Layer, VectorSource } from "@maplibre/maplibre-react-native";
import { MAPTILER_OPENMAPTILES_TILEJSON_URL } from "@/lib/maptiler";
import { buildLabelLayers, LABELS_SOURCE_ID } from "./label-layers";

// House numbers one zoom level earlier than the basemap. Road names stay
// with the basemap so there is no second set of labels to collide with.
export function LabelLayers({ isDark = false }: { isDark?: boolean }) {
  return (
    <VectorSource id={LABELS_SOURCE_ID} url={MAPTILER_OPENMAPTILES_TILEJSON_URL}>
      {buildLabelLayers({ isDark }).map((layer) => (
        <Layer key={layer.id} {...layer} />
      ))}
    </VectorSource>
  );
}
