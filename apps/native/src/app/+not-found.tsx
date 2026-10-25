import { router, Stack } from "expo-router";
import { useAtomValue } from "jotai";
import { Platform, Text, View } from "react-native";
import { activeTurfAtom } from "@/lib/atoms/active-turf";
import { Button } from "@/components/button";

// Catches any route nothing matches — in practice a malformed link. Back
// goes where the boot gate would: the bound turf, or the landing. Dismissing
// pops to that screen when it's already beneath (a link that arrived mid-
// session) and takes this screen's place when it isn't (a cold launch), so
// the back gesture never returns here. The gesture is off on this screen
// too: the button is the one exit, so a bound device can't swipe down to
// the landing beneath.
export default function NotFoundScreen() {
  const activeTurf = useAtomValue(activeTurfAtom);
  const goBack = () => router.dismissTo(activeTurf ? `/turfs/${activeTurf.turfId}` : "/");
  return (
    <>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
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
          That link didn't lead anywhere.
        </Text>
        <View className="w-full max-w-xs">
          <Button title="Go back" variant="outline" onPress={goBack} />
        </View>
      </View>
    </>
  );
}
