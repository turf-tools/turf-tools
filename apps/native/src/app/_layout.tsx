import "react-native-random-uuid";
import "@/global.css";

import { Geist_400Regular, Geist_700Bold } from "@expo-google-fonts/geist";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { useFonts } from "expo-font";
import { router, SplashScreen, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Provider as JotaiProvider, useAtomValue } from "jotai";
import { Menu } from "lucide-react-native";
import { useColorScheme } from "nativewind";
import { useEffect } from "react";
import { LogBox, Pressable } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { themeAtom } from "@/lib/atoms/theme";
import { persister, queryClient } from "@/lib/query-client";

// Harmless noise silenced to avoid warning popups.
LogBox.ignoreLogs([
  "Sending `onAnimatedValueUpdate` with no listeners registered",
  "MapLibre warning",
]);

void SplashScreen.preventAutoHideAsync();

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
  return (
    <Pressable
      onPress={() => router.push("/settings")}
      hitSlop={4}
      className="absolute z-50 items-center justify-center w-12 h-12 rounded-full bg-white dark:bg-surface-dark active:opacity-60"
      style={[MENU_SHADOW, { top: insets.top + 12, right: 20 }]}
    >
      <Menu size={20} color={iconColor} />
    </Pressable>
  );
}

function ThemedStack() {
  const theme = useAtomValue(themeAtom);
  const colorSchemeUtils = useColorScheme();
  const isDark = theme === "dark";

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
        <Stack.Screen name="settings" options={{ headerShown: false, presentation: "modal" }} />
        <Stack.Screen
          name="turfs/[turfId]"
          options={{ headerShown: false, gestureEnabled: false }}
        />
        <Stack.Screen name="distribute" options={{ headerShown: false }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Geist_400Regular,
    Geist_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded) void SplashScreen.hideAsync();
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
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
        <JotaiProvider>
          <ThemedStack />
        </JotaiProvider>
      </PersistQueryClientProvider>
    </GestureHandlerRootView>
  );
}
