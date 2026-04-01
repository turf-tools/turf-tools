import { useEffect, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";

// Set your Mapbox access token here or via environment variable
const MAPBOX_ACCESS_TOKEN = process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN ?? "";

export default function MapScreen() {
  const [Mapbox, setMapbox] = useState<typeof import("@rnmapbox/maps").default | null>(null);

  useEffect(() => {
    if (Platform.OS === "web") return;
    import("@rnmapbox/maps").then((mod) => {
      if (MAPBOX_ACCESS_TOKEN) {
        mod.default.setAccessToken(MAPBOX_ACCESS_TOKEN);
      }
      setMapbox(mod.default);
    });
  }, []);

  if (!MAPBOX_ACCESS_TOKEN) {
    return (
      <View className="flex-1 items-center justify-center bg-slate-50 p-6">
        <Text className="mb-2 text-lg font-semibold text-red-600">Mapbox token not set</Text>
        <Text className="text-center text-sm text-slate-500">
          Set EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN in your .env file
        </Text>
      </View>
    );
  }

  if (!Mapbox) {
    return (
      <View className="flex-1 items-center justify-center bg-slate-50 p-6">
        <Text className="text-lg text-slate-500">
          {Platform.OS === "web" ? "Map not available on web" : "Loading map..."}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Mapbox.MapView style={styles.map} styleURL={Mapbox.StyleURL.Street}>
        <Mapbox.Camera zoomLevel={12} centerCoordinate={[-73.97, 40.77]} />
        <Mapbox.LocationPuck puckBearing="heading" puckBearingEnabled />
      </Mapbox.MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
});
