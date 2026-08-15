import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { X } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { InteractionManager, Linking, Platform, Pressable, Text, View } from "react-native";
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { scannedEntryAtom } from "@/lib/atoms/scan";
import { themeAtom } from "@/lib/atoms/theme";
import { parseTurfQr } from "@/lib/turf-qr";

// Modal camera for scanning a turf QR (`https://<host>/t/<code>`). A valid
// scan writes the handoff atom and dismisses — the landing screen fills its
// fields and opens the turf; failures land there with the fields filled.
// Non-matching QR codes show a quiet warning pill over the camera while one
// is in frame (the camera just keeps looking).
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

  // Mask camera warmup: mount after the modal's slide-up (init would jank
  // the animation) and reveal a beat past onCameraReady — SDK 55's camera
  // starts the session before it's fully configured, so the preview
  // zooms/rotates into place with dark frames (fixed upstream in SDK 56).
  const REVEAL_DELAY_MS = 400;
  const [cameraMounted, setCameraMounted] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => setCameraMounted(true));
    return () => task.cancel();
  }, []);

  // The scanner fires repeatedly while a code is in frame — latch on the
  // first valid parse so we hand off exactly once. Non-turf codes show the
  // warning hint, kept alive while frames keep arriving and cleared 1.5s
  // after the last one.
  const handledRef = useRef(false);
  const [showInvalid, setShowInvalid] = useState(false);
  const invalidTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (invalidTimerRef.current) clearTimeout(invalidTimerRef.current);
    };
  }, []);
  // The pill stays mounted and fades via opacity. ReduceMotion.Never: with
  // system Reduce Motion on, Reanimated skips animations entirely — but a
  // pure crossfade is the reduced-motion-safe form, so keep it.
  const invalidOpacity = useSharedValue(0);
  useEffect(() => {
    invalidOpacity.value = withTiming(showInvalid ? 1 : 0, {
      duration: showInvalid ? 150 : 300,
      reduceMotion: ReduceMotion.Never,
    });
  }, [showInvalid, invalidOpacity]);
  const invalidStyle = useAnimatedStyle(() => ({ opacity: invalidOpacity.value }));
  const handleData = (data: string) => {
    if (handledRef.current) return;
    const entry = parseTurfQr(data);
    if (!entry) {
      setShowInvalid(true);
      if (invalidTimerRef.current) clearTimeout(invalidTimerRef.current);
      invalidTimerRef.current = setTimeout(() => setShowInvalid(false), 1250);
      return;
    }
    handledRef.current = true;
    setScanned(entry);
    router.back();
  };

  // The title row and the X share this offset so they stay vertically
  // aligned regardless of device inset. iOS's deep top inset lets the
  // control tuck up beside the notch; Android's slim status bar needs it
  // pushed below instead.
  const closeTop = Platform.OS === "android" ? insets.top + 12 : Math.max(insets.top - 41, 12);

  return (
    <View className="flex-1 bg-background dark:bg-background-dark">
      {/* X close button (matches Settings) */}
      <Pressable
        onPress={() => router.back()}
        hitSlop={4}
        className="absolute z-10 items-center justify-center w-12 h-12 rounded-full bg-surface dark:bg-surface-dark active:opacity-60"
        style={{
          top: closeTop,
          right: 22,
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.15,
          shadowRadius: 6,
          elevation: 4,
        }}
      >
        <X size={20} color={isDark ? "#ededed" : "#1b1b1b"} strokeWidth={2} />
      </Pressable>

      <View
        className="flex-1 px-4 pb-6"
        style={{ paddingTop: closeTop, paddingBottom: insets.bottom + 16 }}
      >
        {/* Same height as the X so the title centers on it. */}
        <View className="h-12 justify-center">
          <Text
            className="self-center text-3xl transform -skew-x-12 text-foreground dark:text-foreground-dark"
            style={{
              fontFamily: Platform.OS === "android" ? "Geist_700Bold_Italic" : "Geist_700Bold",
            }}
          >
            Scan a code
          </Text>
        </View>

        {permission?.granted ? (
          <>
            <View className="mt-6 flex-1 overflow-hidden rounded-2xl bg-black">
              {cameraMounted ? (
                <CameraView
                  style={{ flex: 1, opacity: cameraReady ? 1 : 0 }}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={({ data }) => handleData(data)}
                  onCameraReady={() => setTimeout(() => setCameraReady(true), REVEAL_DELAY_MS)}
                />
              ) : null}
              <Animated.View
                pointerEvents="none"
                style={[
                  { position: "absolute", left: 0, right: 0, bottom: 36, alignItems: "center" },
                  invalidStyle,
                ]}
              >
                <View className="rounded-2xl bg-black/60 px-5 py-2.5">
                  <Text className="text-xl text-white" style={{ fontFamily: "Geist_400Regular" }}>
                    That's not a turf code
                  </Text>
                </View>
              </Animated.View>
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
