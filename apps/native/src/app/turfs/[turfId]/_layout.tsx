import { Stack } from "expo-router";
import { useAtomValue } from "jotai";
import { useColorScheme } from "nativewind";
import { useEffect } from "react";
import { View } from "react-native";
import { themeAtom } from "@/lib/atoms/theme";
import { BottomNavProvider } from "@/lib/bottom-nav-context";

// Layout for all screens inside a turf (List, Building, Person).
// Renders its own Stack for sub-navigation + a persistent BottomNav
// below the screen content that stays fixed during transitions.
export default function TurfLayout() {
  const theme = useAtomValue(themeAtom);
  const colorSchemeUtils = useColorScheme();
  const isDark = theme === "dark";

  useEffect(() => {
    colorSchemeUtils.setColorScheme(theme);
  }, [theme, colorSchemeUtils]);

  return (
    <BottomNavProvider>
      <View className="flex-1">
        <Stack
          screenOptions={{
            headerStyle: {
              backgroundColor: isDark ? "#1b1b1b" : "#fcfcfc",
            },
            headerTintColor: isDark ? "#ededed" : "#1b1b1b",
            headerTitleStyle: { fontFamily: "Geist_700Bold", fontSize: 18 },
            headerBackButtonDisplayMode: "minimal",
          }}
        >
          <Stack.Screen
            name="index"
            options={{ headerBackVisible: false, gestureEnabled: false }}
          />
          <Stack.Screen name="buildings/[buildingId]" />
          <Stack.Screen name="persons/[personId]" />
        </Stack>
      </View>
    </BottomNavProvider>
  );
}
