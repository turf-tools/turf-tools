import { type ReactNode } from "react";
import { Text, View, type ViewStyle } from "react-native";

type Props = {
  children?: ReactNode;
  icon?: ReactNode;
  // Inline style override — applied on top of the default neutral pill.
  // Use this to provide semantic backgrounds (e.g. `colors.contacted.background`).
  style?: ViewStyle;
};

// Small label pill for compact metadata badges (age + gender, party, counts
// with icons, status indicators, etc.). Defaults to a neutral gray; pass
// `style` to override the background.
export function Pill({ children, icon, style }: Props) {
  return (
    <View
      style={style}
      className="flex-row items-center px-2 py-0.5 rounded-md min-w-[32px] min-h-[28px] justify-center gap-1.5 bg-badge dark:bg-badge-dark"
    >
      {icon}
      {children != null && (
        <Text
          style={{ fontVariant: ["tabular-nums"] }}
          className="font-sans text-lg text-foreground dark:text-foreground-dark"
        >
          {children}
        </Text>
      )}
    </View>
  );
}
