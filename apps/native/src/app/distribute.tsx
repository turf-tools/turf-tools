import { Text, View } from "react-native";

// Placeholder for Distribute mode. The full Distribute experience (the lead
// canvasser's view for signing out turfs via QR code) is intentionally
// deferred to a later PR. This stub exists so the route is reachable from
// Settings and the layout supports it from day one.
export default function DistributeScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-background dark:bg-background-dark p-6">
      <Text
        className="mb-2 text-2xl text-foreground dark:text-foreground-dark"
        style={{ fontFamily: "Geist_700Bold" }}
      >
        Distribute
      </Text>
      <Text
        className="text-center text-base text-muted-foreground dark:text-muted-foreground-dark"
        style={{ fontFamily: "Geist_400Regular" }}
      >
        Coming soon
      </Text>
    </View>
  );
}
