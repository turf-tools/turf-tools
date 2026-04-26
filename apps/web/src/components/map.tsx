import "maplibre-gl/dist/maplibre-gl.css";

import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import {
  Layer,
  type MapMouseEvent,
  Map as MapLibreMap,
  type MapRef,
  Source,
  type ViewState,
} from "react-map-gl/maplibre";
import { darkAtom } from "~/lib/atoms/theme";
import {
  getMaptilerStyleUrl,
  isMaptilerKeyConfigured,
  MAPTILER_OPENMAPTILES_TILEJSON_URL,
} from "~/lib/maptiler";
import { cn } from "~/lib/utils";
import { Switch } from "./switch";

// MapLibre wrapper. Uses MapTiler-hosted styles (same as the native app)
// for visual consistency between admin and canvasser views. Theme follows
// the dark-mode toggle in the top bar via `darkAtom`.
//
// An optional OpenMapTiles overlay adds road-name labels on top of the
// basemap (mirrors apps/native/src/components/map/labels.tsx). The "Show
// labels" toggle is inset over the bottom-right corner of the map.
type MapProps = {
  initialViewState?: Partial<ViewState>;
  className?: string;
  // Optional URL for a GeoJSON FeatureCollection to render as an outlined
  // boundary layer. Each feature should have `properties.key` (the unique
  // id within its key group) so callers can resolve clicks back to a key.
  boundariesUrl?: string;
  // Per-key color to apply to the corresponding polygon's fill. Keys not
  // present render with the default unassigned style. Used by the zone
  // editor to color EDs by which zone they belong to.
  coloringByKey?: Record<string, string>;
  // Fired with the clicked polygon's `key` when the user clicks anywhere
  // on the boundary layer. Caller decides what to do (toggle membership in
  // a zone, add to a filter, etc.).
  onPolygonClick?: (key: string) => void;
};

const DEFAULT_VIEW: Partial<ViewState> = {
  // Centered roughly on NYC's centroid (Brooklyn/Lower Manhattan border) at
  // a zoom that keeps all five boroughs in view. Override per page via
  // `initialViewState` when the data dictates a different frame.
  longitude: -73.95,
  latitude: 40.7,
  zoom: 9.5,
};

// IMPORTANT: not "openmaptiles" — that's already used internally by the
// MapTiler basemap, and a duplicate source id crashes MapLibre.
const LABELS_SOURCE_ID = "labels-omt";

// Shared paint spec for every label layer — dark/light aware text + halo
// for legibility against either basemap variant.
const LABEL_PAINT = (isDark: boolean) => ({
  "text-color": isDark ? "hsl(0, 0%, 80%)" : "hsl(0, 0%, 10%)",
  "text-halo-color": isDark ? "hsla(0, 0%, 0%, 0.8)" : "hsla(0, 0%, 100%, 0.97)",
  "text-halo-width": 1,
});

const BOUNDARIES_SOURCE_ID = "boundaries";
const BOUNDARIES_FILL_LAYER = "boundaries-fill";
const BOUNDARIES_LINE_LAYER = "boundaries-line";

