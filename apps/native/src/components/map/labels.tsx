import { SymbolLayer, VectorSource } from "@maplibre/maplibre-react-native";
import { MAPTILER_OPENMAPTILES_TILEJSON_URL } from "@/lib/maptiler";

// Label overlays for the canvassing map. Renders an OpenMapTiles vector
// source plus two symbol layers — road names and house numbers — which are
// the labels canvassers actually need on a block-walking zoom level.
//
// Notes for future iteration:
//   * The source id is intentionally NOT "openmaptiles" — that's the
//     conventional name used by the basemap's own internal source, and
//     declaring a second source with the same id crashes MapLibre native.
//   * `textFont` is intentionally omitted so we inherit whichever font the
//     basemap glyph set actually ships. Adding fonts that aren't in the
//     glyph set causes a hard crash, not a fallback.
//   * Filters use the modern expression syntax (`["get", "class"]`), not
//     the legacy property-name shorthand.

const LABELS_SOURCE_ID = "labels-omt";

export function LabelLayers({ isDark = false }: { isDark?: boolean }) {
  return (
    <>
      <VectorSource id={LABELS_SOURCE_ID} url={MAPTILER_OPENMAPTILES_TILEJSON_URL}>
        <SymbolLayer
          id="labels-road"
          sourceLayerID="transportation_name"
          minZoomLevel={11}
          maxZoomLevel={22}
          filter={["!=", ["get", "class"], "ferry"]}
          style={{
            symbolPlacement: "line",
            textField: ["coalesce", ["get", "name:en"], ["get", "name"]],
            textSize: ["interpolate", ["linear"], ["zoom"], 14, 9, 18, 13],
            textColor: isDark ? "hsl(0, 0%, 80%)" : "hsl(0, 0%, 10%)",
            textHaloColor: isDark ? "hsla(0, 0%, 0%, 0.8)" : "hsla(0, 0%, 100%, 0.97)",
            textHaloWidth: 1,
          }}
        />
      </VectorSource>
    </>
  );
}
