import "react-native-random-uuid";
import "@/global.css";

import { Geist_400Regular, Geist_700Bold } from "@expo-google-fonts/geist";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { useFonts } from "expo-font";
import { router, SplashScreen, Stack, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useAtomValue, useSetAtom } from "jotai";
import { Menu } from "lucide-react-native";
import { useColorScheme } from "nativewind";
import { useEffect, useState } from "react";
import { AppState, Linking, LogBox, Platform, Pressable } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { activeTurfAtom, loadActiveTurf } from "@/lib/atoms/active-turf";
import { canvasserAtom, loadCanvasser } from "@/lib/atoms/canvasser";
import { themeAtom } from "@/lib/atoms/theme";
import { REQUIRE_ATTRIBUTION } from "@/lib/canvasser";
import { pullCanvassEvents } from "@/lib/canvass-events";
import { persister, queryClient } from "@/lib/query-client";
import { parseTurfLink, type TurfLink } from "@/lib/turf-link";
import { setHost } from "@/rpc/client";

// Harmless noise silenced to avoid warning popups.
LogBox.ignoreLogs([
  "Sending `onAnimatedValueUpdate` with no listeners registered",
  "MapLibre warning",
]);

void SplashScreen.preventAutoHideAsync();

// The landing is the screen under any deep-linked route. With it declared,
// a link that arrives while the app is open is pushed onto the existing
// stack; without it the router rebuilds the stack from the link and
// remounts everything. Only consulted for deep links.
export const unstable_settings = { anchor: "index" };

const MENU_SHADOW = {
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.15,
  shadowRadius: 6,
  elevation: 4,
};

function GlobalMenuButton() {
  const insets = useSafeAreaInsets();
  const theme = useAtomValue(themeAtom);
  const iconColor = theme === "dark" ? "#ededed" : "#1b1b1b";
  const pathname = usePathname();
  // On Android the modal presentation doesn't cover root chrome the way
  // iOS's does, so this button would sit on top of those screens' own
  // close controls (same spot) — yield to them there.
  if (
    Platform.OS === "android" &&
    ["/settings", "/canvasser", "/scan", "/share", "/progress"].includes(pathname)
  ) {
    return null;
  }
  return (
    <Pressable
      onPress={() => router.push("/settings")}
      hitSlop={4}
      className="absolute z-50 items-center justify-center w-12 h-12 rounded-full bg-white dark:bg-surface-dark active:opacity-60"
      style={[
        MENU_SHADOW,
        { top: Platform.OS === "android" ? insets.top + 12 : insets.top + 6, right: 22 },
      ]}
    >
      <Menu size={20} color={iconColor} />
    </Pressable>
  );
}

function useForegroundSync() {
  const activeTurf = useAtomValue(activeTurfAtom);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && activeTurf) {
        pullCanvassEvents(activeTurf.turfId).catch(() => {});
      }
    });
    return () => sub.remove();
  }, [activeTurf]);
}

