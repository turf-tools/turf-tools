import { router, useFocusEffect } from "expo-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Scan } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Keyboard, Platform, Pressable, Text, type TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { Input } from "@/components/input";
import { activeTurfAtom } from "@/lib/atoms/active-turf";
import { canvasserAtom } from "@/lib/atoms/canvasser";
import { pendingOpenAtom, scannedEntryAtom } from "@/lib/atoms/scan";
import { themeAtom } from "@/lib/atoms/theme";
import { showBindError } from "@/lib/bind-error";
import { openTurf } from "@/lib/canvass-events";
import { REQUIRE_ATTRIBUTION } from "@/lib/canvasser";
import { client, setHost } from "@/rpc/client";

export default function LandingScreen() {
  const [host, setHostInput] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  // True only while a submit is awaiting the network — the re-entry guard,
  // and the focus reset's signal to leave an in-flight open alone.
  const inFlightRef = useRef(false);

  const codeRef = useRef<TextInput>(null);
  const insets = useSafeAreaInsets();
  const [activeTurf, setActiveTurf] = useAtom(activeTurfAtom);
  const isDark = useAtomValue(themeAtom) === "dark";

  // A successful scan opens the turf directly. The fields fill first so a
  // failed open lands back here ready to retry or edit by hand.
  const [scanned, setScanned] = useAtom(scannedEntryAtom);
  useEffect(() => {
    if (!scanned) return;
    setHostInput(scanned.host);
    setCode(scanned.code);
    setScanned(null);
    void submitRef.current(scanned.host, scanned.code);
  }, [scanned, setScanned]);

  // Clear inputs only when the binding transitions from bound → null (i.e.
  // user hit "Download new turf"). Settings round-trips don't change
  // activeTurf so partial input survives.
  const prevActiveTurf = useRef(activeTurf);
  useEffect(() => {
    if (prevActiveTurf.current !== null && activeTurf === null) {
      setHostInput("");
      setCode("");
    }
    prevActiveTurf.current = activeTurf;
  }, [activeTurf]);

  const canvasser = useAtomValue(canvasserAtom);

  // Recording the walk (the lead's sign-out signal) is a hard precondition
  // of binding: an unrecorded sign-out still looks available to the lead,
  // who may hand the same turf to someone else. Throws on failure so
  // callers refuse the bind.
  const openWalk = async (turfId: string) => {
    if (!canvasser) return undefined;
    const { walkId } = await client.walks.open({
      turfId,
      canvasserName: canvasser.name,
      canvasserPhone: canvasser.phone ?? undefined,
    });
    return walkId;
  };

  const goToTurf = (turfId: string) => {
    void openTurf(turfId).catch(() => {
      Alert.alert(
        "Couldn't refresh from server",
        "Showing the most recently synced version but data may be out of date, sync when you have a connection.",
      );
    });
    router.push(`/turfs/${turfId}`);
  };

  // Attribution is a precondition of binding: with no canvasser on the
  // device, Open parks the resolved turf in `pendingOpenAtom` and raises
  // the identity sheet instead of binding. The sheet's Save completes the
  // bind and navigates straight to the turf — the landing never flashes
  // back into view mid-flow.
  const setPendingOpen = useSetAtom(pendingOpenAtom);
  useFocusEffect(
    useCallback(() => {
      // Regaining focus normally means no bind is in flight (a successful
      // save lands on the turf screen, not here): drop any declined parked
      // open so a later Open starts clean, and reset the button label —
      // success paths keep `loading` true through their transition so
      // "Loading..." never flashes back to "Open". The exception is a
      // scan-initiated open, which starts before the camera modal finishes
      // dismissing — skip the reset so it keeps its label and guard.
      if (inFlightRef.current) return;
      setPendingOpen(null);
      setLoading(false);
    }, [setPendingOpen]),
  );

  // Takes explicit values rather than reading input state — the QR path
  // submits in the same tick it fills the fields.
  const submit = async (hostValue: string, codeValue: string) => {
    // Swallow taps while a previous submit is in flight. The button stays
    // visually active (no disabled dim) but extra presses are no-ops.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    try {
      setHost(hostValue);
      // `attributed` tells the server whether this bind will complete
      // immediately (walk follows in ~a second) or park behind the
      // identity sheet — only the latter records the board's "signing
      // out…" pending signal.
      const turf = await client.turfs.getByCode({
        code: codeValue,
        attributed: canvasser != null || !REQUIRE_ATTRIBUTION,
      });
      if (!turf) {
        Alert.alert("Not found", `No turf found for code "${codeValue}".`);
        inFlightRef.current = false;
        setLoading(false);
        return;
      }
      if (REQUIRE_ATTRIBUTION && !canvasser) {
        setPendingOpen({ host: hostValue, turfId: turf.turfId });
        // Parked — the identity sheet owns the flow now, and its decline
        // path needs the focus reset to run.
        inFlightRef.current = false;
        router.push("/canvasser");
        return;
      }
      const walkId = await openWalk(turf.turfId);
      setActiveTurf({ host: hostValue, turfId: turf.turfId, walkId });
      goToTurf(turf.turfId);
      // Navigated away — the label resets via the focus effect on return.
      inFlightRef.current = false;
    } catch (err) {
      showBindError(err);
      inFlightRef.current = false;
      setLoading(false);
    }
  };
  const submitRef = useRef(submit);
  submitRef.current = submit;

  const handleSubmit = async () => {
    const trimmedHost = host.trim();
    const trimmedCode = code.trim();
    if (!trimmedHost) {
      Alert.alert("Enter a server", "Please enter the server.");
      return;
    }
    if (!trimmedCode) {
      Alert.alert("Enter a code", "Please enter a turf code.");
      return;
    }
    await submit(trimmedHost, trimmedCode);
  };

  return (
    <Pressable className="flex-1 bg-background dark:bg-background-dark" onPress={Keyboard.dismiss}>
      <View className="flex-1 items-center p-6">
        <View style={{ flex: 1.4 }} />
        <Text
          className="mb-2 text-5xl transform -skew-x-12 text-foreground dark:text-foreground-dark"
          style={{
            fontFamily: Platform.OS === "android" ? "Geist_700Bold_Italic" : "Geist_700Bold",
          }}
        >
          Turf Tools
        </Text>
        <Text
          className="mt-2 mb-4 text-center text-xl text-muted-foreground dark:text-muted-foreground-dark"
          style={{ fontFamily: "Geist_400Regular" }}
        >
          Enter a server and code to start
        </Text>

        <View className="gap-3 w-full max-w-xs">
          <Input
            value={host}
            onChangeText={setHostInput}
            placeholder="Server domain"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="next"
            onSubmitEditing={() => codeRef.current?.focus()}
          />
          <Input
            ref={codeRef}
            value={code}
            onChangeText={setCode}
            placeholder="Turf code"
            keyboardType="number-pad"
            style={{ fontVariant: ["tabular-nums"] }}
          />
          <Button title={loading ? "Loading..." : "Open"} onPress={handleSubmit} />
        </View>
        <View style={{ flex: 2 }} />
      </View>
      {/* Bottom-anchored and out of the flex flow: `bottom` moves only the
          button, never the layout above. Thumb-reachable; the keypad fully
          covers it while typing a code. */}
      <View className="absolute inset-x-6 items-center" style={{ bottom: insets.bottom + 128 }}>
        <View className="w-full max-w-xs">
          <Button
            title="Scan a QR code"
            variant="outline"
            icon={<Scan size={20} color={isDark ? "#ededed" : "#1b1b1b"} />}
            onPress={() => router.push("/scan")}
          />
        </View>
      </View>
    </Pressable>
  );
}
