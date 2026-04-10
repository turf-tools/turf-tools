import { Link, router } from "expo-router";
import { Text, View } from "react-native";
import { Button } from "@/components/button";

// Landing screen — placeholder for Slice B. The real version (Slice F) will
// have a QR scanner and a list-code entry field that resolve to a turf via
// `turfs.getByCode`. For now, hard-link to the seeded turf so we can navigate
// the screen graph end-to-end during development.
const SEEDED_TURF_ID = "00000000-0000-4000-8000-000000000006";

export default function LandingScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-background dark:bg-background-dark p-6">
      <Text
        className="mb-2 text-4xl text-foreground dark:text-foreground-dark"
        style={{ fontFamily: "Geist_700Bold" }}
      >
        Field Tools
      </Text>
      <Text
        className="mb-12 text-center text-xl text-muted-foreground dark:text-muted-foreground-dark"
        style={{ fontFamily: "Geist_400Regular" }}
      >
        Landing placeholder
      </Text>

      <View className="gap-3 w-full max-w-xs">
        <Button title="Open seeded turf" onPress={() => router.push(`/turfs/${SEEDED_TURF_ID}`)} />
        <Link href="/settings" asChild>
          <Button title="Settings" variant="outline" />
        </Link>
      </View>
    </View>
  );
}
