// MapTiler URLs and key handling. The key lives in VITE_MAPTILER_KEY
// (gitignored .env), and is inlined into the JS bundle at build time. Sign up
// at maptiler.com and add your key to apps/web/.env. Use the same key as
// EXPO_PUBLIC_MAPTILER_KEY in apps/native/.env so both apps share the styles.
// The style ids pick the basemap (custom styles from a MapTiler account, or
// any public style); MapTiler's public streets-v4 serves when none is set.
const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY ?? "";
const PUBLIC_STYLE_ID = "streets-v4";
const MAPTILER_STYLE_ID_LIGHT = import.meta.env.VITE_MAPTILER_STYLE_ID_LIGHT || PUBLIC_STYLE_ID;
const MAPTILER_STYLE_ID_DARK = import.meta.env.VITE_MAPTILER_STYLE_ID_DARK || PUBLIC_STYLE_ID;

export function getMaptilerStyleUrl(isDark: boolean): string {
  const styleId = isDark ? MAPTILER_STYLE_ID_DARK : MAPTILER_STYLE_ID_LIGHT;
  return `https://api.maptiler.com/maps/${styleId}/style.json?key=${MAPTILER_KEY}`;
}

// OpenMapTiles vector tile source. Used for label overlays (roads, places,
// house numbers) on top of the basemap.
export const MAPTILER_OPENMAPTILES_TILEJSON_URL = `https://api.maptiler.com/tiles/v3-openmaptiles/tiles.json?key=${MAPTILER_KEY}`;

export function isMaptilerKeyConfigured(): boolean {
  return MAPTILER_KEY.length > 0;
}
