import { LocateFixed, Navigation2 } from "lucide-react-native";
import { Platform, Pressable, View } from "react-native";
import Animated, {
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  withTiming,
} from "react-native-reanimated";

const SHADOW = {
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.15,
  shadowRadius: 6,
};

// One spacing everywhere: from the right edge, from the tray below, and
// between the two buttons.
const GAP = 10;
// The building list's collapsed snap point — the row sits GAP above it.
const TRAY_PEEK = 40;

// Rounded squares (radius matching the tray corners), distinct from the
// circular chrome buttons — these act on the map, not the app.
const BUTTON_CLASS =
  "items-center justify-center w-12 h-12 rounded-2xl bg-surface dark:bg-surface-dark active:opacity-60";

// Lower-right map controls (the Apple/Google convention for locate).
// Locate anchors the corner; the compass exists only while the map is
// rotated — it fades in to the left of locate with its needle tracking
// the live bearing, pointing at map north on screen.
export function MapControls({
  bearing,
  rotated,
  onResetNorth,
  onLocate,
  isDark,
}: {
  bearing: SharedValue<number>;
  rotated: boolean;
  onResetNorth: () => void;
  onLocate: () => void;
  isDark: boolean;
}) {
  const iconColor = isDark ? "#ededed" : "#1b1b1b";
  // Android's elevation shadow is heavy and doesn't fade with the view's
  // opacity (it pops in before the compass finishes fading) — use the
  // tray's hairline border there instead. iOS keeps the soft shadow.
  const buttonStyle =
    Platform.OS === "android"
      ? { borderWidth: 1, borderColor: isDark ? "#333333" : "#e5e5e5" }
      : SHADOW;
  const needleStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${-bearing.value}deg` }],
  }));
  // Quick in (rotation just started, be there), gentle out (the reset
  // animation has finished — linger a beat rather than vanishing).
  // ReduceMotion.Never: reanimated otherwise honors the OS Reduce Motion
  // setting by jumping to the end state — but a pure crossfade is the
  // reduced-motion-safe form, and the jump reads as a glitch.
  const compassStyle = useAnimatedStyle(
    () => ({
      opacity: withTiming(rotated ? 1 : 0, {
        duration: rotated ? 150 : 450,
        reduceMotion: ReduceMotion.Never,
      }),
    }),
    [rotated],
  );

  return (
    <View className="absolute flex-row" style={{ right: GAP, bottom: TRAY_PEEK + GAP, gap: GAP }}>
      <Animated.View style={compassStyle} pointerEvents={rotated ? "auto" : "none"}>
        <Pressable onPress={onResetNorth} hitSlop={4} className={BUTTON_CLASS} style={buttonStyle}>
          <Animated.View style={needleStyle}>
            <Navigation2 size={20} color={iconColor} strokeWidth={2} />
          </Animated.View>
        </Pressable>
      </Animated.View>
      <Pressable onPress={onLocate} hitSlop={4} className={BUTTON_CLASS} style={buttonStyle}>
        <LocateFixed size={20} color={iconColor} strokeWidth={2} />
      </Pressable>
    </View>
  );
}
