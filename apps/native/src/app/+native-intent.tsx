import { loadActiveTurf } from "@/lib/atoms/active-turf";
import { loadCanvasser } from "@/lib/atoms/canvasser";
import { REQUIRE_ATTRIBUTION } from "@/lib/canvasser";
import { parseTurfLink } from "@/lib/turf-link";

// Rewrites the URL the app was launched with before the router builds its
// first stack. A turf link opened while a turf is bound lands on that turf
// (the prompt to switch is pushed over it once the stack is up); every
// other URL passes through. Nothing here may throw.
export async function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  try {
    if (!initial || !parseTurfLink(path)) return path;
    const activeTurf = await loadActiveTurf();
    if (!activeTurf) return path;
    // Mirrors the boot gate: a binding without a canvasser is dropped there.
    if (REQUIRE_ATTRIBUTION && !(await loadCanvasser())) return path;
    return `/turfs/${activeTurf.turfId}`;
  } catch {
    return path;
  }
}
