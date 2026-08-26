import { Icon } from "~/components/icon";
import "maplibre-gl/dist/maplibre-gl.css";

import { useAtomValue, useSetAtom } from "jotai";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  Layer,
  type MapMouseEvent,
  Map as MapLibreMap,
  type MapRef,
  Source,
  type ViewState,
} from "react-map-gl/maplibre";
import { mapLoadingCountAtom } from "~/lib/atoms/map-loading";
import { darkAtom } from "~/lib/atoms/theme";
import {
  getMaptilerStyleUrl,
  isMaptilerKeyConfigured,
  MAPTILER_OPENMAPTILES_TILEJSON_URL,
} from "~/lib/maptiler";
import { cn } from "~/lib/utils";
import { useDelayedFlag } from "~/lib/use-delayed-flag";
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
  // Optional label points — point features with `properties.label`,
  // drawn as text above the perimeter fills. Callers compute placement
  // (e.g. bbox centers): letting MapLibre self-label polygons
  // duplicates text across tile splits. Features with
  // `properties.badge` get a theme-aware translucent plate behind mono
  // text — sized for short numeric labels, not names — and collision-
  // hide (with a fade) when the map gets crowded.
  shapeLabels?: GeoJSON.FeatureCollection;
  // Fired with a badged label's `zoneId` on tap of the plate itself —
  // polygon-sized targets misfire on dense maps.
  onBadgeClick?: (id: string) => void;
  // The currently-selected zone's id. Its perimeter line renders
  // with a heavier stroke + full opacity; the rest stay thin and
  // faded so the selection reads at a glance.
  selectedZoneId?: string | null;
  // Multi-select variant: highlight exactly these zone ids (takes
  // precedence over `selectedZoneId`). The map has no opinion about
  // what the set means — callers own concepts like "all zones".
  selectedZoneIds?: ReadonlyArray<string> | null;
  // Optional `[minLng, minLat, maxLng, maxLat]` to fit the viewport
  // to. The map calls `fitBounds` whenever this value changes. Pass
  // `null`/`undefined` to leave the viewport alone.
  fitBounds?: [number, number, number, number] | null;
  // Fired with the clicked polygon's `key` when the user clicks
  // anywhere on the boundary layer. The second argument carries
  // modifier-key state from the underlying mouse event so callers
  // can distinguish click vs. shift-click without needing their
  // own DOM listener — the zone editor uses this to differentiate
  // "activate the containing zone" (plain click) from "toggle key
  // membership in the active zone" (shift-click).
  onPolygonClick?: (key: string, opts: { shiftKey: boolean }) => void;
  // Fires when the cursor moves over a polygon, with the
  // hovered polygon's `key`, and again with `null` when the cursor
  // leaves the boundary layer. Deduplicated so consecutive calls
  // never repeat the same key. Used by the zone editor to drive a
  // hover-driven info popup without each consumer having to wire
  // up its own MapLibre layer listeners.
  onPolygonHover?: (key: string | null) => void;
  // Fired when the user clicks on the map but not on a polygon (i.e.
  // on the basemap). Useful for dismissing transient UI like a
  // clicked-key info popup.
  onBackgroundClick?: () => void;
  // Parent-supplied "data isn't ready yet" flag. Combined with the
  // map's own internal readiness (basemap loaded, any pending
  // fitBounds applied) to decide whether to show the loading
  // curtain. Concentrates the timing logic for "is the map showing
  // its final state" in one place — segments/zones/campaigns/cutter
  // each just say `loading={!myDataReady}` and don't have to chase
  // map-internal events.
  loading?: boolean;
  // Centered spinner on the loading curtain. Opt-in for maps whose
  // context hides the global loading indicator (dialogs) — elsewhere
  // that indicator already covers it.
  loadingSpinner?: boolean;
  // Optional point overlay rendered via a custom WebGL layer. The
  // caller owns the data and passes a mercator-delta buffer + the fp64
  // origin those deltas were computed against straight into the GPU
  // buffer with no per-point object allocation. We don't viewport-bound
  // the data here; the layer renders whatever's loaded, and pan/zoom
  // is purely a per-frame matrix update on the GPU.
  points?: { deltas: Float32Array; origin: [number, number] } | null;
  // Optional per-point RGB color overlay (one byte triple per point,
  // matched 1:1 with `points`). When provided, every dot uses its own
  // color instead of the layer's default style color. Mismatched
  // length is ignored by the layer.
  pointColors?: Uint8Array | null;
  // Optional per-point size scaling factor (one float per point).
  // 1.0 = the zoom-driven base size; >1 grows the dot. Used by the
  // cutter to flag high-door buildings.
  pointSizes?: Float32Array | null;
  // Fires after pan/zoom settle (`moveend`) with the current viewport
  // bounds + zoom. Caller is responsible for any debouncing. Currently
  // unused by the points layer (which loads everything once); kept
  // around for callers that still want viewport awareness.
  onViewportChange?: (viewport: Viewport) => void;
  // Force the street-label overlay on and drop its toggle; omit to
  // keep the toggle.
  streetsAlwaysOn?: boolean;
  // Content for the bottom-right inset, rendered below the built-in
  // "Show streets" toggle in the same card. Lets routes drop in extra
  // rows without re-inventing an absolute-positioned inset.
  cornerLowerRight?: ReactNode;
  // Content for the upper-right inset — same card styling and edge offsets
  // as the lower-right slot. Positional slot; the route owns the content.
  cornerUpperRight?: ReactNode;
  // Upper-left counterpart.
  cornerUpperLeft?: ReactNode;
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
const SHAPE_LABELS_SOURCE_ID = "shape-labels";
// The two shape-label layers, in stacking order. The points layer is
// kept immediately below these (badges stay readable over the dots) —
// shared with PointsLayer via its `keepBelow` option.
const SHAPE_LABEL_LAYER_IDS = ["shape-labels-badged", "shape-labels"];
const LABEL_BADGE_IMAGES = {
  light: "shape-label-plate-light",
  dark: "shape-label-plate-dark",
} as const;

