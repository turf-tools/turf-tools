import { atom } from "jotai";

// Count of mounted maps whose loading curtain is up. The map's own
// network work (MapTiler style/glyphs/tiles) is invisible to React
// Query and the router, so without this the global indicator drops
// while a map is still visibly blank. Maps increment/decrement in an
// effect; the indicator treats a nonzero count as in-flight work.
export const mapLoadingCountAtom = atom(0);
