// MapTiler URLs and key handling. The key lives in VITE_MAPTILER_KEY
// (gitignored .env), and is inlined into the JS bundle at build time. Sign up
// at maptiler.com and add your key to apps/web/.env. Use the same key as
// EXPO_PUBLIC_MAPTILER_KEY in apps/native/.env so both apps share the styles.

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY ?? "";

// Custom styles designed for canvassing — high contrast streets, muted
// everything else. Style IDs match apps/native/src/lib/maptiler.ts.
const STYLE_ID_LIGHT = "01961350-1791-703e-8753-2c795c604620";
const STYLE_ID_DARK = "019dc276-9981-7168-a043-8a1ae4051996";

export function getMaptilerStyleUrl(isDark: boolean): string {
  const styleId = isDark ? STYLE_ID_DARK : STYLE_ID_LIGHT;
  return `https://api.maptiler.com/maps/${styleId}/style.json?key=${MAPTILER_KEY}`;
}

// OpenMapTiles vector tile source. Used for label overlays (roads, places,
// house numbers) on top of the basemap.
export const MAPTILER_OPENMAPTILES_TILEJSON_URL = `https://api.maptiler.com/tiles/v3-openmaptiles/tiles.json?key=${MAPTILER_KEY}`;

export function isMaptilerKeyConfigured(): boolean {
  return MAPTILER_KEY.length > 0;
}
