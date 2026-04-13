import { router } from "expo-router";
import { ChevronLeft } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const ICON_SIZE = 20;
const SHADOW = {
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.15,
  shadowRadius: 6,
  elevation: 4,
};

type Props = {
  title: string;
  showBack: boolean;
  // "minimal" hides the title and border (used on the map/list screen).
  variant?: "default" | "minimal";
  isDark: boolean;
};

export function TopNav({ title, showBack, variant = "default", isDark }: Props) {
  const insets = useSafeAreaInsets();
  const isMinimal = variant === "minimal";

  return (
    <View
      className={`bg-background dark:bg-background-dark ${isMinimal ? "" : "border-b border-border dark:border-border-dark"}`}
      style={{ paddingTop: insets.top }}
    >
      <View className="flex-row items-center px-5" style={{ paddingTop: 12, paddingBottom: 18 }}>
        {/* Left: back button (h-11 always to keep consistent height) */}
        <View className="w-12 h-12">
          {showBack && (
            <Pressable
              onPress={() => router.back()}
              hitSlop={4}
              className="items-center justify-center w-12 h-12 rounded-full bg-surface dark:bg-surface-dark active:opacity-60"
              style={SHADOW}
            >
              <ChevronLeft
                size={ICON_SIZE}
                color={isDark ? "#ededed" : "#1b1b1b"}
                strokeWidth={2}
              />
            </Pressable>
          )}
        </View>

        {/* Center: title */}
        <View className="flex-1 items-center px-3">
          {!!title && (
            <Text
              className="text-foreground dark:text-foreground-dark"
              style={{ fontFamily: "Geist_700Bold", fontSize: 18 }}
              numberOfLines={1}
            >
              {title}
            </Text>
          )}
        </View>

        {/* Right: spacer (menu button is rendered globally in root layout) */}
        <View className="w-12" />
      </View>
    </View>
  );
}
