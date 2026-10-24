import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import { Alert } from "react-native";
import { activeTurfAtom } from "@/lib/atoms/active-turf";
import { canvasserAtom } from "@/lib/atoms/canvasser";
import { pendingResultCount } from "@/lib/canvass-events";
import { clearHost, client } from "@/rpc/client";

// Unbinds the device from its turf; resolves false (nothing changed) when
// results are still in the outbox, since unbinding would strand them —
// the outbox is already pushing whenever the phone is online, so the
// person only has to try again. Then a best-effort close of this
// device's walk, so the lead's board flips to available without waiting
// for the next open. Fire-and-forget (before clearHost so the request
// still knows the host): offline unbinds fall back to implicit close on
// next open, or lead clear. Navigation is the caller's.
export function useReleaseTurf() {
  const activeTurf = useAtomValue(activeTurfAtom);
  const canvasser = useAtomValue(canvasserAtom);
  const setActiveTurf = useSetAtom(activeTurfAtom);
  return useCallback(async () => {
    if (activeTurf) {
      const pending = await pendingResultCount(activeTurf.turfId);
      if (pending > 0) {
        Alert.alert(
          "Results still syncing",
          `${pending} ${pending === 1 ? "result hasn't" : "results haven't"} synced yet. Try again in a moment.`,
        );
        return false;
      }
    }
    if (activeTurf && canvasser?.phone) {
      try {
        void client.walks
          .close({ turfId: activeTurf.turfId, canvasserPhone: canvasser.phone })
          .catch(() => {});
      } catch {
        // Uninitialized client throws synchronously — nothing to close.
      }
    }
    setActiveTurf(null);
    clearHost();
    return true;
  }, [activeTurf, canvasser, setActiveTurf]);
}
