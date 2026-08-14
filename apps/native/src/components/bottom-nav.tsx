import { DoorOpen, List, Mic, Search } from "lucide-react-native";
import { Platform, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type ButtonAction = "search" | "list" | "next" | "mic";

type Props = {
  buttons: Array<ButtonAction | null>;
  onPress: (action: ButtonAction) => void;
  isDark?: boolean;
};

const ICON_SIZE = 20;

// Bottom clearance shared by the nav bar and Settings' footer row. iOS's
// bottom inset already includes clearance above the home indicator;
// Android's is just the bar region itself, so add breathing room there.
export function bottomClearance(insets: { bottom: number }) {
  return Platform.OS === "android" ? Math.max(insets.bottom, 8) + 24 : Math.max(insets.bottom, 8);
}
const SHADOW = {
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.15,
  shadowRadius: 6,
  // Android's light model casts heavier shadows near the screen bottom —
  // 1 here matches the top controls' 4 visually.
  elevation: 1,
};

// Floating bottom toolbar — white buttons with shadows, no separator line.
// Labeled buttons (List, Next) are rounded pills with icon + text.
// Icon-only buttons (Search, Plus, Mic) are white circles.
export function BottomNav({ buttons, onPress, isDark = false }: Props) {
  const insets = useSafeAreaInsets();

  return (
    <View
      className="flex-row items-center gap-3 px-8 border-t border-border dark:border-border-dark bg-background dark:bg-background-dark"
      style={{
        paddingBottom: bottomClearance(insets),
        // Android: match the visible air below the buttons (the +24 in
        // bottomClearance) so the bar is symmetric on any screen.
        paddingTop: Platform.OS === "android" ? 24 : 25,
      }}
    >
      {buttons.map((action, idx) => {
        if (action === null) {
          return <View key={`empty-${idx}`} style={{ width: 44 }} />;
        }
        return (
          <NavButton key={action} action={action} isDark={isDark} onPress={() => onPress(action)} />
        );
      })}
    </View>
  );
}

function NavButton({
  action,
  isDark,
  onPress,
}: {
  action: ButtonAction;
  isDark: boolean;
  onPress: () => void;
}) {
  const label = getLabel(action);
  const iconColor = isDark ? "#ededed" : "#1b1b1b";

  if (label) {
    return (
      <Pressable
        onPress={onPress}
        className="flex-1 flex-row items-center justify-center gap-2 px-5 h-12 rounded-full bg-surface dark:bg-surface-dark active:opacity-60"
        style={SHADOW}
        hitSlop={4}
      >
        {getIcon(action, iconColor)}
        <Text className="font-sans text-xl text-foreground dark:text-foreground-dark">{label}</Text>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      className="items-center justify-center w-12 h-12 rounded-full bg-surface dark:bg-surface-dark active:opacity-60"
      style={SHADOW}
      hitSlop={4}
    >
      {getIcon(action, iconColor)}
    </Pressable>
  );
}

function getIcon(action: ButtonAction, color: string) {
  switch (action) {
    case "search":
      return <Search size={ICON_SIZE} color={color} strokeWidth={2} />;
    case "list":
      return <List size={ICON_SIZE} color={color} strokeWidth={2} />;
    case "next":
      return <DoorOpen size={ICON_SIZE} color={color} strokeWidth={2} />;
    case "mic":
      return <Mic size={ICON_SIZE} color={color} strokeWidth={2} />;
  }
}

function getLabel(action: ButtonAction): string | null {
  switch (action) {
    case "list":
      return "List";
    case "next":
      return "Next";
    default:
      return null;
  }
}
