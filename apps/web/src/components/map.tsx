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
import { PointsLayer } from "./points-layer";
import { Switch } from "./switch";

export type Viewport = { north: number; south: number; east: number; west: number; zoom: number };

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
  // Opacity for keys that have a color in `coloringByKey`. Defaults to
  // 0.4 (so the basemap reads through tinted zones). Pass 1 for opaque
  // overlays — e.g. a segment-counts heatmap where the gray ramp is
  // the signal and the basemap underneath would only confuse it.
  coloredFillOpacity?: number;
  // Keys to draw with a thicker stroke. Used by the zone editor to
  // make the active zone's polygons stand out under any fill.
  activeKeys?: ReadonlyArray<string>;
  // Optional pre-unioned zone perimeters (one feature per zone) — drawn
  // as a translucent fill + black outline. Each feature's
  // `properties.zoneId` is fed to `onZoneClick` when the user clicks
  // its polygon. The campaign editor uses this to render zones as
  // single shapes (no per-key boundaries) and dispatch into the
  // turf-cutter.
  zonePerimeters?: GeoJSON.FeatureCollection;
  onZoneClick?: (zoneId: string) => void;
  // Optional `[minLng, minLat, maxLng, maxLat]` to fit the viewport
  // to. The map calls `fitBounds` whenever this value changes. Pass
  // `null`/`undefined` to leave the viewport alone.
  fitBounds?: [number, number, number, number] | null;
  // Fired with the clicked polygon's `key` when the user clicks anywhere
  // on the boundary layer. Caller decides what to do (toggle membership in
  // a zone, add to a filter, etc.).
  onPolygonClick?: (key: string) => void;
  // Fired when the user clicks on the map but not on a polygon (i.e.
  // on the basemap). Useful for dismissing transient UI like a
  // clicked-key info popup.
  onBackgroundClick?: () => void;
  // Fires once after MapLibre's `load` event AND any pending
  // `fitBounds` has been applied. Lets a parent gate its loading
  // curtain on the map being visually settled, not just "tiles
  // loaded somewhere underneath."
  onLoaded?: () => void;
  // Optional point overlay rendered via a custom WebGL layer. The
  // caller owns the data and passes a flat `[lng, lat, ...]` typed
  // array straight into the GPU buffer — no per-point object
  // allocation. We don't viewport-bound the data here; the layer
  // renders whatever's loaded, and pan/zoom is purely a per-frame
  // matrix update on the GPU.
  points?: Float32Array;
  // Fires after pan/zoom settle (`moveend`) with the current viewport
  // bounds + zoom. Caller is responsible for any debouncing. Currently
  // unused by the points layer (which loads everything once); kept
  // around for callers that still want viewport awareness.
  onViewportChange?: (viewport: Viewport) => void;
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
const ZONE_PERIMETERS_SOURCE_ID = "zone-perimeters";
const ZONE_PERIMETERS_FILL_LAYER = "zone-perimeters-fill";
const ZONE_PERIMETERS_LINE_LAYER = "zone-perimeters-line";
const BOUNDARIES_LINE_LAYER = "boundaries-line";

