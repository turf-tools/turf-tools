// MapTiler URLs and key handling. The key lives in EXPO_PUBLIC_MAPTILER_KEY
// (gitignored .env), and is inlined into the JS bundle at build time. Sign up
// at maptiler.com and add your key to apps/native/.env.

const MAPTILER_KEY = process.env.EXPO_PUBLIC_MAPTILER_KEY ?? "";

// Custom grayscale style designed for canvassing — high contrast streets,
// muted everything else. Style ID provided by the project owner.
const STYLE_ID = "01968205-0dc7-71df-87a7-8b67f7828379";

export const MAPTILER_STYLE_URL = `https://api.maptiler.com/maps/${STYLE_ID}/style.json?key=${MAPTILER_KEY}`;

// OpenMapTiles vector tile source. Used for label layers (roads, places,
// house numbers) overlaid on top of the basemap.
export const MAPTILER_OPENMAPTILES_TILEJSON_URL = `https://api.maptiler.com/tiles/v3-openmaptiles/tiles.json?key=${MAPTILER_KEY}`;

export function isMaptilerKeyConfigured(): boolean {
  return MAPTILER_KEY.length > 0;
}
