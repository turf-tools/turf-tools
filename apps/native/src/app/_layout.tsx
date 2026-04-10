import "@/global.css";

import { Geist_400Regular, Geist_700Bold } from "@expo-google-fonts/geist";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Provider as JotaiProvider, useAtomValue } from "jotai";
import { useColorScheme } from "nativewind";
import { useEffect } from "react";
import { ActivityIndicator, LogBox, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { themeAtom } from "@/lib/atoms/theme";
import { persister, queryClient } from "@/lib/query-client";

// Harmless noise from react-native-screens / Animated when a screen unmounts
// mid-transition. Known upstream issue with no real fix; silenced here so the
// dev console stays clean.
LogBox.ignoreLogs(["Sending `onAnimatedValueUpdate` with no listeners registered"]);

function ThemedStack() {
  const theme = useAtomValue(themeAtom);
  const colorSchemeUtils = useColorScheme();
  const isDark = theme === "dark";

  // Keep NativeWind's color scheme in sync with our jotai theme atom so that
  // `dark:` Tailwind variants respond to the same source of truth as the
  // header colors below.
  useEffect(() => {
    colorSchemeUtils.setColorScheme(theme);
  }, [theme, colorSchemeUtils]);

  return (
    <>
      <StatusBar style={isDark ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: true,
          headerStyle: {
            backgroundColor: isDark ? "#1b1b1b" : "#fcfcfc",
          },
          headerTintColor: isDark ? "#ededed" : "#1b1b1b",
          headerTitleStyle: { fontFamily: "Geist_700Bold", fontSize: 18 },
          headerBackButtonDisplayMode: "minimal",
        }}
      >
        <Stack.Screen name="index" options={{ title: "Field Tools" }} />
        <Stack.Screen name="settings" options={{ title: "Settings", presentation: "modal" }} />
        <Stack.Screen name="turfs/[turfId]" options={{ headerShown: false }} />
        <Stack.Screen name="distribute" options={{ title: "Distribute" }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Geist_400Regular,
    Geist_700Bold,
  });

  if (!fontsLoaded) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister, maxAge: 1000 * 60 * 60 * 24 * 7 }}
      >
        <JotaiProvider>
          <ThemedStack />
        </JotaiProvider>
      </PersistQueryClientProvider>
    </GestureHandlerRootView>
  );
}