export function Map({
  initialViewState,
  className,
  boundariesUrl,
  coloringByKey,
  onPolygonClick,
}: MapProps) {
  const isDark = useAtomValue(darkAtom);
  const [showLabels, setShowLabels] = useState(false);
  const [hoveringPolygon, setHoveringPolygon] = useState(false);
  const mapRef = useRef<MapRef>(null);

  // Apply per-feature fill colors via MapLibre's feature-state. Re-runs
  // on every change to `coloringByKey`, and also when the style reloads
  // (e.g. light/dark switch) — `setStyle` wipes all feature-state, so we
  // listen for `sourcedata` to re-apply once the boundary source comes
  // back. Without this, theme toggles dropped all zone colors until the
  // next polygon click forced a re-render.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;

    const apply = () => {
      if (!map.isSourceLoaded(BOUNDARIES_SOURCE_ID)) return;
      map.removeFeatureState({ source: BOUNDARIES_SOURCE_ID });
      if (!coloringByKey) return;
      for (const [key, color] of Object.entries(coloringByKey)) {
        map.setFeatureState({ source: BOUNDARIES_SOURCE_ID, id: key }, { color });
      }
    };

    apply();

    const handler = (e: { sourceId?: string; isSourceLoaded?: boolean }) => {
      if (e.sourceId === BOUNDARIES_SOURCE_ID && e.isSourceLoaded) apply();
    };
    map.on("sourcedata", handler);
    return () => {
      map.off("sourcedata", handler);
    };
  }, [coloringByKey, boundariesUrl, isDark]);

  // Switch to pointer only while the cursor is over a clickable polygon;
  // otherwise let MapLibre keep its default pan/grab cursor. Listening to
  // layer-scoped enter/leave events is more reliable than `interactive-
  // LayerIds` + a static cursor prop, which renders pointer everywhere
  // the editor is active.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !onPolygonClick) {
      setHoveringPolygon(false);
      return;
    }
    const onEnter = () => setHoveringPolygon(true);
    const onLeave = () => setHoveringPolygon(false);
    map.on("mouseenter", BOUNDARIES_FILL_LAYER, onEnter);
    map.on("mouseleave", BOUNDARIES_FILL_LAYER, onLeave);
    return () => {
      map.off("mouseenter", BOUNDARIES_FILL_LAYER, onEnter);
      map.off("mouseleave", BOUNDARIES_FILL_LAYER, onLeave);
    };
  }, [onPolygonClick]);

  const handleClick = (e: MapMouseEvent) => {
    if (!onPolygonClick) return;
    const feature = e.features?.[0];
    const key = feature?.properties?.key;
    if (typeof key === "string") {
      onPolygonClick(key);
    }
  };

  if (!isMaptilerKeyConfigured()) {
    return (
      <div
        className={
          className ??
          "flex h-full items-center justify-center rounded-lg border border-dashed border-border bg-muted/40 p-4 text-center text-sm text-muted-foreground"
        }
      >
        Set <code className="font-mono">VITE_MAPTILER_KEY</code> in{" "}
        <code className="font-mono">apps/web/.env</code> to enable the map.
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative",
        className ?? "h-full overflow-hidden rounded-lg border border-border",
      )}
    >
      <MapLibreMap
        ref={mapRef}
        initialViewState={{ ...DEFAULT_VIEW, ...initialViewState }}
        mapStyle={getMaptilerStyleUrl(isDark)}
        attributionControl={false}
        style={{ width: "100%", height: "100%" }}
        // Only intercept clicks on the boundary fill layer; the basemap
        // stays click-through.
        interactiveLayerIds={onPolygonClick ? [BOUNDARIES_FILL_LAYER] : []}
        onClick={onPolygonClick ? handleClick : undefined}
        cursor={onPolygonClick && hoveringPolygon ? "pointer" : "grab"}
      >
        {boundariesUrl ? (
          <Source
            id={BOUNDARIES_SOURCE_ID}
            type="geojson"
            data={boundariesUrl}
            // Promote the `key` property to feature id so feature-state
            // (used for per-polygon coloring) can be addressed by key.
            promoteId="key"
          >
            <Layer
              id={BOUNDARIES_FILL_LAYER}
              type="fill"
              paint={{
                "fill-color": [
                  "coalesce",
                  ["feature-state", "color"],
                  isDark ? "hsl(0, 0%, 80%)" : "hsl(0, 0%, 20%)",
                ],
                "fill-opacity": ["case", ["!=", ["feature-state", "color"], null], 0.4, 0.05],
              }}
            />
            <Layer
              id={BOUNDARIES_LINE_LAYER}
              type="line"
              paint={{
                "line-color": isDark ? "hsl(0, 0%, 80%)" : "hsl(0, 0%, 20%)",
                "line-width": 0.5,
                "line-opacity": 0.6,
              }}
            />
          </Source>
        ) : null}

        {showLabels ? (
          <Source id={LABELS_SOURCE_ID} type="vector" url={MAPTILER_OPENMAPTILES_TILEJSON_URL}>
            {/* Cities (zoom 4–14) */}
            <Layer
              id="labels-city"
              type="symbol"
              source-layer="place"
              minzoom={4}
              maxzoom={14}
              filter={["all", ["==", "class", "city"]]}
              layout={{
                "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
                "text-size": ["interpolate", ["linear"], ["zoom"], 4, 11, 15, 16],
              }}
              paint={LABEL_PAINT(isDark)}
            />

            {/* Towns (zoom 6+) */}
            <Layer
              id="labels-town"
              type="symbol"
              source-layer="place"
              minzoom={6}
              filter={["all", ["==", "class", "town"]]}
              layout={{
                "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
                "text-size": ["interpolate", ["linear"], ["zoom"], 7, 10, 11, 13],
              }}
              paint={LABEL_PAINT(isDark)}
            />

            {/* Neighborhoods, hamlets, etc. (zoom 8+) */}
            <Layer
              id="labels-other"
              type="symbol"
              source-layer="place"
              minzoom={8}
              filter={[
                "all",
                ["in", "class", "hamlet", "island", "islet", "neighbourhood", "suburb", "place"],
              ]}
              layout={{
                "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
                "text-size": ["interpolate", ["linear"], ["zoom"], 11, 10, 18, 16],
              }}
              paint={LABEL_PAINT(isDark)}
            />

            {/* Roads (zoom 9+) */}
            <Layer
              id="labels-road"
              type="symbol"
              source-layer="transportation_name"
              minzoom={9}
              maxzoom={22}
              filter={["!=", ["get", "class"], "ferry"]}
              layout={{
                "symbol-placement": "line",
                "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
                "text-size": ["interpolate", ["linear"], ["zoom"], 14, 9, 18, 13],
              }}
              paint={LABEL_PAINT(isDark)}
            />

            {/* House numbers (zoom 17+) */}
            <Layer
              id="labels-housenumber"
              type="symbol"
              source-layer="housenumber"
              minzoom={17}
              layout={{
                "text-field": "{housenumber}",
                "text-size": ["interpolate", ["linear"], ["zoom"], 17, 9, 22, 11],
              }}
              paint={LABEL_PAINT(isDark)}
            />
          </Source>
        ) : null}
      </MapLibreMap>

      <label
        className={
          "absolute right-3 bottom-3 flex items-center gap-3 rounded-md border border-border " +
          "bg-background px-3 py-3 text-sm"
        }
      >
        <Switch checked={showLabels} onCheckedChange={setShowLabels} />
        <span>Show labels</span>
      </label>
    </div>
  );
}
