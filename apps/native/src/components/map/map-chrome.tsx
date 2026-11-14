import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { ATTRIBUTION_BOTTOM } from "./map-layout";

export function MissingKeyNotice({ isDark }: { isDark: boolean }) {
  return (
    <View style={[styles.missingKey, isDark && styles.missingKeyDark]}>
      <Text style={[styles.missingKeyText, isDark && styles.missingKeyTextDark]}>
        Set EXPO_PUBLIC_MAPTILER_KEY in apps/native/.env to enable the map.
      </Text>
    </View>
  );
}

// MapTiler's terms require visible text attribution (only the logo is
// waivable), and OSM's ODbL wants it visible by default. The built-in
// info button is buried under the bottom sheet, so this sits just above
// the sheet's collapsed peek.
export function AttributionBadge({ isDark }: { isDark: boolean }) {
  const textStyle = [styles.badgeText, isDark && styles.badgeTextDark];

  return (
    <View style={[styles.badge, isDark && styles.badgeDark]}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel="MapTiler copyright"
        hitSlop={6}
        onPress={() => void Linking.openURL("https://www.maptiler.com/copyright/")}
      >
        <Text style={textStyle}>© MapTiler</Text>
      </Pressable>
      <Text style={textStyle}> · </Text>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel="OpenStreetMap copyright"
        hitSlop={6}
        onPress={() => void Linking.openURL("https://www.openstreetmap.org/copyright")}
      >
        <Text style={textStyle}>© OpenStreetMap contributors</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    position: "absolute",
    left: 6,
    bottom: ATTRIBUTION_BOTTOM,
    flexDirection: "row",
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
    backgroundColor: "rgba(255,255,255,0.55)",
  },
  badgeDark: { backgroundColor: "rgba(10,10,10,0.55)" },
  badgeText: {
    fontSize: 10,
    fontFamily: "Geist_400Regular",
    color: "#555",
  },
  badgeTextDark: { color: "#999" },
  missingKey: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#f5f5f5",
  },
  missingKeyDark: { backgroundColor: "#0a0a0a" },
  missingKeyText: {
    fontFamily: "Geist_400Regular",
    color: "#444",
    textAlign: "center",
  },
  missingKeyTextDark: { color: "#aaa" },
});
