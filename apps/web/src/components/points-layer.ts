// Custom MapLibre layer that renders an array of geographic points as
// anti-aliased dots via WebGL. Conforms to MapLibre's CustomLayerInterface.
//
// Input: a Float32Array of mercator deltas `[dx, dy, dx, dy, ...]` where
// each pair is the point's MapLibre [0,1] mercator coord minus a
// stable `origin` (passed alongside the buffer, fp64). Pre-projecting
// to mercator off the GPU is what ensures precision.
//
// Two optional per-point overlays:
//   - colors  (Uint8Array RGB triples, one per point)
//   - sizes   (Float32Array scaling factors, one per point)
// Both default to a uniform style — `style.color` for color, 1.0 for
// size — and resize automatically when `setPoints` runs.
//
// Data flow:
//   setPoints({deltas, origin})
//                   → one VBO upload per data refresh, plus reset of
//                     the color / size buffers to their defaults so a
//                     stale per-point overlay can't outlive its points.
//                     Stores `origin` for the per-frame shift math.
//   setColors(buf)  → one VBO upload; `null` reverts to style color.
//   setSizes(buf)   → one VBO upload; `null` reverts to scale 1.0.
//   render()        → one draw call (gl.POINTS) per frame; computes
//                     `shift = cameraMerc - storedOrigin` at fp64,
//                     splits into hi/lo fp32, and the shader does
//                     `a_merc_rel - shift` then multiplies by an
//                     origin-shifted projection matrix (see the
//                     "translation split" comment on `render`).
//
// The origin-split trick: at high zoom, MapLibre's `mainMatrix` has
// translation values in the millions, and `mat * vec(small_mercator)`
// in float32 is a difference-of-large-numbers that loses precision.
// We compute a "shifted" matrix on the CPU (camera mercator origin
// baked into the translation column at JS-double precision) and have
// the shader multiply it against `mercator - cameraMerc`. Algebra
// cancels the same way; the bytes flowing to the GPU are small numbers.

import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";

const VERTEX_SHADER = `#version 300 es
precision highp float;

// Per-vertex: mercator delta (point's [0,1] mercator coord minus the
// layer's stored origin), pre-projected by the producer. Pre-projection +
// origin subtract together keep fp32 spending its full mantissa on
// useful digits, yielding millimeter precision at z20.
in vec2 a_merc_rel;
// Per-vertex color (UNSIGNED_BYTE normalized to 0..1). Defaults to
// the style color when no per-point colors are provided.
in vec3 a_color;
// Per-vertex size scaling factor. 1.0 = the zoom-driven base size;
// >1 grows the dot, <1 shrinks it. Defaults to 1.0.
in float a_size;

// Origin-shifted projection matrix (see PointsLayer.render).
uniform mat4 u_matrix;
// cameraMerc minus storedOrigin for the current frame, split into
// hi/lo fp32 pair (effective ~48 bits of mantissa). Two-step subtract
// in the shader stays smooth as the hi part ticks across fp32
// boundaries during pan/zoom.
uniform vec2 u_shiftHi;
uniform vec2 u_shiftLo;
uniform float u_zoom;
// devicePixelRatio — gl_PointSize is in physical framebuffer pixels,
// so without this scale dots render visibly smaller on high-DPR
// phones than on desktop.
uniform float u_pixelRatio;

out vec3 v_color;

// Zoom range and CSS-pixel size endpoints for the dot. Each zoom level
// scales the dot by the same factor (geometric ramp), matching the
// way map scale doubles per zoom level.
const float Z_MIN = 9.0;
const float Z_MAX = 18.0;
const float PX_MIN = 1.0;
const float PX_MAX = 7.0;

void main() {
  // (merc - cameraMerc) = (merc - storedOrigin) - (cameraMerc - storedOrigin).
  // Two-step subtraction so cross-quantum camera shifts stay smooth.
  vec2 deltaHi = a_merc_rel - u_shiftHi;
  vec2 relative = deltaHi - u_shiftLo;
  gl_Position = u_matrix * vec4(relative, 0.0, 1.0);

  v_color = a_color;

  float t = clamp((u_zoom - Z_MIN) / (Z_MAX - Z_MIN), 0.0, 1.0);
  float baseSize = PX_MIN * pow(PX_MAX / PX_MIN, t);
  gl_PointSize = baseSize * a_size * u_pixelRatio;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;

in vec3 v_color;
out vec4 fragColor;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float alpha = smoothstep(0.25, 0.20, r2);
  // MapLibre's blendFunc is (ONE, ONE_MINUS_SRC_ALPHA) — premultiplied
  // alpha output. Multiply rgb by alpha here.
  fragColor = vec4(v_color * alpha, alpha);
}
`;

