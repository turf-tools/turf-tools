import Mapbox from "@rnmapbox/maps";
import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";

// Set your Mapbox access token here or via environment variable
const MAPBOX_ACCESS_TOKEN = process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN ?? "";

export default function MapScreen() {
  useEffect(() => {
    if (MAPBOX_ACCESS_TOKEN) {
      Mapbox.setAccessToken(MAPBOX_ACCESS_TOKEN);
    }
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
