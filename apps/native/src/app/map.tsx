import { Platform, StyleSheet, Text, View } from "react-native";

export default function MapScreen() {
  if (Platform.OS === "web") {
    return (
      <View className="flex-1 items-center justify-center bg-slate-50 p-6">
        <Text className="text-lg text-slate-500">Map not available on web</Text>
        <Text className="mt-2 text-center text-sm text-slate-400">
          Use the iOS simulator to preview maps
        </Text>
      </View>
    );
  }

  return <NativeMap />;
}

function NativeMap() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const MapLibreGL = require("@maplibre/maplibre-react-native").default;

  const styleURL = "https://demotiles.maplibre.org/style.json";

  return (
    <View style={styles.container}>
      <MapLibreGL.MapView style={styles.map} styleURL={styleURL}>
        <MapLibreGL.Camera zoomLevel={12} centerCoordinate={[-73.97, 40.77]} />
      </MapLibreGL.MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
});
