import { router, Stack } from "expo-router";
import { Platform, Text, View } from "react-native";
import { Button } from "@/components/button";

// Catches any route nothing matches — in practice a malformed link.
export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 items-center justify-center px-6 bg-background dark:bg-background-dark">
        <Text
          className="mb-2 text-5xl transform -skew-x-12 text-foreground dark:text-foreground-dark"
          style={{
            fontFamily: Platform.OS === "android" ? "Geist_700Bold_Italic" : "Geist_700Bold",
          }}
        >
          Turf Tools
        </Text>
        <Text
          className="mt-2 mb-6 text-center text-xl text-muted-foreground dark:text-muted-foreground-dark"
          style={{ fontFamily: "Geist_400Regular" }}
        >
          That link didn't lead anywhere
        </Text>
        <View className="w-full max-w-xs">
          <Button title="Go to start" variant="outline" onPress={() => router.replace("/")} />
        </View>
      </View>
    </>
  );
}