// The label plate: a translucent rounded rectangle drawn once at 2x,
// with stretch zones between the corners so icon-text-fit can size it
// to any label width without distorting the radius. Coordinates in the
// metadata below are image pixels (36px image = 18 CSS px, radius 12 =
// rounded-md's 6). Both theme variants are registered; the layer picks
// per theme.
function badgePlateImage(variant: keyof typeof LABEL_BADGE_IMAGES): ImageData {
  const size = 36;
  const radius = 12;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.beginPath();
  ctx.roundRect(1, 1, size - 2, size - 2, radius);
  ctx.fillStyle = variant === "dark" ? "rgba(20, 20, 20, 0.85)" : "rgba(255, 255, 255, 0.82)";
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = variant === "dark" ? "rgba(255, 255, 255, 0.28)" : "rgba(0, 0, 0, 0.25)";
  ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}

const LABEL_BADGE_METADATA = {
  pixelRatio: 2,
  stretchX: [[14, 22]] as [number, number][],
  stretchY: [[14, 22]] as [number, number][],
  content: [12, 12, 24, 24] as [number, number, number, number],
};

export function Map({
  initialViewState,
  className,
  boundariesUrl,
  coloringByKey,
  coloredFillOpacity = 0.4,
  activeKeys,
  zonePerimeters,
  onZoneClick,
  shapeLabels,
  onBadgeClick,
  selectedZoneId,
  selectedZoneIds,
  fitBounds,
  onPolygonClick,
  onPolygonHover,
  onBackgroundClick,
  loading,
  loadingSpinner = false,
  points,
  pointColors,
  pointSizes,
  onViewportChange,
  streetsAlwaysOn,
  cornerLowerRight,
  cornerUpperRight,
  cornerUpperLeft,
}: MapProps) {
  const isDark = useAtomValue(darkAtom);
  const [streetsToggled, setStreetsToggled] = useState(false);
  const showLabels = streetsAlwaysOn || streetsToggled;
  // Street labels sit beneath every overlay layer this map renders —
  // insert them before whichever of ours is lowest in the stack.
  const streetLabelsBeforeId = boundariesUrl
    ? BOUNDARIES_FILL_LAYER
    : zonePerimeters
      ? ZONE_PERIMETERS_FILL_LAYER
      : shapeLabels
        ? "shape-labels-badged"
        : undefined;
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
  // The two sets above track which keys we've written feature-state
  // for on the *current* boundaries source. When the source remounts
  // (URL change → keyed source remount), the new source has a fresh
  // `SourceFeatureState`, so the old keys are stale and must not be
  // queued for `removeFeatureState` against the new source.
  useEffect(() => {
    prevColoredRef.current = new Set();
    prevActiveRef.current = new Set();
  }, [boundariesUrl]);
  // True from the moment a `fitBounds` prop arrives until we've
  // actually applied it on the map. Combined with `loading` and
  // `mapReady` to drive the curtain: parents need fitBounds to land
  // before they can show the map, but firing the application is
  // async (we wait for the perimeters source to finish tessellating
  // before jumping). Tracking the in-flight state here means the
  // curtain stays up across re-frames without any parent
  // coordination.
  const [pendingFit, setPendingFit] = useState(false);
  // Last bounds we actually fit to — refetched-but-identical-content
  // bounds short-circuit the fit effect so a focus refetch doesn't reset
  // the camera the user just panned.
  const lastFitBoundsRef = useRef<readonly number[] | null>(null);
  // Spinner on the curtain once it's been up a beat — the curtain is
  // otherwise featureless, indistinguishable from an empty map.
  // Delayed so fast loads never flash it.
  const curtainUp = !mapReady || pendingFit || Boolean(loading);
  const showSpinner = useDelayedFlag(loadingSpinner && curtainUp, { showAfter: 300 });
  // Report curtain-up to the global indicator: the map's own network
  // work (style/tiles) is invisible to React Query and the router, so
  // without this the indicator drops while the map is still blank.
  const setMapLoading = useSetAtom(mapLoadingCountAtom);
  useEffect(() => {
    if (!curtainUp) return;
    setMapLoading((c) => c + 1);
    return () => setMapLoading((c) => c - 1);
  }, [curtainUp, setMapLoading]);

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
  }, [coloringByKey, boundariesUrl, isDark, mapReady]);

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
  }, [activeKeys, boundariesUrl, isDark, mapReady]);

  // Mark the selected zone's perimeter feature with `selected: true`
  // so the line layer's paint expression bumps its weight + opacity.
  // Mirrors the per-key `active` pattern above, just on the
  // zone-perimeters source (keyed on `zoneId` via `promoteId`).
  const prevSelectedZonesRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!zonePerimeters) return;
    const map = mapRef.current?.getMap();
    if (!map) return;

    const apply = () => {
      if (!map.getSource(ZONE_PERIMETERS_SOURCE_ID)) return;
      if (!map.isSourceLoaded(ZONE_PERIMETERS_SOURCE_ID)) return;
      // Diff per id — MapLibre's bulk removeFeatureState(source, key)
      // without an id does not reliably clear, so each previously-set
      // id is removed explicitly.
      const next = new Set(selectedZoneIds ?? (selectedZoneId ? [selectedZoneId] : []));
      for (const id of prevSelectedZonesRef.current) {
        if (!next.has(id)) {
          map.removeFeatureState({ source: ZONE_PERIMETERS_SOURCE_ID, id }, "selected");
        }
      }
      for (const id of next) {
        map.setFeatureState({ source: ZONE_PERIMETERS_SOURCE_ID, id }, { selected: true });
      }
      prevSelectedZonesRef.current = next;
    };

    apply();
    const handler = (e: { sourceId?: string; isSourceLoaded?: boolean }) => {
      if (e.sourceId === ZONE_PERIMETERS_SOURCE_ID && e.isSourceLoaded) apply();
    };
    map.on("sourcedata", handler);
    return () => {
      map.off("sourcedata", handler);
    };
  }, [selectedZoneId, selectedZoneIds, zonePerimeters, isDark, mapReady]);

  // Pointer over clickable polygons, grab everywhere else. Query
  // features on every mousemove (with mouseout as a backstop) so cursor
  // state self-corrects each frame — fast cursor exits and source
  // remounts can otherwise leave the cursor stuck.
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current?.getMap();
    if (!map) return;
    const layers: string[] = [];
    if (onPolygonClick) layers.push(BOUNDARIES_FILL_LAYER);
    if (onZoneClick) layers.push(ZONE_PERIMETERS_FILL_LAYER);
    if (onBadgeClick) layers.push("shape-labels-badged");
    if (layers.length === 0) {
      setHoveringPolygon(false);
      return;
    }
    const onMove = (e: MapMouseEvent) => {
      // Filter to layers that actually exist on the style — avoids
      // MapLibre warnings when boundaries/perimeters haven't mounted
      // yet (e.g., during source swap).
      const present = layers.filter((l) => map.getLayer(l));
      if (present.length === 0) {
        setHoveringPolygon(false);
        return;
      }
      const features = map.queryRenderedFeatures(e.point, { layers: present });
      setHoveringPolygon(features.length > 0);
    };
    const onOut = () => setHoveringPolygon(false);
    map.on("mousemove", onMove);
    map.on("mouseout", onOut);
    return () => {
      map.off("mousemove", onMove);
      map.off("mouseout", onOut);
    };
  }, [onPolygonClick, onZoneClick, mapReady]);

  // Hover surface for the boundaries layer. Sets a `hover` feature-
  // state on the polygon under the cursor (read by the line layer's
  // paint expression for an outline highlight) and fires
  // `onPolygonHover` with the same key for callers that want to
  // surface info elsewhere (the zones editor's inset). Both side
  // effects are deduplicated so consecutive moves over the same
  // feature don't repaint or re-fire.
  //
  // `mousemove` (not `mouseenter`) is the right event here because
  // we want to detect cursor crossings between adjacent polygons,
  // not just enter/leave from outside the layer.
  //
  // Gated on `mapReady` so the listener attaches after the
  // boundaries layer has been added by react-map-gl — listeners
  // registered before the layer exists silently never fire.
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current?.getMap();
    if (!map) return;
    let last: string | null = null;
    const fire = (next: string | null) => {
      if (next === last) return;
      if (last) {
        map.removeFeatureState({ source: BOUNDARIES_SOURCE_ID, id: last }, "hover");
      }
      if (next) {
        map.setFeatureState({ source: BOUNDARIES_SOURCE_ID, id: next }, { hover: true });
      }
      last = next;
      onPolygonHover?.(next);
    };
    const onMove = (e: MapMouseEvent) => {
      const k = e.features?.[0]?.properties?.key;
      fire(typeof k === "string" ? k : null);
    };
    const onLeave = () => fire(null);
    map.on("mousemove", BOUNDARIES_FILL_LAYER, onMove);
    map.on("mouseleave", BOUNDARIES_FILL_LAYER, onLeave);
    return () => {
      map.off("mousemove", BOUNDARIES_FILL_LAYER, onMove);
      map.off("mouseleave", BOUNDARIES_FILL_LAYER, onLeave);
    };
  }, [onPolygonHover, mapReady]);

  const handleClick = (e: MapMouseEvent) => {
    const feature = e.features?.[0];
    // Badge plates first — their features also carry `zoneId`, so
    // they must dispatch before the generic zoneId branch below.
    if (feature?.layer?.id === "shape-labels-badged") {
      const id = feature.properties?.zoneId;
      if (typeof id === "string") {
        onBadgeClick?.(id);
        return;
      }
    }
    // Zone perimeters take priority — they sit on top of boundary
    // fills, so a click on one is a zone click, not a key click.
    const zoneId = feature?.properties?.zoneId;
    if (typeof zoneId === "string") {
      onZoneClick?.(zoneId);
      return;
    }
    const key = feature?.properties?.key;
    if (typeof key === "string") {
      onPolygonClick?.(key, { shiftKey: e.originalEvent.shiftKey });
    } else {
      onBackgroundClick?.();
    }
  };

  // Register the label plate images. `setStyle` (theme toggle) wipes
  // images, so `styleimagemissing` is the durable re-add hook — it
  // fires whenever a layer wants an image that isn't there.
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current?.getMap();
    if (!map) return;
    const ensure = (variant: keyof typeof LABEL_BADGE_IMAGES) => {
      const id = LABEL_BADGE_IMAGES[variant];
      if (!map.hasImage(id)) {
        map.addImage(id, badgePlateImage(variant), LABEL_BADGE_METADATA);
      }
    };
    ensure("light");
    ensure("dark");
    const onMissing = (e: { id: string }) => {
      if (e.id === LABEL_BADGE_IMAGES.light) ensure("light");
      if (e.id === LABEL_BADGE_IMAGES.dark) ensure("dark");
    };
    map.on("styleimagemissing", onMissing);
    return () => {
      map.off("styleimagemissing", onMissing);
    };
  }, [mapReady]);

  // Add the WebGL points layer once the map is up. We add even when
  // `points` is undefined so a later prop change doesn't cost a layer
  // re-create — `setPoints` just toggles the visible point count.
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current?.getMap();
    if (!map) return;
    const layer = new PointsLayer({ id: "segment-points", keepBelow: SHAPE_LABEL_LAYER_IDS });
    pointsLayerRef.current = layer;
    if (!map.getLayer(layer.id)) map.addLayer(layer);
    return () => {
      pointsLayerRef.current = null;
      if (map.getLayer(layer.id)) map.removeLayer(layer.id);
    };
  }, [mapReady]);

  // Keep the points layer stacked correctly, whenever the style
  // changes: above every other layer EXCEPT the shape labels, whose
  // badges must stay readable over the dots. The JSX-driven
  // Source/Layer components (boundaries, zone perimeters, labels) add
  // their layers via react-map-gl's own internal effects, which we
  // don't directly observe and which run on a different schedule from
  // our imperative addLayer for points. Result: any time someone else
  // adds a layer (style load, source mount, dynamic toggle), points
  // can end up mis-stacked and stay there.
  //
  // `styledata` fires after every style mutation, so we just listen
  // and re-stack whenever points isn't already in position. moveLayer
  // itself fires `styledata` again, but the next check sees points in
  // place and exits — no loop. This logic MUST stay in lockstep with
  // PointsLayer.nudgeOnTop (which gets the same target via the
  // `keepBelow` option) — if the two disagree, they re-stack against
  // each other on every styledata: a permanent repaint loop.
  //
  // IMPORTANT: the order check must use `getLayersOrder()`, never
  // `getStyle().layers` — the latter is a serialization that omits
  // custom layers, so points could never satisfy the position check
  // and every styledata triggered a moveLayer, which fired styledata
  // again: a permanent 60fps repaint loop that kept the map from ever
  // going idle (and disabled symbol fades, which are gated behind the
  // first `idle`).
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current?.getMap();
    if (!map) return;
    const ensure = () => {
      if (!map.getLayer("segment-points")) return;
      const order = map.getLayersOrder();
      const idx = order.indexOf("segment-points");
      if (idx < 0) return;
      // In position iff everything above the dots is a shape-label
      // layer and no shape-label layer sits below them.
      const above = order.slice(idx + 1);
      const labelsPresent = order.filter((id) => SHAPE_LABEL_LAYER_IDS.includes(id));
      if (
        above.length === labelsPresent.length &&
        above.every((id) => SHAPE_LABEL_LAYER_IDS.includes(id))
      ) {
        return;
      }
      map.moveLayer(
        "segment-points",
        order.find((id) => SHAPE_LABEL_LAYER_IDS.includes(id)),
      );
    };
    // `styledata` covers most reorder triggers; `idle` is the
    // belt-and-suspenders hook — fires when the map has fully
    // settled after any pending tile / source / style work, so any
    // reorder that didn't surface as `styledata` still gets
    // corrected once the map is quiet.
    map.on("styledata", ensure);
    map.on("idle", ensure);
    return () => {
      map.off("styledata", ensure);
      map.off("idle", ensure);
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

  // Per-point overlays. Both run independent of `setPoints` — the
  // layer re-derives the buffers automatically when points change,
  // so a re-upload on every prop tick isn't required, only when the
  // overlay itself shifts.
  useEffect(() => {
    pointsLayerRef.current?.setColors(pointColors);
  }, [pointColors, mapReady]);
  useEffect(() => {
    pointsLayerRef.current?.setSizes(pointSizes);
  }, [pointSizes, mapReady]);

  // Match the dot color to the current theme. Dark dots on light
  // basemap, light dots on dark basemap — high contrast both ways.
  // `mapReady` dep for the same reason as above.
  useEffect(() => {
    pointsLayerRef.current?.setStyle({
      color: isDark ? "#e5e5e5" : "#1a1a1a",
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
    if (!fitBounds) {
      lastFitBoundsRef.current = null;
      setPendingFit(false);
      return;
    }
    // Refetched-but-identical-content bounds shouldn't reset the camera
    // after the user has panned/zoomed. Compare by value.
    const prev = lastFitBoundsRef.current;
    if (prev && prev.every((v, i) => v === fitBounds[i])) return;
    setPendingFit(true);
    if (!mapReady) return;
    const map = mapRef.current?.getMap();
    if (!map) return;
    const fit = () => {
      // Padding scales with the container: a flat 40px reads right on
      // desktop editors but eats over a quarter of a phone-width
      // dialog, leaving the shape floating under-zoomed.
      const el = map.getContainer();
      const padding = Math.min(40, Math.round(Math.min(el.clientWidth, el.clientHeight) * 0.08));
      map.fitBounds(
        [
          [fitBounds[0], fitBounds[1]],
          [fitBounds[2], fitBounds[3]],
        ],
        { padding, duration: 0 },
      );
      lastFitBoundsRef.current = fitBounds;
      setPendingFit(false);
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
      className={cn("relative h-full overflow-hidden rounded-lg border border-border", className)}
    >
      <MapLibreMap
        ref={mapRef}
        initialViewState={{ ...DEFAULT_VIEW, ...initialViewState }}
        mapStyle={getMaptilerStyleUrl(isDark)}
        attributionControl={false}
        style={{ width: "100%", height: "100%" }}
        // Every map stays north-up and flat: no rotation, no pitch.
        // touchZoomRotate={false} would kill pinch zoom too, so only its
        // rotation half is disabled (below, after load).
        dragRotate={false}
        touchPitch={false}
        maxPitch={0}
        onLoad={() => {
          const map = mapRef.current?.getMap();
          map?.touchZoomRotate.disableRotation();
          map?.keyboard.disableRotation();
          setMapReady(true);
          // Dev-only console handle for render-loop / placement
          // diagnostics (label-fade gate, idle behavior).
          if (import.meta.env.DEV) {
            (window as { __map?: unknown }).__map = mapRef.current?.getMap();
          }
        }}
        // Disabled: MapLibre's box-zoom handler intercepts
        // shift+drag (and effectively shift+click) to draw a zoom
        // rectangle. The zone editor uses shift+click to toggle
        // key membership in a zone, so we need the click event to
        // pass through unmolested.
        boxZoom={false}
        // `interactiveLayerIds` filters the `features` field on the
        // click event to those layers — without it, basemap clicks
        // would never resolve a polygon. `onClick` itself fires for
        // every map click, so background-vs-polygon dispatch happens
        // in `handleClick`.
        interactiveLayerIds={[
          ...(onPolygonClick ? [BOUNDARIES_FILL_LAYER] : []),
          ...(onZoneClick ? [ZONE_PERIMETERS_FILL_LAYER] : []),
          ...(onBadgeClick ? ["shape-labels-badged"] : []),
        ]}
        onClick={
          onPolygonClick || onZoneClick || onBadgeClick || onBackgroundClick
            ? handleClick
            : undefined
        }
        cursor={
          (onPolygonClick || onZoneClick || onBadgeClick) && hoveringPolygon ? "pointer" : "grab"
        }
      >
        {boundariesUrl ? (
          <Source
            // Force a fresh source whenever the URL changes — `setData` on
            // the same source id otherwise reuses MapLibre's
            // `SourceFeatureState`, and stale entries from the previous
            // key group's keys can corrupt the deletion queue and crash
            // the next `coalesceChanges` (`Object.keys` of an undefined
            // `deletedStates[layer][feature]` slot). Remounting wipes
            // feature-state cleanly.
            key={boundariesUrl}
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
                // Three-way stroke weight: active zone keys >
                // hovered key > everything else. Active wins over
                // hover so the active zone outline doesn't lose
                // emphasis when the user moves their cursor across
                // its own keys.
                "line-width": [
                  "case",
                  ["==", ["feature-state", "active"], true],
                  1.5,
                  ["==", ["feature-state", "hover"], true],
                  1.25,
                  0.75,
                ],
                "line-opacity": [
                  "case",
                  ["==", ["feature-state", "active"], true],
                  1,
                  ["==", ["feature-state", "hover"], true],
                  0.85,
                  0.5,
                ],
              }}
            />
          </Source>
        ) : null}

        {zonePerimeters ? (
          <Source
            id={ZONE_PERIMETERS_SOURCE_ID}
            type="geojson"
            data={zonePerimeters}
            // Promote `zoneId` to feature id so feature-state can
            // address each zone by its id (used for the selected-
            // zone outline emphasis below).
            promoteId="zoneId"
          >
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
                // Per-feature `opacity` override for callers that encode
                // state in fill strength (the turfs board's walk states).
                "fill-opacity": ["coalesce", ["get", "opacity"], 0.65],
              }}
            />
            <Layer
              id={ZONE_PERIMETERS_LINE_LAYER}
              type="line"
              paint={{
                // Per-feature `lineColor` override (drawn solid); the
                // theme-neutral stroke is the fallback. The turf maps
                // use it to match each outline to its fill color.
                "line-color": [
                  "coalesce",
                  ["get", "lineColor"],
                  isDark ? "hsl(0, 0%, 95%)" : "hsl(0, 0%, 5%)",
                ],
                // Thin and faded by default; the selected zone gets
                // the heavier stroke at full opacity so it reads as
                // the active one without disrupting the others.
                "line-width": ["case", ["==", ["feature-state", "selected"], true], 1.5, 0.75],
                "line-opacity": [
                  "case",
                  ["==", ["feature-state", "selected"], true],
                  1,
                  ["!=", ["get", "lineColor"], null],
                  1,
                  0.5,
                ],
              }}
            />
          </Source>
        ) : null}

        {shapeLabels ? (
          <Source id={SHAPE_LABELS_SOURCE_ID} type="geojson" data={shapeLabels}>
            {/* Badged labels ride a stretchable rounded-rect plate
                (icon-text-fit sizes it to the text); plate and text
                colors flip with the theme. */}
            <Layer
              id="shape-labels-badged"
              type="symbol"
              filter={["==", ["get", "badge"], true]}
              layout={{
                "text-field": ["get", "label"],
                "text-size": 15,
                // Served by MapTiler's glyph endpoint (verified) — the
                // style's default stack isn't mono, and mono digits keep
                // plate widths steady across equal-length labels.
                "text-font": ["Roboto Mono Regular"],
                "text-allow-overlap": false,
                "icon-image": isDark ? LABEL_BADGE_IMAGES.dark : LABEL_BADGE_IMAGES.light,
                "icon-text-fit": "both",
                "icon-text-fit-padding": [0, 0, 0, 0],
                "icon-allow-overlap": false,
              }}
              paint={{ "text-color": isDark ? "hsl(0, 0%, 92%)" : "hsl(0, 0%, 10%)" }}
            />
            <Layer
              id="shape-labels"
              type="symbol"
              filter={["!=", ["get", "badge"], true]}
              layout={{
                "text-field": ["get", "label"],
                "text-size": 13,
                // Counts are small and every label sits inside its own
                // shape — collision-hiding tiny turfs' numbers would
                // defeat the layer's purpose.
                "text-allow-overlap": true,
              }}
              paint={LABEL_PAINT(isDark)}
            />
          </Source>
        ) : null}

        {/* Symbol placement runs top-down, so badges claim collision
            space first and street names flow around the plates — layer
            order is MapLibre's only collision-priority mechanism. */}
        {showLabels ? (
          <Source id={LABELS_SOURCE_ID} type="vector" url={MAPTILER_OPENMAPTILES_TILEJSON_URL}>
            {/* Cities (zoom 4–14) */}
            <Layer
              id="labels-city"
              beforeId={streetLabelsBeforeId}
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
              beforeId={streetLabelsBeforeId}
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
              beforeId={streetLabelsBeforeId}
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
              beforeId={streetLabelsBeforeId}
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
              beforeId={streetLabelsBeforeId}
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

      {/* Bottom-right inset. Single rounded card with one row per
          toggle; built-in "Show streets" is the first row, routes
          add extra rows via `cornerLowerRight` (which render below).
          `divide-y` puts a separator between rows, so the
          cornerLowerRight labels just need padding/gap, not their
          own border or background. */}
      {!streetsAlwaysOn || cornerLowerRight ? (
        <div
          className={
            "absolute right-3 bottom-3 z-20 flex flex-col items-stretch " +
            "rounded-md border border-border bg-background text-sm"
          }
        >
          {!streetsAlwaysOn ? (
            <label className="flex items-center gap-3 px-3 py-3">
              <Switch checked={streetsToggled} onCheckedChange={setStreetsToggled} />
              <span>Show streets</span>
            </label>
          ) : null}
          {cornerLowerRight}
        </div>
      ) : null}

      {cornerUpperLeft ? (
        <div
          className={
            "absolute top-3 left-3 z-20 flex flex-col items-stretch " +
            "rounded-md border border-border bg-background text-sm"
          }
        >
          {cornerUpperLeft}
        </div>
      ) : null}

      {/* Upper-right inset — same card + edge offsets as the lower slots;
          positional, content supplied by the route. */}
      {cornerUpperRight ? (
        <div
          className={
            "absolute top-3 right-3 z-20 flex flex-col items-stretch " +
            "rounded-md border border-border bg-background text-sm"
          }
        >
          {cornerUpperRight}
        </div>
      ) : null}

      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-background",
          // Show instantly when activating so a binding swap can never
          // leave the canvas partially visible during a fade-in;
          // transition only when retreating, so the reveal is smooth.
          curtainUp ? "opacity-100" : "opacity-0 transition-opacity duration-150",
        )}
      >
        {/* Fade lives on the wrapper — `animate-in` and `animate-spin`
            both set `animation`, so on one element the spin clobbers
            the fade. Stays mounted past curtain-drop (`minVisible`)
            so it fades out with the curtain instead of popping off. */}
        {showSpinner ? (
          <span className="animate-in fade-in duration-300">
            <Icon
              name="loader-circle"
              className="size-6 animate-spin text-muted-foreground [stroke-width:2.5]"
            />
          </span>
        ) : null}
      </div>
    </div>
  );
}