export type PointsLayerStyle = {
  // CSS hex string ("#rrggbb"). Used as the default per-point color
  // when no `setColors` array has been provided.
  color: string;
};

const DEFAULT_STYLE: PointsLayerStyle = {
  color: "#0a0a0a",
};

export class PointsLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;

  // Three parallel VBOs: positions, per-point colors, per-point
  // sizes. Kept separate (not interleaved) so each can be re-uploaded
  // independently — color refresh on turf-membership change is a hot
  // path and shouldn't drag positions/sizes along with it.
  private pointsBuffer: WebGLBuffer | null = null;
  private colorBuffer: WebGLBuffer | null = null;
  private sizeBuffer: WebGLBuffer | null = null;
  private pointCount = 0;

  // Cached attribute / uniform locations.
  private locA_mercRel = -1;
  private locA_color = -1;
  private locA_size = -1;
  private locU_matrix: WebGLUniformLocation | null = null;
  private locU_shiftHi: WebGLUniformLocation | null = null;
  private locU_shiftLo: WebGLUniformLocation | null = null;
  private locU_pixelRatio: WebGLUniformLocation | null = null;
  private locU_zoom: WebGLUniformLocation | null = null;

  // Reusable scratch buffer for the shifted matrix; one allocation
  // amortized over every frame.
  private readonly shiftedMatrix = new Float32Array(16);

  // Mercator origin the current `a_merc_rel` deltas were computed
  // against. Held at fp64, the per-frame `cameraMerc - storedOrigin`
  // subtract is the precision-critical step.
  private storedOrigin: [number, number] = [0, 0];

  // Pending point data — applied during the next `onAdd` once GL is up.
  private pendingPoints: { deltas: Float32Array; origin: [number, number] } | null = null;

  // Latest user-provided overlays. `null` means "no per-point data,
  // use the style/default." Held independent of GL state so we can
  // re-derive the actual buffer contents whenever pointCount changes
  // (setPoints) or the style does (setStyle).
  private userColors: Uint8Array | null = null;
  private userSizes: Float32Array | null = null;

  private style: PointsLayerStyle = DEFAULT_STYLE;

  // Layer ids allowed to sit above the dots (e.g. label badges); the
  // re-stacking keeps this layer immediately below them, topmost
  // otherwise.
  private readonly keepBelow: string[];

  constructor(opts: { id?: string; keepBelow?: string[] } = {}) {
    this.id = opts.id ?? "points-layer";
    this.keepBelow = opts.keepBelow ?? [];
  }

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl as WebGL2RenderingContext;
    this.compileProgram();
    this.pointsBuffer = this.gl.createBuffer();
    this.colorBuffer = this.gl.createBuffer();
    this.sizeBuffer = this.gl.createBuffer();
    if (this.pendingPoints) {
      this.storedOrigin = this.pendingPoints.origin;
      this.uploadPoints(this.pendingPoints.deltas);
      this.pendingPoints = null;
    }
    // Color/size buffers always need *some* contents — the shader
    // reads attributes from them every frame. uploadDerived* fills
    // them with either the user-provided overlay (if length matches)
    // or the default for the current pointCount.
    this.uploadDerivedColors();
    this.uploadDerivedSizes();
  }

  onRemove(_map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (this.program) gl.deleteProgram(this.program);
    if (this.pointsBuffer) gl.deleteBuffer(this.pointsBuffer);
    if (this.colorBuffer) gl.deleteBuffer(this.colorBuffer);
    if (this.sizeBuffer) gl.deleteBuffer(this.sizeBuffer);
    this.program = null;
    this.pointsBuffer = null;
    this.colorBuffer = null;
    this.sizeBuffer = null;
    this.gl = null;
    this.map = null;
  }

  render(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    options: CustomRenderMethodInput,
  ): void {
    if (!this.program || !this.pointsBuffer || this.pointCount === 0 || !this.map) return;
    const gl2 = gl as WebGL2RenderingContext;

    gl2.useProgram(this.program);

    gl2.bindBuffer(gl2.ARRAY_BUFFER, this.pointsBuffer);
    gl2.enableVertexAttribArray(this.locA_mercRel);
    gl2.vertexAttribPointer(this.locA_mercRel, 2, gl2.FLOAT, false, 0, 0);

    // Per-point color attribute when an overlay is active; otherwise
    // disable the array and feed the shader a constant style color via
    // vertexAttrib4f. Skips the per-point color buffer's allocation +
    // JS-side fill + GPU upload entirely when there's no overlay.
    if (this.userColors && this.userColors.length === this.pointCount * 3) {
      gl2.bindBuffer(gl2.ARRAY_BUFFER, this.colorBuffer);
      gl2.enableVertexAttribArray(this.locA_color);
      gl2.vertexAttribPointer(this.locA_color, 3, gl2.UNSIGNED_BYTE, true, 0, 0);
    } else {
      gl2.disableVertexAttribArray(this.locA_color);
      const [r, g, b] = parseColor(this.style.color);
      gl2.vertexAttrib4f(this.locA_color, r, g, b, 1.0);
    }

    // Same constant-vs-buffer split for the per-point size scale.
    if (this.userSizes && this.userSizes.length === this.pointCount) {
      gl2.bindBuffer(gl2.ARRAY_BUFFER, this.sizeBuffer);
      gl2.enableVertexAttribArray(this.locA_size);
      gl2.vertexAttribPointer(this.locA_size, 1, gl2.FLOAT, false, 0, 0);
    } else {
      gl2.disableVertexAttribArray(this.locA_size);
      gl2.vertexAttrib1f(this.locA_size, 1.0);
    }

    // Translation-split. `mainMatrix` projects mercator-[0,1] → clip,
    // and at high zoom its translation column is in the millions —
    // float32 mat * mercator becomes a near-exact-cancellation that
    // quantizes visibly as the camera shifts.
    //
    // We rewrite the multiplication as
    //   M * vec4(mercator, 0, 1)
    //     = M * vec4(mercator - origin + origin, 0, 1)
    //     = M' * vec4(mercator - origin, 0, 1)
    // where `M'` has the same first three columns as M but with the
    // translation column replaced by `M * vec4(origin.x, origin.y, 0, 1)`.
    // Computing that one column on the CPU at JS-double precision gives
    // us a translation that's small (camera origin projects to near 0
    // in clip space), so the GPU only multiplies small numbers and
    // precision is preserved.
    const center = this.map.getCenter();
    // Inline Web Mercator (lng/lat → [0,1]^2). We don't import
    // MercatorCoordinate from maplibre-gl because that named import
    // doesn't survive Vite's SSR transform (the package is CJS at
    // runtime). The math here matches MercatorCoordinate.fromLngLat.
    const ox = (center.lng + 180) / 360;
    const oy = 0.5 - Math.log(Math.tan(Math.PI / 4 + (center.lat * Math.PI) / 360)) / (2 * Math.PI);
    const M = options.defaultProjectionData.mainMatrix;
    // First three columns unchanged (small scale/rotation values).
    for (let i = 0; i < 12; i++) this.shiftedMatrix[i] = M[i];
    // Last column: M * vec4(origin.x, origin.y, 0, 1), computed in
    // float64 (JS Number arithmetic) before storing as float32.
    this.shiftedMatrix[12] = M[0] * ox + M[4] * oy + M[12];
    this.shiftedMatrix[13] = M[1] * ox + M[5] * oy + M[13];
    this.shiftedMatrix[14] = M[2] * ox + M[6] * oy + M[14];
    this.shiftedMatrix[15] = M[3] * ox + M[7] * oy + M[15];

    // Shift = cameraMerc - storedOrigin, computed at fp64 then split
    // into hi/lo fp32. The subtraction itself is the precision-critical
    // step — both operands are fp64 here. `Math.fround` quantizes to
    // fp32; the residual recovers the bits lost. Two-step subtract in
    // the shader keeps cross-quantum camera shifts smooth.
    const sx = ox - this.storedOrigin[0];
    const sy = oy - this.storedOrigin[1];
    const sxHi = Math.fround(sx);
    const sxLo = sx - sxHi;
    const syHi = Math.fround(sy);
    const syLo = sy - syHi;

    gl2.uniformMatrix4fv(this.locU_matrix, false, this.shiftedMatrix);
    gl2.uniform2f(this.locU_shiftHi, sxHi, syHi);
    gl2.uniform2f(this.locU_shiftLo, sxLo, syLo);
    gl2.uniform1f(this.locU_zoom, this.map.getZoom());
    // Per frame: DPR changes with browser zoom and cross-screen moves.
    gl2.uniform1f(this.locU_pixelRatio, window.devicePixelRatio || 1);

    gl2.drawArrays(gl2.POINTS, 0, this.pointCount);
  }

  // Replace the entire point set. One VBO upload for positions; the
  // color/size buffers only get touched when a per-point overlay is
  // active (otherwise render() supplies a constant attribute value).
  // `deltas` is `[dx0, dy0, dx1, dy1, ...]` in MapLibre [0,1] mercator,
  // each pair already offset by `origin`. If the layer hasn't been
  // added to the map yet (onAdd hasn't run), we stash and upload on add.
  setPoints(input: { deltas: Float32Array; origin: [number, number] } | null | undefined): void {
    const deltas = input?.deltas ?? new Float32Array(0);
    const origin: [number, number] = input?.origin ?? [0, 0];
    this.storedOrigin = origin;
    if (this.gl && this.pointsBuffer) {
      this.uploadPoints(deltas);
      if (this.userColors) this.uploadDerivedColors();
      if (this.userSizes) this.uploadDerivedSizes();
    } else {
      this.pendingPoints = { deltas, origin };
      this.pointCount = deltas.length / 2;
    }
    this.nudgeOnTop();
    this.map?.triggerRepaint();
  }

  // Per-point RGB overlay. `null` reverts to the uniform style color.
  // Length must be `pointCount * 3`; mismatched arrays are ignored
  // and the buffer falls back to the default — that way a caller
  // who's about to follow up with a fresh `setPoints` doesn't crash
  // mid-flight.
  setColors(colors: Uint8Array | null | undefined): void {
    this.userColors = colors ?? null;
    this.uploadDerivedColors();
    this.nudgeOnTop();
    this.map?.triggerRepaint();
  }

  // Per-point size scaling. `null` reverts every dot to scale 1.0
  // (the zoom-driven base size).
  setSizes(sizes: Float32Array | null | undefined): void {
    this.userSizes = sizes ?? null;
    this.uploadDerivedSizes();
    this.nudgeOnTop();
    this.map?.triggerRepaint();
  }

  setStyle(style: Partial<PointsLayerStyle>): void {
    this.style = { ...this.style, ...style };
    // The style color is sampled in render() via vertexAttrib4f when
    // no per-point overlay is active, so a repaint is enough.
    this.map?.triggerRepaint();
  }

  private uploadPoints(flat: Float32Array): void {
    const gl = this.gl;
    if (!gl || !this.pointsBuffer) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointsBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, flat, gl.DYNAMIC_DRAW);
    this.pointCount = flat.length / 2;
  }

  // Upload the user-provided color overlay to the color VBO. No-op
  // when `userColors` is null — render() feeds the shader a constant
  // color via vertexAttrib4f instead. Mismatched lengths are skipped
  // so a caller about to follow up with a fresh `setPoints` doesn't
  // crash mid-flight.
  private uploadDerivedColors(): void {
    const gl = this.gl;
    if (!gl || !this.colorBuffer || !this.userColors) return;
    if (this.userColors.length !== this.pointCount * 3) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.userColors, gl.DYNAMIC_DRAW);
  }

  // Mirror for the size VBO. No-op when `userSizes` is null — render()
  // uses vertexAttrib1f(1.0) directly.
  private uploadDerivedSizes(): void {
    const gl = this.gl;
    if (!gl || !this.sizeBuffer || !this.userSizes) return;
    if (this.userSizes.length !== this.pointCount) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sizeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.userSizes, gl.DYNAMIC_DRAW);
  }

  // Re-stack the layer to its position (top, except `keepBelow`
  // layers) if it isn't there already. The Map component has its own
  // listener that does this on `styledata` / `idle`, but those events
  // don't fire reliably for every reorder trigger — calling here on
  // every data upload is a cheap belt-and-suspenders so a buried-
  // points race never outlives the next prop change. MUST match the
  // Map component's ensure() logic exactly — two re-stackers with
  // different targets would fight on every styledata (repaint loop).
  private nudgeOnTop(): void {
    if (!this.map) return;
    if (!this.map.getLayer(this.id)) return;
    // `getLayersOrder()`, never `getStyle().layers` — the serialized
    // list omits custom layers, so this layer would never test as
    // topmost and every call would moveLayer (see the repaint-loop
    // note in map.tsx).
    const order = this.map.getLayersOrder();
    const idx = order.indexOf(this.id);
    if (idx < 0) return;
    const above = order.slice(idx + 1);
    const keepBelowPresent = order.filter((id) => this.keepBelow.includes(id));
    if (
      above.length === keepBelowPresent.length &&
      above.every((id) => this.keepBelow.includes(id))
    ) {
      return;
    }
    this.map.moveLayer(
      this.id,
      order.find((id) => this.keepBelow.includes(id)),
    );
  }

  private compileProgram(): void {
    const gl = this.gl;
    if (!gl) return;
    const vert = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const frag = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (!program) throw new Error("PointsLayer: gl.createProgram returned null");
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`PointsLayer: program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;

    this.locA_mercRel = gl.getAttribLocation(program, "a_merc_rel");
    this.locA_color = gl.getAttribLocation(program, "a_color");
    this.locA_size = gl.getAttribLocation(program, "a_size");
    this.locU_matrix = gl.getUniformLocation(program, "u_matrix");
    this.locU_shiftHi = gl.getUniformLocation(program, "u_shiftHi");
    this.locU_shiftLo = gl.getUniformLocation(program, "u_shiftLo");
    this.locU_zoom = gl.getUniformLocation(program, "u_zoom");
    this.locU_pixelRatio = gl.getUniformLocation(program, "u_pixelRatio");
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("PointsLayer: gl.createShader returned null");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`PointsLayer: shader compile failed: ${log}\nsource:\n${source}`);
  }
  return shader;
}

// "#rrggbb" or "#rgb" → [r, g, b, 1] in [0,1]. Anything else falls back
// to opaque black; we don't accept rgba strings yet but adding the parse
// is trivial when needed.
function parseColor(css: string): [number, number, number, number] {
  let hex = css.replace(/^#/, "");
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (hex.length !== 6) return [0, 0, 0, 1];
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  return [r, g, b, 1];
}
