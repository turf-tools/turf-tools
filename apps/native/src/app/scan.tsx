import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { X } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { scannedEntryAtom } from "@/lib/atoms/scan";
import { themeAtom } from "@/lib/atoms/theme";
import { parseTurfQr } from "@/lib/turf-qr";

// Modal camera for scanning a turf QR (`https://<host>/t/<code>`). A valid
// scan writes the handoff atom and dismisses — the landing screen fills its
// fields and the user reviews + hits Open; nothing opens automatically.
// Non-matching QR codes are ignored silently (the camera just keeps looking).
export default function ScanScreen() {
  const insets = useSafeAreaInsets();
  const isDark = useAtomValue(themeAtom) === "dark";
  const [permission, requestPermission] = useCameraPermissions();
  const setScanned = useSetAtom(scannedEntryAtom);

  // The whole screen is the camera — ask on arrival rather than behind an
  // extra tap. While the system alert is up we render bare background (no
  // explainer): stacking our denied-state UI under the alert mid-slide-up
  // reads as flicker. The explainer only appears after a real denial.
  const askedRef = useRef(false);
  const [askDone, setAskDone] = useState(false);
  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain && !askedRef.current) {
      askedRef.current = true;
      void requestPermission().finally(() => setAskDone(true));
    }
  }, [permission, requestPermission]);

  // The scanner fires repeatedly while a code is in frame — latch on the
  // first valid parse so we hand off exactly once.
  const handledRef = useRef(false);
  const handleData = (data: string) => {
    if (handledRef.current) return;
    const entry = parseTurfQr(data);
    if (!entry) return;
    handledRef.current = true;
    setScanned(entry);
    router.back();
  };

  return (
    <View className="flex-1 bg-background dark:bg-background-dark">
      {/* X close button (matches Settings) */}
      <Pressable
        onPress={() => router.back()}
        hitSlop={4}
        className="absolute z-10 items-center justify-center w-12 h-12 rounded-full bg-surface dark:bg-surface-dark active:opacity-60"
        style={{
          top: insets.top - 35,
          right: 20,
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.15,
          shadowRadius: 6,
          elevation: 4,
        }}
      >
        <X size={20} color={isDark ? "#ededed" : "#1b1b1b"} strokeWidth={2} />
      </Pressable>

      <View className="flex-1 px-4 pb-6" style={{ paddingBottom: insets.bottom + 16 }}>
        <Text
          className="mt-9 mb-9 self-center text-3xl transform -skew-x-12 text-foreground dark:text-foreground-dark"
          style={{ fontFamily: "Geist_700Bold" }}
        >
          Scan a code
        </Text>

        {permission?.granted ? (
          <>
            <View className="flex-1 overflow-hidden rounded-2xl">
              <CameraView
                style={{ flex: 1 }}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={({ data }) => handleData(data)}
              />
            </View>
            <Text
              className="mt-9 text-center text-xl text-muted-foreground dark:text-muted-foreground-dark"
              style={{ fontFamily: "Geist_400Regular" }}
            >
              Point at a turf QR code
            </Text>
          </>
        ) : permission && (askDone || !permission.canAskAgain) ? (
          <View className="flex-1 items-center justify-center gap-4 px-6">
            <Text
              className="text-center text-lg text-foreground dark:text-foreground-dark"
              style={{ fontFamily: "Geist_400Regular" }}
            >
              Camera access is needed to scan turf codes.
            </Text>
            <View className="w-full max-w-xs">
              <Button
                title="Allow camera access"
                onPress={() => {
                  if (permission.canAskAgain) void requestPermission();
                  else void Linking.openSettings();
                }}
              />
            </View>
          </View>
        ) : (
          <View className="flex-1" />
        )}
      </View>
    </View>
  );
}