export function Map({
  initialViewState,
  className,
  boundariesUrl,
  coloringByKey,
  coloredFillOpacity = 0.4,
  activeKeys,
  zonePerimeters,
  onZoneClick,
  fitBounds,
  onPolygonClick,
  onBackgroundClick,
  onLoaded,
  points,
  onViewportChange,
}: MapProps) {
  const isDark = useAtomValue(darkAtom);
  const [showLabels, setShowLabels] = useState(false);
  const [hoveringPolygon, setHoveringPolygon] = useState(false);
  // The underlying MapLibre instance isn't available on first render —
  // react-map-gl populates the ref but doesn't trigger a re-render
  // afterward. Effects that touch the map imperatively (custom layer
  // add/remove, viewport callback) gate on this flag, which flips true
  // when MapLibre fires `load`.
  const [mapReady, setMapReady] = useState(false);
  const mapRef = useRef<MapRef>(null);
  const pointsLayerRef = useRef<PointsLayer | null>(null);
  // Color and active are managed by two separate effects so a click
  // (which only changes `activeKeys`) doesn't have to re-apply color
  // for every colored key — with the heatmap overlay on, that's
  // ~4000 EDs of wasted work per click. Each effect tracks the keys
  // it last touched so it can target removal of stale state without
  // a bulk wipe (the wipe pattern was unreliable under rapid prop
  // changes). `setFeatureState` merges per-key, so the two effects
  // don't stomp each other.
  //
  // Both effects also listen for `sourcedata` so a style swap (light/
  // dark toggle) re-applies their state once the source reloads —
  // `setStyle` wipes all feature-state, so without this the colors
  // would vanish on theme change.
  const prevColoredRef = useRef<ReadonlySet<string>>(new Set());
  const prevActiveRef = useRef<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!boundariesUrl) return;
    const map = mapRef.current?.getMap();
    if (!map) return;

    const apply = () => {
      if (!map.getSource(BOUNDARIES_SOURCE_ID)) return;
      if (!map.isSourceLoaded(BOUNDARIES_SOURCE_ID)) return;
      const current = new Set(Object.keys(coloringByKey ?? {}));
      for (const key of prevColoredRef.current) {
        if (!current.has(key)) {
          map.removeFeatureState({ source: BOUNDARIES_SOURCE_ID, id: key }, "color");
        }
      }
      if (coloringByKey) {
        for (const [key, color] of Object.entries(coloringByKey)) {
          map.setFeatureState({ source: BOUNDARIES_SOURCE_ID, id: key }, { color });
        }
      }
      prevColoredRef.current = current;
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

  useEffect(() => {
    if (!boundariesUrl) return;
    const map = mapRef.current?.getMap();
    if (!map) return;

    const apply = () => {
      if (!map.getSource(BOUNDARIES_SOURCE_ID)) return;
      if (!map.isSourceLoaded(BOUNDARIES_SOURCE_ID)) return;
      const current = new Set(activeKeys ?? []);
      for (const key of prevActiveRef.current) {
        if (!current.has(key)) {
          map.removeFeatureState({ source: BOUNDARIES_SOURCE_ID, id: key }, "active");
        }
      }
      for (const key of current) {
        map.setFeatureState({ source: BOUNDARIES_SOURCE_ID, id: key }, { active: true });
      }
      prevActiveRef.current = current;
    };

    apply();
    const handler = (e: { sourceId?: string; isSourceLoaded?: boolean }) => {
      if (e.sourceId === BOUNDARIES_SOURCE_ID && e.isSourceLoaded) apply();
    };
    map.on("sourcedata", handler);
    return () => {
      map.off("sourcedata", handler);
    };
  }, [activeKeys, boundariesUrl, isDark]);

  // Switch to pointer only while the cursor is over a clickable polygon;
  // otherwise let MapLibre keep its default pan/grab cursor. Listening to
  // layer-scoped enter/leave events is more reliable than `interactive-
  // LayerIds` + a static cursor prop, which renders pointer everywhere
  // the editor is active.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    const layers: string[] = [];
    if (onPolygonClick) layers.push(BOUNDARIES_FILL_LAYER);
    if (onZoneClick) layers.push(ZONE_PERIMETERS_FILL_LAYER);
    if (layers.length === 0) {
      setHoveringPolygon(false);
      return;
    }
    const onEnter = () => setHoveringPolygon(true);
    const onLeave = () => setHoveringPolygon(false);
    for (const layer of layers) {
      map.on("mouseenter", layer, onEnter);
      map.on("mouseleave", layer, onLeave);
    }
    return () => {
      for (const layer of layers) {
        map.off("mouseenter", layer, onEnter);
        map.off("mouseleave", layer, onLeave);
      }
    };
  }, [onPolygonClick, onZoneClick]);

  const handleClick = (e: MapMouseEvent) => {
    // Zone perimeters take priority — they sit on top of boundary
    // fills, so a click on one is a zone click, not a key click.
    const feature = e.features?.[0];
    const zoneId = feature?.properties?.zoneId;
    if (typeof zoneId === "string") {
      onZoneClick?.(zoneId);
      return;
    }
    const key = feature?.properties?.key;
    if (typeof key === "string") {
      onPolygonClick?.(key);
    } else {
      onBackgroundClick?.();
    }
  };

  // Add the WebGL points layer once the map is up. We add even when
  // `points` is undefined so a later prop change doesn't cost a layer
  // re-create — `setPoints` just toggles the visible point count.
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current?.getMap();
    if (!map) return;
    const layer = new PointsLayer({ id: "segment-points" });
    pointsLayerRef.current = layer;
    if (!map.getLayer(layer.id)) map.addLayer(layer);
    return () => {
      pointsLayerRef.current = null;
      if (map.getLayer(layer.id)) map.removeLayer(layer.id);
    };
  }, [mapReady]);

  // Push point data to the layer whenever it changes — and also when
  // the layer first becomes ready, in case the query resolved before
  // the map's `load` fired (cached response, fast network). Without
  // the `mapReady` dep this effect runs once with `pointsLayerRef`
  // still null, the call no-ops, and the points are silently dropped
  // until something else forces another re-render of `points`.
  useEffect(() => {
    pointsLayerRef.current?.setPoints(points);
  }, [points, mapReady]);

  // Match the dot color to the current theme. Dark dots on light
  // basemap, light dots on dark basemap — high contrast both ways.
  // `mapReady` dep for the same reason as above.
  useEffect(() => {
    pointsLayerRef.current?.setStyle({
      color: isDark ? "#e5e5e5" : "#0a0a0a",
    });
  }, [isDark, mapReady]);

  // Fit the viewport to the supplied bounds whenever the prop value
  // changes. `duration: 0` jumps instantly — when a curtain is
  // covering the map, an animation underneath is invisible work to
  // wait on, and even without one a snap reads cleaner than a sweep.
  //
  // Waits for the zone-perimeters source to finish re-tessellating
  // before jumping. setData on a GeoJSON source is async (worker
  // thread); a sync fitBounds beats it to the screen and shows the
  // *previous* perimeters at the *new* bounds for one frame. We
  // gate on `isSourceLoaded` and fall back to a `sourcedata`
  // listener if it isn't ready yet.
  useEffect(() => {
    if (!mapReady || !fitBounds) return;
    const map = mapRef.current?.getMap();
    if (!map) return;
    const fit = () => {
      map.fitBounds(
        [
          [fitBounds[0], fitBounds[1]],
          [fitBounds[2], fitBounds[3]],
        ],
        { padding: 40, duration: 0 },
      );
    };
    if (
      map.getSource(ZONE_PERIMETERS_SOURCE_ID) &&
      !map.isSourceLoaded(ZONE_PERIMETERS_SOURCE_ID)
    ) {
      const handler = (e: { sourceId?: string; isSourceLoaded?: boolean }) => {
        if (e.sourceId === ZONE_PERIMETERS_SOURCE_ID && e.isSourceLoaded) {
          map.off("sourcedata", handler);
          fit();
        }
      };
      map.on("sourcedata", handler);
      return () => {
        map.off("sourcedata", handler);
      };
    }
    fit();
    return undefined;
  }, [fitBounds, mapReady]);

  // Surface viewport changes after pan/zoom settles. Caller owns
  // debounce + fetch.
  useEffect(() => {
    if (!mapReady || !onViewportChange) return;
    const map = mapRef.current?.getMap();
    if (!map) return;
    const handler = () => {
      const b = map.getBounds();
      onViewportChange({
        north: b.getNorth(),
        south: b.getSouth(),
        east: b.getEast(),
        west: b.getWest(),
        zoom: map.getZoom(),
      });
    };
    map.on("moveend", handler);
    // Fire once on attach so the initial viewport is captured without
    // requiring the user to interact first.
    handler();
    return () => {
      map.off("moveend", handler);
    };
  }, [mapReady, onViewportChange]);

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
        onLoad={() => {
          setMapReady(true);
          // Defer `onLoaded` to the map's next `idle` — fires after
          // basemap tiles, user-supplied sources (boundaries, zone
          // perimeters), and any pending fitBounds have all settled.
          // Lets parents gate their loading curtain on a single
          // signal that means "the map is finished moving and
          // nothing is loading," not just "basemap arrived."
          const m = mapRef.current?.getMap();
          void m?.once("idle", () => onLoaded?.());
        }}
        // `interactiveLayerIds` filters the `features` field on the
        // click event to those layers — without it, basemap clicks
        // would never resolve a polygon. `onClick` itself fires for
        // every map click, so background-vs-polygon dispatch happens
        // in `handleClick`.
        interactiveLayerIds={[
          ...(onPolygonClick ? [BOUNDARIES_FILL_LAYER] : []),
          ...(onZoneClick ? [ZONE_PERIMETERS_FILL_LAYER] : []),
        ]}
        onClick={onPolygonClick || onZoneClick || onBackgroundClick ? handleClick : undefined}
        cursor={(onPolygonClick || onZoneClick) && hoveringPolygon ? "pointer" : "grab"}
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
                "fill-opacity": [
                  "case",
                  ["!=", ["feature-state", "color"], null],
                  coloredFillOpacity,
                  0.05,
                ],
              }}
            />
            <Layer
              id={BOUNDARIES_LINE_LAYER}
              type="line"
              paint={{
                "line-color": isDark ? "hsl(0, 0%, 80%)" : "hsl(0, 0%, 20%)",
                "line-width": ["case", ["==", ["feature-state", "active"], true], 1.75, 0.5],
                "line-opacity": ["case", ["==", ["feature-state", "active"], true], 1, 0.6],
              }}
            />
          </Source>
        ) : null}

        {zonePerimeters ? (
          <Source id={ZONE_PERIMETERS_SOURCE_ID} type="geojson" data={zonePerimeters}>
            <Layer
              id={ZONE_PERIMETERS_FILL_LAYER}
              type="fill"
              paint={{
                // Per-feature `color` falls through to a neutral gray
                // when a caller passes perimeters without a color
                // attribute (haven't shipped that path yet, but the
                // contract stays open).
                "fill-color": [
                  "coalesce",
                  ["get", "color"],
                  isDark ? "hsl(0, 0%, 80%)" : "hsl(0, 0%, 20%)",
                ],
                "fill-opacity": 0.4,
              }}
            />
            <Layer
              id={ZONE_PERIMETERS_LINE_LAYER}
              type="line"
              paint={{
                "line-color": isDark ? "hsl(0, 0%, 95%)" : "hsl(0, 0%, 5%)",
                "line-width": 1.5,
                "line-opacity": 0.9,
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
        <span>Show streets</span>
      </label>
    </div>
  );
}
