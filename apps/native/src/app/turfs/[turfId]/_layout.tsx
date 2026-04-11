import { Stack } from "expo-router";
import { useAtomValue } from "jotai";
import { useColorScheme } from "nativewind";
import { useEffect } from "react";
import { themeAtom } from "@/lib/atoms/theme";
import { NavProvider } from "@/lib/nav-context";

export default function TurfLayout() {
  const theme = useAtomValue(themeAtom);
  const colorSchemeUtils = useColorScheme();

  useEffect(() => {
    colorSchemeUtils.setColorScheme(theme);
  }, [theme, colorSchemeUtils]);

  return (
    <NavProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" options={{ gestureEnabled: false }} />
        <Stack.Screen name="buildings/[buildingId]" />
        <Stack.Screen name="persons/[personId]" />
      </Stack>
    </NavProvider>
  );
}
