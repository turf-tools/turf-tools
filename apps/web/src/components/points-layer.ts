// Custom MapLibre layer that renders an array of geographic points as
// anti-aliased dots via WebGL. Conforms to MapLibre's CustomLayerInterface.
//
// Input: a flat Float32Array of `[lng, lat, lng, lat, ...]` in degrees.
// The vertex shader does the lng/lat → mercator projection on the GPU
// so the CPU never touches per-point coords beyond the one-time decode.
//
// Data flow:
//   setPoints(buf)     → one VBO upload per data refresh.
//   render(gl, args)   → one draw call (gl.POINTS) every frame; the
//                        shader subtracts a per-frame camera origin
//                        from each projected mercator coord and
//                        applies an origin-shifted matrix (see the
//                        "translation split" comment on `render`).
//
// The origin-split trick: at high zoom, MapLibre's `mainMatrix` has
// translation values in the millions, and `mat * vec(small_mercator)`
// in float32 is a difference-of-large-numbers that loses precision.
// We compute a "shifted" matrix on the CPU (camera mercator origin
// baked into the translation column at JS-double precision) and have
// the shader multiply it against `mercator - origin`. Algebra cancels
// the same way; the bytes flowing to the GPU are small numbers.

import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";

const VERTEX_SHADER = `#version 300 es
precision highp float;

// Per-vertex: lng, lat in degrees, straight from the server.
in vec2 a_lnglat;

// Origin-shifted projection matrix (see PointsLayer.render).
uniform mat4 u_matrix;
// Camera mercator origin for the current frame, split into hi/lo
// fp32 pair (effective ~48 bits of mantissa). The lo half absorbs
// the fp32 quantization of the hi half, so the perceived origin
// changes smoothly as the camera pans by sub-ULP amounts. Without
// this, every fp32 quantum the camera crosses snaps all points by
// 1 ULP at once — visible jitter during slow pan.
uniform vec2 u_originHi;
uniform vec2 u_originLo;
uniform float u_zoom;

const float PI = 3.14159265359;

// Zoom range and pixel-size endpoints for the dot. Each zoom level
// scales the dot by the same factor (geometric ramp), matching the
// way map scale doubles per zoom level.
const float Z_MIN = 9.0;
const float Z_MAX = 18.0;
const float PX_MIN = 2.0;
const float PX_MAX = 14.0;

void main() {
  // Web Mercator projection: lng/lat (degrees) → mercator (0..1).
  float x = (a_lnglat.x + 180.0) / 360.0;
  float lat_rad = a_lnglat.y * PI / 180.0;
  float y = 0.5 - log(tan(PI / 4.0 + lat_rad / 2.0)) / (2.0 * PI);

  // Two-step subtraction: subtract the hi part (close to vertex
  // mercator → fp32 has plenty of precision in the small result),
  // then the lo residual. Equivalent to merc - (hi + lo) but stays
  // smooth as the hi part ticks across fp32 boundaries during pan.
  vec2 deltaHi = vec2(x, y) - u_originHi;
  vec2 relative = deltaHi - u_originLo;
  gl_Position = u_matrix * vec4(relative, 0.0, 1.0);

  float t = clamp((u_zoom - Z_MIN) / (Z_MAX - Z_MIN), 0.0, 1.0);
  gl_PointSize = PX_MIN * pow(PX_MAX / PX_MIN, t);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;

uniform vec4 u_color;
out vec4 fragColor;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float alpha = smoothstep(0.25, 0.20, r2) * u_color.a;
  // MapLibre's blendFunc is (ONE, ONE_MINUS_SRC_ALPHA) — premultiplied
  // alpha output. Multiply rgb by alpha here.
  fragColor = vec4(u_color.rgb * alpha, alpha);
}
`;

