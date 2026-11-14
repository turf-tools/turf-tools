// MapTiler URLs and key handling. The key lives in EXPO_PUBLIC_MAPTILER_KEY
// (gitignored .env), and is inlined into the JS bundle at build time. Sign up
// at maptiler.com and add your key to apps/native/.env.

const MAPTILER_KEY = process.env.EXPO_PUBLIC_MAPTILER_KEY ?? "";

// Style IDs are deployment configuration. "streets-v4" is MapTiler's
// public style and works with any key; set the env vars to use a custom
// style instead.
const STYLE_ID_LIGHT = process.env.EXPO_PUBLIC_MAPTILER_STYLE_ID_LIGHT || "streets-v4";
const STYLE_ID_DARK = process.env.EXPO_PUBLIC_MAPTILER_STYLE_ID_DARK || STYLE_ID_LIGHT;

export function getMaptilerStyleUrl(isDark: boolean): string {
  const styleId = isDark ? STYLE_ID_DARK : STYLE_ID_LIGHT;
  return `https://api.maptiler.com/maps/${styleId}/style.json?key=${MAPTILER_KEY}`;
}

// OpenMapTiles v3 source for the house-number overlay. The basemap already
// draws road names and building numbers; this only pulls house numbers in
// one zoom level earlier.
export const MAPTILER_OPENMAPTILES_TILEJSON_URL = `https://api.maptiler.com/tiles/v3-openmaptiles/tiles.json?key=${MAPTILER_KEY}`;

export function isMaptilerKeyConfigured(): boolean {
  return MAPTILER_KEY.length > 0;
}
