import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import { type MapMouseEvent, useMap } from "react-map-gl/maplibre";
import { pointInPolygon } from "~/lib/geometry";
import { colorFor } from "~/lib/zone-colors";

// Polygon-drawing surface for the turf cutter. Reads the underlying
// MapLibre instance from the surrounding `<MapProvider>` so it adds
// no props to the Map component itself.
//
// One *zone* is being cut at a time (the cutter URL is per-
// zoneId); within that zone the user lays down multiple *turfs*,
// each its own closed polygon. Turfs are independent — closing one
// starts a fresh in-progress turf on the next click on empty
// space; clicking on an existing closed turf selects it instead.
//
// State (turfs[], selectedTurfId) lives in the parent so the
// sidebar list and the drawer share it. Drawer reads it and writes
// back through setters.
//
// Per-frame positioning is **imperative** (DOM `setAttribute`
// inside the `render` event) rather than React-rendered. Routing
// per-frame projection through React batches the SVG update behind
// the basemap paint by a frame or two, visible as the polygon
// lagging during pan/zoom. React still owns structure (which turfs
// exist, their vertex counts, fill state, who's selected); only
// positions, ghost segment, and snap indicator are written
// imperatively.
//
// Per-turf state machine:
//
//   drawing:   clicks add vertices; ghost segment from last vertex
//              to cursor; clicking within `SNAP_RADIUS` of the
//              first vertex (with ≥3 vertices) closes the polygon.
//   editing:   polygon is closed and filled. Editing gestures
//              (drag/insert/delete) come in later chunks.
//
// At most one turf is in `drawing` mode at any moment; clicks that
// fall after a close start a brand-new turf. Escape during drawing
// removes the in-progress turf (closed turfs are unaffected).

export type Turf = {
  id: string;
  vertices: Array<[number, number]>;
  mode: "drawing" | "editing";
};

// 12px screen-space radius is the conventional snap-to-close
// threshold (mapbox-gl-draw, terra-draw both use roughly this).
const SNAP_RADIUS = 12;

// Pointer movement (in pixels) before we treat a vertex
// pointerdown as a drag instead of a click. Below this, pointerup
// runs click semantics — e.g. snap-closing the polygon when
// clicking its first vertex.
const DRAG_THRESHOLD = 3;

// Custom delete cursor — small red ✕ centered on the hotspot,
// shown when alt is held over a vertex that's safe to remove.
// Built-in `not-allowed` reads as "you can't do this"; this reads
// as "this will delete," which is the actual semantic. Inline SVG
// data URL avoids shipping an asset.
const DELETE_CURSOR =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20'><line x1='5' y1='5' x2='15' y2='15' stroke='black' stroke-width='2.5' stroke-linecap='round'/><line x1='15' y1='5' x2='5' y2='15' stroke='black' stroke-width='2.5' stroke-linecap='round'/></svg>\") 10 10, not-allowed";

type Props = {
  turfs: Turf[];
  setTurfs: Dispatch<SetStateAction<Turf[]>>;
  selectedTurfId: string | null;
  setSelectedTurfId: Dispatch<SetStateAction<string | null>>;
  // Fires with the cursor's lng/lat whenever the pointer moves
  // over the map, and `null` when it leaves the map area. Caller
  // uses it to compute a live count for the in-progress drawing
  // turf — the polygon there is implicitly closed by a segment
  // from the cursor back to the first vertex, so the count needs
  // the cursor position the same frame.
  onCursorChange?: (lngLat: [number, number] | null) => void;
  // Fires once per discrete "commit" — polygon close, vertex drag-end,
  // midpoint drag-end, vertex delete on a closed turf — with the
  // committed turfs. Intermediate updates (mid-drag, drawing-turf
  // mutations) don't fire it.
  onCommit?: (turfs: Turf[]) => void;
};

