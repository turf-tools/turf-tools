import { DoorOpen, List, Mic, Search } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type ButtonAction = "search" | "list" | "next" | "mic";

type Props = {
  buttons: Array<ButtonAction | null>;
  onPress: (action: ButtonAction) => void;
};

const ICON_SIZE = 20;
const SHADOW = {
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.15,
  shadowRadius: 6,
  elevation: 4,
};

// Floating bottom toolbar — white buttons with shadows, no separator line.
// Labeled buttons (List, Next) are rounded pills with icon + text.
// Icon-only buttons (Search, Plus, Mic) are white circles.
export function BottomNav({ buttons, onPress }: Props) {
  const insets = useSafeAreaInsets();

  return (
    <View
      className="flex-row items-center gap-3 px-8 border-t border-border dark:border-border-dark bg-background dark:bg-background-dark"
      style={{ paddingBottom: Math.max(insets.bottom, 8), paddingTop: 25 }}
    >
      {buttons.map((action, idx) => {
        if (action === null) {
          return <View key={`empty-${idx}`} style={{ width: 44 }} />;
        }
        return <NavButton key={action} action={action} onPress={() => onPress(action)} />;
      })}
    </View>
  );
}

function NavButton({ action, onPress }: { action: ButtonAction; onPress: () => void }) {
  const label = getLabel(action);

  if (label) {
    return (
      <Pressable
        onPress={onPress}
        className="flex-1 flex-row items-center justify-center gap-2 px-5 h-11 rounded-full bg-white dark:bg-muted-dark active:opacity-60"
        style={SHADOW}
        hitSlop={4}
      >
        {getIcon(action)}
        <Text className="font-sans text-xl text-foreground dark:text-foreground-dark">{label}</Text>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      className="items-center justify-center w-11 h-11 rounded-full bg-white dark:bg-muted-dark active:opacity-60"
      style={SHADOW}
      hitSlop={4}
    >
      {getIcon(action)}
    </Pressable>
  );
}

function getIcon(action: ButtonAction) {
  const color = "#1b1b1b";
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
