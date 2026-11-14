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

// Keep the default export for backwards compat until all callers switch.
export const MAPTILER_STYLE_URL = getMaptilerStyleUrl(false);

// OpenMapTiles vector tile source. Used for label layers (roads, places,
// house numbers) overlaid on top of the basemap.
export const MAPTILER_OPENMAPTILES_TILEJSON_URL = `https://api.maptiler.com/tiles/v3-openmaptiles/tiles.json?key=${MAPTILER_KEY}`;

export function isMaptilerKeyConfigured(): boolean {
  return MAPTILER_KEY.length > 0;
}