export function TurfDrawer({
  turfs,
  setTurfs,
  selectedTurfId,
  setSelectedTurfId,
  onCursorChange,
  onCommit,
}: Props) {
  // Mirror `turfs` for commit-time reads from drag-end handlers, where
  // the latest state isn't available inline.
  const turfsPropRef = useRef(turfs);
  useEffect(() => {
    turfsPropRef.current = turfs;
  }, [turfs]);
  // `useMap().current` only resolves for children rendered inside
  // a Map; we're a sibling, so we read by registration id. With no
  // explicit `id` prop, the underlying `MapLibreMap` registers
  // under the key `"default"`.
  const ctx = useMap();
  const map = ctx.default?.getMap() ?? null;

  // Cursor in screen space — when the user pans without moving the
  // mouse, the cursor stays at the same viewport pixel even as the
  // lng/lat under it changes, and the ghost segment should stretch
  // with the polygon end (which moves with the basemap), not with
  // the cursor end.
  const cursorRef = useRef<[number, number] | null>(null);

  // While a vertex is being dragged, holds which one. The actual
  // position update flows through `setTurfs` so the rest of the
  // app (counts, sidebar) sees it; the ref is just to know which
  // vertex the in-flight `pointermove` events apply to. Cleared on
  // pointerup.
  const dragRef = useRef<{ turfId: string; vertexIdx: number } | null>(null);

  // Midpoint-initiated drags use a separate ref + document-level
  // listeners (see effect below). The midpoint element disappears
  // the instant we insert the vertex (the array shifts, that DOM
  // slot now belongs to a different edge's midpoint), so we can't
  // rely on element-scoped pointer capture the way the vertex
  // handles do. Listening at the document is robust to that
  // remount.
  const midpointDragRef = useRef<{ turfId: string; vertexIdx: number } | null>(null);

  // Click-vs-drag disambiguation. Pointerdown on a vertex doesn't
  // immediately mean "drag this vertex" — it might be a click
  // (e.g., on the first vertex of a drawing turf to snap-close).
  // We record the pointerdown position and only promote to a drag
  // once movement exceeds `DRAG_THRESHOLD`. On pointerup, if no
  // drag started, we run click semantics instead (currently:
  // close the polygon if it was vertex 0 of a drawing turf with
  // ≥3 vertices).
  const pointerStartRef = useRef<{
    turfId: string;
    vertexIdx: number;
    x: number;
    y: number;
  } | null>(null);

  const svgRef = useRef<SVGSVGElement>(null);

  // The vertex just placed by the most recent click. Pointer ends
  // up on top of the new circle, and a `grab` cursor there reads
  // as "you've stopped drawing" — so we suppress it (showing
  // crosshair to match the canvas) until the user moves off the
  // handle. Re-hovering after that gets the normal `grab`.
  const [freshVertex, setFreshVertex] = useState<{ turfId: string; vertexIdx: number } | null>(
    null,
  );

  // Tracked so we can swap the vertex cursor to a "delete" affordance
  // while alt is held. Reading `e.altKey` on pointerdown is what
  // actually triggers the delete; this is just so the cursor signals
  // intent before the click.
  const [altDown, setAltDown] = useState(false);
  useEffect(() => {
    const sync = (e: KeyboardEvent) => setAltDown(e.altKey);
    // Also clear on blur — if the user alt-tabs away with alt held,
    // the keyup never fires and the cursor would stick.
    const clear = () => setAltDown(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
    };
  }, []);

  // Wheel-event forwarder. The vertex circles have
  // `pointer-events: all` so they catch hover/drag, but that also
  // means wheel events that land on a handle never reach MapLibre's
  // canvas — they bubble up to the document and scroll the page
  // instead of zooming the map. We attach a non-passive wheel
  // listener on the SVG (so `preventDefault` actually works — React's
  // `onWheel` registers passive listeners and would no-op the
  // preventDefault) and re-dispatch a clone on the canvas so
  // MapLibre's scrollZoom handler picks it up.
  useEffect(() => {
    if (!map) return;
    const svg = svgRef.current;
    if (!svg) return;
    const canvas = map.getCanvas();
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          deltaZ: e.deltaZ,
          deltaMode: e.deltaMode,
          clientX: e.clientX,
          clientY: e.clientY,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [map]);

  // Document-level pointer handlers for midpoint-initiated drags.
  // The midpoint element gets unmounted the moment the new vertex
  // is inserted (its slot now belongs to a different edge's
  // midpoint), so element-scoped `setPointerCapture` isn't an
  // option — listen at the document instead. The handlers only do
  // anything when `midpointDragRef` is set; otherwise they're cheap
  // branches that no-op.
  useEffect(() => {
    if (!map) return;
    const onMove = (e: PointerEvent) => {
      const drag = midpointDragRef.current;
      if (!drag) return;
      const rect = map.getCanvas().getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const { lng, lat } = map.unproject([x, y]);
      setTurfs((ts) =>
        ts.map((t) =>
          t.id === drag.turfId
            ? {
                ...t,
                vertices: t.vertices.map((v, vi) => (vi === drag.vertexIdx ? [lng, lat] : v)),
              }
            : t,
        ),
      );
    };
    const onUp = () => {
      if (!midpointDragRef.current) return;
      midpointDragRef.current = null;
      map.dragPan.enable();
      document.body.style.userSelect = "";
      // Midpoints only render on closed turfs, so this is always a commit.
      onCommit?.(turfsPropRef.current);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  }, [map, setTurfs, onCommit]);

  // Click handler routes between three behaviors, in priority:
  //   1. Hit a closed turf → select it.
  //   2. Active drawing turf → snap-close (≥3 verts) or add vertex.
  //   3. Empty click → start a new turf (replaces any current
  //      selection). Click on empty *always* creates — there's no
  //      deselect-via-click step, since users want to place
  //      successive turfs without an intervening discard click.
  //      Escape (or shift+click) deselects when nothing is being
  //      drawn, and discards the in-progress turf when one is.
  useEffect(() => {
    if (!map) return;
    const onClick = (e: MapMouseEvent) => {
      // Shift+click is the on-map equivalent of Escape — same
      // "step back" semantics: discard a drawing turf if one's in
      // flight, otherwise clear the selection. Lives ahead of the
      // priority-ordered branches below so it can never be
      // shadowed by a closed-turf hit-test.
      if (e.originalEvent.shiftKey) {
        if (turfs.some((t) => t.mode === "drawing")) {
          setTurfs((ts) => ts.filter((t) => t.mode !== "drawing"));
          cursorRef.current = null;
          setFreshVertex(null);
        } else if (selectedTurfId) {
          setSelectedTurfId(null);
        }
        return;
      }

      const click: [number, number] = [e.point.x, e.point.y];

      // 1. Hit-test closed turfs first. Project each closed turf
      // to screen space and run point-in-polygon against the
      // click. Selection wins over starting/extending so the user
      // can always click a polygon to focus it.
      for (const turf of turfs) {
        if (turf.mode !== "editing") continue;
        const screen = turf.vertices.map(([lng, lat]) => {
          const p = map.project([lng, lat]);
          return [p.x, p.y] as [number, number];
        });
        if (pointInPolygon(click, screen)) {
          setSelectedTurfId(turf.id);
          return;
        }
      }

      // 2. Active drawing turf: snap-close or add vertex.
      const activeIdx = turfs.findIndex((t) => t.mode === "drawing");
      const active = activeIdx >= 0 ? turfs[activeIdx]! : null;
      if (active && active.vertices.length >= 3) {
        const v0 = map.project(active.vertices[0]!);
        if (Math.hypot(click[0] - v0.x, click[1] - v0.y) <= SNAP_RADIUS) {
          setTurfs((ts) => {
            const next = ts.map((t, i) =>
              i === activeIdx ? { ...t, mode: "editing" as const } : t,
            );
            onCommit?.(next);
            return next;
          });
          setFreshVertex(null);
          return;
        }
      }

      const { lng, lat } = e.lngLat;
      if (active) {
        const newIdx = active.vertices.length;
        setTurfs((ts) =>
          ts.map((t, i) => (i === activeIdx ? { ...t, vertices: [...t.vertices, [lng, lat]] } : t)),
        );
        setFreshVertex({ turfId: active.id, vertexIdx: newIdx });
        return;
      }

      // 3. Start a new turf, replacing any current selection.
      const id = crypto.randomUUID();
      setTurfs((ts) => [...ts, { id, vertices: [[lng, lat]], mode: "drawing" }]);
      setSelectedTurfId(id);
      setFreshVertex({ turfId: id, vertexIdx: 0 });
    };
    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
    };
  }, [map, turfs, setTurfs, selectedTurfId, setSelectedTurfId, onCommit]);

  // Escape is the only deselect/cancel gesture (clicking on empty
  // always creates a new turf). When a turf is mid-draw, Escape
  // discards it without touching closed turfs. Otherwise Escape
  // clears the selection — no-op if nothing is selected.
  const hasDrawing = turfs.some((t) => t.mode === "drawing");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (hasDrawing) {
        setTurfs((ts) => ts.filter((t) => t.mode !== "drawing"));
        cursorRef.current = null;
        setFreshVertex(null);
      } else if (selectedTurfId) {
        setSelectedTurfId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [hasDrawing, selectedTurfId, setTurfs, setSelectedTurfId]);

  // Imperative per-frame sync. Iterates the SVG's per-turf groups
  // (one <g> per turf, each containing a <path> followed by a
  // handles <g>) and writes positions straight to the DOM. Skips
  // React's render cycle so the SVG always paints the same frame
  // as the basemap. Also drives the cursor: pointer over a closed
  // turf (clicking will select it), crosshair otherwise (clicking
  // will create / extend / deselect).
  useEffect(() => {
    if (!map) return;
    // react-map-gl/maplibre applies the `cursor` prop to
    // `map.getCanvas()`, not the canvas's container, so we have
    // to write to the same element to win CSS specificity. Inline
    // cursor on the canvas itself overrides anything set on
    // ancestors via inheritance.
    const canvas = map.getCanvas();
    const sync = () => {
      const svg = svgRef.current;
      if (!svg) return;

      // Cursor style reflects what the next click will do:
      //   - inside the snap-to-close ring of a drawing turf →
      //     pointer (click closes the polygon)
      //   - over closed turf → pointer (click selects it)
      //   - over empty → crosshair (click creates or extends)
      // No "deselect" cursor state — empty clicks always create,
      // and Escape is the only deselect gesture.
      let overClosedTurf = false;
      let inSnapZone = false;
      if (cursorRef.current) {
        for (const turf of turfs) {
          if (turf.mode === "editing") {
            const screen = turf.vertices.map(([lng, lat]) => {
              const p = map.project([lng, lat]);
              return [p.x, p.y] as [number, number];
            });
            if (pointInPolygon(cursorRef.current, screen)) {
              overClosedTurf = true;
              break;
            }
          } else if (turf.mode === "drawing" && turf.vertices.length >= 3) {
            const v0 = map.project(turf.vertices[0]!);
            const [cx, cy] = cursorRef.current;
            if (Math.hypot(cx - v0.x, cy - v0.y) <= SNAP_RADIUS) {
              inSnapZone = true;
              break;
            }
          }
        }
      }
      canvas.style.cursor = overClosedTurf || inSnapZone ? "pointer" : "crosshair";

      const turfGroups = svg.children;
      for (let i = 0; i < turfGroups.length && i < turfs.length; i++) {
        const turf = turfs[i]!;
        const group = turfGroups[i] as SVGGElement;
        const path = group.children[0] as SVGPathElement;
        const handles = group.children[1] as SVGGElement;
        // Midpoints group is only rendered for closed+selected
        // turfs, so it may not be present.
        const midpoints = group.children[2] as SVGGElement | undefined;
        if (!path || !handles) continue;

        if (turf.vertices.length === 0) {
          path.setAttribute("d", "");
          continue;
        }

        const pts: Array<[number, number]> = turf.vertices.map(([lng, lat]) => {
          const p = map.project([lng, lat]);
          return [p.x, p.y];
        });

        let d = `M ${pts.map(([x, y]) => `${x},${y}`).join(" L ")}`;
        if (turf.mode === "editing") {
          d += " Z";
        } else if (cursorRef.current) {
          const [cx, cy] = cursorRef.current;
          d += ` L ${cx},${cy}`;
        }
        path.setAttribute("d", d);

        // Snap indicator: enlarge the first vertex when the cursor
        // is in snap range AND this turf is the one being drawn.
        let inSnap = false;
        if (turf.mode === "drawing" && pts.length >= 3 && cursorRef.current) {
          const [v0x, v0y] = pts[0]!;
          const [cx, cy] = cursorRef.current;
          if (Math.hypot(cx - v0x, cy - v0y) <= SNAP_RADIUS) inSnap = true;
        }

        const circles = handles.children;
        for (let j = 0; j < circles.length && j < pts.length; j++) {
          const [x, y] = pts[j]!;
          const c = circles[j]!;
          c.setAttribute("cx", String(x));
          c.setAttribute("cy", String(y));
          c.setAttribute("r", j === 0 && inSnap ? "8.5" : "5.5");
        }

        // Midpoint positions — average adjacent projected vertex
        // coords. Projecting the lng/lat midpoint and averaging
        // projected coords differ by a fraction of a pixel at the
        // typical polygon scale, so the cheaper average is fine.
        // Last edge wraps from final vertex back to first.
        if (midpoints) {
          const midCircles = midpoints.children;
          for (let j = 0; j < midCircles.length && j < pts.length; j++) {
            const [x0, y0] = pts[j]!;
            const [x1, y1] = pts[(j + 1) % pts.length]!;
            const c = midCircles[j]!;
            c.setAttribute("cx", String((x0 + x1) / 2));
            c.setAttribute("cy", String((y0 + y1) / 2));
          }
        }
      }
    };

    const onRender = () => sync();
    // Cursor tracked via document-level mousemove with the *canvas*
    // bounding rect as the coord origin (not the SVG's). MapLibre's
    // `map.project()` returns canvas-relative pixels, so anything
    // we compare against projected vertex positions has to use the
    // same origin — otherwise small offsets between the canvas and
    // the SVG (subpixel layout, borders) show up as a shift between
    // the ghost segment and the placed vertex. `clientX/Y` and
    // `getBoundingClientRect` are both viewport-relative, so the
    // subtraction stays consistent through pan/zoom — sidesteps the
    // `e.point` staleness we'd see relying on MapLibre's own
    // `mousemove` during drag-pan / zoom gestures.
    const onDocMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const inside = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height;
      cursorRef.current = inside ? [x, y] : null;
      // Fire cursor lng/lat to the parent so it can include the
      // implicit closing segment when computing live counts for
      // the drawing turf. Skipped entirely when the consumer
      // didn't ask for it — keeps the no-callback path free of
      // an extra unproject + setState per move.
      if (onCursorChange) {
        if (inside) {
          const { lng, lat } = map.unproject([x, y]);
          onCursorChange([lng, lat]);
        } else {
          onCursorChange(null);
        }
      }
      sync();
    };
    sync();
    map.on("render", onRender);
    document.addEventListener("mousemove", onDocMove);
    return () => {
      map.off("render", onRender);
      document.removeEventListener("mousemove", onDocMove);
      // Restore the map's default cursor so unmounting the cutter
      // doesn't leak our crosshair/pointer override into other
      // surfaces that share the Map component.
      canvas.style.cursor = "";
    };
  }, [map, turfs, onCursorChange]);

  if (!map) return null;

  return (
    <svg
      ref={svgRef}
      aria-hidden
      // Sits over the map, lets clicks fall through to MapLibre so
      // the click-to-add-vertex listener still fires. Hit-testing
      // for selecting closed turfs happens in the click handler
      // above via point-in-polygon, which means turf polygons
      // never need their own pointer events.
      className="pointer-events-none absolute inset-0 z-10 h-full w-full"
    >
      {/* One <g> per turf, in render order. Each contains a <path>
          (outline + fill) and a handles <g> with the vertex
          circles. Position attributes (`d`, `cx`, `cy`, `r`) are
          intentionally omitted from JSX and written imperatively
          in the sync effect — listing them in JSX would make
          React reapply stale values on every re-render and
          overwrite our per-frame DOM writes. */}
      {turfs.map((turf, i) => {
        const isClosed = turf.mode === "editing";
        const showHandles = turf.mode === "drawing" || turf.id === selectedTurfId;
        const color = colorFor(i);
        // First vertex of a drawing turf with ≥3 vertices is the
        // snap-close target — show `pointer` so it reads as "click
        // to close" rather than `grab` ("drag me"). Every other
        // handle is draggable.
        const canClose = turf.mode === "drawing" && turf.vertices.length >= 3;
        return (
          <g key={turf.id}>
            <path
              // Same fill for drawing and closed turfs — SVG fills
              // an open path as if closed from last point back to
              // first, so the in-progress polygon (with the cursor
              // as its trailing vertex) shades live as the user
              // draws. Visualizes the same polygon used for the
              // sidebar's live count.
              fill={color}
              fillOpacity={0.25}
              stroke={color}
              strokeWidth={3}
            />
            <g style={showHandles ? undefined : { display: "none" }}>
              {turf.vertices.map((_, j) => {
                const isFresh = freshVertex?.turfId === turf.id && freshVertex?.vertexIdx === j;
                // Alt over a vertex that's *actually* deletable — drawing
                // turfs always are; closed turfs only above the 3-vertex
                // floor. Below that the click no-ops, and the regular
                // cursor stays so the user isn't promised an action that
                // won't happen.
                const wouldDelete =
                  altDown && (turf.mode === "drawing" || turf.vertices.length > 3);
                const cursor = wouldDelete
                  ? DELETE_CURSOR
                  : isFresh
                    ? "crosshair"
                    : canClose && j === 0
                      ? "pointer"
                      : "grab";
                return (
                  <circle
                    key={j}
                    fill="white"
                    stroke={color}
                    strokeWidth={3}
                    // Override the SVG's pointer-events: none so the
                    // circle can receive pointerdown for drag-to-edit.
                    // Map clicks (from MapLibre, on the canvas
                    // underneath) still fall through anywhere except
                    // a circle's hit area.
                    pointerEvents="all"
                    style={{ cursor }}
                    onPointerLeave={() => {
                      if (isFresh) setFreshVertex(null);
                    }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      // Alt-click deletes the vertex. Drawing turfs
                      // can shrink to empty — we drop the turf
                      // entirely and clear the selection. Editing
                      // turfs need ≥3 vertices to stay valid; below
                      // that we just no-op rather than convert back
                      // to drawing mode (the user can hit Escape and
                      // restart if they really want to redo it).
                      if (e.altKey) {
                        if (turf.mode === "editing" && turf.vertices.length <= 3) return;
                        const wasEditing = turf.mode === "editing";
                        setTurfs((ts) => {
                          const next = ts.flatMap((t) => {
                            if (t.id !== turf.id) return [t];
                            const v = t.vertices.filter((_, vi) => vi !== j);
                            if (v.length === 0) return [];
                            return [{ ...t, vertices: v }];
                          });
                          if (wasEditing) onCommit?.(next);
                          return next;
                        });
                        // If we just removed the last vertex of a
                        // drawing turf the turf itself is gone; drop
                        // the selection so the sidebar/map don't
                        // hold a dangling id.
                        if (turf.mode === "drawing" && turf.vertices.length === 1) {
                          setSelectedTurfId((s) => (s === turf.id ? null : s));
                        }
                        setFreshVertex(null);
                        return;
                      }
                      e.currentTarget.setPointerCapture(e.pointerId);
                      pointerStartRef.current = {
                        turfId: turf.id,
                        vertexIdx: j,
                        x: e.clientX,
                        y: e.clientY,
                      };
                      // Don't disable dragPan or set dragRef yet —
                      // wait for movement past the threshold.
                    }}
                    onPointerMove={(e) => {
                      // Already dragging → update vertex position.
                      if (dragRef.current) {
                        const rect = map.getCanvas().getBoundingClientRect();
                        const x = e.clientX - rect.left;
                        const y = e.clientY - rect.top;
                        const { lng, lat } = map.unproject([x, y]);
                        const drag = dragRef.current;
                        setTurfs((ts) =>
                          ts.map((t) =>
                            t.id === drag.turfId
                              ? {
                                  ...t,
                                  vertices: t.vertices.map((v, vi) =>
                                    vi === drag.vertexIdx ? [lng, lat] : v,
                                  ),
                                }
                              : t,
                          ),
                        );
                        return;
                      }
                      // Not yet dragging — promote to drag once the
                      // pointer has moved past the threshold.
                      const start = pointerStartRef.current;
                      if (!start) return;
                      const dx = e.clientX - start.x;
                      const dy = e.clientY - start.y;
                      if (Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
                        dragRef.current = { turfId: start.turfId, vertexIdx: start.vertexIdx };
                        map.dragPan.disable();
                      }
                    }}
                    onPointerUp={(e) => {
                      e.currentTarget.releasePointerCapture(e.pointerId);
                      if (dragRef.current) {
                        // Was a drag — clean up. Commit if the dragged
                        // vertex belonged to a closed turf.
                        const wasEditing = turf.mode === "editing";
                        dragRef.current = null;
                        map.dragPan.enable();
                        if (wasEditing) onCommit?.(turfsPropRef.current);
                      } else {
                        // Was a click on the vertex. The only click
                        // semantic so far: snap-close the polygon
                        // when the user clicks the first vertex of
                        // a drawing turf with ≥3 vertices.
                        const start = pointerStartRef.current;
                        if (
                          start &&
                          start.vertexIdx === 0 &&
                          turf.id === start.turfId &&
                          turf.mode === "drawing" &&
                          turf.vertices.length >= 3
                        ) {
                          setTurfs((ts) => {
                            const next = ts.map((t) =>
                              t.id === start.turfId ? { ...t, mode: "editing" as const } : t,
                            );
                            onCommit?.(next);
                            return next;
                          });
                          setFreshVertex(null);
                        }
                      }
                      pointerStartRef.current = null;
                    }}
                  />
                );
              })}
            </g>
            {/* Midpoint handles — small ghost circles centered on
                each edge of a closed, selected polygon. Pointerdown
                inserts a new vertex at the midpoint position and
                hands the drag off to document-level listeners
                (above) so the drag can continue past the moment
                this midpoint element gets unmounted by the
                insertion. Drawing-mode turfs don't get midpoints —
                the trailing edge is being actively laid down. */}
            {isClosed && turf.id === selectedTurfId ? (
              <g>
                {turf.vertices.map((_, j) => (
                  <circle
                    key={j}
                    r={4}
                    fill="white"
                    stroke={color}
                    strokeWidth={3}
                    pointerEvents="all"
                    style={{ cursor: "pointer" }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      // Prevents the implicit `selectstart` that
                      // would otherwise fire as the cursor moves
                      // over text during the drag — without this
                      // (plus the body-level `user-select: none`
                      // we set below), dragging across the "Show
                      // streets" label highlights its text.
                      e.preventDefault();
                      const v0 = turf.vertices[j]!;
                      const v1 = turf.vertices[(j + 1) % turf.vertices.length]!;
                      const midLng = (v0[0] + v1[0]) / 2;
                      const midLat = (v0[1] + v1[1]) / 2;
                      const insertAt = j + 1;
                      setTurfs((ts) =>
                        ts.map((t) =>
                          t.id === turf.id
                            ? {
                                ...t,
                                vertices: [
                                  ...t.vertices.slice(0, insertAt),
                                  [midLng, midLat],
                                  ...t.vertices.slice(insertAt),
                                ],
                              }
                            : t,
                        ),
                      );
                      midpointDragRef.current = { turfId: turf.id, vertexIdx: insertAt };
                      map.dragPan.disable();
                      // Suppress text selection across the page
                      // while dragging — restored on pointerup.
                      // The vertex drag avoids this by holding
                      // pointer capture on a stable element; the
                      // midpoint can't (its element disappears on
                      // insert), so we lean on user-select instead.
                      document.body.style.userSelect = "none";
                    }}
                  />
                ))}
              </g>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
