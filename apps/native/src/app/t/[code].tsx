import { router, useLocalSearchParams } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";
import { Alert } from "react-native";
import { activeTurfAtom } from "@/lib/atoms/active-turf";
import { scannedEntryAtom } from "@/lib/atoms/scan";
import { useReleaseTurf } from "@/lib/release-turf";
import { normalizeHost } from "@/lib/turf-link";

// Target of a tapped turf link (`/t/<code>?host=<host>`, by universal link
// or the custom scheme). A transparent overlay that renders nothing: it
// hands the parsed entry to the landing screen, which opens it exactly as
// a scan would — or, for a link missing its host, fills in the code and
// waits. With a turf already open it only asks; the release is the same
// one as "Download new turf", pending results and all.
export default function TurfLinkScreen() {
  const { code, host: hostParam } = useLocalSearchParams<{ code: string; host?: string }>();
  const activeTurf = useAtomValue(activeTurfAtom);
  const setScanned = useSetAtom(scannedEntryAtom);
  const releaseTurf = useReleaseTurf();

  useEffect(() => {
    const host = normalizeHost(hostParam ?? "");
    const open = () => {
      setScanned({ host, code });
      router.dismissAll();
      router.replace("/");
    };
    const stay = () => {
      if (router.canGoBack()) router.back();
      else router.replace(activeTurf ? `/turfs/${activeTurf.turfId}` : "/");
    };
    if (!code) {
      stay();
      return;
    }
    if (!activeTurf) {
      open();
      return;
    }
    Alert.alert(
      "Open a new turf?",
      "You'll exit your current turf and start a new one (progress will be saved).",
      [
        { text: "Cancel", style: "cancel", onPress: stay },
        {
          text: "Open",
          style: "destructive",
          onPress: () => {
            void releaseTurf().then((released) => (released ? open() : stay()));
          },
        },
      ],
    );
    // One run per link arrival; the params are its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, hostParam]);

  return null;
}