function ThemedStack() {
  const theme = useAtomValue(themeAtom);
  const colorSchemeUtils = useColorScheme();
  const isDark = theme === "dark";

  useForegroundSync();

  useEffect(() => {
    colorSchemeUtils.setColorScheme(theme);
  }, [theme, colorSchemeUtils]);

  return (
    <>
      <StatusBar style={isDark ? "light" : "dark"} />
      <GlobalMenuButton />
      <Stack
        screenOptions={{
          headerShown: true,
          headerStyle: {
            backgroundColor: isDark ? "#0a0a0a" : "#fcfcfc",
          },
          headerTintColor: isDark ? "#ededed" : "#1b1b1b",
          headerTitleStyle: { fontFamily: "Geist_700Bold", fontSize: 18 },
          headerBackButtonDisplayMode: "minimal",
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen
          name="settings"
          options={{
            headerShown: false,
            presentation: "modal",
            contentStyle: { backgroundColor: isDark ? "#0a0a0a" : "#fcfcfc" },
          }}
        />
        <Stack.Screen
          name="scan"
          options={{
            headerShown: false,
            presentation: "modal",
            contentStyle: { backgroundColor: isDark ? "#0a0a0a" : "#fcfcfc" },
          }}
        />
        <Stack.Screen
          name="canvasser"
          options={{
            headerShown: false,
            presentation: "modal",
            contentStyle: { backgroundColor: isDark ? "#0a0a0a" : "#fcfcfc" },
          }}
        />
        <Stack.Screen
          name="share"
          options={{
            headerShown: false,
            presentation: "modal",
            contentStyle: { backgroundColor: isDark ? "#0a0a0a" : "#fcfcfc" },
          }}
        />
        <Stack.Screen
          name="progress"
          options={{
            headerShown: false,
            presentation: "modal",
            contentStyle: { backgroundColor: isDark ? "#0a0a0a" : "#fcfcfc" },
          }}
        />
        <Stack.Screen
          name="turfs/[turfId]"
          options={{ headerShown: false, gestureEnabled: false }}
        />
        {/* Transparent: the link's prompt sits over whatever is on screen. */}
        <Stack.Screen
          name="t/[code]"
          options={{ headerShown: false, presentation: "transparentModal", animation: "none" }}
        />
      </Stack>
    </>
  );
}

function BootGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const setActiveTurf = useSetAtom(activeTurfAtom);
  const setCanvasser = useSetAtom(canvasserAtom);
  // A turf link that launched the app while a turf was bound. The launch
  // URL was rewritten to the turf (see +native-intent), so the router's
  // first stack already shows it; the link's prompt is pushed over it once
  // the stack exists.
  const [pendingLink, setPendingLink] = useState<TurfLink | null>(null);
  useEffect(() => {
    if (!ready || !pendingLink) return;
    router.push({
      pathname: "/t/[code]",
      params: { code: pendingLink.code, host: pendingLink.host },
    });
    setPendingLink(null);
  }, [ready, pendingLink]);

  useEffect(() => {
    void (async () => {
      const canvasser = await loadCanvasser();
      if (canvasser) setCanvasser(canvasser);
      const activeTurf = await loadActiveTurf();
      const launchUrl = await Linking.getInitialURL();
      const launchLink = launchUrl ? parseTurfLink(launchUrl) : null;
      if (activeTurf) {
        // Bound ⇒ attributed is an invariant of the open flow (the landing
        // gates binding on the canvasser sheet). A stored binding without a
        // canvasser is stale state from before that gate existed — drop it
        // instead of auto-opening into a turf the gate would bounce.
        if (REQUIRE_ATTRIBUTION && !canvasser) {
          setActiveTurf(null);
        } else {
          setHost(activeTurf.host);
          setActiveTurf(activeTurf);
          if (launchLink) setPendingLink(launchLink);
          else router.replace(`/turfs/${activeTurf.turfId}`);
        }
      }
      setReady(true);
    })();
  }, [setActiveTurf, setCanvasser]);

  if (!ready) return null;
  return <>{children}</>;
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Geist_400Regular,
    Geist_700Bold,
    // Real italics, vendored from vercel/geist-font (OFL, see assets/fonts):
    // Android's renderer drops skew transforms, so the slanted wordmark uses
    // these there; iOS keeps its skew styling.
    Geist_400Regular_Italic: require("../../assets/fonts/Geist-Italic.ttf"),
    Geist_700Bold_Italic: require("../../assets/fonts/Geist-BoldItalic.ttf"),
  });

  useEffect(() => {
    if (fontsLoaded) void SplashScreen.hideAsync();
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <PersistQueryClientProvider
          client={queryClient}
          persistOptions={{
            persister,
            maxAge: 1000 * 60 * 60 * 24 * 7,
            dehydrateOptions: {
              shouldDehydrateQuery: (query) => {
                if (query.queryKey[0] === "canvass-events") return false;
                return query.state.status === "success";
              },
            },
          }}
        >
          <BootGate>
            <ThemedStack />
          </BootGate>
        </PersistQueryClientProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
