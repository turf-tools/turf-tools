import { router } from "expo-router";
import { useAtom, useAtomValue } from "jotai";
import { Scan } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Alert, Keyboard, Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { activeTurfAtom } from "@/lib/atoms/active-turf";
import { scannedEntryAtom } from "@/lib/atoms/scan";
import { themeAtom } from "@/lib/atoms/theme";
import { openTurf } from "@/lib/canvass-events";
import { client, setHost } from "@/rpc/client";

export default function LandingScreen() {
  const [host, setHostInput] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);

  const codeRef = useRef<TextInput>(null);
  const insets = useSafeAreaInsets();
  const [activeTurf, setActiveTurf] = useAtom(activeTurfAtom);
  const isDark = useAtomValue(themeAtom) === "dark";

  // A successful scan fills the fields and stops — the user reviews the
  // server + code and hits Open themselves.
  const [scanned, setScanned] = useAtom(scannedEntryAtom);
  useEffect(() => {
    if (!scanned) return;
    setHostInput(scanned.host);
    setCode(scanned.code);
    setScanned(null);
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

  const goToTurf = (turfId: string) => {
    void openTurf(turfId).catch(() => {
      Alert.alert(
        "Couldn't refresh from server",
        "Showing the most recently synced version but data may be out of date, sync when you have a connection.",
      );
    });
    router.push(`/turfs/${turfId}`);
  };

  const handleSubmit = async () => {
    // Swallow taps while a previous submit is in flight. The button stays
    // visually active (no disabled dim) but extra presses are no-ops.
    if (loading) return;
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
    setLoading(true);
    try {
      setHost(trimmedHost);
      const turf = await client.turfs.getByCode({ code: trimmedCode });
      if (!turf) {
        Alert.alert("Not found", `No turf found for code "${trimmedCode}".`);
        setLoading(false);
        return;
      }
      setActiveTurf({ host: trimmedHost, turfId: turf.turfId });
      setLoading(false);
      goToTurf(turf.turfId);
    } catch (err) {
      // RN's fetch surfaces offline / unreachable-host failures as
      // `TypeError: Network request failed`. Translate to a human-readable
      // alert; pass other errors through as best-effort text.
      const message = String(err);
      if (message.includes("Network request failed")) {
        Alert.alert(
          "Connection error",
          "Could not reach the server to load the turf, try again when you have a network connection.",
        );
      } else {
        Alert.alert("Error", message);
      }
      setLoading(false);
    }
  };

  return (
    <Pressable className="flex-1 bg-background dark:bg-background-dark" onPress={Keyboard.dismiss}>
      <View className="flex-1 items-center p-6">
        <View style={{ flex: 1.4 }} />
        <Text
          className="mb-2 text-5xl transform -skew-x-12 text-foreground dark:text-foreground-dark"
          style={{ fontFamily: "Geist_700Bold" }}
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
          <TextInput
            value={host}
            onChangeText={setHostInput}
            placeholder="Server domain"
            placeholderTextColor="#999"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="next"
            onSubmitEditing={() => codeRef.current?.focus()}
            style={{ paddingTop: 11, paddingBottom: 13 }}
            className="font-sans text-xl text-foreground dark:text-foreground-dark bg-surface dark:bg-surface-dark border border-border dark:border-border-dark rounded-lg px-4 text-center h-14"
          />
          <TextInput
            ref={codeRef}
            value={code}
            onChangeText={setCode}
            placeholder="Turf code"
            placeholderTextColor="#999"
            keyboardType="number-pad"
            style={{ paddingTop: 11, paddingBottom: 13, fontVariant: ["tabular-nums"] }}
            className="font-sans text-xl text-foreground dark:text-foreground-dark bg-surface dark:bg-surface-dark border border-border dark:border-border-dark rounded-lg px-4 text-center h-14"
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