export type PointsLayerStyle = {
  // CSS hex string ("#rrggbb"). Single solid color for every point in
  // v1; variation by attribute is a follow-up — wire as another VBO
  // and a varying.
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
  private buffer: WebGLBuffer | null = null;
  private pointCount = 0;

  // Cached attribute / uniform locations.
  private locA_lnglat = -1;
  private locU_matrix: WebGLUniformLocation | null = null;
  private locU_originHi: WebGLUniformLocation | null = null;
  private locU_originLo: WebGLUniformLocation | null = null;
  private locU_zoom: WebGLUniformLocation | null = null;
  private locU_color: WebGLUniformLocation | null = null;

  // Reusable scratch buffer for the shifted matrix; one allocation
  // amortized over every frame.
  private readonly shiftedMatrix = new Float32Array(16);

  // Pending state — applied during the next render once GL is up.
  private pendingPoints: Float32Array | null = null;
  private style: PointsLayerStyle = DEFAULT_STYLE;

  constructor(opts: { id?: string } = {}) {
    this.id = opts.id ?? "points-layer";
  }

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl as WebGL2RenderingContext;
    this.compileProgram();
    this.buffer = this.gl.createBuffer();
    if (this.pendingPoints) {
      this.uploadBuffer(this.pendingPoints);
      this.pendingPoints = null;
    }
  }

  onRemove(_map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (this.program) gl.deleteProgram(this.program);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    this.program = null;
    this.buffer = null;
    this.gl = null;
    this.map = null;
  }

  render(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    options: CustomRenderMethodInput,
  ): void {
    if (!this.program || !this.buffer || this.pointCount === 0 || !this.map) return;
    const gl2 = gl as WebGL2RenderingContext;

    gl2.useProgram(this.program);

    gl2.bindBuffer(gl2.ARRAY_BUFFER, this.buffer);
    gl2.enableVertexAttribArray(this.locA_lnglat);
    gl2.vertexAttribPointer(this.locA_lnglat, 2, gl2.FLOAT, false, 0, 0);

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

    // Split the fp64 origin into a hi/lo fp32 pair. `Math.fround`
    // gives the closest fp32; the residual fits in fp32 precision-wise
    // because we just subtracted two close values. The shader does a
    // two-step subtraction (see VERTEX_SHADER) so cross-quantum camera
    // shifts stay smooth.
    const oxHi = Math.fround(ox);
    const oxLo = ox - oxHi;
    const oyHi = Math.fround(oy);
    const oyLo = oy - oyHi;

    gl2.uniformMatrix4fv(this.locU_matrix, false, this.shiftedMatrix);
    gl2.uniform2f(this.locU_originHi, oxHi, oyHi);
    gl2.uniform2f(this.locU_originLo, oxLo, oyLo);
    gl2.uniform1f(this.locU_zoom, this.map.getZoom());

    const [r, g, b, a] = parseColor(this.style.color);
    gl2.uniform4f(this.locU_color, r, g, b, a);

    gl2.drawArrays(gl2.POINTS, 0, this.pointCount);
  }

  // Replace the entire point set. Cheap: one VBO upload. If the layer
  // hasn't been added to the map yet (onAdd hasn't run), we stash and
  // upload on add. `flat` is `[lng0, lat0, lng1, lat1, ...]`.
  setPoints(flat: Float32Array | null | undefined): void {
    const data = flat ?? new Float32Array(0);
    if (this.gl && this.buffer) {
      this.uploadBuffer(data);
    } else {
      this.pendingPoints = data;
      this.pointCount = data.length / 2;
    }
    this.map?.triggerRepaint();
  }

  setStyle(style: Partial<PointsLayerStyle>): void {
    this.style = { ...this.style, ...style };
    this.map?.triggerRepaint();
  }

  private uploadBuffer(flat: Float32Array): void {
    const gl = this.gl;
    if (!gl || !this.buffer) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, flat, gl.DYNAMIC_DRAW);
    this.pointCount = flat.length / 2;
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

    this.locA_lnglat = gl.getAttribLocation(program, "a_lnglat");
    this.locU_matrix = gl.getUniformLocation(program, "u_matrix");
    this.locU_originHi = gl.getUniformLocation(program, "u_originHi");
    this.locU_originLo = gl.getUniformLocation(program, "u_originLo");
    this.locU_zoom = gl.getUniformLocation(program, "u_zoom");
    this.locU_color = gl.getUniformLocation(program, "u_color");
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
